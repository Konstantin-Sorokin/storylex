from django.contrib import admin

from .models import Author, BookSeries, ContentDraft, Product, Section, Show
from .services import save_product, save_section


@admin.register(Author)
class AuthorAdmin(admin.ModelAdmin):
    list_display = ("name_en", "name_ru", "id")
    search_fields = ("name_en", "name_ru")
    readonly_fields = ("id",)


class TitledAdmin(admin.ModelAdmin):
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
    list_display = ("title_en", "kind", "author", "year", "access_mode", "id")
    list_filter = ("kind", "access_mode", "trial_enabled")
    search_fields = ("title_en", "title_ru", "author__name_ru", "author__name_en")
    list_select_related = ("author", "show", "book_series")
    autocomplete_fields = ("author", "book_series", "show")
    fieldsets = (
        ("Тип и структура", {"fields": (
            "id", "kind", "author", "book_series", "show", "sequence",
        )}),
        ("Метаданные (черновик)", {"fields": (
            "title_ru", "title_en", "description_ru", "description_en",
            "year", "cefr_min", "cefr_max",
        )}),
        ("Доступ (черновик, не публикация)", {"fields": (
            "access_mode", "price_minor", "trial_enabled",
        )}),
    )

    def save_model(self, request, obj, form, change):
        save_product(obj)


@admin.register(Section)
class SectionAdmin(admin.ModelAdmin):
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
