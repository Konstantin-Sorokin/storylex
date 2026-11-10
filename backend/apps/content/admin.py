from django.contrib import admin
from django.core.exceptions import PermissionDenied
from django.http import Http404
from django.urls import path

from .admin_tools import ImmutableAdmin, WorkflowAdmin, artifact_response
from .models import (Author, BookSeries, CatalogHead, CatalogRevision, ContentDraft,
                     LearningItem, Lesson, PackArtifact, Product, PublishedRevision, Section, Show)
from .services import delete_editorial, save_editorial, save_product, save_section


class EditorialAdmin(WorkflowAdmin):
    def save_model(self, request, obj, form, change):
        save_editorial(obj)

    def delete_model(self, request, obj):
        delete_editorial(type(obj).objects.filter(pk=obj.pk))

    def delete_queryset(self, request, queryset):
        delete_editorial(queryset)


@admin.register(Author)
class AuthorAdmin(EditorialAdmin):
    metadata_publication = True
    list_display = ("name_en", "name_ru", "id")
    search_fields = ("name_en", "name_ru")
    readonly_fields = ("id",)


class TitledAdmin(EditorialAdmin):
    metadata_publication = True
    list_display = ("title_en", "title_ru", "id")
    search_fields = ("title_en", "title_ru")
    readonly_fields = ("id",)


@admin.register(BookSeries)
class BookSeriesAdmin(TitledAdmin):
    list_display = ("title_en", "title_ru", "order", "id")


@admin.register(Show)
class ShowAdmin(TitledAdmin):
    list_display = ("title_en", "title_ru", "release_year", "id")


@admin.register(Product)
class ProductAdmin(TitledAdmin):
    import_enabled = True
    product_publication = True
    list_display = ("title_en", "kind", "author", "year", "access_mode", "id")
    list_filter = ("kind", "access_mode", "trial_enabled")
    search_fields = ("title_en", "title_ru", "author__name_ru", "author__name_en")
    list_select_related = ("author", "show", "book_series")
    autocomplete_fields = ("author", "book_series", "show")
    readonly_fields = ("id", "current_revision", "first_published_at")
    fieldsets = (
        ("Тип и структура", {"fields": (
            "id", "kind", "author", "book_series", "show", "sequence",
        )}),
        ("Метаданные (черновик)", {"fields": (
            "title_ru", "title_en", "description_ru", "description_en",
            "year", "cefr_min", "cefr_max",
        )}),
        ("Доступ (черновик, не публикация)", {"fields": (
            "access_mode", "price_minor", "trial_enabled", "availability",
        )}),
        ("Опубликовано", {"fields": ("current_revision", "first_published_at")}),
    )

    def save_model(self, request, obj, form, change):
        save_product(obj)


@admin.register(Section)
class SectionAdmin(EditorialAdmin):
    import_enabled = True
    list_display = ("title_en", "product", "kind", "position", "id")
    list_filter = ("kind", "product")
    search_fields = ("title_en", "title_ru", "product__title_en", "product__title_ru")
    list_select_related = ("product",)
    autocomplete_fields = ("product",)
    readonly_fields = ("id", "retired_at")

    def save_model(self, request, obj, form, change):
        save_section(obj)


@admin.register(ContentDraft)
class ContentDraftAdmin(admin.ModelAdmin):
    list_display = ("id", "product", "section", "validation_version", "updated_at")
    list_select_related = ("product", "section")
    readonly_fields = (
        "id", "product", "section", "source", "source_hash",
        "validation_version", "updated_at",
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(PublishedRevision)
class PublishedRevisionAdmin(ImmutableAdmin):
    list_display = ("id", "product", "number", "publication_kind", "published_at")
    list_select_related = ("product",)

    def get_urls(self):
        return [path("<uuid:object_id>/download/<str:scope>/", self.admin_site.admin_view(self.download_view),
                     name="content_publishedrevision_download")] + super().get_urls()

    def download_view(self, request, object_id, scope):
        obj = self.get_object(request, str(object_id))
        if obj is None or scope not in obj.manifest_files:
            raise Http404
        if not self.has_view_permission(request, obj):
            raise PermissionDenied
        return artifact_response(obj.manifest_files[scope], f"{obj.pk}-{scope}.json")


@admin.register(PackArtifact)
class PackArtifactAdmin(ImmutableAdmin):
    list_display = ("id", "revision", "scope", "section", "sha256")
    list_select_related = ("revision", "section")

    def get_urls(self):
        return [path("<uuid:object_id>/download/", self.admin_site.admin_view(self.download_view),
                     name="content_packartifact_download")] + super().get_urls()

    def download_view(self, request, object_id):
        obj = self.get_object(request, str(object_id))
        if obj is None:
            raise Http404
        if not self.has_view_permission(request, obj):
            raise PermissionDenied
        return artifact_response({"object_key": obj.object_key, "sha256": obj.sha256,
                                  "byte_size": obj.byte_size}, f"{obj.pk}.json")


@admin.register(CatalogRevision)
class CatalogRevisionAdmin(ImmutableAdmin):
    list_display = ("id", "sha256", "byte_size", "activated_at")

    def get_urls(self):
        return [path("<uuid:object_id>/download/", self.admin_site.admin_view(self.download_view),
                     name="content_catalogrevision_download")] + super().get_urls()

    def download_view(self, request, object_id):
        obj = self.get_object(request, str(object_id))
        if obj is None:
            raise Http404
        if not self.has_view_permission(request, obj):
            raise PermissionDenied
        return artifact_response({"object_key": obj.object_key, "sha256": obj.sha256,
                                  "byte_size": obj.byte_size}, f"catalog-{obj.pk}.json")


@admin.register(CatalogHead)
class CatalogHeadAdmin(ImmutableAdmin):
    list_display = ("id", "current_revision", "source_revision")


@admin.register(Lesson)
class LessonAdmin(ImmutableAdmin):
    list_display = ("id", "product", "section", "position")
    list_select_related = ("product", "section")


@admin.register(LearningItem)
class LearningItemAdmin(ImmutableAdmin):
    list_display = ("id", "product", "lesson", "position", "sense_key", "en", "ru")
    list_select_related = ("product", "lesson")
