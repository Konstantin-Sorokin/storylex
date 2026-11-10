"""Whole-document draft replacement. Publication is a separate operation."""

from uuid import UUID

from django.db import transaction

from .models import (
    Author, BookSeries, ContentDraft, LearningItem, Lesson, Product,
    PublishedRevision, Section, Show,
)
from .services import locked_head, mark_changed
from .validation import ContentError, digest, identity_map, parse_source, validate_source


def validate_scope(source: dict, product: Product, section: Section | None) -> None:
    expected_scope = {"book": "chapter", "season": "episode", "movie": "movie"}[product.kind]
    if source["product_id"] != str(product.pk) or source["scope"] != expected_scope:
        raise ContentError("scope_mismatch", "Product/scope не совпадает с выбором в Admin.")
    if source["section_id"] != (str(section.pk) if section else None):
        raise ContentError("scope_mismatch", "section_id не совпадает с выбором в Admin.", "/section_id")
    if product.kind == "movie":
        if section is not None:
            raise ContentError("scope_mismatch", "У фильма нет секций.")
    elif section is None or section.product_id != product.pk or section.kind != expected_scope or section.retired_at:
        raise ContentError("scope_mismatch", "Нужна действующая секция этого Product.")


def validate_identities(product: Product, documents: list[dict]) -> dict:
    identities = identity_map(documents)
    ids = set(identities)
    # Catalog identities are references, never reusable question/lesson/item IDs.
    for model in (Product, Section, Author, BookSeries, Show):
        if model.objects.filter(pk__in=ids).exists():
            raise ContentError("foreign_id", "Учебный UUID уже занят сущностью каталога.")
    for revision in PublishedRevision.objects.only("product_id", "identity_map").iterator():
        previous = revision.identity_map
        for identifier in ids & previous.keys():
            if revision.product_id != product.pk or identities[identifier] != previous[identifier]:
                raise ContentError("identity_changed", "UUID принадлежит другой сущности/значению.")
    for draft in ContentDraft.objects.exclude(product=product).exclude(validation_version=None).iterator():
        if ids & identity_map([draft.source]).keys():
            raise ContentError("foreign_id", "UUID уже используется в чужом черновике.")
    for model in (Lesson, LearningItem):
        if model.objects.filter(pk__in=ids).exclude(product=product).exists():
            raise ContentError("foreign_id", "UUID уже зарегистрирован в другом Product.")
    if product.current_revision_id:
        old = product.current_revision.identity_map
        if not old.keys() <= identities.keys():
            raise ContentError("identity_removed", "Удаление/замена опубликованных UUID требует миграции.")
    return identities


def candidate_documents(product: Product, replacement: dict | None = None) -> list[dict]:
    documents = {}
    if product.current_revision_id:
        for source in product.current_revision.source_documents:
            documents[source["section_id"]] = source
    for draft in product.drafts.all():
        if draft.validation_version is not None:
            documents[str(draft.section_id) if draft.section_id else None] = draft.source
    if replacement is not None:
        documents[replacement["section_id"]] = replacement
    return list(documents.values())


@transaction.atomic
def _store_draft(source: dict, product_id, section_id) -> ContentDraft:
    head = locked_head()
    product = Product.objects.select_for_update(of=("self",)).select_related("current_revision").get(pk=product_id)
    section = Section.objects.get(pk=section_id) if section_id else None
    validate_scope(source, product, section)
    validate_identities(product, candidate_documents(product, source))
    source_hash = digest(source)
    draft = ContentDraft.objects.filter(product=product, section=section).first()
    if draft is not None and draft.source_hash == source_hash and draft.validation_version == 1:
        return draft
    if draft is None:
        draft = ContentDraft(product=product, section=section)
    draft.source = source
    draft.source_hash = source_hash
    draft.validation_version = 1
    draft.full_clean()
    draft.save()
    mark_changed(head)
    return draft


def import_document(data: bytes, *, product_id: UUID | str,
                    section_id: UUID | str | None = None) -> ContentDraft:
    source = parse_source(data)  # CPU work before acquiring any locks.
    return _store_draft(source, product_id, section_id)


def validate_complete_product(product: Product) -> tuple[list[dict], dict]:
    sections = list(product.sections.filter(retired_at=None).order_by("position"))
    if product.kind == "movie":
        if sections:
            raise ContentError("invalid_structure", "У фильма не должно быть секций.")
        units = [None]
    else:
        if not sections or [s.position for s in sections] != list(range(1, len(sections) + 1)):
            raise ContentError("incomplete_product", "Нужен полный состав секций 1…N.")
        units = sections
    drafts = {draft.section_id: draft for draft in product.drafts.all()}
    documents = []
    for section in units:
        draft = drafts.get(section.pk if section else None)
        if not draft or draft.validation_version != 1:
            raise ContentError("incomplete_product", "Для каждой секции нужен проверенный черновик.")
        source = validate_source(draft.source)
        validate_scope(source, product, section)
        if digest(source) != draft.source_hash:
            raise ContentError("draft_hash_mismatch", "Hash черновика не совпадает; повторите импорт.")
        documents.append(source)
    if set(drafts) != {section.pk if section else None for section in units}:
        raise ContentError("invalid_structure", "Черновики вне объявленного состава секций.")
    return documents, validate_identities(product, documents)
