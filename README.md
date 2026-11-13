# Storylex

Мобильное приложение для изучения английского по книгам, фильмам и сериалам.
Архитектура и требования: [docs/architecture.md](docs/architecture.md),
[docs/requirements.md](docs/requirements.md).

Реализованы и приняты **этапы 1.1–1.4**: фундамент Django-бэкенда, каталог, строгий
импорт JSON через Admin, черновики, атомарная публикация immutable-пакетов и
мобильный Expo-каркас с постоянным SQLite-хранилищем опубликованных проб.
Пошаговый пример: [импорт и публикация](docs/content-authoring.md).
Мобильный запуск и ручная проверка: [этап 1.3](docs/mobile-development.md).
В 1.4 добавлены прохождение урока, локальные dev-результаты и короткое повторение.
Ручная проверка: [уроки на Android](docs/lesson-development.md).
Серверная синхронизация прогресса ещё не реализована; этап 1.5 не начат.

## Локальная среда: WSL2 Ubuntu

Нужны Python 3.14 (выбран в `backend/.python-version`), `uv`, Docker Desktop
с Compose v2 и включённой интеграцией с Ubuntu. Python-проект допускает
3.12–3.14; текущая проверяемая среда — 3.14.4.

Все команды ниже выполняются в терминале **Ubuntu/WSL**, не PowerShell.
Репозиторий и `.venv` находятся в Linux-файловой системе.
В Docker Desktop включите Settings → Resources → WSL Integration → Ubuntu →
Apply & restart. Перед запуском проверьте `docker compose version` и `docker info`.
См. [официальную инструкцию Docker](https://docs.docker.com/desktop/features/wsl/).
После изменения членства в группе `docker` откройте новую WSL-сессию;
у уже запущенных процессов IDE права автоматически не обновляются.

На этапе 1.1 Compose запускает только PostgreSQL; Django работает в WSL,
чтобы PyCharm использовал тот же интерпретатор и отладчик. Дополнительный
контейнер приложения пока не нужен.

## Первый запуск

Из корня репозитория:

```bash
cp .env.example .env
chmod 600 .env
```

Заполните в `.env` пустые `DJANGO_SECRET_KEY` и `POSTGRES_PASSWORD` разными
случайными значениями. Например, `openssl rand -hex 48` и `openssl rand -hex 24`.
Это локальные секреты: не добавляйте их в Git и не присылайте в отчётах.
Существующий `.env` повторно не копируйте. Другие значения примера подходят
для локального запуска. `.env` и `.venv` исключены существующим `.gitignore`.

```bash
docker compose --env-file .env -f infra/compose.yaml up -d --wait db
docker compose --env-file .env -f infra/compose.yaml ps

cd backend
uv sync --locked
uv run --env-file ../.env manage.py migrate
uv run --env-file ../.env manage.py createsuperuser
uv run --env-file ../.env manage.py runserver 127.0.0.1:8000
```

Admin: **http://127.0.0.1:8000/admin/** (из Windows также можно открыть
http://localhost:8000/admin/). Корневой URL `/` возвращает 404: отдельной
страницы нет. Опубликованный каталог: `/api/v1/catalog/head` (503 до публикации).

Для повседневного запуска достаточно `up -d --wait db` из корня и `runserver`
из `backend`. Остановка БД из корня:

```bash
docker compose --env-file .env -f infra/compose.yaml stop db
```

Данные сохраняются в именованном volume `storylex_postgres_data`. Не удаляйте
volume для исправления миграций. Переменные `POSTGRES_*` инициализируют роли
и БД только при первом создании volume: изменение пароля в `.env` само по
себе не меняет пароль уже существующей роли PostgreSQL.
Если порт занят, измените `POSTGRES_PORT` в `.env`: он используется и Django,
и Compose. PostgreSQL опубликован только на `127.0.0.1`.

`.env` загружает **uv** через `--env-file`, Django сам этот файл не читает.
Реальные переменные процесса имеют приоритет. Без обязательных переменных
Django завершает запуск с `ImproperlyConfigured`; SQLite-подмены нет.

## PyCharm

Добавьте существующий **WSL-интерпретатор** Ubuntu:
`/home/konstantin/projects/storylex/backend/.venv/bin/python` (или путь своего checkout).
Не создавайте Windows-окружение по UNC-пути `\\wsl.localhost\...`.
В настройках Django укажите `backend` как project root, `backend/manage.py`
как manage script, `backend/config/settings/dev.py` как settings.
У run configuration рабочая папка — `backend`, переменные — из корневого
`.env` через поле env files вашей версии IDE либо через Environment variables.
Можно запускать приведённые команды `uv` во встроенном WSL-терминале.
Локальную конфигурацию `.idea` в Git не добавлять.

## Начальный каталог в Admin

1. Создайте автора с обоими именами `name_ru` и `name_en`.
2. Создайте Product типа `book`: автор, год, названия ru/en, диапазон CEFR.
   Для бесплатной тестовой книги оставьте `access_mode=free`, `price_minor=0`.
3. Создайте Section типа `chapter`, привяжите книгу и задайте `position=1`.

У книги в серии нужен номер внутри серии; у сезона — сериал и номер сезона;
у фильма нет родителя, автора или секций. Цена задаётся в копейках, валюта
RUB; у платного материала цена строго положительна. Имена автора не уникальны.
Год/авторы книжной серии не вводятся вручную: они вычисляются из опубликованных
книг при формировании снимка каталога.

Модели: `accounts.User`; `content.Author`, `BookSeries`, `Show`, `Product`,
`Section`, `ContentDraft`, `Lesson`, `LearningItem`, `PublishedRevision`,
`PackArtifact`, `CatalogRevision`, `CatalogHead`; `feedback.PublicationEvent`.
Все предметные PK — UUID; у singleton CatalogHead ключ 1. `User.username` —
необязательный уникальный логин для staff/Admin; мобильные аккаунты создаются
без логина с неиспользуемым паролем. Email необязательный, неуникальный,
не объединяет аккаунты. Создание staff через Admin включает `is_staff`,
но не выдаёт права на каталог: назначьте их явно или используйте superuser.
Парольный API для мобильных пользователей отсутствует.

Формы метаданных редактируют только проект каталога. «Импорт JSON» на главе/
эпизоде или фильме атомарно заменяет ContentDraft, но не действующий пакет.
«Опубликовать полный материал» у Product требует отдельного подтверждения
полноты и смысловой проверки. Есть diff, проверка устаревшего подтверждения,
full/trial manifests и каталог с SHA-256. «Опубликовать метаданные» выпускает
каталог без новой учебной ревизии. Файлы скачиваются из readonly-страниц Admin;
публичный API 1.3 выдаёт только каталог и разрешённые trial-пакеты, full остаётся
закрытым. Источники с validation_version=NULL из
1.1 сохраняются при миграции, но перед публикацией требуют корректного импорта.
Обложки остаются null; Asset/upload пока не реализованы.

SQL-ограничения защищают связи Product, порядки, цены и CEFR.
Соответствие типа секции её Product проверяют `Model.clean()` и
транзакционные `content.services.save_product/save_section`, используемые Admin.
При ручной работе через shell используйте эти сервисы: обычные `save()` и
`QuerySet.update()` не вызывают `full_clean()` и не проверяют чужие строки.
Прямое изменение FK/типов SQL-запросами обходит сервисную валидацию.

## Проверки и миграции

Из `backend` при работающей PostgreSQL:

```bash
uv run --env-file ../.env manage.py check --database default
uv run --env-file ../.env manage.py makemigrations --check --dry-run
uv run --env-file ../.env manage.py showmigrations
uv run --env-file ../.env manage.py test --settings=config.settings.test
```

Используется стандартный Django TestCase/test runner, без pytest и SQLite.
Тесты создают и удаляют отдельную `test_storylex`, не очищают рабочую БД.
Локальная роль из Compose может создавать тестовую БД; это только dev-роль,
не образец production-привилегий. Не направляйте тесты на production.
Проверяются ограничения в реальной PostgreSQL, стабильность UUID при правках,
структура, черновики, парольный staff-вход, запрет доступа посторонним,
формы Admin, обязательные переменные и закрытые по умолчанию DRF permissions.

После согласованного изменения моделей создавайте новую миграцию:

```bash
uv run --env-file ../.env manage.py makemigrations
uv run --env-file ../.env manage.py migrate
```

Не редактируйте применённые миграции. Обновление с 1.1 на 1.2 проверяется отдельным
тестом с существующими Product/Section/ContentDraft, их UUID и данными.

## Зависимости и границы

`backend/uv.lock` фиксирует разрешённые версии и хеши. Django 5.2 выбран как
[LTS](https://docs.djangoproject.com/en/5.2/releases/5.2/); DRF — согласованный
стек REST API (сам Django не предоставляет его serializers/permissions).
`psycopg[binary]` — драйвер PostgreSQL с готовой libpq для WSL без компилятора;
альтернатива `psycopg[c]` требует системных libpq/build tools. Стоимость
поддержки — обновлять lockfile и повторять проверки совместимости трёх
основных зависимостей; обновление бинарного драйвера обновляет и его libpq.
См. [DRF](https://www.django-rest-framework.org/) и
[установку Psycopg](https://www.psycopg.org/psycopg3/docs/basic/install.html).
Для конфигурации используются `os.environ` и загрузчик env-файла uv;
dotenv/django-environ не нужны. Тесты — средствами Django, без дополнительных
инструментов. PostgreSQL закреплена в `infra/compose.yaml` на 17.10.

В 1.2 добавлена `jsonschema` для согласованной Draft 2020-12 и явного FormatChecker
UUID ([документация](https://python-jsonschema.readthedocs.io/en/stable/validate/)).
Альтернатива — вручную дублировать схему валидаторами Django; это повышает риск
расхождения контрактов. Стоимость поддержки — одна прямая зависимость с её
транзитивными пакетами в uv.lock и повторная проверка схемы при обновлении.
Исходники/пакеты по умолчанию хранятся в игнорируемой `backend/.content-storage/`,
не в MEDIA_ROOT. Подробности и ограничения — в [инструкции автора](docs/content-authoring.md).

Проверено на этапе 1.1 (10.11.2026): `uv sync --locked`, Compose config и запуск healthy БД,
PostgreSQL 17.10, начальные миграции, 28 тестов, повторный migrate с сохранением
каталога, `check --database default`, `makemigrations --check --dry-run`.
HTTP: Admin/login и CSS — 200, закрытый Admin без входа — 302.
Аутентифицированные страницы и создание Product/Section проверены Django-клиентом
в тестах. Windows-браузер и отладчик PyCharm автоматически не проверялись;
WSL SDK нужно подключить в IDE вручную.

На этапе 1.2 (10.11.2026) прошли **74 теста** на PostgreSQL: импорт и ошибки,
отделение черновиков, full/trial, immutable-файлы и SQL-строки, сохранение UUID,
повторы Admin, сбои/откаты, конкуренция, чтение head до commit и миграция с 1.1.
Новые миграции применены к рабочей БД; `check --database default`, отсутствие
миграционного дрейфа и `uv sync --locked` проверены. Структура исходной схемы v1
сохранена; инструкция и ограничения находятся в `docs/content-authoring.md`.

Это локальный фундамент, не production-развёртывание: HTTPS, WSGI-сервер,
резервирование и эксплуатационная защита Admin требуют отдельной настройки.
OAuth, SRS, платежи, sync и dev-auth не реализованы.

В 1.3 добавлены `mobile/` (Expo SDK 58, TypeScript strict, Router, SQLite), общие
схемы catalog/manifest и минимальная публичная доставка каталога/проб в Django.
Клиент проверяет SHA-256/размер/схему/UUID и активирует пакет атомарно;
экраны читают SQLite, обычный повторный запуск не запрашивает контент.
Библиотека не пополняется пробами. Backend-модели/миграции не менялись.
Проверено: 87 Django-тестов (включая HTTP → клиентская SQLite), 11 клиентских
тестов; npm ci, TypeScript, Expo module check, Android JS/Hermes export,
Django check с БД и отсутствие миграционного дрейфа. Отдельный live-тест npm
ожидаемо пропущен без адреса API; в Django suite он выполнен.
Проверки и ограничения, включая native Android и npm audit, описаны в
[мобильной инструкции](docs/mobile-development.md).
12.11.2026 этап 1.3 принят владельцем после проверки на реальном Android через
Expo Go: API, опубликованный каталог, сохранение и повторное открытие пробной
главы из SQLite без Django и интернета, восстановление каталога после возвращения
соединения. Перед коммитами повторно прошли 87 Django-тестов, 11 клиентских тестов,
TypeScript, Android export, Django check с БД и проверка миграционного дрейфа;
Expo module check использовал локальную карту версий в offline-режиме.
В 1.4 реализованы 16 основных заданий W/R/E + пары, 0–5 отработок, простые итоги,
пять контекстных вопросов повторения и сохранение результата после последнего
ответа в отдельной dev-SQLite. Пакет закрепляется на время урока, обновление ждёт
в ready_packages. Новых зависимостей, изменений JSON или серверных миграций нет.
13.11.2026 этап 1.4 принят владельцем после ручной проверки Android: 16 заданий,
отработка ошибок, сохранение результата в SQLite, статус завершённого урока,
короткое повторение из пяти заданий и скачанный контент без интернета.
Выход из незавершённого урока вручную не проверен; обработчики «Остаться»/«Выйти»,
защита финальной записи и повторный вход после закрытия SQLite покрыты тестами.
Перед сохранением этапа прошли 44 клиентских теста (1 standalone live-тест
ожидаемо пропущен), 87 Django-тестов со сквозным LiveServer → SQLite, TypeScript,
Android JS/Hermes export, Django check с БД и проверка миграционного дрейфа.
Expo module check использовал локальную карту версий в offline-режиме.
Текущий UI временный; полный редизайн будет отдельным этапом после основных функций.
Границы локальных результатов и сценарии — в [инструкции 1.4](docs/lesson-development.md).
Переход к 1.5 требует отдельного согласования владельца.
