from django.contrib import admin

from apps.content.admin_tools import ImmutableAdmin
from .models import PublicationEvent


@admin.register(PublicationEvent)
class PublicationEventAdmin(ImmutableAdmin):
    list_display = ("id", "revision", "kind", "occurred_at")
    list_select_related = ("revision",)
