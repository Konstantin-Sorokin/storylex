"""Read-only published catalogue and trial delivery for the mobile foundation.

Full manifests/artifacts remain closed until accounts and entitlements (stage 2).
No storage key, draft, or editable metadata is accepted from the client.
"""

from uuid import uuid4

from django.http import HttpResponse
from django.urls import path, reverse
from django.utils.http import parse_etags
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .delivery import DeliveryError, active_catalog, selected_catalog, trial_artifacts, trial_revision
from .models import CatalogRevision
from .storage import LocalContentStorage
from .validation import ContentError


class PublicContentView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def handle_exception(self, exc):
        if isinstance(exc, (DeliveryError, ContentError)):
            code = exc.code
            status = exc.status if isinstance(exc, DeliveryError) else 503
            return Response({"error": {"code": code, "message": "Контент недоступен.",
                                       "details": {}, "request_id": str(uuid4())}}, status=status)
        return super().handle_exception(exc)


def file_response(request, descriptor: dict, *, immutable: bool = False) -> HttpResponse:
    # Verify before returning even 304; missing/corrupt storage must not look ready.
    data = LocalContentStorage().verify(descriptor)
    etag = '"' + descriptor["sha256"] + '"'
    candidates = parse_etags(request.headers.get("If-None-Match", ""))
    matched = "*" in candidates or etag in [tag.removeprefix("W/") for tag in candidates]
    response = HttpResponse(status=304) if matched else HttpResponse(data, content_type="application/json")
    response["ETag"] = etag
    response["Cache-Control"] = "public, max-age=31536000, immutable" if immutable else "no-cache"
    response["X-Content-Type-Options"] = "nosniff"
    return response


class CatalogHeadView(PublicContentView):
    def get(self, request):
        catalog = active_catalog()
        descriptor = {"object_key": catalog.object_key, "sha256": catalog.sha256,
                      "byte_size": catalog.byte_size}
        LocalContentStorage().verify(descriptor)
        etag = f'"{catalog.pk}"'
        candidates = parse_etags(request.headers.get("If-None-Match", ""))
        if "*" in candidates or etag in [tag.removeprefix("W/") for tag in candidates]:
            response = HttpResponse(status=304)
        else:
            response = Response({
                "catalog_revision": str(catalog.pk), "schema_version": catalog.schema_version,
                "url": request.build_absolute_uri(reverse("content-api:catalog-file", args=(catalog.pk,))),
                "sha256": catalog.sha256, "byte_size": catalog.byte_size,
            })
        response["ETag"] = etag
        response["Cache-Control"] = "no-cache"
        return response


class CatalogFileView(PublicContentView):
    def get(self, request, revision_id):
        catalog = CatalogRevision.objects.filter(pk=revision_id).first()
        if catalog is None:
            raise DeliveryError("catalog_not_found", 404)
        return file_response(request, {"object_key": catalog.object_key, "sha256": catalog.sha256,
                                       "byte_size": catalog.byte_size}, immutable=True)


class ManifestView(PublicContentView):
    def get(self, request, product_id):
        scope = request.query_params.get("scope")
        if scope not in ("trial", "full"):
            raise DeliveryError("invalid_scope", 400)
        if scope == "full":
            raise DeliveryError("full_access_required", 403)
        catalog = selected_catalog(request.query_params.get("catalog_revision"))
        revision = trial_revision(catalog, product_id)
        response = file_response(request, revision.manifest_files["trial"])
        response["X-Catalog-Revision"] = str(catalog.pk)
        return response


class DownloadRequest(serializers.Serializer):
    artifact_ids = serializers.ListField(child=serializers.UUIDField(), min_length=1, max_length=100)


class DownloadsView(PublicContentView):
    def post(self, request):
        serializer = DownloadRequest(data=request.data)
        if not serializer.is_valid() or set(request.data) != {"artifact_ids"}:
            raise DeliveryError("invalid_download_request", 400)
        artifacts = trial_artifacts(serializer.validated_data["artifact_ids"])
        response = Response({"downloads": [{
            "artifact_id": str(artifact.pk),
            "url": request.build_absolute_uri(reverse("content-api:artifact", args=(artifact.pk,))),
            "expires_at": None, "sha256": artifact.sha256, "byte_size": artifact.byte_size,
        } for artifact in artifacts]})
        response["Cache-Control"] = "no-store"
        return response


class ArtifactView(PublicContentView):
    def get(self, request, artifact_id):
        artifact = trial_artifacts([artifact_id])[0]
        return file_response(request, {"object_key": artifact.object_key, "sha256": artifact.sha256,
                                       "byte_size": artifact.byte_size})


app_name = "content-api"
urlpatterns = [
    path("catalog/head", CatalogHeadView.as_view(), name="catalog-head"),
    path("catalog/revisions/<uuid:revision_id>", CatalogFileView.as_view(), name="catalog-file"),
    path("products/<uuid:product_id>/manifest", ManifestView.as_view(), name="manifest"),
    path("content/downloads", DownloadsView.as_view(), name="downloads"),
    path("content/artifacts/<uuid:artifact_id>", ArtifactView.as_view(), name="artifact"),
]
