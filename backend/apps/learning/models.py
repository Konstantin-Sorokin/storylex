from django.conf import settings
from django.db import models
from django.utils import timezone


class LessonCompletion(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    lesson = models.ForeignKey("content.Lesson", on_delete=models.PROTECT)
    first_revision = models.ForeignKey("content.PublishedRevision", on_delete=models.PROTECT, related_name="first_completions")
    trial_revision = models.ForeignKey("content.PublishedRevision", on_delete=models.PROTECT, null=True, related_name="trial_completions")
    client_completed_at = models.DateTimeField()
    accepted_at = models.DateTimeField(default=timezone.now)
    server_revision = models.PositiveBigIntegerField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=("user", "lesson"), name="completion_user_lesson_unique")]
