from django.conf import settings
from django.db import models


class UserSyncState(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, primary_key=True)
    last_revision = models.PositiveBigIntegerField(default=0)


class UserChange(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    revision = models.PositiveBigIntegerField()
    entity_type = models.CharField(max_length=40)
    entity_id = models.UUIDField()
    state = models.JSONField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=("user", "revision"), name="change_user_revision_unique")]


class SyncInbox(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    operation_id = models.UUIDField()
    device = models.ForeignKey("accounts.Device", on_delete=models.CASCADE)
    sequence = models.PositiveBigIntegerField()
    type = models.CharField(max_length=80)
    payload_hash = models.CharField(max_length=64)
    result = models.JSONField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=("user", "operation_id"), name="inbox_user_operation_unique"),
            models.UniqueConstraint(fields=("device", "sequence"), name="inbox_device_sequence_unique"),
        ]
