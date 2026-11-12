import tempfile
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings
from django.urls import reverse

from apps.content.models import CatalogHead, ContentDraft, PackArtifact, PublishedRevision
from apps.content.publishing import capture_product, publish
from apps.content.storage import LocalContentStorage
from apps.content.validation import ContentError, canonical_bytes
from .helpers import PublicationFixture


class AdminWorkflowTests(PublicationFixture, TestCase):
    def setUp(self):
        super().setUp()
        self.override = override_settings(CONTENT_STORAGE_ROOT=Path(self.directory.name))
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.owner = get_user_model().objects.create_superuser("owner", password="test-only-password")
        self.client.force_login(self.owner)

    def import_url(self):
        return reverse("admin:content_section_import", args=(self.section.pk,))

    def publish_url(self):
        return reverse("admin:content_product_publish", args=(self.product.pk,))

    def test_admin_upload_confirmation_publish_and_download(self):
        response = self.client.post(self.import_url(), {
            "document": SimpleUploadedFile("chapter.json", canonical_bytes(self.corrected()),
                                           content_type="application/json"),
        })
        self.assertEqual(response.status_code, 302)
        self.assertFalse(PublishedRevision.objects.exists())
        page = self.client.get(self.publish_url())
        self.assertEqual(page.status_code, 200)
        token = page.context["form"].initial["approval_token"]
        response = self.client.post(self.publish_url(), {"approval_token": token, "confirm_ready": "on"})
        self.assertEqual(response.status_code, 302)
        revision = PublishedRevision.objects.get()
        for scope in revision.manifest_files:
            response = self.client.get(reverse("admin:content_publishedrevision_download", args=(revision.pk, scope)))
            self.assertEqual(response.status_code, 200)
            self.assertTrue(b"revision_id" in b"".join(response.streaming_content))
        for artifact in PackArtifact.objects.all():
            response = self.client.get(reverse("admin:content_packartifact_download", args=(artifact.pk,)))
            self.assertEqual(response.status_code, 200)
            self.assertTrue(b"".join(response.streaming_content))
        for model, obj in (("publishedrevision", revision), ("packartifact", PackArtifact.objects.first()),
                           ("catalogrevision", CatalogHead.objects.get().current_revision)):
            page = self.client.get(reverse(f"admin:content_{model}_change", args=(obj.pk,)))
            self.assertEqual(page.status_code, 200)
            self.assertContains(page, "/download/")
        self.assertEqual(self.client.get(
            reverse("admin:content_contentdraft_change", args=(ContentDraft.objects.get().pk,))).status_code, 200)

    def test_invalid_upload_keeps_existing_draft_and_reports_json_path(self):
        previous = ContentDraft.objects.get().source_hash
        response = self.client.post(self.import_url(), {
            "document": SimpleUploadedFile("chapter.json", b'{"schema_version":2}'),
        })
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "schema_invalid")
        self.assertEqual(ContentDraft.objects.get().source_hash, previous)

    def test_confirmation_checkbox_and_signed_token_required(self):
        page = self.client.get(self.publish_url())
        token = page.context["form"].initial["approval_token"]
        response = self.client.post(self.publish_url(), {"approval_token": token})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(PublishedRevision.objects.exists())
        response = self.client.post(self.publish_url(), {"approval_token": "forged", "confirm_ready": "on"})
        self.assertContains(response, "approval_invalid")
        self.assertFalse(PublishedRevision.objects.exists())

    def test_stale_confirmation_and_lost_response_retry_do_not_republish(self):
        token = self.client.get(self.publish_url()).context["form"].initial["approval_token"]
        self.import_source(self.corrected())
        response = self.client.post(self.publish_url(), {"approval_token": token, "confirm_ready": "on"})
        self.assertContains(response, "publication_conflict")
        fresh = self.client.get(self.publish_url()).context["form"].initial["approval_token"]
        self.client.post(self.publish_url(), {"approval_token": fresh, "confirm_ready": "on"})
        response = self.client.post(self.publish_url(), {"approval_token": fresh, "confirm_ready": "on"})
        self.assertContains(response, "publication_conflict")
        self.assertEqual(PublishedRevision.objects.count(), 1)

    def test_incomplete_product_get_shows_error_instead_of_server_failure(self):
        from apps.content.models import Section
        Section.objects.create(product=self.product, kind="chapter", position=2, title_ru="Вторая", title_en="Second")
        response = self.client.get(self.publish_url())
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "incomplete_product")
        self.assertContains(self.client.post(self.publish_url(), {}), "incomplete_product")

    def test_anonymous_and_staff_without_permissions_cannot_import_or_publish(self):
        self.client.logout()
        for url in (self.import_url(), self.publish_url()):
            self.assertEqual(self.client.get(url).status_code, 302)
        staff = get_user_model().objects.create_user("limited", is_staff=True)
        self.client.force_login(staff)
        for url in (self.import_url(), self.publish_url()):
            self.assertEqual(self.client.get(url).status_code, 403)
        self.client.force_login(self.owner)
        self.publish_product()
        artifact = PackArtifact.objects.get()
        url = reverse("admin:content_packartifact_download", args=(artifact.pk,))
        self.client.force_login(staff)
        self.assertEqual(self.client.get(url).status_code, 403)

    def test_csrf_protection_and_no_public_storage_routes(self):
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.owner)
        self.assertEqual(client.post(self.import_url(), {}).status_code, 403)
        self.publish_product()
        artifact = PackArtifact.objects.get()
        self.client.logout()
        self.assertEqual(self.client.get("/api/v1/catalog/head").status_code, 200)
        for url in ("/media/" + artifact.object_key,
                    "/content/" + artifact.object_key, "/" + artifact.object_key):
            self.assertEqual(self.client.get(url).status_code, 404)


class StorageTests(TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.storage = LocalContentStorage(directory.name)

    def test_immutable_write_repeat_and_corruption(self):
        descriptor = self.storage.put("private/packs/test.json", b'{"safe":true}')
        self.assertEqual(self.storage.put(descriptor["object_key"], b'{"safe":true}'), descriptor)
        with self.assertRaises(ContentError):
            self.storage.put(descriptor["object_key"], b"different")
        self.assertEqual(self.storage.verify(descriptor), b'{"safe":true}')
        (self.storage.root / descriptor["object_key"]).write_bytes(b"corrupted")
        with self.assertRaises(ContentError):
            self.storage.verify(descriptor)

    def test_keys_cannot_escape_root_or_namespaces(self):
        for key in ("../secret", "/etc/passwd", "public/../../outside", "random/file"):
            with self.subTest(key=key), self.assertRaises(ContentError):
                self.storage.put(key, b"content")
