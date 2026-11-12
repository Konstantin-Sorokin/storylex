from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse

from apps.content.models import Author, Product, Section


class CatalogAdminTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.staff = get_user_model().objects.create_superuser(
            "owner", password="test-only-password",
        )
        cls.author = Author.objects.create(name_ru="Автор", name_en="Author")

    def product_data(self, **changes):
        data = {
            "kind": "book", "author": str(self.author.pk),
            "title_ru": "Книга", "title_en": "Book", "year": "2026",
            "cefr_min": "A2", "cefr_max": "B1",
            "access_mode": "free", "price_minor": "0", "_save": "Save",
            "availability": "available",
        }
        data.update(changes)
        return data

    def test_all_initial_models_registered_and_accessible(self):
        self.client.force_login(self.staff)
        for model in ("author", "bookseries", "show", "product", "section", "contentdraft"):
            with self.subTest(model=model):
                response = self.client.get(reverse(f"admin:content_{model}_changelist"))
                self.assertEqual(response.status_code, 200)
        for model in ("author", "bookseries", "show", "product", "section"):
            with self.subTest(model=model):
                self.assertEqual(self.client.get(reverse(
                    f"admin:content_{model}_add",
                )).status_code, 200)

    def test_anonymous_cannot_read_editorial_data(self):
        for model in ("product", "section", "contentdraft"):
            with self.subTest(model=model):
                self.assertEqual(self.client.get(reverse(
                    f"admin:content_{model}_changelist",
                )).status_code, 302)

    def test_create_product_and_section_in_admin(self):
        self.client.force_login(self.staff)
        response = self.client.post(
            reverse("admin:content_product_add"), self.product_data(),
        )
        self.assertEqual(response.status_code, 302)
        product = Product.objects.get()
        response = self.client.post(reverse("admin:content_section_add"), {
            "product": str(product.pk), "kind": "chapter", "position": "1",
            "title_ru": "Глава 1", "title_en": "Chapter 1", "_save": "Save",
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(Section.objects.get().product_id, product.pk)
        self.assertEqual(self.client.get(reverse(
            "admin:content_product_change", args=(product.pk,),
        )).status_code, 200)

    def test_admin_rejects_invalid_product_and_section(self):
        self.client.force_login(self.staff)
        response = self.client.post(reverse("admin:content_product_add"),
                                    self.product_data(kind="movie"))
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.context["adminform"].form.errors)
        self.assertFalse(Product.objects.exists())
        product = Product.objects.create(
            kind="book", author=self.author, title_ru="Книга", title_en="Book",
            year=2026, cefr_min="A1", cefr_max="A2",
        )
        response = self.client.post(reverse("admin:content_section_add"), {
            "product": str(product.pk), "kind": "episode", "position": "1",
            "title_ru": "Глава", "title_en": "Chapter", "_save": "Save",
        })
        self.assertEqual(response.status_code, 200)
        self.assertIn("kind", response.context["adminform"].form.errors)
        self.assertFalse(Section.objects.exists())

    def test_direct_draft_creation_and_auth_api_are_unavailable(self):
        self.client.force_login(self.staff)
        self.assertEqual(self.client.get(reverse(
            "admin:content_contentdraft_add",
        )).status_code, 403)
        self.assertEqual(self.client.get("/api/v1/catalog/head").status_code, 503)
        for path in ("/api/v1/auth/exchange",):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)
