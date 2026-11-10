"""Local WSL development; never use runserver/settings.dev for deployment."""

import os

from .base import *  # noqa: F403

DEBUG = os.environ.get("DJANGO_DEBUG", "false").lower() == "true"
