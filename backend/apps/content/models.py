"""Editorial identities and immutable published content."""

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
    current_revision = models.ForeignKey(
        "PublishedRevision", null=True, blank=True, editable=False,
        on_delete=models.PROTECT, related_name="current_for_products",
    )
    first_published_at = models.DateTimeField(null=True, editable=False)
    availability = models.CharField(
        max_length=9, choices=[("available", "Доступен"), ("blocked", "Заблокирован")],
        default="available",
    )

    class Meta:
        ordering = ("title_en", "id")
        constraints = [
            models.CheckConstraint(
                condition=Q(availability__in=("available", "blocked")),
                name="product_availability_valid",
            ),
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
            previous = type(self).objects.get(pk=self.pk)
            previous_kind = previous.kind
            if previous.current_revision_id and (
                    previous.book_series_id != self.book_series_id or previous.show_id != self.show_id
            ):
                raise ValidationError("Нельзя переносить опубликованный Product между родителями.")
            if previous_kind != self.kind and (
                self.sections.exists() or self.drafts.exists() or self.current_revision_id
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


class ImmutableQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise ValidationError("Опубликованные записи неизменяемы.")

    def delete(self):
        raise ValidationError("Опубликованные записи нельзя удалять.")


class ImmutableRecord(Identity):
    objects = ImmutableQuerySet.as_manager()

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ValidationError("Опубликованные записи неизменяемы.")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("Опубликованные записи нельзя удалять.")


class PublishedRevision(ImmutableRecord):
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="revisions")
    number = models.PositiveIntegerField()
    schema_version = models.PositiveSmallIntegerField(default=1)
    full_manifest = models.JSONField()
    trial_manifest = models.JSONField(null=True)
    manifest_files = models.JSONField()
    # Internal identity ledger and complete source snapshot; never public catalog data.
    source_documents = models.JSONField()
    identity_map = models.JSONField()
    content_hash = models.CharField(max_length=64)
    publication_kind = models.CharField(
        max_length=10, choices=[("initial", "Initial"), ("correction", "Correction"),
                                ("extension", "Extension")],
    )
    published_at = models.DateTimeField()

    class Meta:
        ordering = ("product_id", "number")
        constraints = [
            models.UniqueConstraint(fields=("product", "number"), name="revision_number_unique"),
            models.CheckConstraint(condition=Q(number__gt=0), name="revision_number_positive"),
            models.CheckConstraint(condition=Q(schema_version=1), name="revision_schema_v1"),
            models.CheckConstraint(
                condition=Q(publication_kind__in=("initial", "correction", "extension")),
                name="revision_kind_valid",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.product_id} / v{self.number}"


class PackArtifact(ImmutableRecord):
    revision = models.ForeignKey(PublishedRevision, on_delete=models.PROTECT, related_name="artifacts")
    scope = models.CharField(max_length=5, choices=[("full", "Full"), ("trial", "Trial")])
    section = models.ForeignKey(Section, null=True, on_delete=models.PROTECT)
    object_key = models.CharField(max_length=255)
    sha256 = models.CharField(max_length=64)
    byte_size = models.PositiveBigIntegerField()
    schema_version = models.PositiveSmallIntegerField(default=1)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(scope__in=("full", "trial")), name="artifact_scope_valid"),
            models.CheckConstraint(condition=Q(byte_size__gt=0), name="artifact_size_positive"),
        ]


class CatalogRevision(ImmutableRecord):
    snapshot = models.JSONField()
    schema_version = models.PositiveSmallIntegerField(default=1)
    object_key = models.CharField(max_length=255, unique=True)
    sha256 = models.CharField(max_length=64)
    byte_size = models.PositiveBigIntegerField()
    activated_at = models.DateTimeField()


class CatalogHead(models.Model):
    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    current_revision = models.ForeignKey(CatalogRevision, null=True, on_delete=models.PROTECT)
    source_revision = models.PositiveBigIntegerField(default=0)

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(id=1), name="catalog_head_singleton")]


class Lesson(Identity):
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="lessons")
    section = models.ForeignKey(Section, null=True, on_delete=models.PROTECT, related_name="lessons")
    position = models.PositiveIntegerField()
    retired_at = models.DateTimeField(null=True, editable=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=("section", "position"), condition=Q(section__isnull=False),
                                    name="lesson_section_position_unique"),
            models.UniqueConstraint(fields=("product", "position"), condition=Q(section__isnull=True),
                                    name="lesson_movie_position_unique"),
            models.CheckConstraint(condition=Q(position__gt=0), name="lesson_position_positive"),
        ]


class LearningItem(Identity):
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="items")
    lesson = models.ForeignKey(Lesson, on_delete=models.PROTECT, related_name="items")
    position = models.PositiveSmallIntegerField()
    sense_key = models.CharField(max_length=255)
    en = models.TextField()
    ru = models.TextField()
    retired_at = models.DateTimeField(null=True, editable=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=("product", "sense_key"), name="item_product_sense_unique"),
            models.UniqueConstraint(fields=("lesson", "position"), name="item_lesson_position_unique",
                                    deferrable=models.Deferrable.DEFERRED),
            models.CheckConstraint(condition=Q(position__gte=1, position__lte=5), name="item_position_1_to_5"),
        ]
