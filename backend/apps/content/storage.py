"""Local immutable object storage. It is deliberately NOT a Django MEDIA_ROOT."""

import hashlib
import os
import tempfile
from pathlib import Path, PurePosixPath

from django.conf import settings

from .validation import ContentError


class LocalContentStorage:
    def __init__(self, root: Path | str | None = None):
        self.root = Path(root or settings.CONTENT_STORAGE_ROOT).resolve()

    def _path(self, key: str) -> Path:
        parts = PurePosixPath(key)
        if parts.is_absolute() or ".." in parts.parts or not parts.parts or parts.parts[0] not in ("public", "private"):
            raise ContentError("storage_key", "Недопустимый ключ хранилища.")
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root):
            raise ContentError("storage_key", "Ключ выходит за пределы хранилища.")
        return path

    def read(self, key: str) -> bytes:
        try:
            return self._path(key).read_bytes()
        except OSError as exc:
            raise ContentError("storage_unavailable", "Не удалось прочитать артефакт.") from exc

    def verify(self, descriptor: dict) -> bytes:
        data = self.read(descriptor["object_key"])
        if len(data) != descriptor["byte_size"] or hashlib.sha256(data).hexdigest() != descriptor["sha256"]:
            raise ContentError("storage_corrupt", "Размер или SHA-256 артефакта не совпадает.")
        return data

    def put(self, key: str, data: bytes) -> dict:
        path = self._path(key)
        temporary = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
                temporary = stream.name
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                # Hard-link publishes a complete file and never overwrites an existing key.
                os.link(temporary, path)
            except FileExistsError:
                if path.read_bytes() != data:
                    raise ContentError("immutable_key", "Нельзя перезаписать immutable ключ.")
            directory = path.parent
            while directory.is_relative_to(self.root):
                descriptor_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(descriptor_fd)
                finally:
                    os.close(descriptor_fd)
                directory = directory.parent
        except OSError as exc:
            raise ContentError("storage_unavailable", "Не удалось записать артефакт.") from exc
        finally:
            if temporary is not None:
                Path(temporary).unlink(missing_ok=True)
        descriptor = {"object_key": key, "sha256": hashlib.sha256(data).hexdigest(), "byte_size": len(data)}
        self.verify(descriptor)
        return descriptor
