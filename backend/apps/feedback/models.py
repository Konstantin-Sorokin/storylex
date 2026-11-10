from django.db import models

from apps.content.models import ImmutableRecord, PublishedRevision


class PublicationEvent(ImmutableRecord):
    """Durable fact only. Notification processing belongs to a later stage."""

    revision = models.OneToOneField(PublishedRevision, on_delete=models.PROTECT)
    kind = models.CharField(max_length=9, choices=[("initial", "Initial"), ("extension", "Extension")])
    added_product_ids = models.JSONField(default=list)
    added_lesson_ids = models.JSONField(default=list)
    occurred_at = models.DateTimeField()
