"""The public tunnel cannot inherit the stage 1.5 local authentication bypass."""

import json
import os
import subprocess
import sys
from unittest.mock import patch
from uuid import uuid4

from django.conf import settings
from django.test import RequestFactory, SimpleTestCase, override_settings

from apps.accounts.dev_auth import dev_sync_enabled


class HttpsDevTests(SimpleTestCase):
    def load_settings(self, origin: str) -> subprocess.CompletedProcess:
        environment = {
            **os.environ,
            "DJANGO_HTTPS_DEV_ORIGIN": origin,
            "DJANGO_DEBUG": "true",
            "DJANGO_ALLOWED_HOSTS": "*",
            "STORYLEX_DEV_SYNC_ENABLED": "true",
        }
        return subprocess.run(
            [sys.executable, "-c", (
                "import json; import config.settings.https_dev as s; "
                "print(json.dumps({k: getattr(s, k) for k in "
                "['DEBUG', 'ALLOWED_HOSTS', 'DEV_AUTH_ALLOWED', 'DEV_SYNC_ENABLED', "
                "'ROOT_URLCONF', 'SECURE_PROXY_SSL_HEADER', 'SECURE_SSL_REDIRECT', "
                "'SESSION_COOKIE_SECURE', 'CSRF_COOKIE_SECURE', 'LOGGING']}))"
            )],
            cwd=settings.BASE_DIR, env=environment,
            capture_output=True, text=True, check=False,
        )

    def test_requires_exact_https_origin(self):
        for origin in (
            "", "http://dev.example.org", "https://*.example.org",
            "https://dev.example.org/path", "https://user:secret@dev.example.org",
            "https://dev.example.org:443", "https://dev.example.org?query=1",
            "https://dev.example.org/#fragment",
        ):
            with self.subTest(origin=origin):
                result = self.load_settings(origin)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("DJANGO_HTTPS_DEV_ORIGIN must be", result.stderr)

    def test_profile_overrides_local_debug_and_dev_auth(self):
        result = self.load_settings("https://dev.example.org")
        self.assertEqual(result.returncode, 0, result.stderr)
        profile = json.loads(result.stdout)
        self.assertEqual(profile["ALLOWED_HOSTS"], ["dev.example.org"])
        self.assertEqual(profile["ROOT_URLCONF"], "config.https_dev_urls")
        self.assertEqual(profile["SECURE_PROXY_SSL_HEADER"], ["HTTP_X_FORWARDED_PROTO", "https"])
        self.assertTrue(profile["SESSION_COOKIE_SECURE"])
        self.assertTrue(profile["CSRF_COOKIE_SECURE"])
        self.assertTrue(profile["SECURE_SSL_REDIRECT"])
        with override_settings(**{k: v for k, v in profile.items() if k != "LOGGING"}):
            self.assertFalse(dev_sync_enabled())
            # Spoofed client flags/credentials cannot enable private routes.
            for path in (
                "/admin/", "/api/v1/dev/session",
                "/api/v1/sync/changes", "/api/v1/sync/operations",
            ):
                with self.subTest(path=path):
                    response = self.client.get(
                        path, HTTP_HOST="dev.example.org", HTTP_X_FORWARDED_PROTO="https",
                        HTTP_AUTHORIZATION="Bearer arbitrary-dev-token",
                    )
                    self.assertEqual(response.status_code, 404)
                    self.assertNotIn(b"Traceback", response.content)
            self.assertEqual(self.client.get(
                "/api/v1/catalog/head", HTTP_HOST="attacker.example.org",
                HTTP_X_FORWARDED_PROTO="https",
            ).status_code, 400)
            response = self.client.get("/api/v1/catalog/head", HTTP_HOST="dev.example.org")
            self.assertEqual(response.status_code, 301)
            self.assertEqual(response["Location"], "https://dev.example.org/api/v1/catalog/head")

            # Existing descriptors must retain the public HTTPS host, never localhost/http.
            request = RequestFactory().get(
                "/api/v1/catalog/head", HTTP_HOST="dev.example.org",
                HTTP_X_FORWARDED_PROTO="https",
            )
            self.assertTrue(request.is_secure())
            self.assertEqual(request.build_absolute_uri("/api/v1/content/downloads"),
                             "https://dev.example.org/api/v1/content/downloads")
            with patch("apps.content.api.active_catalog") as catalog, patch(
                "apps.content.api.LocalContentStorage.verify"
            ):
                catalog.return_value.pk = uuid4()
                catalog.return_value.object_key = "catalog/test.json"
                catalog.return_value.sha256 = "a" * 64
                catalog.return_value.byte_size = 10
                catalog.return_value.schema_version = 1
                response = self.client.get(
                    "/api/v1/catalog/head", HTTP_HOST="dev.example.org",
                    HTTP_X_FORWARDED_PROTO="https",
                )
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.json()["url"].startswith("https://dev.example.org/"))
