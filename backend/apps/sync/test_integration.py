import os
import shutil
import subprocess
from pathlib import Path
from unittest import skipUnless
from uuid import uuid4

from django.conf import settings
from django.test import LiveServerTestCase, override_settings

from apps.accounts.models import User
from apps.content.services import save_product
from apps.content.tests.helpers import PublicationFixture, example_source
from apps.learning.models import LessonCompletion
from .models import SyncInbox, UserChange

MOBILE = settings.BASE_DIR.parent / "mobile"
NODE = shutil.which("node")


@skipUnless(NODE and (MOBILE / "node_modules/ajv").is_dir(), "Install mobile dependencies and Node 24 for cross-stack tests.")
class MobileSyncIntegrationTests(PublicationFixture, LiveServerTestCase):
    def test_offline_runner_reopen_lost_response_and_two_clients(self):
        self.product.trial_enabled = True
        save_product(self.product)
        second = example_source(self.product, self.section)["lessons"][0]
        second["position"] = 2
        for item in second["items"]:
            item["sense_key"] += ".second"
        self.source["lessons"].append(second)
        self.import_source(self.source)
        self.publish_product()
        user = User.objects.create_user()
        token = "test-credential-" + str(uuid4())
        environment = os.environ.copy()
        environment.update(STORYLEX_TEST_SYNC_URL=self.live_server_url + "/api/v1/", STORYLEX_TEST_SYNC_TOKEN=token)
        with override_settings(CONTENT_STORAGE_ROOT=Path(self.directory.name), DEBUG=True,
                               DEV_AUTH_ALLOWED=True, DEV_SYNC_ENABLED=True,
                               DEV_SYNC_TOKEN=token, DEV_SYNC_USER_ID=str(user.pk)):
            result = subprocess.run([NODE, "--test", "--test-isolation=none", "tests/live-sync.test.ts"],
                                    cwd=MOBILE, env=environment, capture_output=True, text=True, timeout=90, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("pass 1", result.stdout)
        self.assertEqual(LessonCompletion.objects.filter(user=user).count(), 2)
        self.assertEqual(SyncInbox.objects.filter(user=user).count(), 2)
        self.assertEqual(UserChange.objects.filter(user=user).count(), 2)
