# Этап 2.1: Android development build и основа авторизации

Подэтап разрешён владельцем 14.11.2026 и завершён 15.11.2026. Подготовлены
собственный dev-клиент, изолированный HTTPS-профиль Django и предложение
следующего OAuth-spike. Владелец подтвердил EAS Build, установленный APK,
Metro/Django/dev-вход на реальном Android. Это **не реализация OAuth и не
завершение всего этапа 2**; внешний HTTPS пока не проверен.

**Обновление 15.11.2026:** владелец выбрал **EAS Build для первой APK** вместо
установки локального toolchain. Профиль, проверка архива, вход/привязка Expo,
сборка и запуск описаны в [инструкции EAS](eas-development.md). Облачную сборку
и подпись выполнил владелец. Раздел 3 ниже остаётся альтернативой локальной сборки;
сохранение прогресса и ограничения HTTPS/dev-sync по-прежнему действуют.

## 1. Что изменилось

React Native + Expo SDK 58, Router, lesson runner, SQLite и sync сохранены.
Добавлен совместимый `expo-dev-client`, зафиксированный package-lock.json.
Он даёт собственный launcher и native development menu. Альтернатива без этой
зависимости — обычный debug-клиент Expo без launcher; Expo Go не позволяет
управлять native-конфигурацией своего приложения для OAuth. Стоимость поддержки:
семь дополнительных npm-пакетов, обновление вместе с SDK и пересборка APK после
изменений native-модулей/config plugins. Новых backend-зависимостей нет.

| Конфигурация | Значение |
|---|---|
| Название на Android | Storylex Dev |
| Android application ID | `app.storylex.mobile.dev` |
| URI scheme | `storylex-dev` |
| Будущая URI возврата входа (ещё без обработчика) | `storylex-dev://auth/callback` |
| Публичные идентификаторы, зарезервированные ранее | `app.storylex.mobile`, `storylex` |

`app.json` сейчас описывает только dev-приложение. Release-профиля нет; прежний
`__DEV__` gate по-прежнему закрывает учебный shell в production bundle. Android
backup отключён; HTTP для Metro разрешается штатным **debug** manifest Expo,
в main manifest глобального разрешения cleartext нет. TLS-проверки не отключаются.
`android/` и `ios/` — генерируемые CNG-каталоги, исключены из Git вместе с APK
и ключами. Источник изменений — app.json, package.json и lockfile.

## 2. Сначала сохраните прогресс Expo Go

Expo Go и Storylex Dev — разные Android sandbox. Новая сборка не может прочитать
их SQLite напрямую. Перед переходом в **старой версии приложения в Expo Go**:

1. Восстановите Django и выполните sync под прежним dev-пользователем.
2. Убедитесь, что pending = 0 и нет rejected. Rejected не доставлены: сохраните
   Expo Go и разберите их, не сбрасывайте его данные.
3. Не удаляйте Expo Go и не очищайте его данные. Подтверждённые completions вернутся
   с сервера в Storylex Dev после входа тем же серверным dev-пользователем.
   Пакеты/каталог скачаются заново. Детальные локальные ответы и результаты 1.4
   остаются в Expo Go: sync передаёт завершения, не эти результаты.

Если новая конфигурация уже используется Metro, старый проект можно открыть
явно через `npx expo start --go` для завершения sync. Новая штатная команда
`npm start` нацелена на Storylex Dev. Автоматического переноса pending и локальных
результатов между Android-приложениями нет; выдавать его за миграцию нельзя.

## 3. Альтернатива: локально собрать и установить на Android

Используется локальная сборка Expo, без Expo/EAS-аккаунта и облачного биллинга.
[Официальный процесс](https://docs.expo.dev/guides/local-app-development/).

В текущей связке Windows + WSL проще собирать APK нативными Windows-инструментами,
а Django и повседневный Metro оставить в WSL. Так не требуется USB passthrough
в Linux или Windows portproxy для телефона.

### Однократная подготовка Windows

1. Установите Android Studio, JDK 17 и Node 24.13+ с npm. В SDK Manager поставьте
   Android SDK Platform **37**, Build-Tools **37.0.0**, Platform-Tools,
   Command-line Tools и NDK **27.1.12297006**. Это версии из установленного
   React Native 0.88.1 (`node_modules/react-native/gradle/libs.versions.toml`),
   а не пример SDK 36 из старых инструкций Expo. SDK licenses примите через
   Android Studio. Gradle wrapper сгенерирован на 9.4.1, AGP — 9.2.1.
2. Укажите `JAVA_HOME` на каталог JDK 17, `ANDROID_HOME` на
   `%LOCALAPPDATA%\Android\Sdk`. Добавьте `%JAVA_HOME%\bin` и
   `%ANDROID_HOME%\platform-tools` в пользовательский PATH. Откройте новый PowerShell.
3. На телефоне включите «Для разработчиков → Отладка по USB», подключите кабель
   с передачей данных, подтвердите доверие компьютеру. `adb devices` должен показать
   статус `device`, не `unauthorized`. При необходимости поставьте OEM USB driver.
4. Проверьте в PowerShell `node --version`, `npm --version`, `java -version`,
   `adb version`. Не смешивайте Windows Java/SDK и Linux Gradle в одной сборке.

### Копия для native-сборки

Не запускайте Windows npm в Linux `mobile/node_modules` через UNC. Создайте
отдельную сборочную копию текущих файлов (включая ещё не закоммиченные изменения).
Из корня репозитория в **WSL**, заменив имя Windows-пользователя при необходимости:

```bash
mkdir -p /mnt/c/Users/konst/Projects/storylex-dev
tar --exclude=node_modules --exclude=.expo --exclude=android --exclude=ios \
  --exclude=dist --exclude='.env*' -cf - mobile contracts \
  | tar -C /mnt/c/Users/konst/Projects/storylex-dev -xf -
cp mobile/.env.example /mnt/c/Users/konst/Projects/storylex-dev/mobile/.env.example
```

Здесь только mobile/contracts, без backend, секретов и .git. Это сборочная копия,
не место для правок исходников. Перед каждой следующей native-пересборкой повторите
копирование; если удаляли исходные файлы, создайте новую пустую сборочную папку.
Обычные изменения TS/JS будут приходить из исходного WSL Metro.

В **PowerShell**:

```powershell
cd C:\Users\konst\Projects\storylex-dev\mobile
npm ci
# Только если локального .env ещё нет:
Copy-Item .env.example .env
npm run android -- --no-bundler
```

Команда генерирует native Android-проект, предлагает выбрать телефон, собирает
и устанавливает debug APK. Первый запуск скачивает Gradle/Maven-зависимости и
занимает время. Результат при успешной сборке:
`android\app\build\outputs\apk\debug\app-debug.apk`.
Повторная установка вручную: `adb install -r <путь-к-app-debug.apk>`.
Не используйте uninstall или очистку данных для устранения ошибок: они удалят
локальные незавершённые доставки. Обновление требует прежней подписи APK.

Если все инструменты и USB уже доступны в одной Linux-среде, сборочная копия
не нужна: в исходном `mobile` выполните `npm ci`, затем
`npm run android -- --no-bundler`. Windows SDK нельзя просто назначить Linux Gradle.

### Повседневный запуск без portproxy

1. В WSL запустите PostgreSQL/Django по README, с сохранённым dev-пользователем
   из [sync-development.md](sync-development.md). Django слушает `127.0.0.1:8000`.
2. В исходном `mobile/.env` поставьте
   `EXPO_PUBLIC_API_URL=http://127.0.0.1:8000/api/v1/`, сохранив остальные
   локальные значения. Секреты туда не добавляйте.
3. Из исходного `mobile` в WSL выполните `npm start`.
4. В PowerShell проверьте доступ Windows → WSL localhost и сделайте USB reverse:

```powershell
curl.exe -I http://127.0.0.1:8000/api/v1/catalog/head
curl.exe -I http://127.0.0.1:8081/status
adb reverse tcp:8000 tcp:8000
adb reverse tcp:8081 tcp:8081
adb reverse --list
```

Второй адрес должен отвечать Metro. Первый — Django (200 либо 503 до публикации).
Если Windows не видит localhost WSL, сначала проверьте WSL localhost forwarding
и VPN/firewall; portproxy и `0.0.0.0` здесь не нужны. USB reverse ведёт с телефона
на Windows loopback, а Windows перенаправляет localhost в WSL. После отсоединения
USB/перезагрузки reverse выполните заново. При нескольких телефонах используйте
`adb -s <serial>` для каждой команды.

Откройте **Storylex Dev** → launcher → адрес Metro `http://127.0.0.1:8081`.
Либо в PowerShell:

```powershell
adb shell am start -a android.intent.action.VIEW -d 'storylex-dev://?__expo_url=http%3A%2F%2F127.0.0.1%3A8081' app.storylex.mobile.dev
```

Первый вход пока прежний dev-вход 1.5: введите токен вручную, не через ссылку.
После смены API URL перезапустите Metro. JS/TS правки не требуют пересборки APK;
native-зависимости, package/scheme и plugins требуют её. Для обновления native
конфигурации запускайте `npm run prebuild:android` перед сборкой. Не запускайте
`prebuild --clean` без необходимости: он удаляет сгенерированные native-файлы.

## 4. HTTPS для OAuth: отдельный listener

Для следующего spike предлагается бесплатный **Cloudflare Quick Tunnel**,
запускаемый вручную. Он не требует аккаунта/домена, но URL меняется после
перезапуска, SLA нет. Для постоянного callback позже согласовать стабильный
домен/туннель или существующий staging; ничего платного пока не создавать.
[Ограничения Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

Установите `cloudflared` по [официальной инструкции](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
В Windows можно использовать `winget install --id Cloudflare.cloudflared --exact`.
В PowerShell запустите:

```powershell
cloudflared tunnel --url http://127.0.0.1:8001
```

Сначала возможен 502: отдельный Django ещё не запущен. Скопируйте выданный точный
`https://…trycloudflare.com` и добавьте **только в корневой локальный `.env`**:

```dotenv
DJANGO_HTTPS_DEV_ORIGIN=https://YOUR-HOST.trycloudflare.com
```

Во втором WSL-терминале, из `backend`:

```bash
uv run --env-file ../.env manage.py runserver 127.0.0.1:8001 --nostatic --settings=config.settings.https_dev
```

Порт 8000 продолжает обслуживать локальные Admin/dev-sync. **Не направляйте
туннель на него.** Профиль 8001 использует ту же dev-БД и опубликованные пробы,
но DEBUG=false, точный ALLOWED_HOSTS, secure cookies, HTTPS redirect и отдельный
URLconf. Admin/dev-session/sync там отсутствуют (404), full-пакеты остаются закрыты.
Даже включённые в `.env` DEV_SYNC/DEBUG не включают их в HTTPS-профиле.

Доверие `X-Forwarded-Proto` ограничено этим профилем: Cloudflare
[перезаписывает заголовок посетителя](https://developers.cloudflare.com/fundamentals/reference/http-headers/#x-forwarded-proto).
Origin слушает только loopback; не открывайте его в LAN и не подставляйте proxy,
сохраняющий клиентский X-Forwarded-Proto. Сертификаты телефона и outbound OAuth
HTTP-клиента проверяются штатно; самоподписанных сертификатов и `--no-tls-verify` нет.
Access/error request logs Django в этом профиле отключены, чтобы будущие
code/state/ticket не попадали в них. Безопасные коды ошибок и request_id надо
добавить при реализации OAuth; диагностировать контент можно локальным listener.

Проверьте **на телефоне через мобильную сеть**, без USB:

- `https://<host>/api/v1/catalog/head` — JSON с **HTTPS** URL, либо 503, если
  каталог ещё не опубликован. Вложенный URL также должен открываться.
- `/admin/`, `/api/v1/dev/session`, `/api/v1/sync/changes` — 404 без traceback.
- Неизвестный host отклоняется; HTTP переводится на HTTPS.

Это публичный временный адрес опубликованных проб, не защита секретностью URL.
Не включайте платный контент или реальные аккаунты в этот тест. Сейчас новый
клиент требует dev/session при первом входе, поэтому **не переключайте его
основной API URL на этот listener ради sync**: dev-вход там намеренно закрыт.
HTTPS-профиль предназначен для проверки транспорта и будущего реального OAuth;
полный пользовательский HTTPS-sync появится с настоящими сеансами.
Остановка cloudflared закрывает внешний доступ. Повторный запуск требует нового
origin в `.env`, рестарта Django и, после регистрации OAuth, обновления callback
в обеих консолях. Quick Tunnel не решает постоянство имени; это следующий выбор
владельца. Metro `--tunnel` — отдельный транспорт и не публикует Django API.

## 5. Сценарии ручной проверки

Фактически подтверждённый владельцем объём — в разделе 7. Этот список шире
подтверждённого: не считать все его пункты автоматически пройденными.

1. После сборки установлено именно Storylex Dev, launcher открывает исходный Metro.
2. Тем же dev-пользователем получены прежние серверные completions; глава доступна.
3. Остановите Django, оставив Metro/USB: закончите новый урок, проверьте pending.
   Перезапустите native-процесс без очистки данных: прогресс и очередь сохраняются.
4. Верните Django, повторите dev-вход после перезапуска, выполните sync: pending=0,
   повтор sync не дублирует завершение.
5. `adb shell am start -a android.intent.action.VIEW -d 'storylex-dev:///settings' app.storylex.mobile.dev`
   открывает приложение/экран настроек. Это проверка scheme, не OAuth callback.
6. Проверьте HTTPS с телефона и недоступность Admin/dev/session через туннель.

Development build требует Metro для JS. Полный offline cold start без доступного
Metro этот APK не доказывает: для него нужен отдельно согласованный build с
встроенным bundle и корректной изоляцией dev-auth. `expo export` не заменяет APK.

## 6. Выполненные проверки и ограничения (14.11.2026)

- `npm run prebuild:android` — native-проект с dev-client и scheme сгенерирован;
  проверены main/debug manifests. Предупреждение об отсутствии `expo-system-ui`
  относится к управлению native theme; зависимость ради этого подэтапа не добавлена.
- `npm run typecheck`, `EXPO_OFFLINE=1 npx expo install --check`,
  `npm run export:android` — успешно. Module check использует локальную карту SDK.
- `npm test` — 55 passed, 2 standalone live skip; SIGKILL тест в sandbox зависал,
  вне sandbox весь набор прошёл без изменения тестов.
- Django: 104 теста на PostgreSQL, включая оба HTTP → SQLite сценария и новый
  HTTPS-профиль; `check --database default` и `makemigrations --check --dry-run`
  прошли. Схема PostgreSQL/SQLite, учебные контракты и sync-код не менялись.
- `./gradlew :app:assembleDebug` остановлен до компиляции: отсутствуют JAVA_HOME/java.
  Android SDK/adb также отсутствуют. APK, USB, deep links и реальный HTTPS-туннель
  на устройстве **не проверены**; действия для владельца приведены выше.
- Установка npm сообщила 4 moderate advisory в toolchain; автоматический audit fix
  не применялся. Это не завершённый security gate публичного выпуска.

## 7. Закрытие 2.1 (15.11.2026)

Владелец подтвердил облачную EAS Build, установку APK на физический Android,
запуск Storylex Dev через Metro, подключение к Django и успешный вход по
dev-токену. Конкретный транспорт телефона (USB/LAN/tunnel) не уточнялся;
инструкции описывают варианты, а не подтверждают проверку каждого из них.

Финальная регрессия: 104 Django-теста и 55 мобильных тестов, TypeScript,
Android JS/Hermes export, Django check и отсутствие новых миграций.
Полная EAS config после привязки проекта прошла; проверка архива и секретов —
в [итогах EAS](eas-development.md#9-закрытие-21-и-оставшиеся-ограничения).

Внешний HTTPS, native force-stop и офлайн-завершение/sync именно в новой APK
владелец в этой проверке не подтверждал. Тесты сохранности completion/outbox,
включая SIGKILL, прошли; это не заменяет новую ручную offline-проверку.
Development build требует Metro для JS. Online Expo check по-прежнему сообщает
о семи новых patch-версиях SDK 58; зависимости не обновлялись.

Разрешённые владельцем завершающие действия — Conventional Commits и push на
GitHub. Затем остановиться; [следующие подэтапы](auth-design.md) требуют
отдельного согласования.
