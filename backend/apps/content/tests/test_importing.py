import copy
from uuid import uuid4

from django.test import TestCase

from apps.content.importing import import_document
from apps.content.models import CatalogHead, ContentDraft, LearningItem, Lesson
from apps.content.validation import ContentError, MAX_DOCUMENT_BYTES, canonical_bytes, parse_source, validate_source
from .helpers import PublicationFixture, catalog_book, example_source


class SourceValidationTests(TestCase):
    def setUp(self):
        self.product, self.section = catalog_book()
        self.source = example_source(self.product, self.section)

    def test_safe_example_satisfies_schema_and_semantics(self):
        self.assertEqual(parse_source(canonical_bytes(self.source)), self.source)

    def test_invalid_json_and_input_limit(self):
        for data in (b'{"a":1,"a":2}', b'{"a":NaN}', b'\xff', b'[]', b'{}', b'{'):
            with self.subTest(data=data), self.assertRaises(ContentError):
                parse_source(data)
        with self.assertRaises(ContentError) as error:
            parse_source(b" " * (MAX_DOCUMENT_BYTES + 1))
        self.assertEqual(error.exception.code, "document_too_large")

    def test_schema_errors_are_strict_and_localized(self):
        mutations = [
            lambda s: s.update(schema_version=2), lambda s: s.update(schema_version=True),
            lambda s: s.update(extra="not allowed"), lambda s: s.update(product_id="not-uuid"),
            lambda s: s["title"].update(ru=" "),
            lambda s: s["title"].update(en="\ud800"),
            lambda s: s["lessons"][0].update(position=2),
            lambda s: s["lessons"][0]["items"].pop(),
            lambda s: s["lessons"][0]["items"][0]["exercises"].pop("context_ru_to_en"),
            lambda s: s["lessons"][0]["items"][0]["exercises"]["word_to_translation"]["options"].pop(),
        ]
        for mutate in mutations:
            source = copy.deepcopy(self.source)
            mutate(source)
            with self.subTest(mutate=mutate), self.assertRaises(ContentError) as error:
                validate_source(source)
            self.assertTrue(error.exception.path.startswith("/"))

    def test_duplicate_ids_senses_options_pairs_and_answers(self):
        mutations = [
            lambda a, b: b.update(id=a["id"]),
            lambda a, b: b.update(sense_key=a["sense_key"]),
            lambda a, b: b.update(ru=a["ru"]),
            lambda a, b: a["example"]["en"][1].update(target=False),
            lambda a, b: a["exercises"]["word_to_translation"].update(correct_option_id=str(uuid4())),
            lambda a, b: a["exercises"]["word_to_translation"].update(prompt="wrong"),
            lambda a, b: a["exercises"]["word_to_translation"]["options"][0].update(text="wrong"),
            lambda a, b: a["exercises"]["context_en_to_ru"]["options"][1].update(
                text="  " + a["exercises"]["context_en_to_ru"]["options"][0]["text"].upper()),
        ]
        for mutate in mutations:
            source = copy.deepcopy(self.source)
            mutate(*source["lessons"][0]["items"][:2])
            with self.subTest(mutate=mutate), self.assertRaises(ContentError):
                validate_source(source)


class ImportTests(PublicationFixture, TestCase):
    def test_first_import_only_creates_draft(self):
        self.assertEqual(ContentDraft.objects.count(), 1)
        self.assertEqual(Lesson.objects.count(), 0)
        self.assertEqual(LearningItem.objects.count(), 0)
        self.assertIsNone(CatalogHead.objects.get().current_revision_id)
        self.assertEqual(ContentDraft.objects.get().validation_version, 1)

    def test_repeat_is_idempotent_and_keeps_uuid(self):
        draft = ContentDraft.objects.get()
        source_revision = CatalogHead.objects.get().source_revision
        again = self.import_source(self.source)
        self.assertEqual(draft.pk, again.pk)
        self.assertEqual(CatalogHead.objects.get().source_revision, source_revision)
        self.assertEqual(self.import_source(self.corrected()).pk, draft.pk)

    def test_bad_document_never_partially_replaces_draft(self):
        before = ContentDraft.objects.get()
        source_revision = CatalogHead.objects.get().source_revision
        bad = copy.deepcopy(self.source)
        bad["lessons"][0]["items"].pop()
        with self.assertRaises(ContentError):
            self.import_source(bad)
        after = ContentDraft.objects.get()
        self.assertEqual(before.source, after.source)
        self.assertEqual(before.updated_at, after.updated_at)
        self.assertEqual(CatalogHead.objects.get().source_revision, source_revision)

    def test_selected_scope_and_ownership_are_enforced(self):
        other, section = catalog_book("Other")
        for product_id, section_id in ((other.pk, self.section.pk), (self.product.pk, section.pk),
                                       (self.product.pk, None)):
            with self.subTest(product_id=product_id, section_id=section_id), self.assertRaises(ContentError):
                import_document(canonical_bytes(self.source), product_id=product_id, section_id=section_id)

    def test_collisions_in_unpublished_and_published_content_rejected(self):
        other, section = catalog_book("Other")
        source = copy.deepcopy(self.source)
        source.update(product_id=str(other.pk), section_id=str(section.pk))
        with self.assertRaises(ContentError):
            self.import_source(source)
        self.publish_product()
        with self.assertRaises(ContentError):
            self.import_source(source)

    def test_sense_uniqueness_across_unchanged_chapters(self):
        section = type(self.section).objects.create(product=self.product, kind="chapter", position=2,
                                                    title_ru="Другая", title_en="Other")
        source = example_source(self.product, section)
        with self.assertRaises(ContentError) as error:
            self.import_source(source)
        self.assertEqual(error.exception.code, "duplicate_sense")

    def test_published_ids_cannot_disappear_move_or_change_sense(self):
        self.publish_product()
        for mutation in ("item_id", "lesson_id", "sense_key", "option_id"):
            source = copy.deepcopy(self.source)
            lesson = source["lessons"][0]
            item = lesson["items"][0]
            if mutation == "item_id":
                item["id"] = str(uuid4())
            elif mutation == "lesson_id":
                lesson["id"] = str(uuid4())
            elif mutation == "sense_key":
                item["sense_key"] = "new-meaning"
            else:
                item["exercises"]["context_en_to_ru"]["options"][1]["id"] = str(uuid4())
            with self.subTest(mutation=mutation), self.assertRaises(ContentError):
                self.import_source(source)

    def test_published_draft_change_does_not_change_active_source(self):
        self.publish_product()
        self.product.refresh_from_db()
        previous = self.product.current_revision
        self.import_source(self.corrected())
        previous.refresh_from_db()
        self.assertEqual(previous.source_documents, [self.source])
        self.product.refresh_from_db()
        self.assertEqual(self.product.current_revision_id, previous.pk)
