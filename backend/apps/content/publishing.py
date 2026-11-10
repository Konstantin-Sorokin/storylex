"""Capture -> immutable files -> conditional atomic activation. No user API."""

import copy
from dataclasses import dataclass
from uuid import UUID, uuid4

from django.db import transaction
from django.db.models import F, Model
from django.utils import timezone

from .importing import validate_complete_product
from .models import (
    Author, BookSeries, CatalogHead, CatalogRevision, ContentDraft, LearningItem, Lesson,
    PackArtifact, Product, PublishedRevision, Show,
)
from .services import locked_head
from .storage import LocalContentStorage
from .validation import ContentError, canonical_bytes, digest


@dataclass
class PublicationInput:
    product_id: UUID | None
    source_revision: int
    head_id: UUID | None
    current_revision_id: UUID | None
    documents: list
    identities: dict
    entry: dict
    related: dict
    catalog: dict
    previous: PublishedRevision | None
    content_hash: str
    mode: str = "product"
    metadata_target: tuple | None = None

    def approval(self) -> dict:
        return {"source_revision": self.source_revision,
                "head_id": str(self.head_id) if self.head_id else None,
                "input_hash": digest([self.entry, self.related, self.content_hash])}

    def review_diff(self) -> dict:
        previous_entry = next((entry for entry in self.catalog["products"]
                               if entry["id"] == str(self.product_id)), {})
        metadata = {key: {"before": previous_entry.get(key), "after": value}
                    for key, value in self.entry.items() if previous_entry.get(key) != value}
        previous_documents = {source["section_id"]: digest(source)
                              for source in self.previous.source_documents} if self.previous else {}
        documents = [{"section_id": source["section_id"],
                      "before": previous_documents.get(source["section_id"]), "after": digest(source)}
                     for source in self.documents
                     if previous_documents.get(source["section_id"]) != digest(source)]
        return {"metadata": metadata, "documents": documents}


@dataclass
class PreparedPublication:
    captured: PublicationInput
    revision: PublishedRevision | None
    artifacts: list
    catalog: CatalogRevision | None


def _localized(obj, prefix="title") -> dict:
    return {"ru": getattr(obj, prefix + "_ru"), "en": getattr(obj, prefix + "_en")}


def _author(author) -> dict:
    return {"id": str(author.pk), "name_ru": author.name_ru, "name_en": author.name_en}


def _parent(parent) -> dict:
    data = {"id": str(parent.pk), "title": _localized(parent),
            "description": _localized(parent, "description"), "cover": None}
    if isinstance(parent, BookSeries):
        data["order"] = parent.order
    else:
        data["release_year"] = parent.release_year
    return data


def _base_catalog(head) -> dict:
    if head.current_revision_id:
        return copy.deepcopy(head.current_revision.snapshot)
    return {"schema_version": 1, "products": [], "book_series": [], "shows": []}


def _entry(product) -> dict:
    return {
        "id": str(product.pk), "kind": product.kind,
        "title": _localized(product), "description": _localized(product, "description"),
        "year": product.year, "author": _author(product.author) if product.author_id else None,
        "book_series_id": str(product.book_series_id) if product.book_series_id else None,
        "show_id": str(product.show_id) if product.show_id else None,
        "sequence": product.sequence, "cefr_min": product.cefr_min, "cefr_max": product.cefr_max,
        "access_mode": product.access_mode, "price_minor": product.price_minor,
        "currency": product.currency, "trial_enabled": product.trial_enabled,
        "availability": product.availability, "cover": None,
        "sections": [{"id": str(s.pk), "kind": s.kind, "position": s.position,
                      "title": _localized(s)} for s in product.sections.filter(retired_at=None).order_by("position")],
    }


def _related(product) -> dict:
    return {"author": _author(product.author) if product.author_id else None,
            "book_series": _parent(product.book_series) if product.book_series_id else None,
            "show": _parent(product.show) if product.show_id else None}


@transaction.atomic
def capture_product(product_id: UUID | str) -> PublicationInput:
    head = locked_head()
    product = Product.objects.select_for_update(of=("self",)).select_related(
        "author", "book_series", "show", "current_revision",
    ).get(pk=product_id)
    product.full_clean()
    documents, identities = validate_complete_product(product)
    if product.trial_enabled:
        if product.kind == "season" and product.sequence != 1:
            raise ContentError("trial_season", "Проба разрешена только для первого сезона.")
        if product.kind == "movie" and len(documents[0]["lessons"]) < 3:
            raise ContentError("trial_short_movie",
                               "Проба короткого фильма требует отдельного решения; отключите пробу.")
    return PublicationInput(
        product.pk, head.source_revision, head.current_revision_id,
        product.current_revision_id, documents, identities, _entry(product), _related(product),
        _base_catalog(head), product.current_revision,
        digest([documents, product.trial_enabled]),
    )


@transaction.atomic
def capture_metadata(model: type[Model], object_id: UUID | str) -> PublicationInput:
    head = locked_head()
    obj = model.objects.get(pk=object_id)
    obj.full_clean()
    catalog = _base_catalog(head)
    if model is Product:
        if not obj.current_revision_id:
            raise ContentError("not_published", "Сначала опубликуйте полный материал.")
        entry, related = _entry(obj), _related(obj)
        current = next(p for p in catalog["products"] if p["id"] == str(obj.pk))
        # A metadata-only command cannot change the composition/trial membership.
        for key in ("kind", "book_series_id", "show_id", "sequence", "trial_enabled", "sections"):
            if entry[key] != current[key]:
                raise ContentError("content_publication_required",
                                   "Изменён состав/проба: нужна публикация всего Product.")
        previous = obj.current_revision
    else:
        key = {Author: "author", BookSeries: "book_series", Show: "show"}[model]
        related = {key: _author(obj) if model is Author else _parent(obj)}
        entry, previous = {}, None
    return PublicationInput(
        obj.pk if model is Product else None, head.source_revision, head.current_revision_id,
        previous.pk if previous else None, [], {}, entry, related, catalog, previous,
        previous.content_hash if previous else "", mode="metadata",
        metadata_target=(model._meta.label_lower, str(obj.pk)),
    )


def _replace(rows: list, entry: dict) -> list:
    return sorted([row for row in rows if row["id"] != entry["id"]] + [entry], key=lambda row: row["id"])


def _catalog_candidate(captured, revision) -> dict:
    catalog = copy.deepcopy(captured.catalog)
    catalog.pop("catalog_revision", None)
    if captured.product_id is not None:
        entry = copy.deepcopy(captured.entry)
        entry.update(revision_id=str(revision.pk), revision_number=revision.number,
                     counts=revision.full_manifest["counts"])
        catalog["products"] = _replace(catalog["products"], entry)
    author = captured.related.get("author")
    if author:
        for entry in catalog["products"]:
            if entry["author"] and entry["author"]["id"] == author["id"]:
                entry["author"] = copy.deepcopy(author)
    for singular, plural, fk in (("book_series", "book_series", "book_series_id"), ("show", "shows", "show_id")):
        parent = captured.related.get(singular)
        parents = {row["id"]: row for row in catalog[plural]}
        if parent:
            parents[parent["id"]] = copy.deepcopy(parent)
        catalog[plural] = []
        for parent_id, data in sorted(parents.items()):
            children = [p for p in catalog["products"] if p[fk] == parent_id]
            if not children:
                continue
            children.sort(key=lambda child: child["sequence"])
            data["product_ids"] = [p["id"] for p in children]
            data["cover"] = children[0]["cover"]
            if singular == "book_series":
                data["authors"] = list({p["author"]["id"]: p["author"] for p in children}.values())
                data["year"] = min(p["year"] for p in children)
            catalog[plural].append(data)
    return catalog


def _manifest(product_id, revision_id, number, scope, documents) -> dict:
    return {"schema_version": 1, "lesson_engine_version": 1, "product_id": str(product_id),
            "revision_id": str(revision_id), "revision_number": number, "scope": scope,
            "counts": {"sections": sum(doc["section_id"] is not None for doc in documents),
                       "lessons": sum(len(doc["lesson_ids"]) for doc in documents),
                       "items": sum(len(doc["lesson_ids"]) * 5 for doc in documents)},
            "documents": documents}


def prepare_publication(captured: PublicationInput, storage: LocalContentStorage) -> PreparedPublication:
    previous = captured.previous
    new_revision = captured.mode == "product" and (previous is None or previous.content_hash != captured.content_hash)
    artifacts = []
    revision = previous
    if new_revision:
        revision_id = uuid4()
        number = previous.number + 1 if previous else 1
        manifests = {}
        files = {}
        for scope in ("full", "trial"):
            if scope == "trial" and not captured.entry["trial_enabled"]:
                manifests[scope] = None
                continue
            sources = copy.deepcopy(captured.documents)
            if scope == "trial":
                sources = sources[:1]
                if captured.entry["kind"] == "movie":
                    sources[0]["lessons"] = sources[0]["lessons"][:3]
            descriptors = []
            for source in sources:
                payload = canonical_bytes(source)
                space = "private" if scope == "full" else "public"
                descriptor = storage.put(f"{space}/packs/{digest(source)}.json", payload)
                artifact_id = uuid4()
                artifacts.append(PackArtifact(
                    id=artifact_id, revision_id=revision_id, scope=scope,
                    section_id=source["section_id"], **descriptor,
                ))
                descriptors.append({"artifact_id": str(artifact_id), "section_id": source["section_id"],
                                    "sha256": descriptor["sha256"], "byte_size": descriptor["byte_size"],
                                    "lesson_ids": [lesson["id"] for lesson in source["lessons"]]})
            manifests[scope] = _manifest(captured.product_id, revision_id, number, scope, descriptors)
            files[scope] = storage.put(f"{space}/manifests/{revision_id}-{scope}.json",
                                       canonical_bytes(manifests[scope]))
        added_lessons = {key for key, value in captured.identities.items() if value[0] == "lesson"}
        if previous:
            added_lessons -= previous.identity_map.keys()
        kind = "initial" if previous is None else ("extension" if added_lessons else "correction")
        revision = PublishedRevision(
            id=revision_id, product_id=captured.product_id, number=number,
            full_manifest=manifests["full"], trial_manifest=manifests["trial"],
            manifest_files=files, source_documents=captured.documents,
            identity_map=captured.identities, content_hash=captured.content_hash,
            publication_kind=kind,
        )
    if revision is not None and not new_revision:
        for descriptor in revision.manifest_files.values():
            storage.verify(descriptor)
        for artifact in revision.artifacts.all():
            storage.verify(
                {"object_key": artifact.object_key, "sha256": artifact.sha256, "byte_size": artifact.byte_size})
    candidate = _catalog_candidate(captured, revision)
    old = copy.deepcopy(captured.catalog)
    old.pop("catalog_revision", None)
    if candidate == old:
        return PreparedPublication(captured, None, [], None)
    catalog_id = uuid4()
    candidate["catalog_revision"] = str(catalog_id)
    descriptor = storage.put(f"public/catalog/{catalog_id}.json", canonical_bytes(candidate))
    catalog = CatalogRevision(id=catalog_id, snapshot=candidate, **descriptor)
    return PreparedPublication(captured, revision if new_revision else None, artifacts, catalog)


def _update_registry(captured: PublicationInput) -> None:
    # Partial unique constraints on lesson positions cannot be deferred.
    Lesson.objects.filter(product_id=captured.product_id).update(position=F("position") + 1000000000)
    for source in captured.documents:
        for lesson in source["lessons"]:
            Lesson.objects.update_or_create(id=lesson["id"], defaults={
                "product_id": captured.product_id, "section_id": source["section_id"], "position": lesson["position"],
            })
            for position, item in enumerate(lesson["items"], start=1):
                LearningItem.objects.update_or_create(id=item["id"], defaults={
                    "product_id": captured.product_id, "lesson_id": lesson["id"], "position": position,
                    "sense_key": item["sense_key"], "en": item["en"], "ru": item["ru"],
                })


@transaction.atomic
def activate_publication(prepared: PreparedPublication) -> CatalogRevision | None:
    captured = prepared.captured
    head = locked_head()
    if head.source_revision != captured.source_revision or head.current_revision_id != captured.head_id:
        raise ContentError("publication_conflict", "Каталог или черновики изменились. Проверьте и подтвердите заново.")
    product = None
    if captured.product_id is not None:
        product = Product.objects.select_for_update().get(pk=captured.product_id)
        if product.current_revision_id != captured.current_revision_id:
            raise ContentError("publication_conflict", "Активная ревизия Product изменилась.")
        if captured.mode == "product":
            hashes = {str(row.section_id) if row.section_id else None: row.source_hash
                      for row in ContentDraft.objects.filter(product=product, validation_version=1)}
            if hashes != {source["section_id"]: digest(source) for source in captured.documents}:
                raise ContentError("publication_conflict", "Hashes черновиков изменились.")
    if prepared.catalog is None:
        return head.current_revision
    now = timezone.now()
    if prepared.revision is not None:
        revision = prepared.revision
        revision.published_at = now
        revision.save(force_insert=True)
        for artifact in prepared.artifacts:
            artifact.save(force_insert=True)
        _update_registry(captured)
        product.current_revision = revision
        if product.first_published_at is None:
            product.first_published_at = now
        product.save(update_fields=("current_revision", "first_published_at"))
        if revision.publication_kind in ("initial", "extension"):
            from apps.feedback.models import PublicationEvent
            old_ids = captured.previous.identity_map.keys() if captured.previous else set()
            added_ids = [key for key, value in captured.identities.items() if
                         value[0] == "lesson" and key not in old_ids]
            PublicationEvent.objects.create(
                revision=revision, kind=revision.publication_kind,
                added_product_ids=[str(product.pk)] if captured.previous is None else [],
                added_lesson_ids=added_ids, occurred_at=now,
            )
    prepared.catalog.activated_at = now
    prepared.catalog.save(force_insert=True)
    head.current_revision = prepared.catalog
    head.save(update_fields=("current_revision",))
    return prepared.catalog


def publish(captured: PublicationInput, *, expected: dict, confirmed: bool,
            storage: LocalContentStorage | None = None) -> CatalogRevision | None:
    if not confirmed:
        raise ContentError("confirmation_required", "Подтвердите полноту состава и редакционную проверку.")
    if captured.approval() != expected:
        raise ContentError("publication_conflict", "Входные данные изменились после просмотра подтверждения.")
    prepared = prepare_publication(captured, storage or LocalContentStorage())
    return activate_publication(prepared)


def catalog_descriptor() -> dict | None:
    head = CatalogHead.objects.select_related("current_revision").filter(pk=1).first()
    if head is None or head.current_revision_id is None:
        return None
    revision = head.current_revision
    return {"catalog_revision": str(revision.pk), "schema_version": revision.schema_version,
            "object_key": revision.object_key, "sha256": revision.sha256, "byte_size": revision.byte_size}
