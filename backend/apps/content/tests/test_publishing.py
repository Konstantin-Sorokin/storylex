import copy
import json
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.db import IntegrityError, connection, transaction
from django.test import TestCase

from apps.content.models import (Author, BookSeries, CatalogHead, CatalogRevision, ContentDraft,
                                 LearningItem, Lesson, PackArtifact, Product, PublishedRevision, Section, Show)
from apps.content.publishing import (activate_publication, capture_metadata, capture_product,
                                     catalog_descriptor, prepare_publication, publish)
from apps.content.services import save_editorial, save_product
from apps.content.validation import ContentError
from apps.feedback.models import PublicationEvent
from .helpers import PublicationFixture, catalog_book, example_source


class PublicationTests(PublicationFixture, TestCase):
    def test_full_publication_and_catalog_bytes_are_consistent(self):
        catalog = self.publish_product()
        self.product.refresh_from_db()
        revision = self.product.current_revision
        self.assertEqual(revision.number, 1)
        self.assertEqual(revision.full_manifest["counts"], {"sections": 1, "lessons": 1, "items": 5})
        self.assertEqual(Lesson.objects.count(), 1)
        self.assertEqual(LearningItem.objects.count(), 5)
        self.assertEqual(PublicationEvent.objects.get().occurred_at, catalog.activated_at)
        self.assertEqual(revision.published_at, catalog.activated_at)
        self.assertEqual(self.product.first_published_at, catalog.activated_at)
        descriptor = catalog_descriptor()
        data = self.storage.verify(descriptor)
        self.assertEqual(json.loads(data), catalog.snapshot)
        self.assertEqual(json.loads(data)["catalog_revision"], str(catalog.pk))
        self.assertNotIn("exercises", data.decode())
        artifact = PackArtifact.objects.get()
        self.assertTrue(artifact.object_key.startswith("private/"))
        self.assertEqual(json.loads(self.storage.read(artifact.object_key)), self.source)

    def test_all_declared_sections_are_required(self):
        Section.objects.create(product=self.product, kind="chapter", position=2,
                               title_ru="Вторая", title_en="Second")
        with self.assertRaises(ContentError):
            capture_product(self.product.pk)
        self.assertFalse(PublishedRevision.objects.exists())
        self.assertIsNone(catalog_descriptor())

    def test_confirmation_is_required(self):
        captured = capture_product(self.product.pk)
        with self.assertRaises(ContentError):
            publish(captured, expected=captured.approval(), confirmed=False, storage=self.storage)

    def test_repeat_without_changes_creates_no_new_revision_or_catalog(self):
        catalog = self.publish_product()
        repeated = self.publish_product()
        self.assertEqual(catalog.pk, repeated.pk)
        self.assertEqual(PublishedRevision.objects.count(), 1)
        self.assertEqual(CatalogRevision.objects.count(), 1)
        self.assertEqual(PublicationEvent.objects.count(), 1)

    def test_correction_preserves_all_ids_and_original_files(self):
        first_catalog = self.publish_product()
        first_revision = PublishedRevision.objects.get()
        first_artifact = PackArtifact.objects.get()
        first_bytes = self.storage.read(first_artifact.object_key)
        first_ids = set(first_revision.identity_map)
        self.import_source(self.corrected())
        second_catalog = self.publish_product()
        self.product.refresh_from_db()
        self.assertNotEqual(first_catalog.pk, second_catalog.pk)
        self.assertEqual(self.product.current_revision.number, 2)
        self.assertEqual(self.product.current_revision.publication_kind, "correction")
        self.assertEqual(set(self.product.current_revision.identity_map), first_ids)
        self.assertEqual(self.storage.read(first_artifact.object_key), first_bytes)
        self.assertEqual(PublicationEvent.objects.count(), 1)
        self.assertEqual(Lesson.objects.count(), 1)
        self.assertEqual(LearningItem.objects.count(), 5)
        self.assertEqual(self.product.first_published_at, first_revision.published_at)

    def test_append_lesson_creates_extension_event(self):
        self.publish_product()
        source = copy.deepcopy(self.source)
        added = example_source(self.product, self.section)["lessons"][0]
        added["position"] = 2
        for item in added["items"]:
            item["sense_key"] += ".second"
        source["lessons"].append(added)
        self.import_source(source)
        self.publish_product()
        self.assertEqual(Lesson.objects.count(), 2)
        self.assertEqual(PublicationEvent.objects.filter(kind="extension").get().added_lesson_ids, [added["id"]])

    def test_reorder_items_and_lessons_keeps_ids(self):
        source = copy.deepcopy(self.source)
        added = example_source(self.product, self.section)["lessons"][0]
        added["position"] = 2
        for item in added["items"]:
            item["sense_key"] += ".second"
        source["lessons"].append(added)
        self.import_source(source)
        self.publish_product()
        ids = set(Lesson.objects.values_list("id", flat=True))
        source["lessons"].reverse()
        for position, lesson in enumerate(source["lessons"], 1):
            lesson["position"] = position
            lesson["items"].reverse()
        self.import_source(source)
        self.publish_product()
        self.assertEqual(set(Lesson.objects.values_list("id", flat=True)), ids)
        self.assertEqual(LearningItem.objects.count(), 10)

    def test_catalog_metadata_update_does_not_regenerate_exercises(self):
        first = self.publish_product()
        self.product.refresh_from_db()
        revision_id = self.product.current_revision_id
        self.product.price_minor = 14900
        self.product.access_mode = "paid"
        save_product(self.product)
        self.assertEqual(CatalogHead.objects.get().current_revision_id, first.pk)
        captured = capture_metadata(Product, self.product.pk)
        catalog = publish(captured, expected=captured.approval(), confirmed=True, storage=self.storage)
        self.product.refresh_from_db()
        self.assertEqual(self.product.current_revision_id, revision_id)
        self.assertEqual(catalog.snapshot["products"][0]["price_minor"], 14900)
        self.assertEqual(PublishedRevision.objects.count(), 1)
        self.assertEqual(PublicationEvent.objects.count(), 1)

    def test_unapproved_other_product_drafts_never_leak(self):
        other, other_section = catalog_book("Original other")
        self.import_source(example_source(other, other_section))
        self.publish_product(other)
        other.title_en = "Unapproved secret title"
        save_product(other)
        catalog = self.publish_product()
        entry = next(row for row in catalog.snapshot["products"] if row["id"] == str(other.pk))
        self.assertEqual(entry["title"]["en"], "Original other")

    def test_parent_authors_and_year_derive_from_published_children(self):
        series = BookSeries.objects.create(title_ru="Серия", title_en="Series")
        self.product.book_series = series
        self.product.sequence = 2
        save_product(self.product)
        self.publish_product()
        unapproved, _ = catalog_book("Unpublished")
        unapproved.book_series = series
        unapproved.sequence = 1
        unapproved.year = 1900
        save_product(unapproved)
        self.product.author.name_ru = "Исправленный автор"
        save_editorial(self.product.author)
        captured = capture_metadata(Author, self.product.author.pk)
        catalog = publish(captured, expected=captured.approval(), confirmed=True, storage=self.storage)
        parent = catalog.snapshot["book_series"][0]
        self.assertEqual(parent["year"], 2026)
        self.assertEqual(parent["product_ids"], [str(self.product.pk)])
        self.assertEqual(parent["authors"][0]["name_ru"], "Исправленный автор")
        self.assertEqual(PublishedRevision.objects.count(), 1)

    def test_book_trial_contains_only_first_chapter(self):
        self.product.trial_enabled = True
        save_product(self.product)
        second = Section.objects.create(product=self.product, kind="chapter", position=2,
                                        title_ru="Вторая", title_en="Second")
        source = example_source(self.product, second)
        for item in source["lessons"][0]["items"]:
            item["sense_key"] += ".second"
        self.import_source(source)
        self.publish_product()
        revision = PublishedRevision.objects.get()
        self.assertEqual(revision.trial_manifest["counts"]["lessons"], 1)
        self.assertEqual(revision.full_manifest["counts"]["lessons"], 2)
        trial = revision.artifacts.get(scope="trial")
        data = json.loads(self.storage.read(trial.object_key))
        self.assertEqual(data["section_id"], str(self.section.pk))
        self.assertTrue(trial.object_key.startswith("public/"))
        self.assertFalse(
            any(artifact.object_key.startswith("public/") for artifact in revision.artifacts.filter(scope="full")))

    def test_movie_trial_exactly_three_and_short_movie_rejected(self):
        movie = Product.objects.create(kind="movie", title_ru="Фильм", title_en="Movie", year=2026,
                                       cefr_min="A1", cefr_max="B1", trial_enabled=True)
        source = example_source(movie)
        self.import_source(source)
        with self.assertRaises(ContentError) as error:
            capture_product(movie.pk)
        self.assertEqual(error.exception.code, "trial_short_movie")
        for position in range(2, 5):
            lesson = example_source(movie)["lessons"][0]
            lesson["position"] = position
            for item in lesson["items"]:
                item["sense_key"] += str(position)
            source["lessons"].append(lesson)
        self.import_source(source)
        self.publish_product(movie)
        revision = PublishedRevision.objects.get(product=movie)
        self.assertEqual(revision.trial_manifest["counts"]["lessons"], 3)
        self.assertEqual(revision.full_manifest["counts"]["lessons"], 4)
        trial = revision.artifacts.get(scope="trial")
        self.assertEqual(len(json.loads(self.storage.read(trial.object_key))["lessons"]), 3)

    def test_only_first_season_can_enable_trial(self):
        show = Show.objects.create(title_ru="Сериал", title_en="Show", release_year=2026)
        season = Product.objects.create(kind="season", show=show, sequence=2, title_ru="Сезон", title_en="Season",
                                        year=2026, cefr_min="A1", cefr_max="B1", trial_enabled=True)
        episode = Section.objects.create(product=season, kind="episode", position=1,
                                         title_ru="Эпизод", title_en="Episode")
        self.import_source(example_source(season, episode))
        with self.assertRaises(ContentError) as error:
            capture_product(season.pk)
        self.assertEqual(error.exception.code, "trial_season")

    def test_file_failure_leaves_old_head_and_revision(self):
        previous = self.publish_product()
        self.import_source(self.corrected())
        captured = capture_product(self.product.pk)
        original = self.storage.put

        def fail_catalog(key, data):
            if key.startswith("public/catalog/"):
                raise ContentError("storage_unavailable", "Test failure")
            return original(key, data)

        with patch.object(self.storage, "put", side_effect=fail_catalog), self.assertRaises(ContentError):
            publish(captured, expected=captured.approval(), confirmed=True, storage=self.storage)
        self.assertEqual(CatalogHead.objects.get().current_revision_id, previous.pk)
        self.assertEqual(PublishedRevision.objects.count(), 1)
        self.assertEqual(PublicationEvent.objects.count(), 1)

    def test_database_rollback_keeps_all_previous_pointers_and_indexes(self):
        previous = self.publish_product()
        self.import_source(self.corrected())
        prepared = prepare_publication(capture_product(self.product.pk), self.storage)
        with patch.object(CatalogRevision, "save", side_effect=IntegrityError("Test rollback")):
            with self.assertRaises(IntegrityError):
                activate_publication(prepared)
        self.assertEqual(CatalogHead.objects.get().current_revision_id, previous.pk)
        self.assertEqual(PublishedRevision.objects.count(), 1)
        self.assertEqual(CatalogRevision.objects.count(), 1)
        self.assertEqual(PublicationEvent.objects.count(), 1)

    def test_changed_input_or_active_head_rejects_candidate(self):
        prepared = prepare_publication(capture_product(self.product.pk), self.storage)
        self.import_source(self.corrected())
        with self.assertRaises(ContentError) as error:
            activate_publication(prepared)
        self.assertEqual(error.exception.code, "publication_conflict")
        self.assertIsNone(catalog_descriptor())
        prepared = prepare_publication(capture_product(self.product.pk), self.storage)
        self.publish_product()
        with self.assertRaises(ContentError):
            activate_publication(prepared)
        self.assertEqual(PublishedRevision.objects.count(), 1)

    def test_file_hash_verification_failure_does_not_activate(self):
        with patch.object(self.storage, "read", return_value=b"corrupted"), self.assertRaises(ContentError):
            self.publish_product()
        self.assertIsNone(catalog_descriptor())

    def test_draft_hash_is_checked_again_before_activation(self):
        prepared = prepare_publication(capture_product(self.product.pk), self.storage)
        ContentDraft.objects.update(source_hash="0" * 64)
        with self.assertRaises(ContentError):
            activate_publication(prepared)
        self.assertIsNone(catalog_descriptor())

    def test_immutable_rows_protected_in_orm_and_database(self):
        catalog = self.publish_product()
        revision = PublishedRevision.objects.get()
        with self.assertRaises(ValidationError):
            revision.save()
        with self.assertRaises(ValidationError):
            revision.delete()
        for table in ("content_publishedrevision", "content_catalogrevision", "content_packartifact",
                      "feedback_publicationevent"):
            with self.subTest(table=table):
                with self.assertRaises(IntegrityError), transaction.atomic(), connection.cursor() as cursor:
                    cursor.execute(f"UPDATE {table} SET id = id")
                with self.assertRaises(IntegrityError), transaction.atomic(), connection.cursor() as cursor:
                    cursor.execute(f"DELETE FROM {table}")
        self.assertEqual(CatalogHead.objects.get().current_revision_id, catalog.pk)

    def test_identity_registry_and_revision_ownership_protected_in_database(self):
        self.publish_product()
        other, _ = catalog_book("Other")
        with self.assertRaises(IntegrityError), transaction.atomic():
            Lesson.objects.update(product=other)
        with self.assertRaises(IntegrityError), transaction.atomic():
            LearningItem.objects.update(sense_key="changed")
        with self.assertRaises(IntegrityError), transaction.atomic():
            Product.objects.filter(pk=other.pk).update(current_revision=PublishedRevision.objects.get())

    def test_concurrent_different_products_require_rebuild_then_preserve_both(self):
        other, section = catalog_book("Other")
        self.import_source(example_source(other, section))
        first = prepare_publication(capture_product(self.product.pk), self.storage)
        stale = prepare_publication(capture_product(other.pk), self.storage)
        activate_publication(first)
        with self.assertRaises(ContentError):
            activate_publication(stale)
        catalog = self.publish_product(other)
        self.assertEqual({entry["id"] for entry in catalog.snapshot["products"]},
                         {str(self.product.pk), str(other.pk)})
