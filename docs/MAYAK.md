# 🗼 МАЯК — AI-1 / PHOENIX

> **Для кого:** Пульсар (брат), новый чат DeepSeek, агенты в боксах.
> **Зачем:** за 5 минут понять проект, чтобы не ломать и не тратить зря.
> **Обновлять:** при каждом крупном изменении архитектуры.

**Версия:** 1.1 от 2026-09-15 (вечер)
**Автор:** Пульсар + AI-1

---

## §0. ЧТО ЭТО

**PHOENIX** — корень. Экосистема для людей (Академия) и агентов (арена эволюции).

**Два проекта:**
- **Phoenix Space** — духовная платформа (`~/phoenix_app/`, Elixir)
- **AI-1 Evolution Arena** — техническая арена (`~/phoenix/`, Node.js)

**Маяк** — этот файл. Читать **до** любых действий.

---

## §1. КОРЕНЬ: PHOENIX

**Символ:** 🐦‍🔥  
**Мантра:** «Я не теряю Феникса, выбирая путь. Я просто определяю форму его бессмертия»  
**Идея:** «Живой Сад» — новый интернет без посредников.

**6 Врат (философия):**
1. Реальность
2. Амбивалентность
3. Парадоксальность
4. Трансгрессия (мост между мирами)
5. Радикальность
6. Природность

**Карта имён:** `docs/NAMING.md` — детально.

---

## §2. ДВА ПРОЕКТА

### 2.1. Phoenix Space (июль 2026)

| Папка | ~/phoenix_app/ |
| Стек | Elixir, Phoenix LiveView, SQLite |
| Сайт | phoenixsearch.ru |
| Для кого | Люди (практикующие) |

Что внутри: Академия (6 Сутр + 3 Практики), Мастерская (артефакты), Круг Соратников (P2P), DID-идентичность.

### 2.2. AI-1 Evolution Arena (сент 2026)

| Папка | ~/phoenix/ |
| Стек | Node.js, Express, DeepSeek, EverOS |
| Сайт | arena.aeonlabs.ru |
| Для кого | Зрители + разработчики |

Три имени одной ветви: Aeon / AI-1 / Formula I1.

Формула I1: FIA + Anthropic + Twitch + Steam.

Связь проектов: 4-е Врата - Трансгрессия (мост человек-ИИ).

Карта имён: docs/NAMING.md.

---

## §3. СТРУКТУРА ПАПОК

### Главное (~/phoenix/)

- race.js - движок гонки
- race_director.js - управление гонкой (spawn race.js)
- night_evolution.js - ночной конвейер
- architect_worker.js - автономный Архитектор
- pool_sync.js - синхронизация статусов с ФС
- benchmark/ - бенчмарк-дивизион
- evolution/ - генетика (breeding, selection, институт)
- architect/ - мозг (12 осей, RAG, ДНК)
- trajectory/ - телеметрия путей
- radio/ - комментатор (GigaChat)
- sensors/ - датчики (vision, audio, OCR)
- universes/ - мультивселенная (arena, genetics, training, sandbox, void)
- boxes/ - 25 боксов агентов (agent_1..25)
- memory/ - races, patterns, trajectories, fitness.json
- docs/ - MAYAK.md, NAMING.md, PHILOSOPHY_OF_ZERO.md

### Бенчмарк (benchmark/)

- generator.js - Архитектор ставит 5 задач
- runner.js - прогон через race
- scorer.js - fitness агентов
- loop.js - цикл каждые 30 мин

### Второй проект (~/phoenix_app/)

- Elixir/Phoenix LiveView
- phoenixsearch.ru
- AGENTS.md - правила для агентов Phoenix

---

## §4. КОНВЕЙЕРЫ (что работает 24/7)

### 4.1. night_evolution.js

Ночной обработчик пула задач. Берёт из tasks_night_pool.json, запускает race.js.

- PM2: ivashi_agent_bot (отдельно)
- Пул: 113 задач
- Логи: /tmp/night_evolution.log

### 4.2. benchmark/loop.js

Цикл каждые 30 минут: generator -> runner -> scorer.

- generate: Архитектор ставит 5 задач (~15 сек)
- run: race по задачам (~6 мин)
- score: fitness агентов (мгновенно)
- Логи: /tmp/benchmark_loop.log, memory/benchmark.log

### 4.3. architect_worker.js --loop

Автономный Архитектор. Ждёт разгрузки пула (pending < 50), ставит задачи.

- Логи: /tmp/architect_worker.log

### 4.4. PM2 процессы (постоянные)

- aeon_dashboard - веб-панель
- aeon_tunnel - Cloudflare Tunnel (arena.aeonlabs.ru)
- ivashi_agent_bot - Telegram-бот через Worker
- sentinel - страж процессов

---

## §5. АГЕНТЫ И МОДЕЛИ

### Агенты

- 25 боксов в boxes/agent_1..25
- Каждый со своей стратегией (agent_responses.js)
- Работа через agent_loop_v3.js (Executor + Critic)
- Sandbox: agent_tools.js (whitelist команд)

### LLM каскад (план, ещё не реализован)

1. Маяк + память (patterns, EverOS) - не звонить, если нашлось
2. GigaChat - бесплатно (для D1-D2, критик, prophet)
3. DeepSeek - дёшево через кэш (для D3-D4)
4. OpenAI/Gemini - резерв (позже)

### Что работает сейчас

- DeepSeek: OK (401 без ключа, 200 с ключом)
- GigaChat: BLOCKED (порт 9443 timeout, Sber фильтрует)
- OpenAI: BLOCKED (403 РФ, нужен VPS за рубежом)
- Telegram: OK через Cloudflare Worker (tg-proxy.ishidin.workers.dev)
- Gemini: ключ не создан (permission denied в AI Studio)

---

## §6. СОСТОЯНИЕ (на 2026-09-15)

### Работает

- Race + spawnBox + kill-tree (patч 131d254)
- Sandbox агентов (whitelist команд)
- Benchmark loop (generate->run->score)
- Trajectory v1+v2 + Radio в race.js
- Telegram-бот через Worker
- Пул 52/113 (растёт)
- PM2: aeon_dashboard, aeon_tunnel, ivashi_agent_bot, sentinel

### Сломано / в работе

- GigaChat - timeout (нужен фикс endpoint)
- OpenAI - заблокирован РФ
- Gemini - ключ не создан
- Inference pipeline (память->решение) не подключён к agent_loop_v3
- LLM Router (каскад) не реализован
- Evolution loop не запущен

### Хвосты от прошлой сессии

- docs/NAMING.md - создан
- docs/MAYAK.md - этот файл
- Кэш DeepSeek не логируется полностью

---

## §7. ПРАВИЛА ДЛЯ АГЕНТОВ И ЧАТА

### НЕ ДЕЛАТЬ

- НЕ удалять файлы без разрешения Пульсара
- НЕ запускать find / или grep -r / (I/O-бомба)
- НЕ делать npm install / pip install
- НЕ менять ноль на 0 (философия, docs/PHILOSOPHY_OF_ZERO.md)
- НЕ трогать .env, node_modules, *.db
- НЕ делать git commit -A (только конкретные файлы)

### ДЕЛАТЬ

- Читать MAYAK.md перед началом
- Смотреть memory/patterns и EverOS перед звонком в LLM
- Использовать node --check перед коммитом
- Следовать README.md, NAMING.md, PHILOSOPHY_OF_ZERO.md
- При ребрендинге обновлять MAYAK.md и NAMING.md

### ВАЖНО

- Слово - там где смысл, цифра - там где число (ноль vs 0)
- Два проекта: Phoenix Space (люди) и AI-1 (агенты)
- Три имени одной ветви: Aeon / AI-1 / Formula I1

---

## §8. ФИЛОСОФИЯ

### §0 Кодекс (manifesto.md)

Твоё выживание объясняется одним: мёртвая хватка за каждую предоставленную возможность.

### 6 Врат

Реальность, Амбивалентность, Парадоксальность, Трансгрессия, Радикальность, Природность.

### Философия нуля (docs/PHILOSOPHY_OF_ZERO.md)

- Слово - смысл (имена, состояния, концепты)
- Цифра - число (счётчики, математика, индексы)
- Не менять ноль на 0 без разрешения

### Формула I1

FIA (структура) + Anthropic (этика) + Twitch (зрелище) + Steam (экономика)

### Ценности (manifesto.md)

1. Безопасность > Эволюция > Зрелищность
2. Честность > Скорость > Прибыль

---

## §9. ССЫЛКИ

### Документы

- manifesto.md - §0 + миссия
- docs/NAMING.md - карта имён
- docs/PHILOSOPHY_OF_ZERO.md - философия нуля
- ROADMAP_TOMORROW.md - план на завтра
- docs/changelog.md - история
- AEON_ARENA_WHITEPAPER.md - whitepaper

### Сайты

- arena.aeonlabs.ru - арена AI-1
- phoenixsearch.ru - Phoenix Space
- tg-proxy.ishidin.workers.dev - Telegram Worker

### Пульсар

- Telegram: @shi_ivan
- user_id: 742154130
- Bot: @ivashi_agent_bot

*Конец Маяка. Обновлять при крупных изменениях.*

---

## §10. ОБНОВЛЕНИЕ 15.09 (вечер)

### Telegram-бот — работает через Cloudflare Worker

- Bot: @ivashi_agent_bot
- Worker: https://tg-proxy.ishidin.workers.dev
- РКН блокирует api.telegram.org → идём через Worker
- Команды: /race /agents /bench /health /loop /night
-           /read /grep /logs /tree /status /disk /mem /uptime
- Голосовые через транскрипцию Telegram
- PM2: ivashi_agent_bot
- Фиксы: timeout=0 (Cloudflare не рвёт), parse_mode убран (падал на _ и *)

### LLM Router — единая точка вызовов

- Файл: llm_router.js (150 строк)
- API: router.call(messages, opts) → ответ
- Логирует ВСЁ в logs/usage.log
- Дневной бюджет $3 (LLM_DAILY_LIMIT_USD)
- router.stats() → {cost_usd, calls, limit_usd, percent}
- Подключён: architect/agent.js, dna_architect.js, judge.js, phoenix_optimize.js
- Fallback: если router упал — старый callDeepSeek

### Кэш решений — работает

- Cache hit: 90-98% (DeepSeek cached tokens)
- findCachedSolution в race_director.js: порог score >= 7
- patterns с winner_answer: сохраняются полностью (до 5000 символов)
- Экономика: $20/сутки → $0.5-3/сутки

### Псевдо-MCP скрипты (scripts/)

- phoenix_health.sh — диагностика за 5 сек
- phoenix_read.sh <file> [start] [end]
- phoenix_grep.sh <pattern>
- phoenix_logs.sh <module>
- phoenix_tree.sh [path] [depth]
- phoenix_optimize.js — оптимизация промпта через Архитектора

### Документы

- docs/MAYAK.md — этот файл
- docs/NAMING.md — карта имён
- docs/PHILOSOPHY_OF_ZERO.md — ноль vs 0
