"""Local WSL development; never use runserver/settings.dev for deployment."""

import os

from .base import *  # noqa: F403

DEBUG = os.environ.get("DJANGO_DEBUG", "false").lower() == "true"

# Both the dev settings module and an explicit server opt-in are required.
DEV_AUTH_ALLOWED = True
DEV_SYNC_ENABLED = os.environ.get("STORYLEX_DEV_SYNC_ENABLED", "false").lower() == "true"
DEV_SYNC_TOKEN = os.environ.get("STORYLEX_DEV_SYNC_TOKEN", "")
DEV_SYNC_USER_ID = os.environ.get("STORYLEX_DEV_SYNC_USER_ID", "")
if DEV_SYNC_ENABLED:
    from uuid import UUID
    from django.core.exceptions import ImproperlyConfigured

    try:
        UUID(DEV_SYNC_USER_ID)
    except ValueError as exc:
        raise ImproperlyConfigured("STORYLEX_DEV_SYNC_USER_ID must be a UUID.") from exc
    if not DEBUG or len(DEV_SYNC_TOKEN) < 32:
        raise ImproperlyConfigured("Dev sync requires DEBUG and a token of at least 32 characters.")
