# Storylex

Мобильное приложение для изучения английского по книгам, фильмам и сериалам.
Архитектура и требования: [docs/architecture.md](docs/architecture.md),
[docs/requirements.md](docs/requirements.md).

Реализован только **этап 1.1**: фундамент Django-бэкенда и редактирование
начального каталога. Импорт, публикация, API мобильного приложения и само
мобильное приложение ещё не реализованы.

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
страницы и API на этом этапе нет.

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
Год/авторы книжной серии не вводятся вручную: они будут вычисляться из
опубликованных книг при реализации снимка каталога.

Модели: `accounts.User`; `content.Author`, `BookSeries`, `Show`, `Product`,
`Section`, `ContentDraft`. Все предметные PK — UUID. `User.username` —
необязательный уникальный логин для staff/Admin; мобильные аккаунты создаются
без логина с неиспользуемым паролем. Email необязательный, неуникальный,
не объединяет аккаунты. Создание staff через Admin включает `is_staff`,
но не выдаёт права на каталог: назначьте их явно или используйте superuser.
Парольный API для мобильных пользователей отсутствует.

Все метаданные сейчас редакционные. Кнопок публикации и публичной выдачи нет.
`ContentDraft` — только заготовка хранилища: пустой `source_hash` и
`validation_version=NULL` означают, что документ не валидирован.
В Admin черновик доступен только для просмотра, без создания/изменения/удаления.
Импорт, вычисление hash, проверка JSON и публикация относятся к **1.2**.
Модели Lesson/LearningItem появятся вместе с обслуживающим их реестр кодом;
PublishedRevision, CatalogRevision/Head, Asset и файлы пока не создаются.

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

Не редактируйте применённые миграции. Сейчас есть только начальные миграции,
перехода с предыдущей версии приложения ещё нет.

## Зависимости и границы

`backend/uv.lock` фиксирует разрешённые версии и хеши. Django 5.2 выбран как
[LTS](https://docs.djangoproject.com/en/5.2/releases/5.2/); DRF — согласованный
стек REST API (сам Django не предоставляет его serializers/permissions).
`psycopg[binary]` — драйвер PostgreSQL с готовой libpq для WSL без компилятора;
альтернатива `psycopg[c]` требует системных libpq/build tools. Стоимость
поддержки — обновлять lockfile и повторять проверки совместимости трёх
прямых зависимостей; обновление бинарного драйвера обновляет и его libpq.
См. [DRF](https://www.django-rest-framework.org/) и
[установку Psycopg](https://www.psycopg.org/psycopg3/docs/basic/install.html).
Для конфигурации используются `os.environ` и загрузчик env-файла uv;
dotenv/django-environ не нужны. Тесты — средствами Django, без дополнительных
инструментов. PostgreSQL закреплена в `infra/compose.yaml` на 17.10.

Проверено 10.11.2026: `uv sync --locked`, Compose config и запуск healthy БД,
PostgreSQL 17.10, начальные миграции, 28 тестов, повторный migrate с сохранением
каталога, `check --database default`, `makemigrations --check --dry-run`.
HTTP: Admin/login и CSS — 200, закрытый Admin без входа — 302.
Аутентифицированные страницы и создание Product/Section проверены Django-клиентом
в тестах. Windows-браузер и отладчик PyCharm автоматически не проверялись;
WSL SDK нужно подключить в IDE вручную.

Это локальный фундамент, не production-развёртывание: HTTPS, WSGI-сервер,
резервирование и эксплуатационная защита Admin требуют отдельной настройки.
OAuth, SRS, платежи, sync, JSON import/publication, мобильный проект и dev-auth
не реализованы. Переход к 1.2 требует отдельного согласования владельца.
