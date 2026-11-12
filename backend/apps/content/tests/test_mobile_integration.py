"""Optional cross-stack check: Django's real test HTTP server and Node SQLite.

Enabled when the mobile dependencies have been installed. No development data
or real accounts are changed: both databases and storage are disposable.
"""

import os
import shutil
import subprocess
from pathlib import Path
from unittest import skipUnless

from django.conf import settings
from django.test import LiveServerTestCase, override_settings

from apps.content.services import save_product
from .helpers import PublicationFixture

MOBILE = settings.BASE_DIR.parent / "mobile"
NODE = shutil.which("node")


@skipUnless(NODE and (MOBILE / "node_modules/ajv").is_dir(), "Install mobile dependencies and Node 24 for cross-stack tests.")
class MobileDeliveryIntegrationTests(PublicationFixture, LiveServerTestCase):
    def setUp(self):
        super().setUp()
        override = override_settings(CONTENT_STORAGE_ROOT=Path(self.directory.name))
        override.enable()
        self.addCleanup(override.disable)
        self.product.trial_enabled = True
        save_product(self.product)
        self.publish_product()

    def test_real_published_chapter_survives_mobile_sqlite_reopen(self):
        environment = os.environ.copy()
        environment["STORYLEX_TEST_API_URL"] = self.live_server_url + "/api/v1/"
        result = subprocess.run(
            [NODE, "--test", "--test-isolation=none", "tests/live-backend.test.ts"],
            cwd=MOBILE, env=environment, capture_output=True, text=True, timeout=90, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("pass 1", result.stdout)
