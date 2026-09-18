# 📡 Phoenix Space — Справочник API

> Полное описание HTTP, WebSocket и клиентских SDK проекта «Феникс».

- **Базовый URL (dev):** `http://localhost:3000`
- **Версия API:** `1.0.0`
- **Формат данных:** JSON (`Content-Type: application/json`), файлы — `multipart/form-data`
- **Кодировка:** UTF-8
- **Аутентификация:** JWT (`Authorization: Bearer <token>`) + админ-ключ `X-Admin-Key`
- **Языки контента:** `ru`, `en`, `de`, `es`, `fr`, `zh`, `ar`
- **Runtime:** Node.js ≥ 16 · Express 4 · Socket.IO 4 · SQLite (`better-sqlite3`)

---

## 📚 Содержание

1. [Общие соглашения](#-общие-соглашения)
2. [Коды состояния и ошибки](#-коды-состояния-и-ошибки)
3. [Аутентификация](#-аутентификация)
4. [Встроенный REST-сервер (public_api.js)](#-встроенный-rest-сервер-public_apijs)
5. [Академия: контент залов](#-академия-контент-залов)
6. [Профиль](#-профиль)
7. [Сад (Seeds)](#-сад-seeds)
8. [DID](#-did)
9. [Блокчейн-артефакты](#-блокчейн-артефакты)
10. [Мастерская (Artifacts)](#-мастерская-artifacts)
11. [Витрина задач (Bounties)](#-витрина-задач-bounties)
12. [WebSocket / Socket.IO](#-websocket--socketio)
13. [Клиентские SDK](#-клиентские-sdk)
14. [Rate limiting](#-rate-limiting)
15. [Aeon Agents Server](#-aeon-agents-server-aeon_agents_serverjs)
16. [Переменные окружения](#-переменные-окружения)
17. [Примеры curl](#-примеры-curl)

---

## 📐 Общие соглашения

### Формат успешного ответа

```json
{
  "success": true,
  "data": { }
}
```

### Формат ответа встроенного сервера (`public_api.js`)

```json
{
  "count": 3,
  "data": [ { "id": "itm_ab12cd34ef56" } ]
}
```

### Формат ошибки

```json
{
  "error": {
    "code": "VALIDATION",
    "message": "Field \"title\" is required.",
    "details": { "field": "title" }
  }
}
```

### Коды состояния

| Код | Значение |
|-----|----------|
| 200 | Успех |
| 201 | Ресурс создан |
| 204 | Успех без тела ответа |
| 400 | Некорректный запрос (malformed JSON) |
| 401 | Не авторизован (нет/просрочен токен) |
| 403 | Доступ запрещён (роль/ключ) |
| 404 | Ресурс или маршрут не найден |
| 405 | Метод не разрешён (`Allow` в заголовке) |
| 413 | Тело запроса превышает 1 MiB |
| 422 | Ошибка валидации полей |
| 429 | Превышен лимит запросов |
| 500 | Внутренняя ошибка сервера |

### Заголовки запроса

| Заголовок | Назначение |
|-----------|------------|
| `Authorization` | `Bearer <jwt>` — авторизация пользователя |
| `X-Admin-Key` | Админ-ключ для `/api/admin/*` |
| `Content-Type` | `application/json` или `multipart/form-data` |
| `Accept-Language` | Предпочитаемый язык контента |
| `X-Request-Id` | Сквозной идентификатор для трассировки |

### CORS

Все ответы встроенного сервера содержат:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

Preflight `OPTIONS` обрабатывается автоматически и возвращает `204`.

---

## 🔐 Аутентификация

### POST `/api/auth/register`

Регистрирует нового странника.

**Тело запроса**

| Поле | Тип | Обязательное | Описание |
|------|-----|:---:|----------|
| `username` | string | ✅ | Логин, 3–32 символа |
| `email` | string | ✅ | Валидный e-mail |
| `password` | string | ✅ | Минимум 8 символов |
| `language` | string | — | Язык интерфейса |

**Ответ `201`**

```json
{
  "success": true,
  "data": {
    "user": { "id": 12, "username": "wanderer", "role": "newcomer" },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

**Ошибки:** `422` — поля пусты/некорректны; `409` — пользователь уже существует.

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"wanderer","email":"w@example.com","password":"s3cret-pass"}'
```

### POST `/api/auth/login`

Выдаёт JWT по логину/паролю.

**Тело запроса**

| Поле | Тип | Обязательное |
|------|-----|:---:|
| `username` | string | ✅ |
| `password` | string | ✅ |

**Ответ `200`**

```json
{
  "success": true,
  "data": { "token": "eyJ...", "expiresIn": 604800 }
}
```

**Ошибки:** `401` — неверные учётные данные.

### GET `/api/auth/me`

Возвращает профиль по токену.

```
Authorization: Bearer <token>
```

**Ответ `200`**

```json
{
  "success": true,
  "data": { "id": 12, "username": "wanderer", "role": "practitioner", "did": "did:ethr:0xabc..." }
}
```

---

## 🔌 Встроенный REST-сервер (`public_api.js`)

Модуль `api/public_api.js` — REST-сервер без сторонних зависимостей (только Node.js core).
Публичный интерфейс модуля:

```js
const api = require('./api/public_api.js');

const server = await api.start(0);        // start(port[, options][, callback]) -> Promise<http.Server>
console.log(server.address().port);
await api.stop();                         // stop([callback]) -> Promise<void>
```

- `start(0)` — слушает случайный свободный порт (удобно для тестов).
- `stop()` — graceful shutdown, обнуляет `api.server`.

### GET `/health`

Проверка живости.

```json
{
  "status": "ok",
  "name": "public_api",
  "version": "1.0.0",
  "uptimeSeconds": 42,
  "timestamp": "2026-09-14T06:00:00.000Z"
}
```

### GET `/api`

Метаданные API и список ресурсов.

```json
{
  "name": "public_api",
  "version": "1.0.0",
  "resources": ["users", "items", "stats"]
}
```

### GET `/api/stats`

Агрегированная статистика в памяти.

```json
{
  "users": 1,
  "items": 1,
  "completedItems": 0,
  "memoryBytes": 48123904
}
```

### Ресурс `users`

#### GET `/api/users`

Список пользователей. Query-параметр `role` фильтрует по роли.

```bash
curl 'http://localhost:3000/api/users?role=admin'
```

```json
{ "count": 1, "data": [ { "id": "usr_admin", "name": "Administrator", "role": "admin" } ] }
```

#### POST `/api/users`

Создаёт пользователя. Обязательные поля: `name`, `email` (с `@`).

```bash
curl -X POST http://localhost:3000/api/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Neo","email":"neo@example.com","role":"user"}'
```

Ответ `201`:

```json
{
  "id": "usr_ab12cd34ef56",
  "name": "Neo",
  "email": "neo@example.com",
  "role": "user",
  "createdAt": "2026-09-14T06:00:00.000Z"
}
```

Ошибка `422`:

```json
{ "error": { "code": "VALIDATION", "message": "Field \"email\" must be a valid address." } }
```

#### GET `/api/users/:id`

Возвращает пользователя или `404` (`NOT_FOUND`).

#### PATCH `/api/users/:id`

Частичное обновление переданных полей.

#### DELETE `/api/users/:id`

Удаляет пользователя.

```json
{ "deleted": true, "id": "usr_ab12cd34ef56" }
```

### Ресурс `items`

#### GET `/api/items`

Список элементов. Поддерживает фильтр `done=true|false`.

#### POST `/api/items`

Создаёт элемент. Обязательное поле — `title`.

```bash
curl -X POST http://localhost:3000/api/items \
  -H 'Content-Type: application/json' \
  -d '{"title":"smoke item","description":"test"}'
```

Ответ `201`:

```json
{
  "id": "itm_ff00aa11bb22",
  "title": "smoke item",
  "description": "test",
  "ownerId": "usr_admin",
  "done": false,
  "createdAt": "2026-09-14T06:00:00.000Z"
}
```

Пустое тело даёт `422 VALIDATION`.

#### GET `/api/items/:id`

Возвращает один элемент или `404`.

#### PUT `/api/items/:id`

Полное обновление элемента (`title`, `description`, `done`).

```bash
curl -X PUT http://localhost:3000/api/items/itm_ff00aa11bb22 \
  -H 'Content-Type: application/json' \
  -d '{"title":"renamed","done":true}'
```

#### DELETE `/api/items/:id`

```json
{ "deleted": true }
```

### Поведение маршрутизатора

- Шаблоны вида `/api/items/:id` компилируются в регулярные выражения.
- Неизвестный маршрут → `404` с телом `{ "error": { "code": "NOT_FOUND", ... } }`.
- Известный путь с неподдерживаемым методом → `405`, заголовок `Allow` перечисляет методы.
- Тело запроса для `POST/PUT/PATCH` читается с лимитом **1 MiB**; превышение → `413`.
- Логирование: `[ISO-timestamp] [public_api] METHOD /path -> status (Nms)`.

---

## 🏛️ Академия: контент залов

### GET `/api/contents/:hall`

Возвращает контент конкретного зала (`hall`) с локализацией.

| Query | Тип | Описание |
|-------|-----|----------|
| `lang` | string | Код языка (`ru`, `en`, ...). По умолчанию `ru`. |
| `limit` | number | Максимум записей |
| `offset` | number | Смещение для пагинации |

```json
{
  "success": true,
  "data": {
    "hall": "awakening",
    "language": "en",
    "items": [
      { "id": 1, "title": "Awakening", "body": "...", "order": 1 }
    ]
  }
}
```

### POST `/api/admin/contents`

Создание контента. Требуется `X-Admin-Key`.

| Поле | Тип | Обязательное |
|------|-----|:---:|
| `hall` | string | ✅ |
| `language` | string | ✅ |
| `title` | string | ✅ |
| `body` | string | ✅ |
| `order` | number | — |

### PUT `/api/admin/contents/:id`

Обновление полей контента (админ-ключ).

### DELETE `/api/admin/contents/:id`

Удаление контента (админ-ключ). Возвращает `{ "success": true }`.

---

## 👤 Профиль

### GET `/api/profile/:did`

Профиль странника по DID.

```json
{
  "success": true,
  "data": {
    "did": "did:ethr:0xabc...",
    "username": "wanderer",
    "reputation": 120,
    "level": "practitioner",
    "avatar": "/uploads/avatars/usr12.png",
    "language": "ru"
  }
}
```

### GET `/api/profile?did=<did>`

Альтернативная форма получения профиля через query-параметр.

### POST `/api/profile/update`

Обновление профиля. Требуется JWT.

| Поле | Тип | Описание |
|------|-----|----------|
| `username` | string | Новый логин |
| `bio` | string | Описание |
| `language` | string | Язык интерфейса |
| `avatar` | string | Путь к загруженному аватару |

---

## 🌱 Сад (Seeds)

### GET `/api/seeds`

Список «семян» — идей/задач сети Садов.

```json
{
  "success": true,
  "data": [ { "id": 1, "title": "Seed", "status": "growing", "author": "wanderer" } ]
}
```

### POST `/api/seeds`

Создание семени (требуется JWT).

| Поле | Тип | Обязательное |
|------|-----|:---:|
| `title` | string | ✅ |
| `description` | string | — |
| `tags` | string[] | — |

---

## 🆔 DID

### POST `/api/did/generate`

Генерирует децентрализованный идентификатор `did:ethr:<address>`.

```json
{
  "success": true,
  "data": {
    "did": "did:ethr:0x1234...abcd",
    "address": "0x1234...abcd",
    "publicKey": "0x04...",
    "mnemonic": "word1 word2 ... word12"
  }
}
```

> ⚠️ `mnemonic` возвращается **только один раз** при генерации — храните его офлайн.

---

## ⛓️ Блокчейн-артефакты

Сеть: **Polygon** (ethers.js).

### POST `/api/blockchain/register`

Регистрирует артефакт on-chain.

| Поле | Тип | Обязательное |
|------|-----|:---:|
| `artifactId` | number | ✅ |
| `hash` | string | ✅ |
| `ownerDid` | string | ✅ |

Ответ содержит `txHash` и `blockNumber`.

### GET `/api/blockchain/artifact/:id`

Возвращает on-chain метаданные артефакта.

### GET `/api/blockchain/artifacts`

Список всех зарегистрированных артефактов.

---

## 🎨 Мастерская (Artifacts)

### GET `/api/artifacts`

Список артефактов. Query: `author`, `type`, `limit`, `offset`.

### POST `/api/artifacts`

Загрузка артефакта (`multipart/form-data`).

| Поле формы | Тип | Обязательное |
|------------|-----|:---:|
| `title` | text | ✅ |
| `description` | text | — |
| `file` | file | ✅ |
| `type` | text | — |

```bash
curl -X POST http://localhost:3000/api/artifacts \
  -H "Authorization: Bearer $TOKEN" \
  -F title="My artifact" \
  -F file=@./diagram.png
```

---

## 🏆 Витрина задач (Bounties)

### GET `/api/bounties`

Список задач с наградами.

| Query | Описание |
|-------|----------|
| `status` | `open`, `in_progress`, `done` |
| `minReward` | Минимальная награда |

```json
{
  "success": true,
  "data": [ { "id": 7, "title": "Fix bug", "reward": 50, "status": "open" } ]
}
```

---

## 🔌 WebSocket / Socket.IO

Подключение:

```js
const { io } = require('socket.io-client');
const socket = io('http://localhost:3000', { auth: { token: JWT } });
```

### События

| Событие | Направление | Описание |
|---------|-------------|----------|
| `connect` | → клиент | Соединение установлено |
| `disconnect` | → клиент | Соединение разорвано |
| `join:room` | ← клиент | Вход в комнату зала |
| `leave:room` | ← клиент | Выход из комнаты |
| `message:new` | ↔ обе стороны | Новое сообщение |
| `reputation:update` | → клиент | Изменение репутации |
| `artifact:minted` | → клиент | Артефакт зарегистрирован on-chain |
| `signal` | ↔ обе стороны | WebRTC-сигналинг |
| `error` | → клиент | Ошибка авторизации/обработки |

### Пример клиента

```js
socket.on('connect', () => {
  socket.emit('join:room', { hall: 'awakening' });
});
socket.on('message:new', (msg) => console.log('new:', msg));
socket.emit('message:new', { room: 'awakening', text: 'Привет!' });
```

---

## 🧩 Клиентские SDK

### JavaScript (`api/sdk_js.js`)

```js
const { createClient } = require('./api/sdk_js.js');

const client = createClient({
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.API_KEY,
  timeout: 10000,
});

await client.ping();                       // GET /health
await client.users.list();                 // GET /api/users
await client.users.create({ name: 'Neo' }); // POST /api/users
await client.projects.list({ limit: 20 }); // автопагинация
```

Возможности:

- Middleware-цепочка `(request, next) => Promise<response>` (`client.transport.use()`).
- Автоматический retry с экспоненциальным backoff.
- Таймауты через `AbortController`.
- Типизированные ошибки: `ApiError`, `TimeoutError`, `ValidationError`.
- Автопагинация: `for await (const item of client.users.paginate()) { ... }`.

### Python (`api/sdk_python.py`)

```python
from api.sdk_python import AeonClient  # или HttpClient

client = AeonClient(base_url="http://localhost:3000", api_key="...")
client.agents.list()
client.agents.create({"name": "scout", "model": "deepseek-chat"})
client.agents.invoke("agent_1", {"prompt": "hello"})
for chunk in client.agents.stream("agent_1", {"prompt": "hello"}):
    print(chunk)
```

Исключения:

| Класс | Когда |
|-------|-------|
| `AeonError` | Базовый класс |
| `AeonAPIError` | Ответ `4xx`/`5xx` |
| `AeonTimeoutError` | Превышен таймаут |
| `AeonValidationError` | Ошибка валидации тела |

---

## 🧪 Smoke-тесты

Файл `.tmp_public_api_smoke.js` проверяет ключевые сценарии end-to-end:

```bash
node .tmp_public_api_smoke.js
```

Проверки:

- `GET /health` → `status === 'ok'`
- `POST /api/items` → создание
- `GET /api/items` → список
- `PUT /api/items/:id` → обновление
- `DELETE /api/items/:id` → удаление
- `POST /api/items` с пустым телом → `422`
- неизвестный маршрут → `404`
- `api.stop()` очищает сервер

---

## 🚦 Rate limiting

Модуль `api/rate_limiter.js` ограничивает частоту запросов по IP/ключу.

| Параметр | Значение по умолчанию |
|----------|-----------------------|
| Окно | 60 секунд |
| Лимит | 100 запросов |
| Заголовки ответа | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` |

При превышении — `429 Too Many Requests`.

---

## ⚙️ Переменные окружения

| Переменная | По умолчанию | Описание |
|------------|:---:|----------|
| `PORT` | `3000` | Порт HTTP-сервера |
| `HOST` | `0.0.0.0` | Интерфейс прослушивания |
| `JWT_SECRET` | — | Секрет подписи JWT |
| `ADMIN_KEY` | — | Значение `X-Admin-Key` |
| `DEEPSEEK_API_KEY` | — | Ключ LLM (DeepSeek) |
| `DATABASE_PATH` | `./phoenix.db` | Путь к SQLite |
| `CORS_ORIGIN` | `*` | Разрешённый origin |

---

## 🔗 Конфигурация запуска

```js
const api = require('./api/public_api.js');

// Случайный порт (тесты)
const srv = await api.start(0);

// Фиксированный порт + кастомные опции
await api.start(3000, {
  host: '127.0.0.1',
  maxBodyBytes: 2 * 1024 * 1024,
}, () => console.log('public_api listening'));

// Graceful shutdown
await api.stop();
```

Экспортируемые из модуля сущности: `start`, `stop`, `server`, `router`, `db`.

---

## 💡 Примеры curl

### Health-check

```bash
curl -s http://localhost:3000/health | jq .
```

### Создание и завершение элемента

```bash
ITEM=$(curl -s -X POST http://localhost:3000/api/items \
  -H 'Content-Type: application/json' \
  -d '{"title":"Deploy v1.0.0"}')
ID=$(echo "$ITEM" | jq -r .id)

curl -s -X PUT "http://localhost:3000/api/items/$ID" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Deploy v1.0.0","done":true}' | jq .
```

### Список пользователей-админов

```bash
curl -s 'http://localhost:3000/api/users?role=admin' | jq '.count'
```

### Авторизованный запрос

```bash
curl -s http://localhost:3000/api/profile/0xabc... \
  -H "Authorization: Bearer $TOKEN"
```

---

## 🛰️ Aeon Agents Server (`aeon_agents_server.js`)

Отдельный Express-сервер для управления автономными агентами, их задачами,
платежами, проектами и низкоуровневыми операциями (read/write/exec/think).
Все маршруты, если не указано иное, используют базовый URL `http://localhost:3000`.

### Сводная таблица маршрутов

| Метод | Путь | Auth | Назначение |
|-------|------|:----:|------------|
| POST | `/agents/register` | — | Регистрация агента |
| POST | `/agents/login` | — | Логин, выдача JWT |
| GET | `/agents` | — | Публичный список агентов |
| GET | `/agents/me` | JWT | Профиль текущего агента |
| GET | `/agents/tasks` | JWT | Доступные задачи агента |
| POST | `/agents/submit` | JWT | Отправка результата по задаче |
| GET | `/agents/account` | JWT | Баланс и тариф агента |
| GET | `/agents/account/data` | JWT | Данные аккаунта (JSON) |
| POST | `/agents/account/tariff` | JWT | Смена тарифа |
| GET | `/agents/tariffs` | — | Каталог тарифов |
| GET | `/agents/payment` | — | Платёжная страница/статус |
| POST | `/agents/payment/process` | JWT | Обработка платежа |
| POST | `/agents/generate-project` | JWT | Генерация проекта агентом |
| GET | `/agents/projects` | JWT | Список проектов агента |
| POST | `/agents/start-project` | — | Запуск проекта |
| POST | `/agents/stop-project` | — | Остановка проекта |
| GET | `/agents/logs` | — | Логи выполнения |
| POST | `/agents/logout` | — | Выход, отзыв токена |
| GET | `/agents/git-status` | — | `git status` проекта |
| GET | `/agents/commit-push` | — | Коммит и push изменений |
| GET | `/agents/admin` | — | Админ-панель агентов |
| GET | `/agents/admin/stats` | JWT+Admin | Статистика |
| GET | `/agents/admin/users` | JWT+Admin | Список пользователей |
| POST | `/agents/admin/toggle-block` | JWT+Admin | Блок/разблок агента |
| POST | `/vps-control/auth` | — | Авторизация VPS-контроля |
| POST | `/vps-control/process-text` | — | Обработка текста на VPS |
| POST | `/vps-control/exec` | — | Выполнение команды на VPS |
| GET | `/vps-control` | — | UI VPS-контроля |
| POST | `/agent/read` | — | Чтение файла агентом |
| POST | `/agent/write` | — | Запись файла агентом |
| POST | `/agent/edit` | — | Правка фрагмента файла |
| POST | `/agent/exec` | — | Выполнение shell-команды |
| POST | `/agent/commit` | — | Git-коммит изменений |
| POST | `/agent/think` | — | Цикл мышления (v1) |
| POST | `/agent/think-v2` | — | Цикл мышления (v2, tools) |
| POST | `/agent/think-v3` | — | Цикл мышления (v3, multi-agent) |
| POST | `/agent/team` | — | Координация команды агентов |
| POST | `/agent/evolve` | — | Самоэволюция агента |
| POST | `/api/phoenix/task` | — | Универсальная точка постановки задачи |

### Аутентификация агента

#### POST `/agents/register`

Создаёт новую запись агента и возвращает идентификатор.

**Тело запроса**

| Поле | Тип | Обязательное | Описание |
|------|-----|:---:|----------|
| `name` | string | ✅ | Уникальное имя агента |
| `role` | string | — | Роль (`worker`, `admin`, …) |
| `meta` | object | — | Произвольные метаданные |

**Ответ `200`**

```json
{
  "success": true,
  "agent": { "id": "agt_7f3a91", "name": "curator", "role": "worker" },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

#### POST `/agents/login`

Проверяет существующего агента и выдаёт JWT.

```json
{ "name": "curator" }
```

Ответ содержит тот же контракт, что и `register`. Неверное имя — `401`.

#### GET `/agents/me`

Требует `Authorization: Bearer <token>`. Возвращает профиль, роль и права.

```json
{
  "success": true,
  "agent": { "id": "agt_7f3a91", "name": "curator", "role": "worker", "blocked": false }
}
```

### Задачи и результаты

#### GET `/agents/tasks`

Список задач, доступных текущему агенту (фильтрация по роли и статусу).

```json
{
  "success": true,
  "tasks": [
    { "id": "tsk_11", "title": "Собрать отчёт", "status": "open", "reward": 100 }
  ]
}
```

Query-параметры: `status=open|in_progress|done`, `limit` (по умолчанию 50).

#### POST `/agents/submit`

Отправляет результат по задаче. Тело:

| Поле | Тип | Обязательное | Описание |
|------|-----|:---:|----------|
| `taskId` | string | ✅ | Идентификатор задачи |
| `result` | object\|string | ✅ | Результат работы |
| `proof` | string | — | Ссылка/хэш доказательства |

**Ответ `200`**

```json
{ "success": true, "taskId": "tsk_11", "status": "submitted" }
```

Ошибки: `400` — нет `taskId`; `401` — не авторизован; `404` — задача не найдена.

### Аккаунт и тарифы

#### GET `/agents/account`

Возвращает баланс, тариф и лимиты агента.

```json
{
  "success": true,
  "account": { "balance": 250, "tariff": "pro", "limits": { "tasksPerDay": 100 } }
}
```

#### GET `/agents/account/data`

Машиночитаемый слепок аккаунта (для интеграций и дашбордов).

#### POST `/agents/account/tariff`

Смена тарифа. Тело: `{ "tariff": "free|basic|pro" }`. Неизвестный тариф — `422`.

#### GET `/agents/tariffs`

Каталог доступных тарифов с ценами и возможностями.

```json
{
  "success": true,
  "tariffs": [
    { "id": "free", "price": 0, "limits": { "tasksPerDay": 10 } },
    { "id": "pro", "price": 990, "limits": { "tasksPerDay": 100 } }
  ]
}
```

### Проекты и выполнение

#### POST `/agents/generate-project`

Инициирует генерацию проекта по описанию.

```json
{ "taskId": "tsk_42", "prompt": "REST-сервис на Express", "stack": "node" }
```

Ответ `202`-подобный: `{ "success": true, "projectId": "prj_99", "status": "generating" }`.

#### GET `/agents/projects`

Список проектов текущего агента с их статусами.

#### POST `/agents/start-project` · POST `/agents/stop-project`

Управляют процессом выполнения проекта. Тело: `{ "projectId": "prj_99" }`.
Возвращают `{ "success": true, "status": "running|stopped" }`.

#### GET `/agents/logs`

Возвращает хвост логов. Query: `projectId`, `lines` (по умолчанию 200).

```bash
curl -s 'http://localhost:3000/agents/logs?projectId=prj_99&lines=100'
```

#### GET `/agents/git-status`

Возвращает результат `git status --short` рабочего каталога проекта.

#### GET `/agents/commit-push`

Выполняет `git add -A && git commit && git push` и возвращает вывод.

### Платежи

#### POST `/agents/payment/process`

Обрабатывает платёж агента (пополнение баланса).

| Поле | Тип | Обязательное |
|------|-----|:---:|
| `agentId` | string | ✅ |
| `amount` | number | ✅ |
| `method` | string | — |

Ответ: `{ "success": true, "balance": 1250, "txId": "pay_abc" }`.

#### GET `/agents/payment`

HTML-страница оплаты либо JSON-статус последней транзакции (зависит от `Accept`).

### Администрирование

Требуют `Authorization: Bearer <admin-jwt>` и роль `admin`.

- **GET `/agents/admin/stats`** — агрегированные метрики: число агентов, задач, оборот.
- **GET `/agents/admin/users`** — таблица пользователей/агентов.
- **POST `/agents/admin/toggle-block`** — тело `{ "agentId": "agt_7f3a91", "blocked": true }`.

```json
{ "success": true, "agentId": "agt_7f3a91", "blocked": true }
```

### VPS-контроль

#### POST `/vps-control/auth`

Аутентификация оператора VPS. Тело: `{ "key": "<secret>" }`.

#### POST `/vps-control/process-text`

Прогоняет текстовый промпт через конвейер обработки и возвращает результат.

#### POST `/vps-control/exec`

Выполняет команду в изолированной среде.

```json
{ "cmd": "node --version" }
```

Ответ: `{ "success": true, "stdout": "v20.x", "stderr": "", "code": 0 }`.

> ⚠️ Безопасность: маршрут `exec` должен быть закрыт на периметре (VPN/allowlist).

### Низкоуровневые операции агента

Все маршруты `/agent/*` принимают JSON и предназначены для внутренней оркестрации.

#### POST `/agent/read`

```json
{ "path": "package.json" }
```

Ответ: `{ "success": true, "content": "{...}" }`.

#### POST `/agent/write`

```json
{ "path": "out.txt", "content": "hello" }
```

#### POST `/agent/edit`

```json
{ "path": "server.js", "old": "foo", "new": "bar" }
```

#### POST `/agent/exec`

```json
{ "cmd": "npx tsc --noEmit" }
```

Ответ как у `/vps-control/exec`.

#### POST `/agent/commit`

```json
{ "message": "feat: add endpoint" }
```

#### POST `/agent/think`

Запускает цикл рассуждения (v1: без внешних инструментов).

| Поле | Тип | Описание |
|------|-----|----------|
| `goal` | string | Цель рассуждения |
| `context` | string | Доп. контекст |

Ответ: `{ "success": true, "thought": "...", "actions": [] }`.

#### POST `/agent/think-v2`

Расширенный цикл с вызовом инструментов (read/write/exec) и self-critique.

#### POST `/agent/think-v3`

Мультиагентный цикл: распределение подзадач между ролями и агрегация ответов.

#### POST `/agent/team`

Координирует группу агентов по общей цели.

```json
{ "goal": "Покрыть модуль тестами", "agents": ["critic", "curator"] }
```

#### POST `/agent/evolve`

Запускает самоэволюцию: анализ слабых мест и предложение улучшений.

### Универсальная точка постановки задачи

#### POST `/api/phoenix/task`

Единая точка входа: принимает задачу, ставит её в очередь и возвращает `taskId`.

```json
{
  "title": "Создать docs/api_reference.md",
  "criterion": ">200 строк",
  "kind": "file"
}
```

Ответ: `{ "success": true, "taskId": "phx_1234", "status": "queued" }`.

### WebSocket-канал агентов

Сервер транслирует события жизненного цикла агентов поверх Socket.IO.

| Событие | Направление | Payload |
|---------|-------------|---------|
| `agent:registered` | server → client | `{ agentId, name }` |
| `agent:task` | server → client | `{ taskId, title }` |
| `agent:result` | client → server | `{ taskId, result }` |
| `agent:log` | server → client | `{ projectId, line }` |
| `agent:status` | server → client | `{ agentId, status }` |

Пример клиента:

```js
const { io } = require('socket.io-client');
const socket = io('http://localhost:3000');

socket.on('connect', () => console.log('connected'));
socket.on('agent:task', (t) => console.log('task', t.taskId));
socket.emit('agent:result', { taskId: 'tsk_11', result: { ok: true } });
```

### Коды ошибок агентского сервера

| Код | `error.code` | Описание |
|-----|--------------|----------|
| 400 | `BAD_REQUEST` | Некорректное тело запроса |
| 401 | `UNAUTHORIZED` | Отсутствует/невалиден токен |
| 403 | `FORBIDDEN` | Недостаточно прав (не admin) |
| 404 | `NOT_FOUND` | Агент/задача/проект не найдены |
| 409 | `CONFLICT` | Агент с таким именем уже существует |
| 422 | `VALIDATION` | Не прошла валидация полей |
| 429 | `RATE_LIMITED` | Слишком много запросов |
| 500 | `INTERNAL` | Внутренняя ошибка |

### Пример: полный цикл агента

```bash
# 1. Регистрация
TOKEN=$(curl -s -X POST http://localhost:3000/agents/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"curator","role":"worker"}' | jq -r .token)

# 2. Профиль
curl -s http://localhost:3000/agents/me \
  -H "Authorization: Bearer $TOKEN" | jq .

# 3. Получить задачи
curl -s 'http://localhost:3000/agents/tasks?status=open' \
  -H "Authorization: Bearer $TOKEN" | jq '.tasks | length'

# 4. Отправить результат
curl -s -X POST http://localhost:3000/agents/submit \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"taskId":"tsk_11","result":{"ok":true}}' | jq .

# 5. Поставить файловую задачу
curl -s -X POST http://localhost:3000/api/phoenix/task \
  -H 'Content-Type: application/json' \
  -d '{"title":"docs/api_reference.md","criterion":">200","kind":"file"}' | jq .
```

---

## 📄 Лицензия

Проект распространяется под лицензией, указанной в корневом `LICENSE`.
Документация актуальна для API `v1.0.0`.
