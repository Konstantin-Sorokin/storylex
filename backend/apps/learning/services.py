"""Completion union, called inside the account sync lock and transaction."""
from django.utils import timezone
from rest_framework import serializers

from apps.accounts.models import User
from apps.content.models import PublishedRevision
from .models import LessonCompletion


class CompletionPayload(serializers.Serializer):
    product_id = serializers.UUIDField()
    lesson_id = serializers.UUIDField()
    content_revision_id = serializers.UUIDField()


def contains(manifest: dict | None, lesson_id: str) -> bool:
    return bool(manifest and any(
        lesson_id in doc["lesson_ids"] for doc in manifest["documents"]
    ))


def completion_state(completion: LessonCompletion) -> dict:
    return {
        "product_id": str(completion.lesson.product_id),
        "lesson_id": str(completion.lesson_id), "completed": True,
        "trial_revision": (
            str(completion.trial_revision_id)
            if completion.trial_revision_id else None
        ),
        "client_completed_at": completion.client_completed_at.isoformat(),
        "accepted_at": completion.accepted_at.isoformat(),
        "revision": completion.server_revision,
    }


def complete(
    user: User, payload: dict, occurred_at: str, revision: int,
) -> tuple[dict | None, bool, str | None]:
    data = CompletionPayload(data=payload)
    date = serializers.DateTimeField()
    try:
        data.is_valid(raise_exception=True)
        completed_at = date.run_validation(occurred_at)
    except serializers.ValidationError:
        return None, False, "invalid_completion"
    values = data.validated_data
    published = PublishedRevision.objects.filter(
        pk=values["content_revision_id"], product_id=values["product_id"],
    ).first()
    lesson_id = str(values["lesson_id"])
    if published is None or not contains(published.full_manifest, lesson_id):
        return None, False, "lesson_not_in_published_revision"
    trial = published if contains(published.trial_manifest, lesson_id) else None
    completions = LessonCompletion.objects.select_related("lesson")
    completion, created = completions.get_or_create(
        user=user, lesson_id=values["lesson_id"],
        defaults={"first_revision": published, "trial_revision": trial,
                  "client_completed_at": min(completed_at, timezone.now()),
                  "server_revision": revision},
    )
    changed = created
    if not created and trial is not None and completion.trial_revision_id is None:
        completion.trial_revision = trial
        completion.server_revision = revision
        completion.save(update_fields=["trial_revision", "server_revision"])
        changed = True
    return completion_state(completion), changed, None
