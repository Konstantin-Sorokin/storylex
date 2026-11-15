"""Temporary HTTPS transport through cloudflared; not a deployment profile.

Bind the origin to 127.0.0.1:8001 only. Cloudflare overwrites X-Forwarded-Proto;
never put this listener on a LAN or behind a proxy that trusts client headers.
"""

import os
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.core.validators import URLValidator

from .base import *  # noqa: F403

origin = os.environ.get("DJANGO_HTTPS_DEV_ORIGIN", "")
try:
    URLValidator(schemes=["https"])(origin)
    parsed_origin = urlsplit(origin)
    if (
        parsed_origin.netloc != parsed_origin.hostname
        or parsed_origin.path not in ("", "/")
        or parsed_origin.query
        or parsed_origin.fragment
    ):
        raise ValueError("Expected an HTTPS origin without credentials or port.")
except (ValidationError, ValueError) as exc:
    raise ImproperlyConfigured(
        "DJANGO_HTTPS_DEV_ORIGIN must be https://<exact-host> without a path."
    ) from exc

DEBUG = False
ALLOWED_HOSTS = [parsed_origin.hostname]
ROOT_URLCONF = "config.https_dev_urls"

# Deliberately ignore the local dev-auth opt-in, even when .env enables it.
DEV_AUTH_ALLOWED = False
DEV_SYNC_ENABLED = False
DEV_SYNC_TOKEN = ""
DEV_SYNC_USER_ID = ""

SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
CSRF_TRUSTED_ORIGINS = [origin.rstrip("/")]
# Temporary third-party host: no persistent HSTS policy for this domain.
SECURE_HSTS_SECONDS = 0

# runserver logs the full request target, including future OAuth code/state.
# Disable its access log in this isolated profile, never log credentials.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"null": {"class": "logging.NullHandler"}},
    "loggers": {
        "django.server": {"handlers": ["null"], "propagate": False},
        "django.request": {"handlers": ["null"], "propagate": False},
    },
}
