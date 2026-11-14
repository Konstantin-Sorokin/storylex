from django.http import Http404
from django.urls import path
from django.utils import timezone
from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.dev_auth import DevAuthentication, dev_sync_enabled
from .models import UserChange, UserSyncState
from .services import process_operation


class Operation(serializers.Serializer):
    operation_id = serializers.UUIDField()
    sequence = serializers.IntegerField(min_value=1, max_value=9007199254740991)
    type = serializers.CharField(max_length=80)
    occurred_at = serializers.CharField(max_length=80)
    payload = serializers.DictField()


class Envelope(serializers.Serializer):
    device_id = serializers.UUIDField()
    operations = Operation(many=True, allow_empty=False, max_length=100)

    def validate_operations(self, value):
        sequences = [row["sequence"] for row in value]
        if sequences != sorted(set(sequences)):
            raise serializers.ValidationError(
                "Sequences must be unique and increasing."
            )
        return value


class PrivateView(APIView):
    authentication_classes = [DevAuthentication]
    permission_classes = [IsAuthenticated]

    def finalize_response(self, request, response, *args, **kwargs):
        response["Cache-Control"] = "no-store"
        return super().finalize_response(request, response, *args, **kwargs)


class DevSession(PrivateView):
    def initial(self, request, *args, **kwargs):
        if not dev_sync_enabled():
            raise Http404
        super().initial(request, *args, **kwargs)

    def get(self, request):
        return Response({"user_id": str(request.user.pk)})


class Operations(PrivateView):
    def post(self, request):
        if len(request.body) > 256 * 1024:
            return Response({"error": {"code": "batch_too_large"}}, status=413)
        envelope = Envelope(data=request.data)
        envelope.is_valid(raise_exception=True)
        device_id = envelope.validated_data["device_id"]
        # Hash the original JSON, including unknown fields. A reused operation ID
        # with a changed command never bypasses the inbox comparison.
        results = [process_operation(request.user, device_id, operation)
                   for operation in request.data["operations"]]
        return Response({
            "results": results, "server_time": timezone.now().isoformat(),
        })


class Changes(PrivateView):
    def get(self, request):
        try:
            after = int(request.query_params.get("after", "0"))
            limit = int(request.query_params.get("limit", "500"))
            latest = UserSyncState.objects.filter(user=request.user).values_list(
                "last_revision", flat=True,
            ).first() or 0
            through = int(request.query_params.get("through_cursor", latest))
            if not 0 <= after <= through <= latest or not 1 <= limit <= 500:
                raise ValueError
        except (ValueError, TypeError):
            return Response({"error": {"code": "invalid_cursor"}}, status=400)
        rows = list(UserChange.objects.filter(
            user=request.user, revision__gt=after, revision__lte=through,
        ).order_by("revision")[:limit])
        cursor = rows[-1].revision if rows else after
        return Response({
            "changes": [{"cursor": str(row.revision), "entity": row.entity_type,
                         "id": str(row.entity_id), "state": row.state} for row in rows],
            "next_cursor": str(cursor), "through_cursor": str(through),
            "has_more": cursor < through,
        })


urlpatterns = [
    path("dev/session", DevSession.as_view()),
    path("sync/operations", Operations.as_view()),
    path("sync/changes", Changes.as_view()),
]
