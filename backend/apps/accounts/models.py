import uuid

from django.contrib.auth.base_user import BaseUserManager
from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils import timezone


class UserManager(BaseUserManager):
    use_in_migrations = True

    def create_user(
        self,
        username: str | None = None,
        email: str | None = None,
        password: str | None = None,
        **extra_fields: object,
    ) -> "User":
        if password is not None and not extra_fields.get("is_staff", False):
            raise ValueError("Password login is reserved for staff accounts.")
        user = self.model(
            username=username or None,
            email=self.normalize_email(email) if email else None,
            **extra_fields,
        )
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(
        self,
        username: str,
        email: str | None = None,
        password: str | None = None,
        **extra_fields: object,
    ) -> "User":
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        if not username or not password:
            raise ValueError("A superuser requires a username and password.")
        if not extra_fields["is_staff"] or not extra_fields["is_superuser"]:
            raise ValueError("A superuser must have is_staff and is_superuser set.")
        return self.create_user(username, email, password, **extra_fields)


class User(AbstractUser):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # Optional staff login, not a mobile identity. Email is never unique.
    username = models.CharField(
        "Логин администратора", max_length=150, unique=True, null=True, blank=True,
    )
    email = models.EmailField(null=True, blank=True)
    first_name = None
    last_name = None
    date_joined = None
    created_at = models.DateTimeField(default=timezone.now, editable=False)

    objects = UserManager()
    REQUIRED_FIELDS = []

    def get_full_name(self) -> str:
        return self.username or str(self.pk)

    def get_short_name(self) -> str:
        return self.get_full_name()

    def __str__(self) -> str:
        return self.get_full_name()
