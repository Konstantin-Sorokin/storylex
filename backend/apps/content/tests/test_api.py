import json
from pathlib import Path
from uuid import uuid4

from django.conf import settings
from django.test import TestCase, override_settings
from django.urls import reverse
from jsonschema import Draft202012Validator, FormatChecker

from apps.content.models import CatalogHead, Product, PublishedRevision
from apps.content.publishing import capture_metadata, publish
from apps.content.services import save_product
from .helpers import PublicationFixture, catalog_book


class DeliveryTests(PublicationFixture, TestCase):
    def setUp(self):
        super().setUp()
        override = override_settings(CONTENT_STORAGE_ROOT=Path(self.directory.name))
        override.enable()
        self.addCleanup(override.disable)
        self.product.trial_enabled = True
        save_product(self.product)

    def manifest_url(self, catalog=None, scope="trial"):
        url = reverse("content-api:manifest", args=(self.product.pk,)) + f"?scope={scope}"
        return url + (f"&catalog_revision={catalog.pk}" if catalog else "")

    def test_no_ready_catalog_returns_503_and_drafts_are_not_delivered(self):
        response = self.client.get("/api/v1/catalog/head")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "catalog_not_ready")
        self.assertEqual(self.client.get(self.manifest_url()).status_code, 503)
        self.assertFalse(PublishedRevision.objects.exists())

    def test_actual_published_bytes_head_hash_etag_and_shared_schemas(self):
        catalog = self.publish_product()
        head = self.client.get("/api/v1/catalog/head")
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head["Cache-Control"], "no-cache")
        self.assertNotIn("object_key", head.json())
        self.assertEqual(head.json()["catalog_revision"], str(catalog.pk))
        self.assertEqual(self.client.get("/api/v1/catalog/head", HTTP_IF_NONE_MATCH=head["ETag"]).status_code, 304)
        snapshot = self.client.get(head.json()["url"])
        self.assertEqual(snapshot.content, self.storage.read(catalog.object_key))
        self.assertEqual(snapshot.json(), catalog.snapshot)
        self.assertNotIn("exercises", snapshot.content.decode())
        manifest = self.client.get(self.manifest_url(catalog))
        self.assertEqual(manifest.status_code, 200)
        self.assertEqual(manifest["X-Catalog-Revision"], str(catalog.pk))
        self.assertEqual(self.client.get(self.manifest_url(catalog), HTTP_IF_NONE_MATCH=manifest["ETag"]).status_code, 304)
        for name, data in (("catalog", snapshot.json()), ("manifest", manifest.json())):
            schema = json.loads((settings.BASE_DIR.parent / f"contracts/content/v1/{name}.schema.json").read_text())
            Draft202012Validator(schema, format_checker=FormatChecker()).validate(data)

    def test_trial_download_round_trip_matches_imported_source(self):
        self.publish_product()
        manifest = self.client.get(self.manifest_url()).json()
        identifier = manifest["documents"][0]["artifact_id"]
        response = self.client.post("/api/v1/content/downloads", {"artifact_ids": [identifier]}, content_type="application/json")
        self.assertEqual(response.status_code, 200)
        download = response.json()["downloads"][0]
        self.assertIsNone(download["expires_at"])
        self.assertNotIn("object_key", download)
        artifact = self.client.get(download["url"])
        self.assertEqual(artifact.status_code, 200)
        self.assertEqual(artifact.json(), self.source)
        self.assertEqual(len(artifact.content), download["byte_size"])
        self.assertEqual(artifact["ETag"], '"' + download["sha256"] + '"')

    def test_full_artifact_manifest_and_mixed_download_batch_are_closed(self):
        self.publish_product()
        revision = PublishedRevision.objects.get()
        full = revision.artifacts.get(scope="full")
        trial = revision.artifacts.get(scope="trial")
        self.assertEqual(self.client.get(self.manifest_url(scope="full")).status_code, 403)
        self.assertEqual(self.client.get(reverse("content-api:artifact", args=(full.pk,))).status_code, 404)
        response = self.client.post("/api/v1/content/downloads", {"artifact_ids": [str(trial.pk), str(full.pk)]}, content_type="application/json")
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("downloads", response.json())

    def test_bad_inputs_unknown_and_unpublished_ids(self):
        self.publish_product()
        for payload in ({"artifact_ids": []}, {"artifact_ids": ["invalid"]}, {"object_key": "private/packs/test.json"}, {"artifact_ids": [str(uuid4())], "object_key": "public/anything"}):
            with self.subTest(payload=payload):
                self.assertEqual(self.client.post("/api/v1/content/downloads", payload, content_type="application/json").status_code, 400)
        self.assertEqual(self.client.get(self.manifest_url() + "&catalog_revision=bad").status_code, 400)
        self.assertEqual(self.client.get(self.manifest_url() + f"&catalog_revision={uuid4()}").status_code, 404)
        self.assertEqual(self.client.get(self.manifest_url(scope="unknown")).status_code, 400)
        unpublished, _ = catalog_book()
        self.assertEqual(self.client.get(reverse("content-api:manifest", args=(unpublished.pk,)) + "?scope=trial").status_code, 404)

    def test_batch_deduplicates_ids_and_has_bounded_queries(self):
        self.publish_product()
        artifact = PublishedRevision.objects.get().artifacts.get(scope="trial")
        with self.assertNumQueries(3):
            response = self.client.post("/api/v1/content/downloads", {"artifact_ids": [str(artifact.pk)] * 100}, content_type="application/json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["downloads"]), 1)

    def test_draft_edit_cannot_leak_and_old_catalog_pins_old_content(self):
        first = self.publish_product()
        self.product.refresh_from_db()
        self.import_source(self.corrected())
        self.product.title_ru = "Неопубликованный заголовок"
        save_product(self.product)
        old_manifest = self.client.get(self.manifest_url(first)).json()
        old_url = self.client.get("/api/v1/catalog/head").json()["url"]
        self.assertNotEqual(self.client.get(old_url).json()["products"][0]["title"]["ru"], self.product.title_ru)
        second = self.publish_product()
        self.assertNotEqual(first.pk, second.pk)
        self.assertEqual(self.client.get(self.manifest_url(first)).json(), old_manifest)
        self.assertNotEqual(self.client.get(self.manifest_url()).json()["revision_id"], old_manifest["revision_id"])

    def test_editorial_trial_flag_not_live_until_publication_and_disabled_trial_stays_closed(self):
        first = self.publish_product()
        self.product.refresh_from_db()
        old_artifact = PublishedRevision.objects.get().artifacts.get(scope="trial")
        self.product.trial_enabled = False
        save_product(self.product)
        self.assertEqual(self.client.get(self.manifest_url(first)).status_code, 200)
        self.publish_product()
        self.assertEqual(self.client.get(self.manifest_url(first)).status_code, 404)
        self.assertEqual(self.client.get(reverse("content-api:artifact", args=(old_artifact.pk,))).status_code, 404)

    def test_immediate_availability_check_even_with_matching_etag_and_old_snapshot(self):
        catalog = self.publish_product()
        response = self.client.get(self.manifest_url(catalog))
        self.product.availability = "blocked"
        save_product(self.product)
        self.assertEqual(self.client.get(self.manifest_url(catalog), HTTP_IF_NONE_MATCH=response["ETag"]).status_code, 404)

    def test_storage_failure_returns_503_without_descriptor_or_replacing_head(self):
        catalog = self.publish_product()
        (self.storage.root / catalog.object_key).write_bytes(b"broken")
        self.assertEqual(self.client.get("/api/v1/catalog/head").status_code, 503)
        self.assertEqual(CatalogHead.objects.get().current_revision_id, catalog.pk)

    def test_unactivated_prepared_file_has_no_public_route(self):
        key = f"public/catalog/{uuid4()}.json"
        self.storage.put(key, b'{}')
        self.assertEqual(self.client.get("/" + key).status_code, 404)

    def test_metadata_revision_preserves_manifest_and_repeated_reads_do_not_write(self):
        first = self.publish_product()
        self.product.refresh_from_db()
        revision_id = self.product.current_revision_id
        self.product.title_ru = "Новый заголовок"
        save_product(self.product)
        captured = capture_metadata(Product, self.product.pk)
        publish(captured, expected=captured.approval(), confirmed=True, storage=self.storage)
        for _ in range(2):
            self.assertEqual(self.client.get(self.manifest_url()).json()["revision_id"], str(revision_id))
            self.assertEqual(self.client.get(self.manifest_url(first)).json()["revision_id"], str(revision_id))
        self.assertEqual(PublishedRevision.objects.count(), 1)
