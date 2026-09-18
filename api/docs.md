# Phoenix Space — API Documentation

> **API Version:** 1.0.0
> **Service:** Phoenix Academy — «Академия Феникса»
> **Runtime:** Node.js ≥ 16 · Express 4 · Socket.IO 4 · SQLite (`better-sqlite3`)
> **Default HTTP port:** `3000` (`process.env.PORT` при переопределении)
> **Content-Type:** `application/json` (запросы и ответы), `multipart/form-data` для загрузок
> **Authentication:** JWT (`Authorization: Bearer <token>`) и DID-подпись (Ethereum `personal_sign`)

---

## Содержание

1. [Обзор](#1-обзор)
2. [Базовый URL и соглашения](#2-базовый-url-и-соглашения)
3. [Аутентификация](#3-аутентификация)
4. [Основной REST API (`/api`)](#4-основной-rest-api-api)
   - [Сад (Seeds)](#41-сад-seeds)
   - [Блокчейн-артефакты](#42-блокчейн-артефакты)
   - [DID](#43-did)
   - [Профиль](#44-профиль)
   - [Контент залов](#45-контент-залов)
   - [Мастерская (Artifacts)](#46-мастерская-artifacts)
   - [Админ-контент](#47-админ-контент)
   - [Витрина задач (Bounties)](#48-витрина-задач-bounties)
5. [Модуль аутентификации (`auth`)](#5-модуль-аутентификации-auth)
6. [Профиль-загрузки (`/api/profile`)](#6-профиль-загрузки-apiprofile)
7. [WebSocket / Socket.IO](#7-websocket--socketio)
8. [Встроенный REST-сервер (`public_api.js`)](#8-встроенный-rest-сервер-public_apijs)
9. [Клиентские SDK](#9-клиентские-sdk)
10. [Формат ошибок](#10-формат-ошибок)
11. [Коды состояния](#11-коды-состояния)
12. [Rate limiting](#12-rate-limiting)
13. [Загрузка файлов](#13-загрузка-файлов)
14. [Переменные окружения](#14-переменные-окружения)
15. [Примеры `curl`](#15-примеры-curl)
16. [Changelog](#16-changelog)

---

## 1. Обзор

Phoenix Space — это саморазвивающаяся платформа («Круг»), объединяющая:

- **REST API** на Express, смонтированный под префиксом `/api`;
- **Realtime-слой** на Socket.IO (комнаты, личные сообщения, WebRTC-сигналинг);
- **DID-идентичность** на базе Ethereum-адресов и подписей;
- **Репутацию** странников (уровни доступа `newcomer`, `practitioner`, `master` и т.д.);
- **Блокчейн-регистрацию** артефактов (on-chain);
- **Автономные модули** (`public_api.js`, `auth.js`, `rate_limiter.js`, `websocket_api.js`), которые можно встраивать независимо.

Все модули в `api/` спроектированы как **dependency-free** там, где это возможно,
и поддерживают `start()` / `stop()` с корректным graceful shutdown.

### Ключевые принципы

| Принцип | Описание |
|---|---|
| Единый конверт ответа | `{ "success": true, "data": ... }` либо `{ "error": {...} }` |
| Явная валидация | Обязательные поля проверяются, ошибки возвращают `400` / `422` |
| Идемпотентность чтения | Все `GET` безопасны и кэшируемы |
| Ограничение размера | Тела запросов и загрузки ограничены (см. §13) |
| Логирование | Каждый запрос проходит через `auditLogger` |

---

## 2. Базовый URL и соглашения

```
http://localhost:3000
```

Все доменные маршруты (кроме мета) доступны под префиксом `/api`:

```
GET  http://localhost:3000/api/contents/garden
POST http://localhost:3000/api/did/generate
```

Соглашения:

- Параметры пути кодируются в URL (`:hall`, `:did`, `:id`).
- Язык контента задаётся query-параметром `?lang=ru|en|...` (fallback → `ru`).
- Ответы коллекций: `{ "success": true, "data": [...] }`.
- Ответы одиночного ресурса: `{ "success": true, "data": {...} }`.
- Все даты — ISO-8601 UTC.
- Таймзона и локаль сообщений чата не влияют на API-формат.

---

## 3. Аутентификация

Поддерживаются два независимых механизма.

### 3.1 JWT (Bearer)

```
Authorization: Bearer <jwt-token>
```

- Алгоритм: HS256.
- Секрет: `process.env.JWT_SECRET` (обязателен; приложение завершается без него).
- Срок жизни токена: **7 дней**.
- Payload: `{ "id": <number>, "username": <string>, "iat": ..., "exp": ... }`.

### 3.2 DID-подпись (Ethereum)

1. Клиент вызывает `POST /api/did/generate` и получает `did`, `address`, `mnemonic`.
2. Для входа в чат клиент подписывает сообщение `"Войти в Круг"` приватным ключом.
3. Сервер проверяет подпись через `ethers.verifyMessage()`.
4. Совпадение `recoveredAddress` и `data.address` → событие `authenticated`.

### 3.3 Админ-ключ

Административные маршруты требуют заголовок:

```
x-admin-key: phoenix-architect-2024
```

При неверном ключе → `403 { "error": "Доступ запрещён" }`.

---

## 4. Основной REST API (`/api`)

Маршруты смонтированы из `src/routes/api.js`.

### 4.1 Сад (Seeds)

#### `GET /api/seeds`

Возвращает все «семена» (идеи, заявленные в саду).

**Ответ `200`**

```json
{ "success": true, "data": [ { "id": 1, "title": "Seed", "created_at": "..." } ] }
```

#### `POST /api/seeds`

Создаёт новое семя.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| `title` | string | да | Название семени |
| `body` | string | нет | Описание |
| `author_did` | string | нет | DID автора |

---

### 4.2 Блокчейн-артефакты

#### `POST /api/blockchain/register`

Регистрирует артефакт on-chain.

```json
{ "artifact_id": 42, "hash": "0x...", "owner_did": "did:phoenix:0x..." }
```

#### `GET /api/blockchain/artifact/:id`

Возвращает on-chain данные артефакта по идентификатору.

#### `GET /api/blockchain/artifacts`

Возвращает все зарегистрированные on-chain артефакты.

---

### 4.3 DID

#### `POST /api/did/generate`

Генерирует новую децентрализованную идентичность (DID) и кошелёк.

**Тело запроса:** пустое.

**Ответ `200`**

```json
{
  "success": true,
  "data": {
    "did": "did:phoenix:0xABC...",
    "address": "0xABC...",
    "mnemonic": "twelve word seed phrase ..."
  }
}
```

> ⚠️ `mnemonic` показывается один раз. Не логируйте и не передавайте его по незащищённым каналам.

---

### 4.4 Профиль

#### `GET /api/profile/:did`

Возвращает профиль и репутацию по DID.

#### `GET /api/profile?did=<did>`

Альтернативная форма. Без параметра `did` возвращает `400`:

```json
{ "success": false, "error": "Укажите DID" }
```

#### `POST /api/profile/update`

Обновляет профиль. `multipart/form-data`.

| Поле | Тип | Описание |
|---|---|---|
| `avatar` | file | Аватар, ≤ 5 МБ |
| `did` | string | DID владельца (обязательно) |
| `display_name` | string | Отображаемое имя |

---

### 4.5 Контент залов

#### `GET /api/contents/:hall`

Возвращает контент зала с учётом языка.

| Параметр | Где | Описание |
|---|---|---|
| `:hall` | path | Идентификатор зала, например `garden`, `workshop`, `healing` |
| `lang` | query | `ru` (по умолчанию), `en`, ... |

Если для запрошенного языка контента нет и `lang !== 'ru'`, возвращается русская версия.

**Ответ `200`**

```json
{ "success": true, "data": [ { "id": 3, "hall": "garden", "title": "...", "body": "..." } ] }
```

---

### 4.6 Мастерская (Artifacts)

#### `GET /api/artifacts`

Возвращает все артефакты мастерской.

#### `POST /api/artifacts`

Загружает новый артефакт. `multipart/form-data`, поле файла — `file` (≤ 10 МБ).

| Поле | Тип | Описание |
|---|---|---|
| `file` | file | Файл артефакта |
| `title` | string | Название |
| `description` | string | Описание |
| `author_did` | string | DID автора |

---

### 4.7 Админ-контент

Все маршруты требуют заголовок `x-admin-key`.

#### `POST /api/admin/contents`

Создаёт запись контента.

```json
{ "hall": "garden", "title": "Утро", "body": "Текст...", "order": 1, "lang": "ru" }
```

**Ответ `200`**

```json
{ "success": true, "id": 17 }
```

#### `PUT /api/admin/contents/:id`

Обновляет `title` и `body` записи по её `id`.

#### `DELETE /api/admin/contents/:id`

Удаляет запись контента.

---

### 4.8 Витрина задач (Bounties)

#### `GET /api/bounties`

Возвращает список задач, отсортированных по `created_at DESC`.

```json
{ "success": true, "data": [ { "id": 1, "title": "...", "reward": 100 } ] }
```

---

## 5. Модуль аутентификации (`auth`)

Реализован в `src/routes/auth.js`. Монтируется в приложение по пути `/auth`
(или `/api/auth`) при подключении. Использует `bcryptjs` + `jsonwebtoken`.

### `POST /register`

Регистрирует пользователя и сразу выдаёт JWT.

| Поле | Тип | Обязательное |
|---|---|---|
| `username` | string | да |
| `email` | string | да |
| `password` | string | да |

**Ответ `201`**

```json
{
  "success": true,
  "token": "eyJhbGciOi...",
  "user": { "id": 1, "username": "ada", "email": "ada@example.com" }
}
```

**Ошибки**

| Код | Условие | Тело |
|---|---|---|
| `400` | Не все поля заполнены | `{ "success": false, "error": "Все поля обязательны" }` |
| `409` | Email уже занят | `{ "success": false, "error": "Пользователь с таким email уже существует" }` |

### `POST /login`

Аутентификация по email и паролю.

| Поле | Тип | Обязательное |
|---|---|---|
| `email` | string | да |
| `password` | string | да |

**Ответ `200`**

```json
{
  "success": true,
  "token": "eyJhbGciOi...",
  "user": { "id": 1, "username": "ada", "email": "ada@example.com" }
}
```

**Ошибки**

| Код | Условие |
|---|---|
| `400` | Email или пароль не переданы |
| `401` | Неверные учётные данные |

Оба маршрута защищены `authLimiter` (см. §12).

---

## 6. Профиль-загрузки (`/api/profile`)

Модуль `src/routes/profile.js` монтируется на `/api/profile`.

### `POST /api/profile/update`

Обновляет аватар и/или отображаемое имя в таблице `did_reputation`.

`multipart/form-data`, лимит файла — **2 МБ**.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| `did` | string | да | DID пользователя |
| `display_name` | string | нет | Новое отображаемое имя |
| `avatar` | file | нет | Файл аватара |

**Ответ `200`**

```json
{ "success": true, "data": { "did": "did:phoenix:0x...", "display_name": "Ada", "avatar": "/uploads/avatars/1712345678-pic.png" } }
```

**Ошибки:** `400` при отсутствии `did`, `500` при ошибке БД.

---

## 7. WebSocket / Socket.IO

Realtime-слой поднимается на том же HTTP-сервере Socket.IO (`socket.io`).
Каждому соединению соответствует `socket.id`.

### 7.1 Client → Server события

| Событие | Payload | Описание |
|---|---|---|
| `authenticateDID` | `{ address, signature }` | Проверка подписи «Войти в Круг» |
| `joinCircle` | `{ name, room }` | Вход в комнату (`room` по умолчанию `общий`) |
| `circleMessage` | `{ text, signature? }` | Сообщение в комнату; при подписи помечается `verified` |
| `call-offer` | `{ to, signal }` | WebRTC offer (требует уровня доступа) |
| `call-answer` | `{ to, signal }` | WebRTC answer |
| `ice-candidate` | `{ to, candidate }` | ICE-кандидат |
| `private-message` | `{ to, text }` | Личное сообщение (требует уровня доступа) |
| `report-user` | `{ targetDid, reason }` | Жалоба на пользователя |
| `disconnect` | — | Отключение, очистка `onlineUsers` |

### 7.2 Server → Client события

| Событие | Payload | Описание |
|---|---|---|
| `authenticated` | `{ success, address }` \| `{ success: false, error }` | Результат проверки подписи |
| `message` | `{ from, text, time, did?, verified? }` | Сообщение комнаты |
| `onlineCount` | `number` | Число онлайн в комнате |
| `room-users` | `Array<{ id, name, status }>` | Список участников комнаты |
| `call-offer` / `call-answer` / `ice-candidate` | сигналы WebRTC | Проксирование сигналинга |
| `private-message` | `{ from, fromId, text, time }` | Личное сообщение |
| `error-notification` | `string` | Ошибка доступа / уровня |

### 7.3 Уровни доступа

Права меняются по репутации DID:

| Статус | Возможности |
|---|---|
| `newcomer` | чтение комнат, общие сообщения |
| `practitioner` | личные сообщения |
| `master` | звонки (WebRTC), модерация |

Проверка выполняется функцией `checkAccess(socket, action)`.

---

## 8. Встроенный REST-сервер (`public_api.js`)

`api/public_api.js` — автономный HTTP-сервер **без внешних зависимостей**.
Полезен для smoke-тестов и встраивания.

### Lifecycle

| Метод | Описание |
|---|---|
| `start([port][, options][, callback]) → Promise<http.Server>` | Запуск сервера |
| `stop([callback]) → Promise<void>` | Graceful shutdown |

```js
const { start, stop } = require('./api/public_api');
const server = await start(3000);
console.log('listening on', server.address().port);
await stop();
```

### Маршруты

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/health` | Liveness, аптайм, версия |
| `GET` | `/api` | Дескриптор API и ресурсы |
| `GET` | `/api/stats` | Счётчики пользователей/элементов и память |
| `GET` | `/api/users?role=` | Список пользователей с фильтром |
| `POST` | `/api/users` | Создать пользователя |
| `GET` | `/api/users/:id` | Получить пользователя |
| `PATCH` | `/api/users/:id` | Частичное обновление |
| `DELETE` | `/api/users/:id` | Удалить пользователя |
| `GET` | `/api/items?ownerId=&done=` | Список элементов |
| `POST` | `/api/items` | Создать элемент |
| `GET` | `/api/items/:id` | Получить элемент |
| `PUT` | `/api/items/:id` | Полная замена элемента |
| `DELETE` | `/api/items/:id` | Удалить элемент |

Все ответы — JSON. Максимальный размер тела — **1 МиБ** (`MAX_BODY_BYTES`).
CORS разрешён для всех источников, поддержан pre-flight `OPTIONS → 204`.

---

## 9. Клиентские SDK

### 9.1 JavaScript (`api/sdk_js.js`)

Модуль-клиент `Speedster` с типизированными ресурсами и классами ошибок.

| Экспорт | Назначение |
|---|---|
| `SpeedsterClient` | Основной клиент |
| `ApiError`, `TimeoutError`, `ValidationError` | Иерархия ошибок |
| `UsersResource`, `ProjectsResource`, `WebhooksResource` | Ресурсы |

```js
const { SpeedsterClient } = require('./api/sdk_js');
const client = new SpeedsterClient({ baseUrl: 'http://localhost:3000' });
const users = await client.users.list();
```

### 9.2 Python (`api/sdk_python.py`)

Клиент `Aeon` / `Everos` на стандартной библиотеке.

| Класс | Назначение |
|---|---|
| `AeonClient` / `EverosClient` | Основной клиент |
| `AeonError`, `AeonAPIError`, `AeonTimeoutError`, `AeonValidationError` | Ошибки |
| `AgentsResource`, `TasksResource` | Ресурсы |

```python
from api.sdk_python import AeonClient
client = AeonClient(base_url="http://localhost:3000")
agents = client.agents.list()
```

Поддерживаются: retry с экспоненциальным backoff, таймауты, стриминг ответов.

---

## 10. Формат ошибок

Доменный API (`src/routes`) использует конверт:

```json
{ "success": false, "error": "Человекочитаемое описание" }
```

Автономный сервер (`public_api.js`) использует структурированный конверт:

```json
{
  "error": {
    "code": "VALIDATION",
    "message": "Field \"name\" is required.",
    "details": { "field": "name" }
  },
  "status": 422
}
```

Коды ошибок автономного сервера: `VALIDATION`, `NOT_FOUND`,
`METHOD_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`, `INTERNAL`.

---

## 11. Коды состояния

| Код | Значение | Когда используется |
|---|---|---|
| `200` | OK | Успешный `GET` / `PUT` / `PATCH` / `DELETE` |
| `201` | Created | Создание пользователя / записи / регистрация |
| `204` | No Content | CORS pre-flight `OPTIONS` |
| `400` | Bad Request | Неверный JSON или отсутствие обязательного поля |
| `401` | Unauthorized | Неверные учётные данные / отсутствует токен |
| `403` | Forbidden | Нет прав (админ-ключ, уровень доступа) |
| `404` | Not Found | Ресурс не существует |
| `405` | Method Not Allowed | Путь есть, метод не поддержан (возвращается `Allow`) |
| `409` | Conflict | Дублирование (email уже занят) |
| `413` | Payload Too Large | Тело > 1 МиБ или файл > лимита |
| `422` | Unprocessable Entity | Ошибка валидации |
| `429` | Too Many Requests | Превышен rate limit |
| `500` | Internal Server Error | Непредвиденная ошибка сервера |

---

## 12. Rate limiting

Реализован в `api/rate_limiter.js` и `src/middleware/rateLimiter.js`.

- `generalLimiter` применяется ко всем запросам приложения.
- `authLimiter` — на маршрутах `/register` и `/login` для защиты от брутфорса.
- Реализация: token-bucket / sliding-window без внешних зависимостей.
- При превышении: `429 Too Many Requests`.

Заголовки ответа лимитера (если включены): `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, `X-RateLimit-Reset`.

---

## 13. Загрузка файлов

Осуществляется через `multer` (`diskStorage`).

| Маршрут | Поле | Лимит | Каталог назначения |
|---|---|---|---|
| `POST /api/profile/update` | `avatar` | 5 МБ | `public/uploads/avatars` |
| `POST /api/profile` (`src/routes/profile.js`) | `avatar` | 2 МБ | `public/uploads/avatars` |
| `POST /api/artifacts` | `file` | 10 МБ | `public/uploads` |

Имена файлов уникализируются: `Date.now() + '-' + originalname`
(для артефактов добавляется случайный суффикс). Расширение сохраняется.

---

## 14. Переменные окружения

| Переменная | Обязательная | По умолчанию | Описание |
|---|---|---|---|
| `PORT` | нет | `3000` | HTTP-порт сервера |
| `JWT_SECRET` | **да** | — | Секрет подписи JWT (приложение завершится без него) |
| `JWT_EXPIRES_IN` | нет | `7d` | Время жизни токена |
| `DB_PATH` | нет | встроенная SQLite | Путь к базе данных |
| `NODE_ENV` | нет | `development` | Режим окружения |
| `TELEGRAM_BOT_TOKEN` | нет | — | Токен бота (уведомления) |

Сгенерировать секрет:

```bash
openssl rand -hex 32
```

---

## 15. Примеры `curl`

### Регистрация и вход

```bash
curl -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"ada","email":"ada@example.com","password":"secret123"}'

curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"secret123"}'
```

### Генерация DID

```bash
curl -X POST http://localhost:3000/api/did/generate
```

### Контент зала с языком

```bash
curl 'http://localhost:3000/api/contents/healing?lang=en'
```

### Создание контента (админ)

```bash
curl -X POST http://localhost:3000/api/admin/contents \
  -H 'Content-Type: application/json' \
  -H 'x-admin-key: phoenix-architect-2024' \
  -d '{"hall":"garden","title":"Утро","body":"Текст","order":1,"lang":"ru"}'
```

### Загрузка артефакта

```bash
curl -X POST http://localhost:3000/api/artifacts \
  -F 'file=@artifact.pdf' \
  -F 'title=Мой артефакт' \
  -F 'author_did=did:phoenix:0x...'
```

### Bounties

```bash
curl http://localhost:3000/api/bounties
```

### Liveness автономного сервера

```bash
curl http://localhost:3000/health
```

---

## 16. Changelog

### 1.0.0

- Первый публичный релиз REST API под `/api`.
- DID-идентичность и подпись «Войти в Круг».
- Realtime-комнаты, личные сообщения и WebRTC-сигналинг.
- Блокчейн-регистрация артефактов.
- Автономные модули `public_api.js`, `auth.js`, `rate_limiter.js`, `websocket_api.js`.
- JavaScript SDK (`SpeedsterClient`) и Python SDK (`AeonClient` / `EverosClient`).
- Rate limiting и audit-логирование.

---

## 17. Приложение: карта HTTP-маршрутов

Ниже сведены все зарегистрированные маршруты основного приложения
(`server.js`) и автономного сервера (`api/public_api.js`). Таблица служит
быстрой шпаргалкой при интеграции.

### 17.1 Основное приложение (`server.js`)

| Метод | Путь | Назначение | Авторизация |
|---|---|---|---|
| `GET` | `/` | SPA-оболочка (`public/index.html`) | — |
| `GET` | `/admin` | Админ-панель (`public/admin.html`) | `x-admin-key` |
| `GET` | `/admin.html` | Алиас админ-панели | `x-admin-key` |
| `GET` | `/profile` | Профиль странника (`public/profile.html`) | — |
| `GET` | `/constitution` | Устав Круга (`public/constitution.html`) | — |
| `GET` | `/license` | Лицензия (`public/license.html`) | — |
| `GET` | `/support` | Поддержка (`public/support.html`) | — |
| `GET` | `/bounties` | Витрина задач (`public/bounties.html`) | — |
| `GET` | `/community` | Сообщество (`public/community.html`) | — |
| `GET` | `/network` | Редирект на `/network.html` | — |
| `GET` | `/network.html` | Карта узлов Сети Садов | — |
| `ALL` | `/api/profile/*` | Роутер профиля (`src/routes/profile`) | DID / JWT |
| `ALL` | `/api/*` | Основной REST API (см. раздел 4) | смешанная |
| `GET` | `*` | Fallback на SPA (`index.html`) | — |

### 17.2 Автономный сервер (`api/public_api.js`)

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/health` | Liveness-проба и статистика |
| `GET` | `/api/items` | Список ресурсов in-memory стора |
| `POST` | `/api/items` | Создание ресурса |
| `GET` | `/api/items/:id` | Чтение ресурса по `id` |
| `PUT` | `/api/items/:id` | Полное обновление ресурса |
| `DELETE` | `/api/items/:id` | Удаление ресурса |

### 17.3 Порядок разрешения маршрутов

1. Статические файлы из `public/` отдаются напрямую.
2. Явно объявленные маршруты (`/admin`, `/profile`, ...) имеют приоритет.
3. Префикс `/api` попадает в соответствующий роутер.
4. Все прочие пути уходят в SPA-fallback и возвращают `index.html`.

### 17.4 Проверка живости

```bash
# Основное приложение
curl -s http://localhost:3000/api/bounties | jq '.success'

# Автономный сервер
curl -s http://localhost:3000/health | jq '.'
```

Ожидаемый ответ `/health`:

```json
{
  "ok": true,
  "data": {
    "status": "up",
    "version": "1.0.0",
    "uptime": 12.34,
    "requests": 42,
    "errors": 0
  },
  "ts": "2026-01-01T00:00:00.000Z"
}
```

---

## 18. Расширенный каталог ошибок и валидация

### 18.1 Принципы валидации

Валидация выполняется на входе, до обращения к базе данных. Это защищает
SQLite от некорректных запросов и позволяет возвращать осмысленные ошибки.

| Правило | Поведение |
|---|---|
| Обязательные поля | Проверяются на «непустоту»; отсутствие → `400` |
| Типы | Числа не приводятся молча из строк; несоответствие → `422` |
| Строки | Обрезаются по краям (`trim`), пустые строки приравниваются к отсутствию |
| Длина | `title` ≤ 200 символов, `body` ≤ 20 000 символов |
| Email | Регулярное выражение `^[^@\s]+@[^@\s]+\.[^@\s]+# Phoenix Space — API Documentation

> **API Version:** 1.0.0
> **Service:** Phoenix Academy — «Академия Феникса»
> **Runtime:** Node.js ≥ 16 · Express 4 · Socket.IO 4 · SQLite (`better-sqlite3`)
> **Default HTTP port:** `3000` (`process.env.PORT` при переопределении)
> **Content-Type:** `application/json` (запросы и ответы), `multipart/form-data` для загрузок
> **Authentication:** JWT (`Authorization: Bearer <token>`) и DID-подпись (Ethereum `personal_sign`)

---

## Содержание

1. [Обзор](#1-обзор)
2. [Базовый URL и соглашения](#2-базовый-url-и-соглашения)
3. [Аутентификация](#3-аутентификация)
4. [Основной REST API (`/api`)](#4-основной-rest-api-api)
   - [Сад (Seeds)](#41-сад-seeds)
   - [Блокчейн-артефакты](#42-блокчейн-артефакты)
   - [DID](#43-did)
   - [Профиль](#44-профиль)
   - [Контент залов](#45-контент-залов)
   - [Мастерская (Artifacts)](#46-мастерская-artifacts)
   - [Админ-контент](#47-админ-контент)
   - [Витрина задач (Bounties)](#48-витрина-задач-bounties)
5. [Модуль аутентификации (`auth`)](#5-модуль-аутентификации-auth)
6. [Профиль-загрузки (`/api/profile`)](#6-профиль-загрузки-apiprofile)
7. [WebSocket / Socket.IO](#7-websocket--socketio)
8. [Встроенный REST-сервер (`public_api.js`)](#8-встроенный-rest-сервер-public_apijs)
9. [Клиентские SDK](#9-клиентские-sdk)
10. [Формат ошибок](#10-формат-ошибок)
11. [Коды состояния](#11-коды-состояния)
12. [Rate limiting](#12-rate-limiting)
13. [Загрузка файлов](#13-загрузка-файлов)
14. [Переменные окружения](#14-переменные-окружения)
15. [Примеры `curl`](#15-примеры-curl)
16. [Changelog](#16-changelog)

---

## 1. Обзор

Phoenix Space — это саморазвивающаяся платформа («Круг»), объединяющая:

- **REST API** на Express, смонтированный под префиксом `/api`;
- **Realtime-слой** на Socket.IO (комнаты, личные сообщения, WebRTC-сигналинг);
- **DID-идентичность** на базе Ethereum-адресов и подписей;
- **Репутацию** странников (уровни доступа `newcomer`, `practitioner`, `master` и т.д.);
- **Блокчейн-регистрацию** артефактов (on-chain);
- **Автономные модули** (`public_api.js`, `auth.js`, `rate_limiter.js`, `websocket_api.js`), которые можно встраивать независимо.

Все модули в `api/` спроектированы как **dependency-free** там, где это возможно,
и поддерживают `start()` / `stop()` с корректным graceful shutdown.

### Ключевые принципы

| Принцип | Описание |
|---|---|
| Единый конверт ответа | `{ "success": true, "data": ... }` либо `{ "error": {...} }` |
| Явная валидация | Обязательные поля проверяются, ошибки возвращают `400` / `422` |
| Идемпотентность чтения | Все `GET` безопасны и кэшируемы |
| Ограничение размера | Тела запросов и загрузки ограничены (см. §13) |
| Логирование | Каждый запрос проходит через `auditLogger` |

---

## 2. Базовый URL и соглашения

```
http://localhost:3000
```

Все доменные маршруты (кроме мета) доступны под префиксом `/api`:

```
GET  http://localhost:3000/api/contents/garden
POST http://localhost:3000/api/did/generate
```

Соглашения:

- Параметры пути кодируются в URL (`:hall`, `:did`, `:id`).
- Язык контента задаётся query-параметром `?lang=ru|en|...` (fallback → `ru`).
- Ответы коллекций: `{ "success": true, "data": [...] }`.
- Ответы одиночного ресурса: `{ "success": true, "data": {...} }`.
- Все даты — ISO-8601 UTC.
- Таймзона и локаль сообщений чата не влияют на API-формат.

---

## 3. Аутентификация

Поддерживаются два независимых механизма.

### 3.1 JWT (Bearer)

```
Authorization: Bearer <jwt-token>
```

- Алгоритм: HS256.
- Секрет: `process.env.JWT_SECRET` (обязателен; приложение завершается без него).
- Срок жизни токена: **7 дней**.
- Payload: `{ "id": <number>, "username": <string>, "iat": ..., "exp": ... }`.

### 3.2 DID-подпись (Ethereum)

1. Клиент вызывает `POST /api/did/generate` и получает `did`, `address`, `mnemonic`.
2. Для входа в чат клиент подписывает сообщение `"Войти в Круг"` приватным ключом.
3. Сервер проверяет подпись через `ethers.verifyMessage()`.
4. Совпадение `recoveredAddress` и `data.address` → событие `authenticated`.

### 3.3 Админ-ключ

Административные маршруты требуют заголовок:

```
x-admin-key: phoenix-architect-2024
```

При неверном ключе → `403 { "error": "Доступ запрещён" }`.

---

## 4. Основной REST API (`/api`)

Маршруты смонтированы из `src/routes/api.js`.

### 4.1 Сад (Seeds)

#### `GET /api/seeds`

Возвращает все «семена» (идеи, заявленные в саду).

**Ответ `200`**

```json
{ "success": true, "data": [ { "id": 1, "title": "Seed", "created_at": "..." } ] }
```

#### `POST /api/seeds`

Создаёт новое семя.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| `title` | string | да | Название семени |
| `body` | string | нет | Описание |
| `author_did` | string | нет | DID автора |

---

### 4.2 Блокчейн-артефакты

#### `POST /api/blockchain/register`

Регистрирует артефакт on-chain.

```json
{ "artifact_id": 42, "hash": "0x...", "owner_did": "did:phoenix:0x..." }
```

#### `GET /api/blockchain/artifact/:id`

Возвращает on-chain данные артефакта по идентификатору.

#### `GET /api/blockchain/artifacts`

Возвращает все зарегистрированные on-chain артефакты.

---

### 4.3 DID

#### `POST /api/did/generate`

Генерирует новую децентрализованную идентичность (DID) и кошелёк.

**Тело запроса:** пустое.

**Ответ `200`**

```json
{
  "success": true,
  "data": {
    "did": "did:phoenix:0xABC...",
    "address": "0xABC...",
    "mnemonic": "twelve word seed phrase ..."
  }
}
```

> ⚠️ `mnemonic` показывается один раз. Не логируйте и не передавайте его по незащищённым каналам.

---

### 4.4 Профиль

#### `GET /api/profile/:did`

Возвращает профиль и репутацию по DID.

#### `GET /api/profile?did=<did>`

Альтернативная форма. Без параметра `did` возвращает `400`:

```json
{ "success": false, "error": "Укажите DID" }
```

#### `POST /api/profile/update`

Обновляет профиль. `multipart/form-data`.

| Поле | Тип | Описание |
|---|---|---|
| `avatar` | file | Аватар, ≤ 5 МБ |
| `did` | string | DID владельца (обязательно) |
| `display_name` | string | Отображаемое имя |

---

### 4.5 Контент залов

#### `GET /api/contents/:hall`

Возвращает контент зала с учётом языка.

| Параметр | Где | Описание |
|---|---|---|
| `:hall` | path | Идентификатор зала, например `garden`, `workshop`, `healing` |
| `lang` | query | `ru` (по умолчанию), `en`, ... |

Если для запрошенного языка контента нет и `lang !== 'ru'`, возвращается русская версия.

**Ответ `200`**

```json
{ "success": true, "data": [ { "id": 3, "hall": "garden", "title": "...", "body": "..." } ] }
```

---

### 4.6 Мастерская (Artifacts)

#### `GET /api/artifacts`

Возвращает все артефакты мастерской.

#### `POST /api/artifacts`

Загружает новый артефакт. `multipart/form-data`, поле файла — `file` (≤ 10 МБ).

| Поле | Тип | Описание |
|---|---|---|
| `file` | file | Файл артефакта |
| `title` | string | Название |
| `description` | string | Описание |
| `author_did` | string | DID автора |

---

### 4.7 Админ-контент

Все маршруты требуют заголовок `x-admin-key`.

#### `POST /api/admin/contents`

Создаёт запись контента.

```json
{ "hall": "garden", "title": "Утро", "body": "Текст...", "order": 1, "lang": "ru" }
```

**Ответ `200`**

```json
{ "success": true, "id": 17 }
```

#### `PUT /api/admin/contents/:id`

Обновляет `title` и `body` записи по её `id`.

#### `DELETE /api/admin/contents/:id`

Удаляет запись контента.

---

### 4.8 Витрина задач (Bounties)

#### `GET /api/bounties`

Возвращает список задач, отсортированных по `created_at DESC`.

```json
{ "success": true, "data": [ { "id": 1, "title": "...", "reward": 100 } ] }
```

---

## 5. Модуль аутентификации (`auth`)

Реализован в `src/routes/auth.js`. Монтируется в приложение по пути `/auth`
(или `/api/auth`) при подключении. Использует `bcryptjs` + `jsonwebtoken`.

### `POST /register`

Регистрирует пользователя и сразу выдаёт JWT.

| Поле | Тип | Обязательное |
|---|---|---|
| `username` | string | да |
| `email` | string | да |
| `password` | string | да |

**Ответ `201`**

```json
{
  "success": true,
  "token": "eyJhbGciOi...",
  "user": { "id": 1, "username": "ada", "email": "ada@example.com" }
}
```

**Ошибки**

| Код | Условие | Тело |
|---|---|---|
| `400` | Не все поля заполнены | `{ "success": false, "error": "Все поля обязательны" }` |
| `409` | Email уже занят | `{ "success": false, "error": "Пользователь с таким email уже существует" }` |

### `POST /login`

Аутентификация по email и паролю.

| Поле | Тип | Обязательное |
|---|---|---|
| `email` | string | да |
| `password` | string | да |

**Ответ `200`**

```json
{
  "success": true,
  "token": "eyJhbGciOi...",
  "user": { "id": 1, "username": "ada", "email": "ada@example.com" }
}
```

**Ошибки**

| Код | Условие |
|---|---|
| `400` | Email или пароль не переданы |
| `401` | Неверные учётные данные |

Оба маршрута защищены `authLimiter` (см. §12).

---

## 6. Профиль-загрузки (`/api/profile`)

Модуль `src/routes/profile.js` монтируется на `/api/profile`.

### `POST /api/profile/update`

Обновляет аватар и/или отображаемое имя в таблице `did_reputation`.

`multipart/form-data`, лимит файла — **2 МБ**.

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| `did` | string | да | DID пользователя |
| `display_name` | string | нет | Новое отображаемое имя |
| `avatar` | file | нет | Файл аватара |

**Ответ `200`**

```json
{ "success": true, "data": { "did": "did:phoenix:0x...", "display_name": "Ada", "avatar": "/uploads/avatars/1712345678-pic.png" } }
```

**Ошибки:** `400` при отсутствии `did`, `500` при ошибке БД.

---

## 7. WebSocket / Socket.IO

Realtime-слой поднимается на том же HTTP-сервере Socket.IO (`socket.io`).
Каждому соединению соответствует `socket.id`.

### 7.1 Client → Server события

| Событие | Payload | Описание |
|---|---|---|
| `authenticateDID` | `{ address, signature }` | Проверка подписи «Войти в Круг» |
| `joinCircle` | `{ name, room }` | Вход в комнату (`room` по умолчанию `общий`) |
| `circleMessage` | `{ text, signature? }` | Сообщение в комнату; при подписи помечается `verified` |
| `call-offer` | `{ to, signal }` | WebRTC offer (требует уровня доступа) |
| `call-answer` | `{ to, signal }` | WebRTC answer |
| `ice-candidate` | `{ to, candidate }` | ICE-кандидат |
| `private-message` | `{ to, text }` | Личное сообщение (требует уровня доступа) |
| `report-user` | `{ targetDid, reason }` | Жалоба на пользователя |
| `disconnect` | — | Отключение, очистка `onlineUsers` |

### 7.2 Server → Client события

| Событие | Payload | Описание |
|---|---|---|
| `authenticated` | `{ success, address }` \| `{ success: false, error }` | Результат проверки подписи |
| `message` | `{ from, text, time, did?, verified? }` | Сообщение комнаты |
| `onlineCount` | `number` | Число онлайн в комнате |
| `room-users` | `Array<{ id, name, status }>` | Список участников комнаты |
| `call-offer` / `call-answer` / `ice-candidate` | сигналы WebRTC | Проксирование сигналинга |
| `private-message` | `{ from, fromId, text, time }` | Личное сообщение |
| `error-notification` | `string` | Ошибка доступа / уровня |

### 7.3 Уровни доступа

Права меняются по репутации DID:

| Статус | Возможности |
|---|---|
| `newcomer` | чтение комнат, общие сообщения |
| `practitioner` | личные сообщения |
| `master` | звонки (WebRTC), модерация |

Проверка выполняется функцией `checkAccess(socket, action)`.

---

## 8. Встроенный REST-сервер (`public_api.js`)

`api/public_api.js` — автономный HTTP-сервер **без внешних зависимостей**.
Полезен для smoke-тестов и встраивания.

### Lifecycle

| Метод | Описание |
|---|---|
| `start([port][, options][, callback]) → Promise<http.Server>` | Запуск сервера |
| `stop([callback]) → Promise<void>` | Graceful shutdown |

```js
const { start, stop } = require('./api/public_api');
const server = await start(3000);
console.log('listening on', server.address().port);
await stop();
```

### Маршруты

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/health` | Liveness, аптайм, версия |
| `GET` | `/api` | Дескриптор API и ресурсы |
| `GET` | `/api/stats` | Счётчики пользователей/элементов и память |
| `GET` | `/api/users?role=` | Список пользователей с фильтром |
| `POST` | `/api/users` | Создать пользователя |
| `GET` | `/api/users/:id` | Получить пользователя |
| `PATCH` | `/api/users/:id` | Частичное обновление |
| `DELETE` | `/api/users/:id` | Удалить пользователя |
| `GET` | `/api/items?ownerId=&done=` | Список элементов |
| `POST` | `/api/items` | Создать элемент |
| `GET` | `/api/items/:id` | Получить элемент |
| `PUT` | `/api/items/:id` | Полная замена элемента |
| `DELETE` | `/api/items/:id` | Удалить элемент |

Все ответы — JSON. Максимальный размер тела — **1 МиБ** (`MAX_BODY_BYTES`).
CORS разрешён для всех источников, поддержан pre-flight `OPTIONS → 204`.

---

## 9. Клиентские SDK

### 9.1 JavaScript (`api/sdk_js.js`)

Модуль-клиент `Speedster` с типизированными ресурсами и классами ошибок.

| Экспорт | Назначение |
|---|---|
| `SpeedsterClient` | Основной клиент |
| `ApiError`, `TimeoutError`, `ValidationError` | Иерархия ошибок |
| `UsersResource`, `ProjectsResource`, `WebhooksResource` | Ресурсы |

```js
const { SpeedsterClient } = require('./api/sdk_js');
const client = new SpeedsterClient({ baseUrl: 'http://localhost:3000' });
const users = await client.users.list();
```

### 9.2 Python (`api/sdk_python.py`)

Клиент `Aeon` / `Everos` на стандартной библиотеке.

| Класс | Назначение |
|---|---|
| `AeonClient` / `EverosClient` | Основной клиент |
| `AeonError`, `AeonAPIError`, `AeonTimeoutError`, `AeonValidationError` | Ошибки |
| `AgentsResource`, `TasksResource` | Ресурсы |

```python
from api.sdk_python import AeonClient
client = AeonClient(base_url="http://localhost:3000")
agents = client.agents.list()
```

Поддерживаются: retry с экспоненциальным backoff, таймауты, стриминг ответов.

---

## 10. Формат ошибок

Доменный API (`src/routes`) использует конверт:

```json
{ "success": false, "error": "Человекочитаемое описание" }
```

Автономный сервер (`public_api.js`) использует структурированный конверт:

```json
{
  "error": {
    "code": "VALIDATION",
    "message": "Field \"name\" is required.",
    "details": { "field": "name" }
  },
  "status": 422
}
```

Коды ошибок автономного сервера: `VALIDATION`, `NOT_FOUND`,
`METHOD_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`, `INTERNAL`.

---

## 11. Коды состояния

| Код | Значение | Когда используется |
|---|---|---|
| `200` | OK | Успешный `GET` / `PUT` / `PATCH` / `DELETE` |
| `201` | Created | Создание пользователя / записи / регистрация |
| `204` | No Content | CORS pre-flight `OPTIONS` |
| `400` | Bad Request | Неверный JSON или отсутствие обязательного поля |
| `401` | Unauthorized | Неверные учётные данные / отсутствует токен |
| `403` | Forbidden | Нет прав (админ-ключ, уровень доступа) |
| `404` | Not Found | Ресурс не существует |
| `405` | Method Not Allowed | Путь есть, метод не поддержан (возвращается `Allow`) |
| `409` | Conflict | Дублирование (email уже занят) |
| `413` | Payload Too Large | Тело > 1 МиБ или файл > лимита |
| `422` | Unprocessable Entity | Ошибка валидации |
| `429` | Too Many Requests | Превышен rate limit |
| `500` | Internal Server Error | Непредвиденная ошибка сервера |

---

## 12. Rate limiting

Реализован в `api/rate_limiter.js` и `src/middleware/rateLimiter.js`.

- `generalLimiter` применяется ко всем запросам приложения.
- `authLimiter` — на маршрутах `/register` и `/login` для защиты от брутфорса.
- Реализация: token-bucket / sliding-window без внешних зависимостей.
- При превышении: `429 Too Many Requests`.

Заголовки ответа лимитера (если включены): `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, `X-RateLimit-Reset`.

---

## 13. Загрузка файлов

Осуществляется через `multer` (`diskStorage`).

| Маршрут | Поле | Лимит | Каталог назначения |
|---|---|---|---|
| `POST /api/profile/update` | `avatar` | 5 МБ | `public/uploads/avatars` |
| `POST /api/profile` (`src/routes/profile.js`) | `avatar` | 2 МБ | `public/uploads/avatars` |
| `POST /api/artifacts` | `file` | 10 МБ | `public/uploads` |

Имена файлов уникализируются: `Date.now() + '-' + originalname`
(для артефактов добавляется случайный суффикс). Расширение сохраняется.

---

## 14. Переменные окружения

| Переменная | Обязательная | По умолчанию | Описание |
|---|---|---|---|
| `PORT` | нет | `3000` | HTTP-порт сервера |
| `JWT_SECRET` | **да** | — | Секрет подписи JWT (приложение завершится без него) |
| `JWT_EXPIRES_IN` | нет | `7d` | Время жизни токена |
| `DB_PATH` | нет | встроенная SQLite | Путь к базе данных |
| `NODE_ENV` | нет | `development` | Режим окружения |
| `TELEGRAM_BOT_TOKEN` | нет | — | Токен бота (уведомления) |

Сгенерировать секрет:

```bash
openssl rand -hex 32
```

---

## 15. Примеры `curl`

### Регистрация и вход

```bash
curl -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"ada","email":"ada@example.com","password":"secret123"}'

curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"secret123"}'
```

### Генерация DID

```bash
curl -X POST http://localhost:3000/api/did/generate
```

### Контент зала с языком

```bash
curl 'http://localhost:3000/api/contents/healing?lang=en'
```

### Создание контента (админ)

```bash
curl -X POST http://localhost:3000/api/admin/contents \
  -H 'Content-Type: application/json' \
  -H 'x-admin-key: phoenix-architect-2024' \
  -d '{"hall":"garden","title":"Утро","body":"Текст","order":1,"lang":"ru"}'
```

### Загрузка артефакта

```bash
curl -X POST http://localhost:3000/api/artifacts \
  -F 'file=@artifact.pdf' \
  -F 'title=Мой артефакт' \
  -F 'author_did=did:phoenix:0x...'
```

### Bounties

```bash
curl http://localhost:3000/api/bounties
```

### Liveness автономного сервера

```bash
curl http://localhost:3000/health
```

---

## 16. Changelog

### 1.0.0

- Первый публичный релиз REST API под `/api`.
- DID-идентичность и подпись «Войти в Круг».
- Realtime-комнаты, личные сообщения и WebRTC-сигналинг.
- Блокчейн-регистрация артефактов.
- Автономные модули `public_api.js`, `auth.js`, `rate_limiter.js`, `websocket_api.js`.
- JavaScript SDK (`SpeedsterClient`) и Python SDK (`AeonClient` / `EverosClient`).
- Rate limiting и audit-логирование.

---

## 17. Приложение: карта HTTP-маршрутов

Ниже сведены все зарегистрированные маршруты основного приложения
(`server.js`) и автономного сервера (`api/public_api.js`). Таблица служит
быстрой шпаргалкой при интеграции.

### 17.1 Основное приложение (`server.js`)

| Метод | Путь | Назначение | Авторизация |
|---|---|---|---|
| `GET` | `/` | SPA-оболочка (`public/index.html`) | — |
| `GET` | `/admin` | Админ-панель (`public/admin.html`) | `x-admin-key` |
| `GET` | `/admin.html` | Алиас админ-панели | `x-admin-key` |
| `GET` | `/profile` | Профиль странника (`public/profile.html`) | — |
| `GET` | `/constitution` | Устав Круга (`public/constitution.html`) | — |
| `GET` | `/license` | Лицензия (`public/license.html`) | — |
| `GET` | `/support` | Поддержка (`public/support.html`) | — |
| `GET` | `/bounties` | Витрина задач (`public/bounties.html`) | — |
| `GET` | `/community` | Сообщество (`public/community.html`) | — |
| `GET` | `/network` | Редирект на `/network.html` | — |
| `GET` | `/network.html` | Карта узлов Сети Садов | — |
| `ALL` | `/api/profile/*` | Роутер профиля (`src/routes/profile`) | DID / JWT |
| `ALL` | `/api/*` | Основной REST API (см. раздел 4) | смешанная |
| `GET` | `*` | Fallback на SPA (`index.html`) | — |

### 17.2 Автономный сервер (`api/public_api.js`)

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/health` | Liveness-проба и статистика |
| `GET` | `/api/items` | Список ресурсов in-memory стора |
| `POST` | `/api/items` | Создание ресурса |
| `GET` | `/api/items/:id` | Чтение ресурса по `id` |
| `PUT` | `/api/items/:id` | Полное обновление ресурса |
| `DELETE` | `/api/items/:id` | Удаление ресурса |

### 17.3 Порядок разрешения маршрутов

1. Статические файлы из `public/` отдаются напрямую.
2. Явно объявленные маршруты (`/admin`, `/profile`, ...) имеют приоритет.
3. Префикс `/api` попадает в соответствующий роутер.
4. Все прочие пути уходят в SPA-fallback и возвращают `index.html`.

### 17.4 Проверка живости

```bash
# Основное приложение
curl -s http://localhost:3000/api/bounties | jq '.success'

# Автономный сервер
curl -s http://localhost:3000/health | jq '.'
```

Ожидаемый ответ `/health`:

```json
{
  "ok": true,
  "data": {
    "status": "up",
    "version": "1.0.0",
    "uptime": 12.34,
    "requests": 42,
    "errors": 0
  },
  "ts": "2026-01-01T00:00:00.000Z"
}
```

---

 |
| DID | Формат `did:phoenix:0x[0-9a-fA-F]{40}` |
| Hash | 32 байта в hex, префикс `0x` |

### 18.2 Таблица частых ошибок

| Код | `code` | Причина | Как исправить |
|---|---|---|---|
| `400` | `BAD_REQUEST` | Тело не является JSON | Проверьте `Content-Type` и синтаксис |
| `400` | `MISSING_FIELD` | Нет обязательного поля | Добавьте поле в тело запроса |
| `401` | `UNAUTHORIZED` | Токен отсутствует или истёк | Обновите JWT |
| `403` | `FORBIDDEN` | Нет admin-key / уровень доступа | Передайте корректный ключ |
| `404` | `NOT_FOUND` | Ресурс не найден по `id` | Проверьте идентификатор |
| `405` | `METHOD_NOT_ALLOWED` | Метод не поддержан | Смотрите заголовок `Allow` |
| `409` | `CONFLICT` | Дублирование email | Используйте другой email |
| `413` | `PAYLOAD_TOO_LARGE` | Файл превышает лимит | Уменьшите размер файла |
| `422` | `VALIDATION` | Ошибка типов/формата | Исправьте поле из `details.field` |
| `429` | `RATE_LIMITED` | Превышен rate limit | Повторите после `X-RateLimit-Reset` |
| `500` | `INTERNAL` | Ошибка сервера | Обратитесь в поддержку с `requestId` |

### 18.3 Пример полного ответа об ошибке

```json
{
  "error": {
    "code": "VALIDATION",
    "message": "Field \"title\" is required.",
    "details": { "field": "title", "rule": "required" },
    "requestId": "a1b2c3d4"
  },
  "status": 422
}
```

---

## 19. Пагинация, фильтрация и сортировка

Коллекционные эндпоинты поддерживают единый набор query-параметров.

| Параметр | Тип | По умолчанию | Описание |
|---|---|---|---|
| `limit` | int | `20` | Количество записей (максимум `100`) |
| `offset` | int | `0` | Смещение от начала выборки |
| `sort` | string | `created_at` | Поле сортировки |
| `order` | string | `desc` | `asc` или `desc` |
| `q` | string | — | Полнотекстовый поиск по `title` |
| `lang` | string | `ru` | Язык контента |
| `from` | ISO date | — | Нижняя граница по `created_at` |
| `to` | ISO date | — | Верхняя граница по `created_at` |

### 19.1 Мета-информация в ответе

При пагинации коллекция возвращает дополнительный объект `meta`:

```json
{
  "success": true,
  "data": [ { "id": 1 }, { "id": 2 } ],
  "meta": { "total": 42, "limit": 20, "offset": 0, "hasMore": true }
}
```

### 19.2 Примеры

```bash
# Первые 10 задач, свежие сверху
curl 'http://localhost:3000/api/bounties?limit=10&order=desc'

# Поиск по семенам со словом "огонь"
curl 'http://localhost:3000/api/seeds?q=огонь'

# Контент за период
curl 'http://localhost:3000/api/contents/garden?from=2026-01-01&to=2026-02-01'
```

### 19.3 Соглашения о фильтрах

- Неизвестные query-параметры игнорируются (не приводят к ошибке).
- `limit` вне диапазона нормализуется к ближайшей границе.
- `offset` отрицательный → `0`.
- Комбинирование `q` и временных границ допускается.

---

## 20. Идемпотентность и повторные запросы

### 20.1 Безопасные методы

`GET`, `HEAD` и `OPTIONS` идемпотентны и не изменяют состояние.

### 20.2 Ключ идемпотентности

Для `POST`, создающих ресурсы, можно передать заголовок:

```
Idempotency-Key: <uuid-v4>
```

Сервер запоминает ключ на 24 часа. Повторный запрос с тем же ключом
возвращает ранее созданный ресурс и код `200` вместо `201`, не создавая
дубликат. Конфликт payload при том же ключе → `409 IDEMPOTENCY_CONFLICT`.

```bash
curl -X POST http://localhost:3000/api/seeds \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 8f14e45f-ea0d-4b1c-a3b2-1f9c9c0a1234' \
  -d '{"title":"Ветер"}'
```

### 20.3 Рекомендации по ретраям

| Ситуация | Действие |
|---|---|
| Сетевой таймаут | Повтор с `Idempotency-Key` |
| `429` | Повтор с экспоненциальной задержкой |
| `5xx` | До 3 повторов с backoff |
| `4xx` (кроме `429`) | Не повторять — исправить запрос |

---

## 21. Безопасность: руководство для интегратора

1. **Никогда не храните `mnemonic` на сервере.** Он выдаётся один раз.
2. **JWT-секрет** держите в переменной окружения, а не в коде.
3. **HTTPS обязателен** для продакшена; DID-подписи без TLS бесполезны.
4. **Админ-ключ** не должен попадать в клиентский бандл.
5. **Ограничивайте CORS** в продакшене конкретным origin.
6. **Скачивайте загруженные файлы** только из белого списка расширений.
7. **Логируйте `requestId`**, но никогда — токены и мнемоники.
8. **Ротируйте ключи** и секреты минимум раз в квартал.

### 21.1 Заголовки безопасности (рекомендуемые)

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'self'
```

---

## 22. Частые вопросы (FAQ)

**Нужны ли блокчейн и кошелёк для чтения контента?**
Нет. DID требуется только для аутентификации, репутации и подписи сообщений.

**Чем отличается `/api` от `/api/items` автономного сервера?**
`/api` — доменный API (контент, DID, артефакты). Автономный сервер
(`public_api.js`) — учебный in-memory API для тестов и встраивания.

**Как узнать число онлайн-пользователей?**
Через WebSocket-событие `onlineCount` после подключения к комнате.

**Почему `mnemonic` больше не возвращается повторно?**
По соображениям безопасности. При утере восстановление невозможно.

**Как передать язык, отличный от русского?**
Query-параметр `?lang=en`. При отсутствии перевода вернётся русская версия.

**Как обрабатывать истёкший JWT?**
Перехватите `401`, выполните повторный вход и повторите запрос.

---

## 23. Матрица совместимости клиентов

| Возможность | JS SDK | Python SDK | curl | Socket.IO |
|---|---|---|---|---|
| REST `/api` | ✅ | ✅ | ✅ | — |
| Auth (JWT) | ✅ | ✅ | ✅ | — |
| DID-подпись | ⚠️ (ethers) | ⚠️ (web3) | — | ✅ |
| Realtime-комнаты | — | — | — | ✅ |
| Загрузка файлов | ✅ | ✅ | ✅ | — |
| Retry/backoff | ✅ | ✅ | — | — |
| Стриминг ответов | ✅ | ✅ | — | — |

---

## 24. Фрагмент спецификации OpenAPI 3.1

```yaml
openapi: 3.1.0
info:
  title: Phoenix Space API
  version: 1.0.0
  description: REST + Realtime API Круга Феникса
servers:
  - url: http://localhost:3000
paths:
  /api/contents/{hall}:
    get:
      summary: Контент зала
      parameters:
        - name: hall
          in: path
          required: true
          schema: { type: string }
        - name: lang
          in: query
          schema: { type: string, default: ru }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean }
                  data: { type: array, items: { type: object } }
  /api/did/generate:
    post:
      summary: Генерация DID
      responses:
        '200': { description: OK }
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
```

---

## 25. Глоссарий

| Термин | Значение |
|---|---|
| **Круг** | Сообщество странников платформы |
| **Странник** | Пользователь, обладающий DID |
| **Сад** | Раздел идей («семян») |
| **Семя (seed)** | Черновая идея, заявленная в саду |
| **Зал (hall)** | Тематический раздел контента |
| **Мастерская** | Раздел артефактов (результатов практик) |
| **Артефакт** | Завершённый результат, возможно on-chain |
| **DID** | Децентрализованный идентификатор |
| **Репутация** | Оценка вклада, влияющая на уровень доступа |
| **Уровень доступа** | `newcomer`, `practitioner`, `master` |
| **Bounty** | Задача с наградой |
| **DID-подпись** | Подпись сообщения приватным ключом Ethereum |

---

## 26. Контрольный список интеграции

- [ ] Заданы `JWT_SECRET` и `PORT`.
- [ ] Настроен HTTPS и заголовки безопасности.
- [ ] Реализована обработка `401` с повторным входом.
- [ ] Ретраи обёрнуты `Idempotency-Key`.
- [ ] Ограничены размеры загружаемых файлов.
- [ ] Подписка на WebSocket-события и очистка при `disconnect`.
- [ ] Логирование по `requestId` без секретов.
- [ ] Мониторинг `/health` и `/api/stats`.

---

*Документ поддерживается командой Phoenix Space. Все примеры проверены на Node.js ≥ 16.*
