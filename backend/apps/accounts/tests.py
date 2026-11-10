import uuid

from django.contrib.auth import authenticate, get_user_model
from django.test import TestCase
from django.urls import reverse

User = get_user_model()


class UserTests(TestCase):
    def test_mobile_users_have_uuid_and_no_password_or_login(self):
        first = User.objects.create_user(email="same@example.com")
        second = User.objects.create_user(email="same@example.com")
        self.assertIsInstance(first.pk, uuid.UUID)
        self.assertNotEqual(first.pk, second.pk)
        self.assertIsNone(first.username)
        self.assertFalse(first.has_usable_password())
        self.assertEqual(User.objects.filter(email="same@example.com").count(), 2)
        self.assertIsNone(User.objects.create_user().email)

    def test_mobile_password_is_rejected(self):
        with self.assertRaisesMessage(ValueError, "reserved for staff"):
            User.objects.create_user(password="test-only-password")

    def test_superuser_can_authenticate_and_inactive_user_cannot(self):
        staff = User.objects.create_superuser("editor", password="test-only-password")
        self.assertTrue(staff.is_staff)
        self.assertTrue(staff.is_superuser)
        self.assertEqual(
            authenticate(username="editor", password="test-only-password"), staff,
        )
        staff.is_active = False
        staff.save(update_fields=("is_active",))
        self.assertIsNone(authenticate(username="editor", password="test-only-password"))

    def test_superuser_flags_and_credentials_are_required(self):
        for options in ({"is_staff": False}, {"is_superuser": False}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                User.objects.create_superuser(
                    "editor", password="test-only-password", **options,
                )
        with self.assertRaises(ValueError):
            User.objects.create_superuser("editor")

    def test_nonstaff_cannot_open_admin(self):
        self.client.force_login(User.objects.create_user())
        self.assertRedirects(
            self.client.get(reverse("admin:index")),
            reverse("admin:login") + "?next=/admin/",
        )

    def test_staff_creation_form_and_account_page(self):
        self.client.force_login(
            User.objects.create_superuser("owner", password="test-only-password"),
        )
        response = self.client.post(reverse("admin:accounts_user_add"), {
            "username": "editor", "usable_password": "true",
            "password1": "test-only-staff-password",
            "password2": "test-only-staff-password", "_save": "Save",
        })
        self.assertEqual(response.status_code, 302)
        editor = User.objects.get(username="editor")
        self.assertTrue(editor.is_staff)
        self.assertTrue(editor.check_password("test-only-staff-password"))
        self.assertEqual(self.client.get(reverse(
            "admin:accounts_user_change", args=(editor.pk,),
        )).status_code, 200)
