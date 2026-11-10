"""Editable catalog identities. Published snapshots arrive in step 1.2."""

import uuid

from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import F, Q


class Identity(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    class Meta:
        abstract = True


class TitledIdentity(Identity):
    title_ru = models.CharField(max_length=255)
    title_en = models.CharField(max_length=255)
    description_ru = models.TextField(blank=True)
    description_en = models.TextField(blank=True)

    class Meta:
        abstract = True

    def __str__(self) -> str:
        return self.title_en


class Author(Identity):
    name_ru = models.CharField(max_length=255)
    name_en = models.CharField(max_length=255)

    class Meta:
        ordering = ("name_en", "id")
        constraints = [
            models.CheckConstraint(
                condition=~Q(name_ru="") & ~Q(name_en=""),
                name="author_names_not_empty",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name_en} / {self.name_ru}"


class BookSeries(TitledIdentity):
    order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ("order", "title_en", "id")


class Show(TitledIdentity):
    release_year = models.PositiveSmallIntegerField()

    class Meta:
        ordering = ("title_en", "id")
        constraints = [
            models.CheckConstraint(
                condition=Q(release_year__gte=1), name="show_release_year_positive",
            ),
        ]


class Product(TitledIdentity):
    class Kind(models.TextChoices):
        BOOK = "book", "Книга"
        SEASON = "season", "Сезон"
        MOVIE = "movie", "Фильм"

    class AccessMode(models.TextChoices):
        FREE = "free", "Бесплатный"
        PAID = "paid", "Платный"

    class CEFR(models.TextChoices):
        A1 = "A1"
        A2 = "A2"
        B1 = "B1"
        B2 = "B2"
        C1 = "C1"
        C2 = "C2"

    kind = models.CharField(max_length=6, choices=Kind.choices)
    book_series = models.ForeignKey(
        BookSeries, null=True, blank=True, on_delete=models.PROTECT,
        related_name="products",
    )
    show = models.ForeignKey(
        Show, null=True, blank=True, on_delete=models.PROTECT,
        related_name="products",
    )
    sequence = models.PositiveIntegerField(null=True, blank=True)
    author = models.ForeignKey(
        Author, null=True, blank=True, on_delete=models.PROTECT,
        related_name="books",
    )
    year = models.PositiveSmallIntegerField()
    cefr_min = models.CharField(max_length=2, choices=CEFR.choices)
    cefr_max = models.CharField(max_length=2, choices=CEFR.choices)
    access_mode = models.CharField(
        max_length=4, choices=AccessMode.choices, default=AccessMode.FREE,
    )
    price_minor = models.PositiveIntegerField(default=0)
    currency = models.CharField(max_length=3, default="RUB", editable=False)
    trial_enabled = models.BooleanField(default=False)

    class Meta:
        ordering = ("title_en", "id")
        constraints = [
            models.CheckConstraint(
                condition=(
                    Q(kind="book", show__isnull=True, author__isnull=False)
                    & (
                        Q(book_series__isnull=True, sequence__isnull=True)
                        | Q(book_series__isnull=False, sequence__isnull=False,
                            sequence__gt=0)
                    )
                ) | Q(
                    kind="season", show__isnull=False, book_series__isnull=True,
                    author__isnull=True, sequence__isnull=False, sequence__gt=0,
                ) | Q(
                    kind="movie", show__isnull=True, book_series__isnull=True,
                    author__isnull=True, sequence__isnull=True,
                ),
                name="product_kind_relations_valid",
            ),
            models.UniqueConstraint(
                fields=("book_series", "sequence"),
                condition=Q(book_series__isnull=False),
                name="product_book_series_sequence_unique",
            ),
            models.UniqueConstraint(
                fields=("show", "sequence"), condition=Q(show__isnull=False),
                name="product_show_sequence_unique",
            ),
            models.CheckConstraint(
                condition=Q(access_mode="free", price_minor__gte=0)
                | Q(access_mode="paid", price_minor__gt=0),
                name="product_access_price_valid",
            ),
            models.CheckConstraint(
                condition=Q(currency="RUB"), name="product_currency_rub",
            ),
            models.CheckConstraint(
                condition=Q(year__gte=1), name="product_year_positive",
            ),
            # Lexical order equals rank for these six explicitly allowed values.
            models.CheckConstraint(
                condition=Q(cefr_min__in=("A1", "A2", "B1", "B2", "C1", "C2"))
                & Q(cefr_max__in=("A1", "A2", "B1", "B2", "C1", "C2"))
                & Q(cefr_min__lte=F("cefr_max")),
                name="product_cefr_range_valid",
            ),
        ]

    def clean(self) -> None:
        super().clean()
        if not self._state.adding:
            previous_kind = type(self).objects.get(pk=self.pk).kind
            if previous_kind != self.kind and (
                self.sections.exists() or self.drafts.exists()
            ):
                raise ValidationError({
                    "kind": "Нельзя менять тип материала с секциями/черновиками.",
                })


class Section(Identity):
    class Kind(models.TextChoices):
        CHAPTER = "chapter", "Глава"
        EPISODE = "episode", "Эпизод"

    product = models.ForeignKey(
        Product, on_delete=models.PROTECT, related_name="sections",
    )
    kind = models.CharField(max_length=7, choices=Kind.choices)
    position = models.PositiveIntegerField()
    title_ru = models.CharField(max_length=255)
    title_en = models.CharField(max_length=255)
    retired_at = models.DateTimeField(null=True, blank=True, editable=False)

    class Meta:
        ordering = ("product", "position", "id")
        constraints = [
            models.UniqueConstraint(
                fields=("product", "position"), name="section_product_position_unique",
            ),
            models.CheckConstraint(
                condition=Q(position__gt=0), name="section_position_positive",
            ),
            models.CheckConstraint(
                condition=Q(kind__in=("chapter", "episode")),
                name="section_kind_valid",
            ),
        ]

    def clean(self) -> None:
        super().clean()
        if self.product_id:
            expected_kind = {
                Product.Kind.BOOK: self.Kind.CHAPTER,
                Product.Kind.SEASON: self.Kind.EPISODE,
            }.get(self.product.kind)
            if self.kind != expected_kind:
                raise ValidationError({
                    "kind": "Главы допустимы у книг, эпизоды — у сезонов; у фильма секций нет.",
                })
        if not self._state.adding:
            previous = type(self).objects.get(pk=self.pk)
            if previous.product_id != self.product_id:
                raise ValidationError({
                    "product": "Стабильную секцию нельзя переносить в другой материал.",
                })

    def __str__(self) -> str:
        return f"{self.position}. {self.title_en}"


class ContentDraft(Identity):
    product = models.ForeignKey(
        Product, on_delete=models.PROTECT, related_name="drafts",
    )
    section = models.ForeignKey(
        Section, null=True, blank=True, on_delete=models.PROTECT,
        related_name="drafts",
    )
    source = models.JSONField(default=dict, blank=True)
    source_hash = models.CharField(max_length=64, blank=True, editable=False)
    validation_version = models.PositiveSmallIntegerField(
        null=True, blank=True, editable=False,
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=("section",), condition=Q(section__isnull=False),
                name="draft_section_unique",
            ),
            models.UniqueConstraint(
                fields=("product",), condition=Q(section__isnull=True),
                name="draft_whole_product_unique",
            ),
        ]

    def clean(self) -> None:
        super().clean()
        if not self.product_id:
            return
        if self.product.kind == Product.Kind.MOVIE:
            if self.section_id is not None:
                raise ValidationError({"section": "Черновик фильма не имеет секции."})
        elif self.section_id is None:
            raise ValidationError({"section": "Нужна глава или эпизод."})
        elif self.section.product_id != self.product_id:
            raise ValidationError({"section": "Секция принадлежит другому материалу."})

    def __str__(self) -> str:
        return f"Draft: {self.section or self.product}"
