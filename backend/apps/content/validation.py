"""Schema and semantic validation of source v1; never mutates published data."""

import copy
import hashlib
import json
import unicodedata
from functools import lru_cache
from uuid import UUID

from django.conf import settings
from jsonschema import Draft202012Validator, FormatChecker

MAX_DOCUMENT_BYTES = 10 * 1024 * 1024


class ContentError(Exception):
    def __init__(self, code: str, message: str, path: str = "/"):
        self.code = code
        self.path = path
        self.message = message
        super().__init__(f"{path}: {message} [{code}]")


def canonical_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value: object) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def normalized(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).casefold().split())


def _pairs(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ContentError("duplicate_key", "Повторяющийся ключ JSON.")
        result[key] = value
    return result


def _constant(value: str) -> None:
    raise ContentError("invalid_json", "NaN/Infinity не являются допустимым JSON.")


def parse_source(data: bytes) -> dict:
    if len(data) > MAX_DOCUMENT_BYTES:
        raise ContentError("document_too_large", "Документ превышает 10 MiB.")
    try:
        source = json.loads(data.decode("utf-8"), object_pairs_hook=_pairs,
                            parse_constant=_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ContentError("invalid_json", "Нужен корректный JSON в UTF-8.") from exc
    return validate_source(source)


@lru_cache(maxsize=1)
def source_validator() -> Draft202012Validator:
    path = settings.BASE_DIR.parent / "contracts/content/v1/source.schema.json"
    schema = json.loads(path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker(formats=["uuid"]))


def _normalize_ids(value):
    if isinstance(value, dict):
        return {key: (str(UUID(item)) if key in (
            "id", "product_id", "section_id", "correct_option_id",
        ) and item is not None else _normalize_ids(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize_ids(item) for item in value]
    return value


def _check_texts(value, path="") -> None:
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise ContentError("invalid_unicode", "Недопустимая Unicode-последовательность.", path) from exc
    if isinstance(value, str) and not normalized(value):
        raise ContentError("empty_text", "Текст не может состоять из пробелов.", path)
    if isinstance(value, dict):
        for key, child in value.items():
            _check_texts(child, f"{path}/{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _check_texts(child, f"{path}/{index}")


def validate_source(source: object) -> dict:
    try:
        error = next(source_validator().iter_errors(source), None)
    except RecursionError as exc:
        raise ContentError("invalid_json", "Слишком глубокая структура JSON.") from exc
    if error:
        path = "/" + "/".join(str(part) for part in error.absolute_path)
        message = {
            "format": "Ожидается UUID в стандартном формате.",
            "type": f"Неверный тип; ожидается {error.validator_value}.",
            "const": "Неподдерживаемая версия схемы.",
            "enum": "Недопустимое значение перечисления.",
            "minItems": f"Нужно не менее {error.validator_value} элементов.",
            "maxItems": f"Допустимо не более {error.validator_value} элементов.",
            "minLength": "Текст не может быть пустым.",
            "minimum": f"Значение должно быть не меньше {error.validator_value}.",
        }.get(error.validator, "Нарушение структуры JSON.")
        if error.validator == "required":
            missing = [key for key in error.validator_value if key not in error.instance]
            message = "Отсутствуют обязательные поля: " + ", ".join(missing) + "."
        elif error.validator == "additionalProperties":
            unknown = set(error.instance) - error.schema.get("properties", {}).keys()
            message = "Недопустимые поля: " + ", ".join(sorted(unknown)) + "."
        raise ContentError("schema_invalid", message, path)
    source = _normalize_ids(copy.deepcopy(source))
    _check_texts(source)
    if type(source["schema_version"]) is not int:
        raise ContentError("schema_invalid", "Версия схемы должна быть целым числом.", "/schema_version")
    lessons = source["lessons"]
    if [lesson["position"] for lesson in lessons] != list(range(1, len(lessons) + 1)):
        raise ContentError("lesson_positions", "Уроки должны идти по порядку 1…N.", "/lessons")
    identity_map([source])
    for li, lesson in enumerate(lessons):
        for lang in ("en", "ru"):
            labels = [normalized(item[lang]) for item in lesson["items"]]
            if len(set(labels)) != 5:
                raise ContentError("ambiguous_pairs", "Подписи пяти пар должны различаться.",
                                   f"/lessons/{li}/items")
        for ii, item in enumerate(lesson["items"]):
            path = f"/lessons/{li}/items/{ii}"
            for lang in ("en", "ru"):
                if not any(part["target"] for part in item["example"][lang]):
                    raise ContentError("missing_target", "Нужен целевой сегмент в обоих языках.",
                                       f"{path}/example/{lang}")
            for kind, question in item["exercises"].items():
                qpath = f"{path}/exercises/{kind}"
                options = {option["id"]: option["text"] for option in question["options"]}
                if question["correct_option_id"] not in options:
                    raise ContentError("answer_reference", "Ответ не входит в варианты.", qpath)
                if len({normalized(text) for text in options.values()}) != 4:
                    raise ContentError("duplicate_options", "Тексты вариантов должны различаться.", qpath)
                if kind == "word_to_translation" and (
                        question["prompt"] != item["en"]
                        or options[question["correct_option_id"]] != item["ru"]
                ):
                    raise ContentError("translation_mismatch", "Вопрос/ответ не совпадает с en/ru единицы.", qpath)
    return source


def identity_map(documents: list[dict]) -> dict:
    identities = {}
    senses = set()

    def add(identifier, identity, path):
        if identifier in identities:
            raise ContentError("duplicate_id", "UUID повторяется в документе/материале.", path)
        identities[identifier] = identity

    for document in documents:
        for li, lesson in enumerate(document["lessons"]):
            path = f"/lessons/{li}"
            add(lesson["id"], ["lesson", document["product_id"], document["section_id"]], path)
            add(lesson["pairs"]["id"], ["pairs", lesson["id"]], path + "/pairs/id")
            for ii, item in enumerate(lesson["items"]):
                ipath = f"{path}/items/{ii}"
                # PostgreSQL btree key limits: reject oversized editorial keys explicitly.
                if len(item["sense_key"]) > 255:
                    raise ContentError("sense_key_too_long", "sense_key не длиннее 255 символов.", ipath)
                sense = normalized(item["sense_key"])
                if sense in senses:
                    raise ContentError("duplicate_sense", "sense_key повторяется в Product.", ipath)
                senses.add(sense)
                add(item["id"], ["item", lesson["id"], item["sense_key"]], ipath + "/id")
                for kind, question in item["exercises"].items():
                    qpath = f"{ipath}/exercises/{kind}"
                    add(question["id"], ["exercise", item["id"], kind], qpath + "/id")
                    for oi, option in enumerate(question["options"]):
                        add(option["id"], ["option", question["id"]], f"{qpath}/options/{oi}/id")
    return identities
