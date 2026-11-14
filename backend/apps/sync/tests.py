import copy
from io import StringIO
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from unittest.mock import patch
from uuid import uuid4

from django.db import close_old_connections
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from apps.accounts.models import Device, User
from apps.content.services import save_product
from apps.content.tests.helpers import PublicationFixture
from apps.learning.models import LessonCompletion
from .models import SyncInbox, UserChange, UserSyncState
from .services import process_operation


class SyncFixture(PublicationFixture):
    def setUp(self):
        super().setUp()
        self.product.trial_enabled = True
        save_product(self.product)
        self.publish_product()
        self.product.refresh_from_db()
        self.revision = self.product.revisions.get()
        self.user = User.objects.create_user()
        self.device = uuid4()
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def operation(self, sequence=1, **payload):
        return {"operation_id": str(uuid4()), "sequence": sequence, "type": "lesson.complete",
                "occurred_at": "2026-01-01T12:00:00Z", "payload": {
                    "product_id": str(self.product.pk), "lesson_id": self.source["lessons"][0]["id"],
                    "content_revision_id": str(self.revision.pk), **payload}}

    def post(self, *operations, device=None):
        return self.client.post("/api/v1/sync/operations", {
            "device_id": str(device or self.device), "operations": list(operations),
        }, format="json")


class CompletionTests(SyncFixture, TestCase):
    def test_retry_lost_response_same_id_and_other_device_are_union(self):
        op = self.operation()
        response = self.post(op)
        self.assertEqual(response.status_code, 200, response.data)
        receipt = response.data["results"][0]
        self.assertEqual(receipt["status"], "applied")
        self.assertEqual(self.post(op).data["results"][0], receipt)
        duplicate = self.post(self.operation(), device=uuid4()).data["results"][0]
        self.assertEqual(duplicate["status"], "noop")
        self.assertEqual(LessonCompletion.objects.count(), 1)
        self.assertEqual(UserChange.objects.count(), 1)
        self.assertEqual(SyncInbox.objects.count(), 2)
        self.assertEqual(LessonCompletion.objects.get().trial_revision_id, self.revision.pk)
        self.assertFalse(Device.objects.filter(user__is_staff=True).exists())

    def test_changed_payload_or_reused_sequence_do_not_mutate(self):
        op = self.operation()
        self.post(op)
        changed = copy.deepcopy(op)
        changed["occurred_at"] = "2026-01-02T12:00:00Z"
        self.assertEqual(self.post(changed).data["results"][0]["code"], "idempotency_key_reused")
        self.assertEqual(self.post(self.operation()).data["results"][0]["code"], "sequence_reused")
        self.assertEqual(UserChange.objects.count(), 1)
        self.assertEqual(LessonCompletion.objects.get().client_completed_at.day, 1)

    def test_bad_operation_is_durable_and_does_not_block_valid_operation(self):
        invalid = self.operation(content_revision_id=str(uuid4()))
        good = self.operation(2)
        response = self.post(invalid, good)
        self.assertEqual([r["status"] for r in response.data["results"]], ["rejected", "applied"])
        self.assertEqual(self.post(invalid).data["results"][0], response.data["results"][0])
        self.assertEqual(SyncInbox.objects.count(), 2)
        malformed = self.operation(3, lesson_id="bad-id")
        self.assertEqual(self.post(malformed).data["results"][0]["code"], "invalid_completion")
        future = self.operation(4)
        future["type"] = "srs.answer"
        self.assertEqual(self.post(future).data["results"][0]["code"], "unsupported_operation")

    def test_historical_revision_accepted_after_correction_and_trial_disabled(self):
        self.import_source(self.corrected())
        self.publish_product()
        self.product.refresh_from_db()
        self.product.trial_enabled = False
        save_product(self.product)
        self.assertEqual(self.post(self.operation()).data["results"][0]["status"], "applied")
        self.assertEqual(LessonCompletion.objects.get().first_revision_id, self.revision.pk)
        wrong = self.operation(2, product_id=str(uuid4()))
        self.assertEqual(self.post(wrong).data["results"][0]["status"], "rejected")

    def test_full_completion_later_gains_trial_proof_without_second_completion(self):
        # A new publication can add a trial proof to an already completed lesson.
        self.product.trial_enabled = False
        save_product(self.product)
        # Create a distinct full-only publication by correcting the source.
        self.import_source(self.corrected())
        self.publish_product()
        full = self.product.revisions.order_by("-number").first()
        op = self.operation(content_revision_id=str(full.pk))
        self.assertEqual(self.post(op).data["results"][0]["state"]["trial_revision"], None)
        response = self.post(self.operation(2))
        self.assertEqual(response.data["results"][0]["status"], "applied")
        self.assertEqual(LessonCompletion.objects.count(), 1)
        self.assertEqual(UserChange.objects.count(), 2)
        self.assertEqual(LessonCompletion.objects.get().first_revision_id, full.pk)

    def test_atomic_rollback_includes_inbox_change_completion_and_cursor(self):
        op = self.operation()
        with patch("apps.sync.services.SyncInbox.objects.create", side_effect=RuntimeError("commit failed")):
            with self.assertRaises(RuntimeError):
                process_operation(self.user, self.device, op)
        self.assertFalse(LessonCompletion.objects.exists())
        self.assertFalse(UserChange.objects.exists())
        self.assertFalse(SyncInbox.objects.exists())
        self.assertEqual(process_operation(self.user, self.device, op)["status"], "applied")
        self.assertEqual(UserSyncState.objects.get(user=self.user).last_revision, 1)

    def test_fixed_pull_boundary_and_account_isolation(self):
        self.post(self.operation())
        page = self.client.get("/api/v1/sync/changes?after=0&limit=1").data
        self.assertEqual(page["through_cursor"], "1")
        other = User.objects.create_user()
        self.client.force_authenticate(other)
        self.assertEqual(self.client.get("/api/v1/sync/changes").data["changes"], [])
        denied = self.post(self.operation())
        self.assertEqual(denied.data["results"][0]["code"], "device_not_owned")
        self.assertFalse(LessonCompletion.objects.filter(user=other).exists())
        self.client.force_authenticate(self.user)
        self.assertEqual(self.client.get("/api/v1/sync/changes?after=2").status_code, 400)
        self.assertEqual(self.client.get("/api/v1/sync/changes?after=0&through_cursor=1").data, page)

    def test_envelope_validation_and_no_private_cache(self):
        self.assertEqual(self.post().status_code, 400)
        self.assertEqual(self.post(self.operation(2), self.operation(1)).status_code, 400)
        op = self.operation()
        op["payload"]["padding"] = "a" * (256 * 1024)
        self.assertEqual(self.post(op).status_code, 413)
        self.client.force_authenticate(None)
        response = self.client.get("/api/v1/sync/changes")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response["Cache-Control"], "no-store")


class DevAuthTests(TestCase):
    def test_provision_command_is_gated_idempotent_and_never_provisions_staff(self):
        from django.core.management import call_command
        from django.core.management.base import CommandError
        user_id = uuid4()
        with self.assertRaises(CommandError):
            call_command("create_dev_sync_user", stdout=StringIO())
        with override_settings(DEBUG=True, DEV_AUTH_ALLOWED=True,
                               DEV_SYNC_ENABLED=True, DEV_SYNC_USER_ID=str(user_id)):
            call_command("create_dev_sync_user", stdout=StringIO())
            call_command("create_dev_sync_user", stdout=StringIO())
            user = User.objects.get(pk=user_id)
            self.assertFalse(user.is_staff)
            self.assertFalse(user.has_usable_password())
            self.assertEqual(User.objects.count(), 1)
            user.is_staff = True
            user.save(update_fields=["is_staff"])
            with self.assertRaises(CommandError):
                call_command("create_dev_sync_user", stdout=StringIO())

    def test_server_opt_in_token_and_nonstaff_identity(self):
        user = User.objects.create_user()
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION="Bearer " + "x" * 32)
        self.assertEqual(client.get("/api/v1/dev/session").status_code, 404)
        with override_settings(DEBUG=True, DEV_AUTH_ALLOWED=True, DEV_SYNC_ENABLED=True,
                               DEV_SYNC_TOKEN="x" * 32, DEV_SYNC_USER_ID=str(user.pk)):
            self.assertEqual(client.get("/api/v1/dev/session").data, {"user_id": str(user.pk)})
            client.credentials(HTTP_AUTHORIZATION="Bearer wrong")
            self.assertEqual(client.get("/api/v1/sync/changes").status_code, 401)
            client.credentials(HTTP_AUTHORIZATION="Bearer " + "x" * 32)
            with override_settings(DEV_AUTH_ALLOWED=False):
                self.assertEqual(client.get("/api/v1/dev/session").status_code, 404)
                self.assertEqual(client.get("/api/v1/sync/changes").status_code, 401)
            with override_settings(DEBUG=False):
                self.assertEqual(client.get("/api/v1/dev/session").status_code, 404)


class ConcurrentSyncTests(SyncFixture, TransactionTestCase):
    def add_second_lesson(self):
        from apps.content.tests.helpers import example_source
        second = example_source(self.product, self.section)["lessons"][0]
        second["position"] = 2
        for item in second["items"]:
            item["sense_key"] += ".second"
        self.source["lessons"].append(second)
        self.import_source(self.source)
        self.publish_product()
        return second["id"], self.product.revisions.order_by("-number").first().pk

    def test_concurrent_different_lessons_have_contiguous_committed_cursors(self):
        lesson_id, revision_id = self.add_second_lesson()
        operations = [self.operation(), self.operation(lesson_id=lesson_id, content_revision_id=str(revision_id))]
        barrier = Barrier(2)

        def send(operation):
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                return process_operation(self.user, uuid4(), operation)
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(send, operations))
        self.assertEqual({r["change_revision"] for r in results}, {1, 2})
        self.assertEqual(LessonCompletion.objects.count(), 2)
        first = self.client.get("/api/v1/sync/changes?after=0&limit=1").data
        self.assertTrue(first["has_more"])
        self.assertEqual(first["through_cursor"], "2")
        second = self.client.get("/api/v1/sync/changes?after=1&through_cursor=2&limit=1").data
        self.assertFalse(second["has_more"])
        self.assertEqual(second["next_cursor"], "2")
        self.assertEqual({first["changes"][0]["id"], second["changes"][0]["id"]}, {op["payload"]["lesson_id"] for op in operations})

    def test_pull_does_not_see_cursor_allocated_before_commit(self):
        written, release = Event(), Event()
        original_create = SyncInbox.objects.create

        def paused_create(**kwargs):
            result = original_create(**kwargs)
            written.set()
            if not release.wait(timeout=10):
                raise AssertionError("Reader timed out")
            return result

        def send():
            close_old_connections()
            try:
                return process_operation(self.user, self.device, self.operation())
            finally:
                close_old_connections()

        with patch("apps.sync.services.SyncInbox.objects.create", side_effect=paused_create), ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(send)
            try:
                self.assertTrue(written.wait(timeout=10))
                page = self.client.get("/api/v1/sync/changes?after=0").data
                self.assertEqual(page["through_cursor"], "0")
                self.assertEqual(page["changes"], [])
            finally:
                release.set()
            future.result(timeout=10)
        self.assertEqual(self.client.get("/api/v1/sync/changes?after=0").data["next_cursor"], "1")

    def test_two_connections_retry_exact_operation_once(self):
        barrier = Barrier(2)
        operation = self.operation()

        def send():
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                return process_operation(self.user, self.device, operation)
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: send(), range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(LessonCompletion.objects.count(), 1)
        self.assertEqual(SyncInbox.objects.count(), 1)
        self.assertEqual(UserChange.objects.count(), 1)


class SyncMigrationTests(TransactionTestCase):
    def test_upgrade_from_stage_1_4_preserves_existing_user_and_catalog(self):
        from django.db import connection
        from django.db.migrations.executor import MigrationExecutor
        from apps.content.tests.helpers import catalog_book
        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        try:
            executor.migrate([("learning", None), ("sync", None), ("accounts", "0001_initial")])
            user = User.objects.create_user()
            product, section = catalog_book()
            MigrationExecutor(connection).migrate(latest)
            from apps.content.models import Product, Section
            self.assertTrue(User.objects.filter(pk=user.pk).exists())
            self.assertEqual(Section.objects.get(pk=section.pk).product_id, product.pk)
            self.assertEqual(Product.objects.get(pk=product.pk).title_en, "Book")
            self.assertFalse(LessonCompletion.objects.exists())
        finally:
            MigrationExecutor(connection).migrate(latest)
