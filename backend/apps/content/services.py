"""Editorial transactions: always lock CatalogHead before any Product."""

from django.db import models, transaction

from .models import CatalogHead, Product, Section
from .validation import ContentError


def locked_head() -> CatalogHead:
    CatalogHead.objects.get_or_create(pk=1)
    return CatalogHead.objects.select_for_update().get(pk=1)


def mark_changed(head: CatalogHead) -> None:
    head.source_revision += 1
    head.save(update_fields=("source_revision",))


@transaction.atomic
def save_editorial(instance: models.Model) -> None:
    head = locked_head()
    if not instance._state.adding:
        type(instance).objects.select_for_update().get(pk=instance.pk)
    instance.full_clean()
    instance.save()
    mark_changed(head)


@transaction.atomic
def save_product(product: Product) -> None:
    head = locked_head()
    if not product._state.adding:
        previous = Product.objects.select_for_update().get(pk=product.pk)
        if previous.current_revision_id and (
                previous.kind != product.kind or previous.book_series_id != product.book_series_id
                or previous.show_id != product.show_id
        ):
            raise ContentError("identity_move", "Нельзя менять тип/родителя опубликованного Product.")
    product.full_clean()
    product.save()
    mark_changed(head)


@transaction.atomic
def save_section(section: Section) -> None:
    head = locked_head()
    section.product = Product.objects.select_for_update().get(pk=section.product_id)
    section.full_clean()
    section.save()
    mark_changed(head)


@transaction.atomic
def delete_editorial(queryset: models.QuerySet) -> None:
    head = locked_head()
    queryset.delete()
    mark_changed(head)
