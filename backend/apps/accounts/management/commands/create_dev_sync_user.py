from django.core.management.base import BaseCommand, CommandError
from django.conf import settings
from apps.accounts.models import User


class Command(BaseCommand):
    help = "Provision the explicitly configured local, non-staff sync test user."

    def handle(self, *args, **options):
        from apps.accounts.dev_auth import dev_sync_enabled
        if not dev_sync_enabled():
            raise CommandError("Enable dev sync in settings.dev first.")
        user, _ = User.objects.get_or_create(pk=settings.DEV_SYNC_USER_ID)
        if user.is_staff or user.has_usable_password():
            if user.is_staff:
                raise CommandError("The test identity must not be staff.")
            user.set_unusable_password()
            user.save(update_fields=["password"])
        self.stdout.write(f"Development sync user: {user.pk}")
