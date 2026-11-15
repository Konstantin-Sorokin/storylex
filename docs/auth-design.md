# Авторизация этапа 2: исследование и предложение

Проверено по официальным источникам 14.11.2026. Это техническое предложение
в границах существующих accounts/API, **не реализованный протокол входа**.
Рабочая [development build](auth-development.md) подтверждена владельцем
15.11.2026; внешний HTTPS ещё не проверен и должен быть проверен до реального OAuth.
Реальные OAuth-приложения и секреты владелец ещё не создавал в рамках этой задачи.

## 1. Провайдеры и Android redirect

| Вопрос | Google | Яндекс ID |
|---|---|---|
| Предлагаемый flow | OIDC Authorization Code через системный браузер; confidential web client на Django | OAuth Authorization Code через браузер; обмен и userinfo на Django |
| Callback провайдера | `https://<dev-host>/api/v1/auth/callback/google` | `https://<dev-host>/api/v1/auth/callback/yandex` |
| Проверка identity | Проверенный ID token: подпись/JWKS, iss, aud/azp, exp/iat, nonce; `sub` | Сервер обменивает code и получает `/info` с Authorization header; подтверждённый `id` |
| Минимальные scope для spike | `openid`; email/profile добавлять только для нужных полей профиля | `login:info`; `login:email` только при необходимости email |
| PKCE | Discovery объявляет S256; в spike проверить code_challenge и неверный verifier на выбранном web client | Документированы code_challenge, S256 и code_verifier при обмене |
| Секрет | Только Django environment | Только Django environment |

Google требует точного совпадения registered redirect URI; вариант без/с trailing
slash — разные адреса. [Web server flow](https://developers.google.com/identity/protocols/oauth2/web-server),
[OIDC-проверки](https://developers.google.com/identity/openid-connect/openid-connect),
[discovery с S256](https://accounts.google.com/.well-known/openid-configuration).
Не следует копировать пример Desktop/loopback-flow на Android: custom schemes
для Android OAuth-клиентов Google отключены по умолчанию из-за impersonation.
[Типы Google clients](https://support.google.com/googleapi/answer/6158849).

Яндекс допускает browser code flow, требует Redirect URI из настроек и поддерживает
S256; нельзя полагаться на fallback первого URI при ошибке конфигурации.
[Запрос и обмен кода](https://yandex.ru/dev/id/doc/ru/codes/code-url).
Предлагается OAuth + JSON userinfo, без предположения об OIDC ID token и nonce
Google в этом flow. Передавать provider token в query нельзя:
[userinfo и риски URL](https://yandex.ru/dev/id/doc/ru/user-information).

**Два перенаправления различаются:** Google/Яндекс возвращают code только на HTTPS
Django callback. Затем Django возвращает собственный одноразовый ticket через
`storylex-dev://auth/callback`. Эта scheme не регистрируется у Google как его
redirect URI. Никаких provider/access/refresh tokens в Android URL.

Для предложенного web flow SHA fingerprints APK не нужны. Если в spike обнаружится
необходимость native SDK, сначала согласовать альтернативу:
[Android client Google](https://developer.android.com/identity/authorization#set-up)
привязан к package + SHA-1; [Яндекс LoginSDK](https://yandex.ru/dev/id/doc/ru/mobileauthsdk/android/3.1.3/sdk-android)
требует package и signing fingerprint (SHA-256). Dev/release подписи и package ID
разные. SDK, Credential Manager или изменение общей архитектуры молча не добавлять.
Expo сохраняется в любом случае; native-модули совместимы с development build.

## 2. Минимальная схема для следующего spike

1. Устройство генерирует криптографически случайный verifier и S256 challenge.
   `POST /auth/attempts` передаёт provider, purpose и challenge, а возврат выбирается
   из серверной allowlist. Для development разрешён ровно `storylex-dev://auth/callback`.
   Произвольный redirect URL от клиента не принимается.
2. Django создаёт одноразовый AuthAttempt с коротким TTL (предложение: 5 минут),
   фиксирует provider, purpose, return URI и challenge. Для link сохраняется
   target user из действующей сессии, не из JSON. Сервер выдаёт authorization_url
   своего browser-start endpoint, который связывает попытку с HttpOnly Secure
   SameSite=Lax browser cookie и случайным state, затем переводит к провайдеру.
   Этот внутренний browser-start ещё надо описать в точном контракте spike.
3. Серверный provider-PKCE verifier создаётся **отдельно** от verifier устройства.
   Google: state + nonce + S256; Яндекс: state + S256. Не использовать plain и не
   делать тихий downgrade при отказе PKCE. Проверить это реальными negative flows.
   Provider verifier хранится только в короткоживущем защищённом серверном контексте,
   не передаётся мобильному клиенту.
4. Callback проверяет state, browser binding, provider, TTL/одноразовость и ошибки.
   Только затем Django обменивает code и проверяет identity по протоколу провайдера.
   Внешний HTTP выполняется вне транзакции; конкурентное потребление попытки
   контролируется состояниями и блокировкой короткой транзакции PostgreSQL.
   Поддерживаемая библиотека OAuth/OIDC нужна для обмена/проверки JWT/JWKS;
   выбрать и обосновать её в spike, не писать собственную криптографию.
5. Django выдаёт случайный одноразовый ticket (предложение: TTL 60 секунд),
   связанный с attempt, provider, purpose, identity и challenge устройства.
   Callback отвечает no-store и Referrer-Policy: no-referrer, без сторонних ресурсов.
   В deep link попадают только ticket и несекретный attempt ID. Сервер хранит hash
   ticket; URL и body с секретами исключаются из логов на всех уровнях.
6. Приложение принимает только ожидаемый callback своей активной попытки и
   вызывает `POST /auth/exchange` по HTTPS с ticket + verifier + device_id.
   Проверяются S256, TTL и одноразовость. Перехватчик scheme без verifier не
   получает сеанс. Потеря памяти попытки означает новый вход, не обход проверки.
   Перехват custom scheme всё ещё может сорвать вход (DoS); для release рассмотреть
   verified Android App Links после выбора домена и подписания, без обещания DRM.

AuthAttempt/ticket/identity/session живут в PostgreSQL, без Redis и брокера.
Повторный callback/exchange, отмена и неверный verifier не создают сеансов.
Семантику безопасного повтора при потере ответа exchange отдельно зафиксировать
до реализации: повтор не должен обходить одноразовость ticket.

Это соответствует целевым `auth/attempts → callback → exchange` из API-контрактов.
Сейчас ни эти endpoints, ни callback-экран не созданы. Нельзя тестировать «вход»
передачей произвольного provider_user_id, email или собственного фальшивого ticket.

## 3. Сеансы и локальные данные после spike

Следующий завершённый подэтап должен определить конкретный формат/TTL токенов
и добавить реальные AuthSession, refresh/logout и адаптер DRF. Предложение по TTL:
access 15 минут, refresh 30 дней (как в security-and-risks); это предложения, не текущие
требования. Refresh ротируется, сервер хранит hash, reuse отзывает family/session.
Повтор refresh с тем же request_id восстанавливает ответ в ограниченном окне
без хранения сырого refresh; механизм защищённого восстановления и гонки двух
запросов описать и проверить до включения клиентского refresh.

Provider tokens не нужны мобильному приложению и не становятся токенами Storylex.
Запрашивать provider offline access/хранить долгоживущий provider refresh для
простого входа не требуется. `ExternalIdentity(provider, subject)` уникальна;
совпадение email никогда не объединяет аккаунты. Привязка — отдельное подтверждённое
действие с недавней авторизацией; чужую identity нельзя перезаписать.

Собственный refresh хранится в `expo-secure-store`, access — в памяти; SecureStore
и браузерный модуль устанавливаются тогда, когда появляется их вызывающий код.
SQLite-контракты completion/outbox не меняются. Перед отправкой очереди проверяется
user/session context. Истечение токена, logout и смена аккаунта не удаляют pending
и прогресс: writer/coordinator останавливаются, БД закрывается, файлы остаются
принадлежать прежнему user. Dev-аккаунт не становится реальным по совпадению email.
Сохранение офлайн-прогресса и защита аккаунтов проверяются одновременно с refresh.

## 4. Действия владельца перед реальным входом

APK/Metro/Django/dev-вход подтверждены в 2.1. До реального входа проверить внешний
HTTPS, отдельно согласовать spike 2.2 и адрес callback. Внешние приложения
самостоятельно сейчас **не создаются**.

После отдельного согласования:

1. Выбрать dev/staging origin. Quick Tunnel годится для короткого эксперимента;
   каждый новый hostname требует обновления зарегистрированных callbacks.
   Стабильный домен через уже имеющуюся инфраструктуру предпочтительнее; если
   её нет, согласовать вариант и стоимость до создания.
2. Google Cloud/Google Auth Platform: выбрать свой проект, настроить Branding,
   Audience для dev-тестирования и Data Access с минимальными scope. Создать
   client типа **Web application** с точным Google HTTPS callback из таблицы.
   Добавить тестовых пользователей, если этого требует текущий режим Audience.
   SHA APK и Android client для этой серверной схемы не подставлять.
3. Яндекс OAuth: создать приложение **для авторизации пользователей**, выбрать
   web-платформу, минимальный `login:info` и точный Яндекс HTTPS callback.
   [Регистрация и типы приложений](https://yandex.ru/dev/id/doc/ru/register-client).
   API-only приложение без login-прав для этого не подходит.
4. Записать client ID/secret только в серверный локальный env по именам,
   которые появятся в согласованном spike. Не присылать секреты в чат,
   не помещать в EXPO_PUBLIC, APK, ссылки или Git. Разделить dev/release clients.
5. Пройти каждым провайдером success/cancel/error в системном браузере реального
   Android. Проверить wrong state, nonce/PKCE, expiry, callback/exchange replay,
   подмену return URI, два конкурирующих callback и отсутствие секретов в логах.
   Mock-тесты не заменяют этот provider spike и не подтверждают доступность
   Google/Cloudflare/Яндекса из целевых сетей.

## 5. Предлагаемая последовательность этапа 2

| Шаг | Завершённый результат | Что принять перед следующим шагом |
|---|---|---|
| **2.1, завершён** | EAS APK/Metro/Django/dev-вход подтверждены; HTTPS-профиль и исследование подготовлены | Внешний HTTPS и ручной offline/sync новой APK не проверены; ограничения сохранены |
| 2.2, требуется согласование | Минимальный реальный spike **обоих** провайдеров: attempts/callback/exchange, проверка identity и возврата | Success/cancel и negative flows на Android, подтверждение схемы, выбранные зависимости и точные контракты |
| 2.3, требуется согласование | Полный жизненный цикл реального сеанса, SecureStore, refresh/logout, identity linking, изоляция account SQLite | Потеря/повтор refresh, expiry offline, старый outbox, смена аккаунта, второй телефон |
| 2.4, требуется согласование | Entitlement-основания/агрегат, claim-free, API/sync | Идемпотентность, бесплатное право сохраняется после изменения цены, чужие права недоступны |
| 2.5, требуется согласование | Private storage, краткоживущие download URLs, полная доставка | Ownership, expiry, отказ/повтор/атомарное обновление и сохранение текущего урока |

Удаление аккаунта — отдельное согласование политики внутри этапа 2. После 2.1
следующие шаги не выполняются автоматически, даже если проверки прошли.
