# Этап 2.1: первая Android development build через EAS

15.11.2026 владелец подтвердил **успешную EAS Build**, установленный на реальный
Android APK, запуск Storylex Dev через Metro, подключение к Django и dev-вход.
Проект привязан владельцем; реальные несекретные owner/projectId сохранены
в app.json. Облачную сборку и signing credentials настраивал владелец, не агент.
Этап 2.1 завершён в этом объёме; внешний HTTPS не проверен, 2.2 не начинается.

## 1. Подготовленная конфигурация

`mobile/eas.json` содержит только профиль `development`: `developmentClient: true`,
`distribution: internal`, Android `buildType: apk`, явный `:app:assembleDebug`.
Именно debug нужен существующему `__DEV__` shell и Metro. Node закреплён на
24.19.0, версия приложения берётся локально, autoIncrement нет, commit не требуется.
EAS CLI для инструкции проверен на **27.10.0**, установлен временно вне проекта;
зависимости и lockfile Storylex в этой задаче не менялись.
[Схема EAS](https://docs.expo.dev/eas/json/).

Package `app.storylex.mobile.dev`, scheme `storylex-dev` и native deep links
сохранены. Существующий `mobile/android/` входит в архив, поэтому EAS использует
его и **не запускает Prebuild**. Здесь нет повторной генерации native-проекта.
Не используйте для первой сборки чистый clone/сборку из GitHub: Android-каталог
пока исключён из Git. Запускайте EAS из текущего WSL checkout с проверенным
`android/`. Изменения app.json/plugins сами в него не применяются; после будущих
native-изменений понадобится осознанное обновление проекта и новая проверка.

## 2. Что попадёт в облако

Корневая `.easignore` ограничивает архив мобильными исходниками/config, native
Android и `contracts/content/`. Схемы нужны импортам из `src/domain/validation.ts`;
сохраняется расположение `mobile/` рядом с `contracts/`.

Не входят backend, infra, docs, Git-история, редакционные fixtures, `.env` и его
варианты (включая примеры), `.npmrc`, dev-токены, SQLite, node_modules, сборочные
кэши/результаты, local.properties, credentials.json и signing keys. Проверялись
имена локальных env-переменных без вывода значений: в mobile только публичный API URL.

`.easignore` лежит **в корне Git-репозитория**, хотя команды и eas.json — в mobile.
Она заменяет правила всех `.gitignore`, поэтому exclusions записаны явно.
Это allowlist: добавляя новый config/ресурс, проверьте, что он действительно попал
в архив. [Правила архива](https://docs.expo.dev/build-reference/easignore/).

Локальный `android/app/debug.keystore` также не загружается. Профиль использует
`credentialsSource: remote`: **при вашем запуске** EAS предложит настроить ключ
для dev-package и внедрит signing configuration на build worker, в том числе
для debug. Не выбирайте production-ключ; создание отдельного dev-keystore должно
быть вашим явным ответом. Не включайте `withoutCredentials`: для этой конфигурации
подпись задаёт EAS, а не отсутствующий в архиве локальный debug-keystore.
[Signing на Android worker](https://docs.expo.dev/build-reference/android-builds/).

EAS-окружение выбрано `development`, без `env` и серверных секретов в eas.json.
После привязки проверьте также account/project variables этого окружения в Expo:
там не должно быть Django/PostgreSQL/OAuth/dev-sync secrets. Не импортируйте
корневой `.env` в EAS и не запускайте `source ../.env` перед командами сборки.
`EXPO_PUBLIC_*` доступно пользователю приложения; туда разрешён только публичный
адрес API, никогда токены. В debug-клиенте JS и API URL приходят из локального
Metro, так что переносить mobile/.env в облако для этого не требуется.

## 3. Авторизация и привязка — WSL-терминал PyCharm

**Текущий checkout уже привязан.** Для обычной работы проверьте whoami/project:info;
не повторяйте создание проекта или ключа. Шаги init ниже нужны только для
первичной настройки другого checkout/аккаунта.

Все команды EAS выполняйте из исходного `mobile` в Ubuntu, не из Windows-копии:

```bash
cd /home/konstantin/projects/storylex/mobile
npx eas-cli@27.10.0 whoami
# Если нужна авторизация или смена аккаунта:
npx eas-cli@27.10.0 login
npx eas-cli@27.10.0 whoami
```

Авторизуйтесь интерактивно. Не помещайте Expo-пароль или EXPO_TOKEN в `.env`,
app.json, eas.json, команды с литеральным токеном или Git.

Привяжите проект самостоятельно:

```bash
npx eas-cli@27.10.0 init
```

Проверьте выбранный личный/организационный аккаунт. Если проект Storylex уже есть,
привяжите его; точный вариант — `npx eas-cli@27.10.0 init --id <его-UUID>`.
Если проекта нет, подтвердите создание только dev-проекта в своём аккаунте,
без покупки тарифа. CLI запишет реальный `extra.eas.projectId` в app.json и может
уточнить owner. Это несекретные метаданные. Проверьте diff: name, slug, package,
scheme, plugins и deep links должны сохраниться. Не подставляйте выдуманный UUID.
`eas build:configure` не нужен: профиль уже подготовлен.

До запуска сборки:

```bash
npx eas-cli@27.10.0 project:info
npx eas-cli@27.10.0 env:list --environment development
npx eas-cli@27.10.0 env:list --environment development --scope account
npx eas-cli@27.10.0 config --platform android --profile development --non-interactive
```

Не публикуйте вывод env:list: обычные public-переменные могут выводиться значениями.
Проверяйте credentials/окружение в своём аккаунте; ничего не загружайте из backend.

## 4. Проверить архив, затем запустить сборку

Убедитесь, что `android/app/build.gradle` существует; если его нет — остановитесь,
иначе EAS может сгенерировать другой native-проект. После привязки повторите
локальную архивацию (каталог output ещё не должен существовать):

```bash
test -f android/app/build.gradle
npx eas-cli@27.10.0 build:inspect --platform android --profile development --stage archive --output /tmp/storylex-eas-review
```

`archive` ничего не загружает и не компилирует. Откройте результат в PyCharm:
должны быть mobile/android, исходники mobile и три схемы contracts/content/v1;
не должно быть `.env`, backend, ключей и credentials.json. Не выбирайте стадии
pre-build/post-build: это уже другой объём работ.

**Следующая команда действительно отправляет исходники и создаёт облачную сборку;
её запускаете вы после проверки:**

```bash
npx eas-cli@27.10.0 build --platform android --profile development
```

На запрос keystore выберите отдельный ключ для `app.storylex.mobile.dev` или
подтвердите создание нового dev-ключа. Если EAS требует платный тариф/ресурс,
остановитесь: платный upgrade в задачу не входит. Наличие бесплатной квоты и
очередь зависят от вашего аккаунта; конфигурация не гарантирует их доступность.
Повторные сборки должны использовать прежний ключ, чтобы устанавливать обновление
поверх APK с сохранением SQLite. Резервирование/выгрузку ключа выполняет владелец;
production credentials сюда не добавляются.

## 5. Скачать и установить APK без Android SDK

После успеха EAS CLI покажет build URL. Откройте его на телефоне через ссылку/QR,
скачайте APK и установите через Android Package Installer, временно разрешив
установку этому браузеру. Запускайте **Storylex Dev**, не Expo Go. Для скачивания
и установки через браузер adb, JDK, Android Studio и Windows-сборочная копия не нужны.
Если Android сообщает о несовпадении подписи, не удаляйте приложение с pending:
сначала сохраните/синхронизируйте его данные и разберите используемый ключ.

Перед переходом из Expo Go синхронизируйте его pending. Между sandbox Expo Go и
Storylex Dev нет автоматической миграции; детали и ручная приёмка sync находятся
в [основной инструкции 2.1](auth-development.md#2-сначала-сохраните-прогресс-expo-go).

## 6. Подключить Metro и Django

EAS собирает APK, но **не размещает Django и не заменяет Metro**. Есть два транспорта.

### USB: оба сервиса без Windows portproxy

Для сборки локальный toolchain не нужен. Только для USB-соединения можно скачать
отдельные [Android Platform-Tools для Windows](https://developer.android.com/tools/releases/platform-tools)
и распаковать, например, в `C:\Tools\platform-tools` — без JDK/Studio/SDK Platforms.
Включите USB debugging на телефоне и подтвердите доверие компьютеру.

В WSL запустите Django на `127.0.0.1:8000` по [инструкции sync](sync-development.md).
В существующем `mobile/.env` задайте `EXPO_PUBLIC_API_URL=http://127.0.0.1:8000/api/v1/`,
сохранив остальные локальные настройки. Затем из `mobile`:

```bash
npm start
```

В PowerShell проверьте Windows → WSL localhost и настройте USB:

```powershell
curl.exe -I http://127.0.0.1:8000/api/v1/catalog/head
curl.exe http://127.0.0.1:8081/status
C:\Tools\platform-tools\adb.exe devices
C:\Tools\platform-tools\adb.exe reverse tcp:8000 tcp:8000
C:\Tools\platform-tools\adb.exe reverse tcp:8081 tcp:8081
```

Откройте Storylex Dev → launcher → Metro `http://127.0.0.1:8081`.
Для запуска deep link можно получить его у самого Metro:

```powershell
$storylexLink = (Invoke-RestMethod 'http://127.0.0.1:8081/_expo/open?platform=android&runtime=custom').url
C:\Tools\platform-tools\adb.exe shell am start -a android.intent.action.VIEW -d $storylexLink app.storylex.mobile.dev
```

После перезапуска WSL/отключения USB повторите reverse. Если Windows не видит
WSL localhost, проверьте localhost forwarding/VPN/firewall по основной инструкции;
EAS этого сетевого соединения не настраивает. Секрет dev-входа вводится только
в приложении и хранится в памяти, не в URL и не в облачном build profile.

### Без USB: туннель только Metro

Остановите прежний Metro и из WSL `mobile` запустите:

```bash
npx expo start --dev-client --tunnel
```

Expo может предложить установить helper `@expo/ngrok` для CLI. Это инструмент
транспорта, не новая зависимость приложения; здесь агент его не устанавливал.
Откройте QR/link в Storylex Dev. Ссылка launcher у SDK 58 может иметь форму
`<scheme>://?__expo_url=...`; используйте фактическую ссылку Metro, не старый шаблон
SDK 57. [Metro tunneling](https://docs.expo.dev/more/expo-cli/#tunneling).

Этот туннель предоставляет **только JS**, не `EXPO_PUBLIC_API_URL`. Django должен
быть отдельно доступен телефону. Если сохраняете прежнюю LAN-конфигурацию API,
её сетевые ограничения остаются. Нельзя заменить её HTTPS listener из 2.1 ради
dev-входа: там намеренно закрыты dev/session и sync. Полностью рабочий текущий
sync без portproxy — USB-вариант выше; публичный HTTPS-sync появится с реальными
сеансами в отдельно разрешённом подэтапе. Проверки TLS/доступа не отключать.

## 7. Когда пересобирать

Обычные правки TypeScript/JavaScript, экранов, упражнений и SQLite-запросов
приходят из Metro через Fast Refresh/reload — повторять EAS Build не нужно.
Миграции SQLite всё равно обязательны для изменений схемы данных. После изменения
EXPO_PUBLIC_API_URL перезапустите Metro и перезагрузите JS; этот dev APK не требует
из-за адреса API новой native-сборки. EAS Update/OTA здесь не настраивались.

Новый APK нужен после смены native-модулей/SDK/React Native, package/scheme,
permissions, manifest, config plugins или native-кода. Сначала осознанно обновите
существующий native-проект; в текущем режиме EAS не синхронизирует app.json с ним
через Prebuild. Обновления учебных JSON-пакетов идут через Django/существующий
загрузчик, не через APK. Development build требует доступного Metro для JS;
она не доказывает offline cold start без Metro.

## 8. Проверки подготовки до первой сборки (15.11.2026)

- TypeScript, public Expo config и Android JS/Hermes export — успешно.
- `EXPO_OFFLINE=1 npx expo install --check` — успешно по локальной карте SDK 58;
  `npm ls --depth=0` — без отсутствующих/невалидных зависимостей.
- **Онлайн** `npx expo install --check` вернул nonzero: появились рекомендации
  patch-версий SDK 58: expo ~58.0.25, constants ~58.0.16, crypto ~58.0.8,
  linking ~58.0.17, router ~58.0.31, sqlite ~58.0.17, status-bar ~58.0.5.
  Текущие версии сохранены по условию задачи; онлайн-проверка не объявляется
  пройденной. Это рекомендации новых patches, не доказанная несовместимость;
  если EAS выявит конкретную ошибку, обновлять согласованный минимальный набор.
- EAS CLI 27.10.0: schema/resolved development profile проверены через
  `@expo/eas-json`; локальный `build:inspect --stage archive` выполнен.
  Архив: **76 файлов**, из них **35 native**, побайтно совпадают с исходными;
  три JSON-схемы присутствуют. Forbidden paths/signing keys/env отсутствуют,
  негативные проверки ignore для вложенных секретов/кэшей прошли.
- При подготовке полный `eas config --non-interactive` остановился на непривязанном
  проекте. После выполненной владельцем привязки повторная проверка прошла (раздел 9).
- Native-проект не пересоздавался; backend, уроки, SQLite, API/sync не менялись.
  Django/mobile behavioral tests повторно не запускались: изменены только build
  config, ignore и инструкции. `git diff --check` проверяется перед сдачей.

## 9. Закрытие 2.1 и оставшиеся ограничения

15.11.2026 владелец подтвердил EAS APK, установку на реальный Android,
Metro/Django/dev-вход. Новая облачная сборка при финальной проверке не запускалась;
подтверждение устройства получено от владельца, а не от автоматических тестов.

Повторно прошли:

- 104 Django-теста на PostgreSQL, включая оба LiveServer → SQLite сценария
  и HTTPS-профиль; `check --database default`, `makemigrations --check --dry-run`.
- `npm test`: 55 passed, 2 ожидаемых standalone live skip (выполнены через Django);
  SIGKILL тест выполнен вне sandbox без изменения теста.
- TypeScript, Android JS/Hermes export, npm dependency tree и offline module check.
- Полный `eas config --platform android --profile development --non-interactive`
  после привязки: правильные dev-package/scheme, SDK 58 и development/internal APK.
- Проверка ссылок документации и `git diff --check` прошли. IDE не сообщила ошибок;
  остаются предупреждения о wildcard imports и тестовых helpers/некорректных URL
  в негативных fixtures. Отдельный Python linter в проекте не настроен.

Финальные diff/архив/секреты проверены перед коммитами: просмотрены 156 файлов Git,
сопоставлены реальные локальные секреты без вывода значений; совпадений не найдено.
Тестовый URL с фиктивными user/password в negative fixture проверен вручную.
Архив снова содержит 76 файлов и 35 неизменённых native-файлов. Локальные env, ключи,
SQLite и generated Android исключены из Git; Android включён в EAS archive без
ключей и локальных настроек. Project ID и owner публичны и не являются токенами.

Ограничения сохраняются:

- Внешний HTTPS с телефона не проверен. Отдельный HTTPS-профиль закрывает dev-auth
  и sync; его автоматические проверки не доказывают доступность публичного туннеля.
- Offline completion/sync и native force-stop именно новой APK в текущей ручной
  проверке не подтверждены. Полный cold start без Metro также не проверен.
- Online Expo check снова вернул nonzero с теми же семью patch-рекомендациями
  из раздела 8. Версии сохранены; это предупреждение, а не пройденный check.
  Повторный `npm audit` подтвердил **4 moderate** в цепочке Expo CLI/fingerprint →
  glob/minimatch, **0 high/critical**. Команда завершилась nonzero из-за advisory;
  audit fix не применялся, зависимости не обновлялись.
- Локальная native-компиляция в среде агента не проверена из-за отсутствия
  toolchain; EAS-компиляция и установка подтверждены владельцем.
- Android-каталог пока игнорируется Git: EAS использует native-файлы текущего
  checkout. Чистый clone не содержит их; не считать облачную сборку из него
  проверенной и не подменять текущую процедуру автоматическим Prebuild.
- Реальные OAuth flows, refresh/logout, private delivery и production release
  не реализованы. Следующие подэтапы требуют отдельного разрешения.

Владелец разрешил завершить этап логическими Conventional Commits и push на GitHub.
После этого — остановка, без начала 2.2.
