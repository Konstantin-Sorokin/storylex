import copy
import json
import tempfile
from uuid import uuid4

from django.conf import settings

from apps.content.importing import import_document
from apps.content.models import Author, Product, Section
from apps.content.publishing import capture_product, publish
from apps.content.storage import LocalContentStorage
from apps.content.validation import canonical_bytes


def example_source(product, section=None):
    path = settings.BASE_DIR.parent / "contracts/fixtures/source-chapter-v1.json"
    source = json.loads(path.read_text(encoding="utf-8"))
    replacements = {}

    def remap(value):
        if isinstance(value, dict):
            return {key: (replacements.setdefault(child, str(uuid4())) if key in (
                "id", "correct_option_id", "product_id", "section_id",
            ) and child is not None else remap(child)) for key, child in value.items()}
        if isinstance(value, list):
            return [remap(child) for child in value]
        return value

    source = remap(source)
    source["product_id"] = str(product.pk)
    source["section_id"] = str(section.pk) if section else None
    source["scope"] = {"book": "chapter", "season": "episode", "movie": "movie"}[product.kind]
    return source


def catalog_book(title="Book"):
    author = Author.objects.create(name_ru="Автор", name_en="Author")
    product = Product.objects.create(kind="book", author=author, title_ru="Книга", title_en=title,
                                     year=2026, cefr_min="A2", cefr_max="B1")
    section = Section.objects.create(product=product, kind="chapter", position=1,
                                     title_ru="Глава", title_en="Chapter")
    return product, section


class PublicationFixture:
    def setUp(self):
        super().setUp()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.storage = LocalContentStorage(self.directory.name)
        self.product, self.section = catalog_book()
        self.source = example_source(self.product, self.section)
        self.import_source(self.source)

    def import_source(self, source):
        return import_document(canonical_bytes(source), product_id=source["product_id"],
                               section_id=source["section_id"])

    def publish_product(self, product=None):
        captured = capture_product((product or self.product).pk)
        return publish(captured, expected=captured.approval(), confirmed=True, storage=self.storage)

    def corrected(self):
        source = copy.deepcopy(self.source)
        source["lessons"][0]["items"][0]["example"]["en"][0]["text"] = "Tomorrow we "
        return source
