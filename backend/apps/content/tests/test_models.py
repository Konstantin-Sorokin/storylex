import uuid
from io import StringIO

from django.core.exceptions import ValidationError
from django.core.management import call_command
from django.db import IntegrityError, connection, transaction
from django.db.models.deletion import ProtectedError
from django.test import TestCase

from apps.content.models import Author, BookSeries, ContentDraft, Product, Section, Show
from apps.content.services import save_product, save_section


class CatalogTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.author = Author.objects.create(name_ru="Автор", name_en="Author")
        cls.book = Product.objects.create(
            kind=Product.Kind.BOOK, author=cls.author,
            title_ru="Книга", title_en="Book", year=2026,
            cefr_min="A2", cefr_max="B1",
        )

    def section(self, **changes):
        values = {
            "product": self.book, "kind": Section.Kind.CHAPTER,
            "position": 1, "title_ru": "Глава", "title_en": "Chapter",
        }
        values.update(changes)
        return Section(**values)

    def test_real_postgresql_connection(self):
        self.assertEqual(connection.vendor, "postgresql")
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_database(), version()")
            name, version = cursor.fetchone()
        self.assertEqual(name, connection.settings_dict["NAME"])
        self.assertIn("PostgreSQL", version)

    def test_edit_preserves_product_and_section_identity(self):
        section = self.section()
        save_section(section)
        product_id, section_id = self.book.pk, section.pk
        self.book.title_en = "Corrected title"
        section.title_en = "Corrected chapter"
        section.position = 2
        save_product(self.book)
        save_section(section)
        self.book.refresh_from_db()
        section.refresh_from_db()
        self.assertEqual((self.book.pk, section.pk), (product_id, section_id))
        self.assertIsInstance(section.pk, uuid.UUID)

    def test_valid_book_series_season_and_movie(self):
        series = BookSeries.objects.create(title_ru="Серия", title_en="Series")
        self.book.book_series = series
        self.book.sequence = 1
        save_product(self.book)
        show = Show.objects.create(title_ru="Сериал", title_en="Show", release_year=2026)
        season = Product(
            kind=Product.Kind.SEASON, show=show, sequence=1,
            title_ru="Сезон", title_en="Season", year=2026,
            cefr_min="B1", cefr_max="B2", access_mode="paid", price_minor=19900,
        )
        save_product(season)
        save_section(self.section(product=season, kind=Section.Kind.EPISODE))
        movie = Product(
            kind=Product.Kind.MOVIE, title_ru="Фильм", title_en="Movie", year=2026,
            cefr_min="A1", cefr_max="C2",
        )
        save_product(movie)
        self.assertEqual(Product.objects.count(), 3)

    def test_product_constraints_cannot_be_bypassed_with_queryset_update(self):
        invalid_updates = [
            {"kind": "audio"}, {"author": None}, {"sequence": 1},
            {"kind": "movie"}, {"kind": "season"},
            {"access_mode": "paid", "price_minor": 0},
            {"access_mode": "none"}, {"price_minor": -1},
            {"currency": "USD"}, {"year": 0},
            {"cefr_min": "C1", "cefr_max": "B2"},
            {"cefr_min": "Z1"}, {"cefr_max": ""},
        ]
        for changes in invalid_updates:
            with self.subTest(changes=changes):
                with self.assertRaises(IntegrityError), transaction.atomic():
                    Product.objects.filter(pk=self.book.pk).update(**changes)

    def test_parent_sequence_constraints(self):
        series = BookSeries.objects.create(title_ru="Серия", title_en="Series")
        self.book.book_series = series
        self.book.sequence = 1
        save_product(self.book)
        with self.assertRaises(IntegrityError), transaction.atomic():
            Product.objects.create(
                kind="book", author=self.author, book_series=series, sequence=1,
                title_ru="Том", title_en="Volume", year=2026,
                cefr_min="A1", cefr_max="A2",
            )
        show = Show.objects.create(title_ru="Сериал", title_en="Show", release_year=2026)
        values = dict(
            kind="season", show=show, sequence=1, title_ru="Сезон",
            title_en="Season", year=2026, cefr_min="A1", cefr_max="A2",
        )
        Product.objects.create(**values)
        with self.assertRaises(IntegrityError), transaction.atomic():
            Product.objects.create(**values)
        for sequence in (0, None):
            with self.subTest(sequence=sequence):
                with self.assertRaises(IntegrityError), transaction.atomic():
                    Product.objects.filter(pk=self.book.pk).update(sequence=sequence)

    def test_author_names_required_but_not_unique(self):
        Author.objects.create(name_ru=self.author.name_ru, name_en=self.author.name_en)
        with self.assertRaises(IntegrityError), transaction.atomic():
            Author.objects.create(name_ru="", name_en="Name")

    def test_protect_referenced_catalog_entities(self):
        section = self.section()
        save_section(section)
        with self.assertRaises(ProtectedError):
            self.author.delete()
        with self.assertRaises(ProtectedError):
            self.book.delete()

    def test_section_position_unique_and_positive(self):
        save_section(self.section())
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.section().save()
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.section(position=0).save()

    def test_reapplying_migrations_preserves_existing_catalog(self):
        section = self.section()
        save_section(section)
        call_command("migrate", interactive=False, stdout=StringIO(), verbosity=0)
        self.assertEqual(Product.objects.get(pk=self.book.pk).title_en, "Book")
        self.assertEqual(Section.objects.get(pk=section.pk).product_id, self.book.pk)

    def test_section_kind_matches_product_in_service(self):
        for kind in (Section.Kind.EPISODE, "invalid"):
            with self.subTest(kind=kind), self.assertRaises(ValidationError):
                save_section(self.section(kind=kind))
        self.assertFalse(Section.objects.exists())

    def test_movie_cannot_have_sections(self):
        movie = Product.objects.create(
            kind="movie", title_ru="Фильм", title_en="Movie", year=2026,
            cefr_min="A1", cefr_max="A2",
        )
        with self.assertRaises(ValidationError):
            save_section(self.section(product=movie))

    def test_product_kind_cannot_invalidate_existing_structure(self):
        save_section(self.section())
        self.book.kind = Product.Kind.MOVIE
        self.book.author = None
        with self.assertRaises(ValidationError):
            save_product(self.book)
        self.book.refresh_from_db()
        self.assertEqual(self.book.kind, Product.Kind.BOOK)

    def test_section_cannot_be_moved_to_another_product(self):
        section = self.section()
        save_section(section)
        other = Product.objects.create(
            kind="book", author=self.author, title_ru="Другая", title_en="Other",
            year=2026, cefr_min="A1", cefr_max="A2",
        )
        section.product = other
        with self.assertRaises(ValidationError):
            save_section(section)
        section.refresh_from_db()
        self.assertEqual(section.product_id, self.book.pk)

    def test_one_draft_per_section_and_stable_id_after_edit(self):
        section = self.section()
        save_section(section)
        draft = ContentDraft(product=self.book, section=section)
        draft.full_clean()
        draft.save()
        original_id = draft.pk
        draft.source = {"unvalidated": "editorial placeholder"}
        draft.save()
        draft.refresh_from_db()
        self.assertEqual(draft.pk, original_id)
        self.assertIsNone(draft.validation_version)
        with self.assertRaises(IntegrityError), transaction.atomic():
            ContentDraft.objects.create(product=self.book, section=section)
        with self.assertRaises(ProtectedError):
            section.delete()

    def test_movie_draft_unique_and_cross_product_draft_rejected(self):
        movie = Product.objects.create(
            kind="movie", title_ru="Фильм", title_en="Movie", year=2026,
            cefr_min="A1", cefr_max="A2",
        )
        draft = ContentDraft(product=movie)
        draft.full_clean()
        draft.save()
        with self.assertRaises(IntegrityError), transaction.atomic():
            ContentDraft.objects.create(product=movie)
        with self.assertRaises(ValidationError):
            ContentDraft(product=self.book).full_clean()
        section = self.section()
        save_section(section)
        with self.assertRaises(ValidationError):
            ContentDraft(product=movie, section=section).full_clean()
        other_book = Product.objects.create(
            kind="book", author=self.author, title_ru="Другая", title_en="Other",
            year=2026, cefr_min="A1", cefr_max="A2",
        )
        with self.assertRaises(ValidationError):
            ContentDraft(product=other_book, section=section).full_clean()
