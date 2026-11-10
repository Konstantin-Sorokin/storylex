import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from django.db import connection, connections
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase

from apps.content.models import CatalogHead, Product, PublishedRevision
from apps.content.publishing import activate_publication, capture_product, catalog_descriptor, prepare_publication
from apps.content.validation import ContentError
from .helpers import PublicationFixture


class PublicationConcurrencyTests(PublicationFixture, TransactionTestCase):
    def test_two_publishers_do_not_mix_or_double_activate(self):
        one = prepare_publication(capture_product(self.product.pk), self.storage)
        two = prepare_publication(capture_product(self.product.pk), self.storage)
        barrier = threading.Barrier(2)

        def activate(candidate):
            try:
                barrier.wait(timeout=10)
                activate_publication(candidate)
                return "activated"
            except ContentError as error:
                return error.code
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(activate, [one, two]))
        self.assertCountEqual(results, ["activated", "publication_conflict"])
        self.assertEqual(PublishedRevision.objects.count(), 1)
        descriptor = catalog_descriptor()
        self.storage.verify(descriptor)
        self.product.refresh_from_db()
        self.assertEqual(self.product.current_revision_id, PublishedRevision.objects.get().pk)

    def test_reader_sees_old_complete_head_until_commit(self):
        old = self.publish_product()
        before = catalog_descriptor()
        self.import_source(self.corrected())
        prepared = prepare_publication(capture_product(self.product.pk), self.storage)
        written = threading.Event()
        read = threading.Event()
        original_save = CatalogHead.save

        def pause_after_head_save(instance, *args, **kwargs):
            result = original_save(instance, *args, **kwargs)
            if kwargs.get("update_fields") == ("current_revision",):
                written.set()
                if not read.wait(timeout=10):
                    raise AssertionError("Reader timed out")
            return result

        def activate():
            try:
                activate_publication(prepared)
            finally:
                connections.close_all()

        with patch.object(CatalogHead, "save", pause_after_head_save), ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(activate)
            try:
                self.assertTrue(written.wait(timeout=10))
                self.assertEqual(catalog_descriptor(), before)
                self.product.refresh_from_db()
                self.assertEqual(str(self.product.current_revision_id), old.snapshot["products"][0]["revision_id"])
            finally:
                read.set()
            future.result(timeout=10)
        self.assertNotEqual(catalog_descriptor(), before)
        self.storage.verify(catalog_descriptor())

    def test_storage_work_runs_outside_transactions(self):
        calls = []
        original = self.storage.put

        def checked_put(key, data):
            calls.append(connection.in_atomic_block)
            return original(key, data)

        with patch.object(self.storage, "put", checked_put):
            self.publish_product()
        self.assertTrue(calls)
        self.assertFalse(any(calls))


class MigrationUpgradeTests(TransactionTestCase):
    def test_upgrade_1_1_keeps_existing_uuid_catalog_and_unvalidated_draft(self):
        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        old = [("content", "0001_initial"), ("feedback", None)]
        try:
            executor.migrate(old)
            apps = executor.loader.project_state([("content", "0001_initial")]).apps
            author = apps.get_model("content", "Author").objects.create(name_ru="Автор", name_en="Author")
            product = apps.get_model("content", "Product").objects.create(
                kind="book", author=author, title_ru="Книга", title_en="Existing",
                year=2026, cefr_min="A1", cefr_max="A2",
            )
            section = apps.get_model("content", "Section").objects.create(
                product=product, kind="chapter", position=1, title_ru="Глава", title_en="Existing chapter",
            )
            draft = apps.get_model("content", "ContentDraft").objects.create(product=product, section=section)
            executor = MigrationExecutor(connection)
            executor.migrate(latest)
            from apps.content.models import ContentDraft, Section
            self.assertEqual(Product.objects.get(pk=product.pk).title_en, "Existing")
            self.assertEqual(Section.objects.get(pk=section.pk).product_id, product.pk)
            self.assertIsNone(ContentDraft.objects.get(pk=draft.pk).validation_version)
            self.assertIsNone(Product.objects.get(pk=product.pk).current_revision_id)
        finally:
            MigrationExecutor(connection).migrate(latest)
