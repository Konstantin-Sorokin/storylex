"""Explicit, server-configured local test identity. Never enabled by base settings."""
from secrets import compare_digest

from django.conf import settings
from rest_framework.authentication import (
    BaseAuthentication, get_authorization_header,
)
from rest_framework.exceptions import AuthenticationFailed

from .models import User


def dev_sync_enabled() -> bool:
    return bool(
        getattr(settings, "DEV_AUTH_ALLOWED", False)
        and getattr(settings, "DEV_SYNC_ENABLED", False)
        and settings.DEBUG
    )


class DevAuthentication(BaseAuthentication):
    def authenticate(self, request):
        if not dev_sync_enabled():
            return None
        header = get_authorization_header(request).split()
        token = getattr(settings, "DEV_SYNC_TOKEN", "")
        if len(header) != 2 or header[0].lower() != b"bearer":
            return None
        if not token or not compare_digest(header[1], token.encode()):
            raise AuthenticationFailed("Invalid development credential.")
        user = User.objects.filter(
            pk=settings.DEV_SYNC_USER_ID, is_active=True, is_staff=False,
        ).first()
        if user is None:
            raise AuthenticationFailed("Development user is not provisioned.")
        return user, None

    def authenticate_header(self, request):
        return "Bearer"
