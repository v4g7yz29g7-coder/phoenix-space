# 🐦‍🔥 ARCHITECTURE.md — Карта системы Aeon/Phoenix

## Общая схема

VPS (103.76.54.130)
├── Phoenix (порт 3000) — Академия Феникса
│   ├── server.js — точка входа
│   ├── src/ — контроллеры, модели, роуты, middleware
│   ├── client/ — React (Vite)
│   ├── public/ — статика (index.html, admin.html, profile.html)
│   └── phoenix.db — основная БД
│
└── Aeon Agents (порт 3001) — VPS-панель и генерация
    ├── aeon_agents_server.js — точка входа
    ├── vps_bot.js — Telegram-бот (ivashi_agent_bot)
    ├── gardener.db — проекты, юзеры, платежи, задачи
    ├── llm_client.js — обёртка над DeepSeek API
    ├── generated_projects/ — сгенерированные проекты
    └── ecosystem.config.js — PM2 конфиг

## Технологии

- **Backend:** Node.js, Express, Socket.IO
- **БД:** SQLite (better-sqlite3)
- **Аутентификация:** JWT, bcryptjs, DID (ethers.js)
- **Блокчейн:** ethers.js, Hardhat (contracts/, blockchain/)
- **LLM:** DeepSeek API (deepseek-chat)
- **Telegram:** node-telegram-bot-api
- **Клиент:** React + Vite
- **Процессы:** PM2

## Ключевые файлы

| Файл | Роль |
|------|------|
| server.js | Основной сервер Phoenix (порт 3000) |
| aeon_agents_server.js | Сервер Aeon Agents (порт 3001) |
| vps_bot.js | Telegram-бот для управления VPS |
| llm_client.js | Обёртка DeepSeek API |
| gardener.js | Садовник — управление проектами |
| gardener_agents.js | Агенты садовника |
| src/routes/api.js | API Phoenix |
| src/routes/auth.js | Аутентификация |
| src/routes/profile.js | Профиль |
| src/models/*.js | Модели (User, Content, Reputation, Artifact, Message, Seed) |
| src/middleware/*.js | Auth, rateLimiter, security, audit |

## Базы данных

### phoenix.db
- Основная БД Академии (пользователи, контент, репутация, артефакты, сообщения, семена).

### gardener.db
- **users** (id, username, email, password_hash, tariff, created_at, blocked)
- **projects** (id, name, path, type, created_at, status, user_id)
- **tasks** (id, agent, prompt, result, created_at, user_id)
- **payments** (id, user_id, tariff, amount, status, created_at)
- **visits** (id, path, user_agent, created_at)

## API-роуты Aeon Agents (порт 3001)

- POST /vps-control/auth — вход в панель
- POST /vps-control/process-text — обработка естественного языка
- POST /vps-control/exec — выполнение команды
- POST /agents/register, /agents/login
- GET /agents/me, /agents/admin/stats, /agents/tasks
- POST /agents/submit, /agents/payment/process
- POST /agents/generate-project — генерация проекта
- GET /agents/projects, /agents/logs
- POST /agents/start-project, /agents/stop-project
- GET /agents/git-status, /agents/commit-push

## Потоки данных

1. Пользователь → Telegram-бот → DeepSeek → команда → VPS
2. Пользователь → веб-панель /vps-control → process-text → DeepSeek → exec
3. Пользователь → /agents/generate-project → DeepSeek → generated_projects/
4. Phoenix → Socket.IO → клиенты (чат, DID-аутентификация)

## Точки расширения

- **VPS-панель** — добавить инструменты самоизменения
- **Telegram-бот** — добавить голос, команды
- **DeepSeek** — Function Calling для автономности
- **Bull + Redis** — очереди задач
- **Socket.IO** — мгновенные обновления
