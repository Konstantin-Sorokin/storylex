"""Selectors for activated public snapshots and currently permitted trial files."""

from uuid import UUID

from .models import CatalogHead, CatalogRevision, PackArtifact, Product, PublishedRevision


class DeliveryError(Exception):
    def __init__(self, code: str, status: int):
        self.code = code
        self.status = status


def active_catalog() -> CatalogRevision:
    head = CatalogHead.objects.select_related("current_revision").filter(pk=1).first()
    if head is None or head.current_revision_id is None:
        raise DeliveryError("catalog_not_ready", 503)
    return head.current_revision


def selected_catalog(identifier: str | None) -> CatalogRevision:
    if identifier is None:
        return active_catalog()
    try:
        revision_id = UUID(identifier)
    except ValueError as exc:
        raise DeliveryError("invalid_catalog_revision", 400) from exc
    catalog = CatalogRevision.objects.filter(pk=revision_id).first()
    if catalog is None:
        raise DeliveryError("catalog_not_found", 404)
    return catalog


def entry_for(catalog: CatalogRevision, product_id: UUID) -> dict:
    entry = next((row for row in catalog.snapshot["products"] if row["id"] == str(product_id)), None)
    if entry is None:
        raise DeliveryError("product_not_found", 404)
    return entry


def check_trial(product_id: UUID) -> None:
    current = entry_for(active_catalog(), product_id)
    if not current["trial_enabled"] or current["availability"] != "available":
        raise DeliveryError("trial_unavailable", 404)
    if not Product.objects.filter(pk=product_id, availability="available").exists():
        raise DeliveryError("product_unavailable", 404)


def trial_revision(catalog: CatalogRevision, product_id: UUID) -> PublishedRevision:
    entry = entry_for(catalog, product_id)
    check_trial(product_id)
    revision = PublishedRevision.objects.filter(pk=entry["revision_id"], product_id=product_id).first()
    if not entry["trial_enabled"] or revision is None or revision.trial_manifest is None:
        raise DeliveryError("trial_unavailable", 404)
    return revision


def trial_artifacts(artifact_ids: list[UUID]) -> list[PackArtifact]:
    """Validate the entire batch with a bounded number of queries, including gates."""
    identifiers = list(dict.fromkeys(artifact_ids))
    artifacts = {row.pk: row for row in PackArtifact.objects.select_related("revision").filter(
        pk__in=identifiers, scope="trial",
    )}
    if len(artifacts) != len(identifiers):
        raise DeliveryError("artifact_not_found", 404)
    product_ids = {row.revision.product_id for row in artifacts.values()}
    current = {row["id"]: row for row in active_catalog().snapshot["products"]}
    available = set(Product.objects.filter(pk__in=product_ids, availability="available").values_list("pk", flat=True))
    for artifact in artifacts.values():
        product_id = artifact.revision.product_id
        entry = current.get(str(product_id))
        if product_id not in available or entry is None or not entry["trial_enabled"] or entry["availability"] != "available":
            raise DeliveryError("trial_unavailable", 404)
        manifest = artifact.revision.trial_manifest
        if manifest is None or not any(row["artifact_id"] == str(artifact.pk) for row in manifest["documents"]):
            raise DeliveryError("artifact_not_found", 404)
    return [artifacts[identifier] for identifier in identifiers]
