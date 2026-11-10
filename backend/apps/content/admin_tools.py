"""Staff-only content workflows used by Django Admin."""

from io import BytesIO

from django import forms
from django.contrib import admin, messages
from django.core import signing
from django.core.exceptions import PermissionDenied, ValidationError
from django.http import FileResponse, Http404, HttpResponse, HttpResponseRedirect
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils.html import format_html_join

from .importing import import_document
from .models import Product, Section
from .publishing import capture_metadata, capture_product, publish
from .storage import LocalContentStorage
from .validation import ContentError, MAX_DOCUMENT_BYTES


class ImportForm(forms.Form):
    document = forms.FileField(label="Полный JSON главы / эпизода / фильма")

    def clean_document(self):
        upload = self.cleaned_data["document"]
        if upload.size > MAX_DOCUMENT_BYTES:
            raise forms.ValidationError("Максимальный размер — 10 MiB.")
        return upload


class PublishForm(forms.Form):
    approval_token = forms.CharField(widget=forms.HiddenInput)
    confirm_ready = forms.BooleanField(
        label="Подтверждаю полный состав и ручную проверку смысла переводов, заданий и прав на тексты",
    )


class WorkflowAdmin(admin.ModelAdmin):
    change_form_template = "admin/content/change_form.html"
    import_enabled = False
    product_publication = False
    metadata_publication = False

    def _url(self, action, object_id):
        return reverse(f"admin:{self.opts.app_label}_{self.opts.model_name}_{action}", args=(object_id,))

    def get_urls(self):
        urls = []
        for enabled, action, view in (
                (self.import_enabled, "import", self.import_view),
                (self.product_publication, "publish", self.publish_view),
                (self.metadata_publication, "metadata", self.metadata_view),
        ):
            if enabled:
                urls.append(path(f"<uuid:object_id>/{action}/", self.admin_site.admin_view(view),
                                 name=f"{self.opts.app_label}_{self.opts.model_name}_{action}"))
        return urls + super().get_urls()

    def change_view(self, request, object_id, form_url="", extra_context=None):
        context = dict(extra_context or {})
        obj = self.get_object(request, object_id)
        if obj is not None and self.has_change_permission(request, obj):
            if self.import_enabled and (not isinstance(obj, Product) or obj.kind == "movie"):
                context["content_import_url"] = self._url("import", object_id)
            if self.product_publication:
                context["content_publish_url"] = self._url("publish", object_id)
            if self.metadata_publication:
                context["content_metadata_url"] = self._url("metadata", object_id)
        return super().change_view(request, object_id, form_url, context)

    def _object(self, request, object_id):
        obj = self.get_object(request, str(object_id))
        if obj is None:
            raise Http404
        if not self.has_change_permission(request, obj):
            raise PermissionDenied
        if isinstance(obj, Section) and not request.user.has_perm("content.change_product"):
            raise PermissionDenied
        return obj

    def _response(self, request, obj, title, form, **extra):
        context = {**self.admin_site.each_context(request), "opts": self.opts,
                   "original": obj, "title": title, "form": form,
                   "back_url": reverse(f"admin:{self.opts.app_label}_{self.opts.model_name}_change", args=(obj.pk,)),
                   **extra}
        return TemplateResponse(request, "admin/content/workflow.html", context)

    def import_view(self, request, object_id):
        obj = self._object(request, object_id)
        if isinstance(obj, Product) and obj.kind != "movie":
            raise Http404
        form = ImportForm(request.POST if request.method == "POST" else None,
                          request.FILES if request.method == "POST" else None)
        if request.method == "POST" and form.is_valid():
            upload = form.cleaned_data["document"]
            try:
                draft = import_document(
                    upload.read(MAX_DOCUMENT_BYTES + 1),
                    product_id=obj.product_id if isinstance(obj, Section) else obj.pk,
                    section_id=obj.pk if isinstance(obj, Section) else None,
                )
            except ContentError as exc:
                form.add_error(None, str(exc))
            else:
                messages.success(request,
                                 f"Черновик сохранён целиком. SHA-256: {draft.source_hash}. Публикация не выполнялась.")
                return HttpResponseRedirect(reverse("admin:content_contentdraft_change", args=(draft.pk,)))
        return self._response(request, obj, "Импорт учебного JSON", form,
                              description="Заменяется только черновик выбранной единицы; действующие пакеты не меняются.")

    def publish_view(self, request, object_id):
        return self._publish_view(request, object_id, metadata=False)

    def metadata_view(self, request, object_id):
        return self._publish_view(request, object_id, metadata=True)

    def _publish_view(self, request, object_id, *, metadata):
        obj = self._object(request, object_id)
        capture = None
        form = PublishForm(request.POST if request.method == "POST" else None)
        try:
            capture = capture_metadata(self.model, obj.pk) if metadata else capture_product(obj.pk)
            payload = {"model": self.opts.label_lower, "id": str(obj.pk), "metadata": metadata,
                       "expected": capture.approval()}
            if request.method == "GET":
                form = PublishForm(initial={"approval_token": signing.dumps(payload, salt="content.publish")})
            elif request.method == "POST" and form.is_valid():
                try:
                    approved = signing.loads(form.cleaned_data["approval_token"], salt="content.publish", max_age=3600)
                except signing.BadSignature as exc:
                    raise ContentError("approval_invalid",
                                       "Подтверждение истекло или повреждено; откройте страницу заново.") from exc
                if any(approved.get(key) != payload[key] for key in ("model", "id", "metadata")):
                    raise ContentError("approval_invalid", "Подтверждение относится к другому объекту/действию.")
                catalog = publish(capture, expected=approved["expected"], confirmed=True)
                messages.success(request,
                                 f"Активный каталог: {catalog.pk if catalog else 'пустой'}. Повтор без изменений не создаёт ревизию.")
                return HttpResponseRedirect(
                    reverse(f"admin:{self.opts.app_label}_{self.opts.model_name}_change", args=(obj.pk,)))
        except (ContentError, ValidationError) as exc:
            if request.method == "GET":
                return self._response(request, obj, "Публикация недоступна", None,
                                      workflow_error=str(exc))
            form.add_error(None, str(exc))
        old_ids = capture.previous.identity_map.keys() if capture and capture.previous else set()
        added = sum(
            value[0] == "lesson" and key not in old_ids for key, value in capture.identities.items()) if capture else 0
        return self._response(
            request, obj, "Публикация метаданных" if metadata else "Публикация полного Product", form,
            description="Подтверждаются только выбранный объект и его показанные связанные метаданные. Изменения других Product не включаются.",
            captured=capture, added_lessons=added,
            review_diff=capture.review_diff() if capture else {},
        )


class ImmutableAdmin(admin.ModelAdmin):
    def get_readonly_fields(self, request, obj=None):
        fields = tuple(field.name for field in self.model._meta.fields)
        if obj is not None and self.model.__name__ in ("PublishedRevision", "PackArtifact", "CatalogRevision"):
            fields += ("download_links",)
        return fields

    @admin.display(description="Скачать проверенные JSON")
    def download_links(self, obj):
        route = f"admin:content_{self.model._meta.model_name}_download"
        scopes = obj.manifest_files if self.model.__name__ == "PublishedRevision" else {"JSON": None}
        return format_html_join(" | ", '<a href="{}">{}</a>',
                                ((reverse(route, args=(obj.pk, scope) if value else (obj.pk,)), scope)
                                 for scope, value in scopes.items()))

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


def artifact_response(descriptor: dict, filename: str) -> HttpResponse:
    try:
        data = LocalContentStorage().verify(descriptor)
    except ContentError as exc:
        return HttpResponse(str(exc), status=503, content_type="text/plain; charset=utf-8")
    return FileResponse(BytesIO(data), as_attachment=True, filename=filename, content_type="application/json")
