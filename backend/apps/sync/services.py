import hashlib
import json
from uuid import UUID

from django.db import transaction

from apps.accounts.models import Device, User
from apps.learning.services import complete
from .models import SyncInbox, UserChange, UserSyncState


@transaction.atomic
def process_operation(user: User, device_id: UUID, operation: dict) -> dict:
    # get_or_create handles first concurrent contact; the following row lock
    # serializes every mutation and cursor allocation through commit.
    UserSyncState.objects.get_or_create(user=user)
    head = UserSyncState.objects.select_for_update().get(user=user)
    command = {"device_id": str(device_id), "operation": operation}
    encoded = json.dumps(
        command, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode()
    digest = hashlib.sha256(encoded).hexdigest()
    identifier = operation["operation_id"]
    existing = SyncInbox.objects.filter(user=user, operation_id=identifier).first()
    if existing:
        if existing.payload_hash == digest:
            return existing.result
        return {"operation_id": identifier, "status": "rejected",
                "code": "idempotency_key_reused"}
    device, _ = Device.objects.get_or_create(pk=device_id, defaults={"user": user})
    if device.user_id != user.pk:
        return {"operation_id": identifier, "status": "rejected",
                "code": "device_not_owned"}
    sequence_used = SyncInbox.objects.filter(
        device=device, sequence=operation["sequence"],
    ).exists()
    if sequence_used:
        return {"operation_id": identifier, "status": "rejected",
                "code": "sequence_reused"}
    result = {"operation_id": identifier, "status": "rejected"}
    if operation["type"] != "lesson.complete":
        result["code"] = "unsupported_operation"
    else:
        state, changed, error = complete(
            user, operation["payload"], operation["occurred_at"],
            head.last_revision + 1,
        )
        if error:
            result["code"] = error
        else:
            assert state is not None
            result.update(status="applied" if changed else "noop", state=state,
                          change_revision=state["revision"])
            if changed:
                head.last_revision += 1
                head.save(update_fields=["last_revision"])
                UserChange.objects.create(
                    user=user, revision=head.last_revision,
                    entity_type="lesson_completion",
                    entity_id=state["lesson_id"], state=state,
                )
    SyncInbox.objects.create(
        user=user, operation_id=identifier, device=device,
        sequence=operation["sequence"], type=operation["type"],
        payload_hash=digest, result=result,
    )
    return result
