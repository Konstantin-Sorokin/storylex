from django.contrib import admin
from .models import LessonCompletion


@admin.register(LessonCompletion)
class CompletionAdmin(admin.ModelAdmin):
    list_display = ("user", "lesson", "client_completed_at", "accepted_at", "server_revision")
    list_select_related = ("user", "lesson")
    readonly_fields = tuple(field.name for field in LessonCompletion._meta.fields)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
