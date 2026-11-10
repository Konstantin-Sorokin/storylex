"""Transaction boundaries for the catalog editors (no import/publication yet)."""

from django.db import transaction

from .models import Product, Section


@transaction.atomic
def save_product(product: Product) -> None:
    if not product._state.adding:
        Product.objects.select_for_update().get(pk=product.pk)
    product.full_clean()
    product.save()


@transaction.atomic
def save_section(section: Section) -> None:
    # The same lock serializes section edits with a product kind change.
    section.product = Product.objects.select_for_update().get(pk=section.product_id)
    section.full_clean()
    section.save()
