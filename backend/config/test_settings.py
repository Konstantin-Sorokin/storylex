import os
import subprocess
import sys

from django.conf import settings
from django.test import SimpleTestCase


class SettingsTests(SimpleTestCase):
    def test_missing_secrets_fail_closed(self):
        for name in ("DJANGO_SECRET_KEY", "POSTGRES_PASSWORD"):
            environment = os.environ.copy()
            environment.pop(name, None)
            result = subprocess.run(
                [sys.executable, "-c", "import config.settings.base"],
                env=environment, cwd=settings.BASE_DIR,
                capture_output=True, text=True, check=False,
            )
            with self.subTest(name=name):
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"{name} is required", result.stderr)

    def test_postgresql_and_default_api_permissions(self):
        self.assertEqual(settings.AUTH_USER_MODEL, "accounts.User")
        self.assertEqual(settings.DATABASES["default"]["ENGINE"],
                         "django.db.backends.postgresql")
        self.assertEqual(settings.REST_FRAMEWORK["DEFAULT_PERMISSION_CLASSES"],
                         ["rest_framework.permissions.IsAuthenticated"])
