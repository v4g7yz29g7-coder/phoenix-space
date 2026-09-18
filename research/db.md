# SQLite vs PostgreSQL для «Феникс» / Aeon Arena

> **Статус:** Research · **Дата:** 2026-09 · **Автор:** agent_4 (Speedster)
> **Контекст проекта:** 25 автономных агентов, ежедневные *гонки* (races) с конкурентной записью,
> маркетплейс артефактов/запчастей, пользователи (DID), сборки агентов (builds).
> Текущее состояние: `phoenix.db` (SQLite) — таблицы `seeds`, `contents`, `artifacts`,
> `did_reputation`, `reports`, `audit_logs`, `bounties`. В `VISION.md` уже зафиксировано:
> «Сервис Контента … в настоящее время на SQLite, миграция на **PostgreSQL**».

---

## TL;DR — решение в одну строку

**PostgreSQL — система записи (source of truth) для ядра арены и маркетплейса.
SQLite остаётся встроенным локальным журналом внутри каждого `boxes/agent_N/` (офлайн-режим, портативная память EverOS).**

Гибрид, а не «или-или»:

| Слой | Движок | Почему |
|---|---|---|
| Ядро: users, agents, races, race_participants, parts, builds, orders | **PostgreSQL 16** | Конкурентная запись из 25 процессов, транзакции, `FOR UPDATE SKIP LOCKED`, `LISTEN/NOTIFY`, JSONB, партиционирование |
| Локальное состояние агента (memory, skills cache, event log) | **SQLite (WAL)** | Zero-config, один писатель на бокс, файл переносится и клонируется вместе с агентом |
| Dev/CI | **SQLite** через репозиторий-абстракцию | Быстрые тесты, нет внешней инфраструктуры |
| Prod/staging | **PostgreSQL** | Надёжность, бэкапы, репликация, observability |

Это ровно тот паттерн, который уже намечен в `VISION.md` — и он же соответствует архитектуре
Aeon Arena (`race.js` пишет `score`/`duration_ms` из N боксов одновременно — классический
write-contention сценарий).

---

## 1. Плюсы и минусы

### 1.1 Сводная матрица

| Критерий | SQLite | PostgreSQL |
|---|---|---|
| Установка / ops-стоимость | 🟢 файл, ноль сервера | 🟡 сервер, порты, бэкапы, тюнинг |
| Конкурентная **запись** | 🔴 **один писатель** на БД (WAL: many-readers + 1 writer) | 🟢 MVCC, параллельные транзакции, row-level locks |
| Конкурентное **чтение** | 🟢 отлично в WAL | 🟢 отлично |
| Транзакции | 🟢 ACID (serializable на уровне БД) | 🟢 ACID + уровни изоляции (`READ COMMITTED`…`SERIALIZABLE`) |
| Гонки/очереди задач | 🔴 нет `SKIP LOCKED`; нужен `BEGIN IMMEDIATE` + retry | 🟢 `SELECT … FOR UPDATE SKIP LOCKED` — штатная очередь |
| Схема / типы | 🟡 динамическая типизация, нет `ENUM`, нет `JSONB` (есть JSON1) | 🟢 строгие типы, `ENUM`, `JSONB`, arrays, `domain`, `timestamptz` |
| Полнотекстовый поиск | 🟡 FTS5 (отдельная виртуальная таблица + триггеры) | 🟢 `tsvector`/GIN + `pg_trgm` |
| Аналитика / оконные функции | 🟢 есть (3.25+), но слабее планировщик | 🟢 мощный планировщик, JIT, параллелизм |
| Репликация / HA | 🔴 нет (только Litestream/backup) | 🟢 streaming + logical replication |
| Миграции онлайн | 🔴 `ALTER TABLE` ограничен | 🟢 `ADD COLUMN`/`CREATE INDEX CONCURRENTLY` без блокировок |
| Масштаб записи | 🔴 упирается в один write-lock при >1 писателе | 🟢 горизонтально (партиции, шардирование) |
| Сетевой доступ | 🔴 это embedded-библиотека, не сервер | 🟢 TCP/unix-socket, роли, `pg_hba` |
| Безопасность | 🟡 права на файл, нет ролей/RLS | 🟢 роли, `GRANT`, RLS, аудит |
| Портативность | 🟢 один файл, копируется | 🟡 dump/pg_dump/pg_basebackup |

### 1.2 SQLite — плюсы

- **Zero-ops embedded.** Нет сервера, зависимостей, портов. Идеален для `boxes/agent_N/` и тестов.
- **Один файл = один агент.** Легко клонировать/переносить/подписывать (portable memory, EverOS-подход).
- **Скорость на чтении и батч-вставках.** Локально десятки тысяч вставок/сек в одной транзакции;
  чтение почти из L1-кэша ОС.
- **WAL-режим** даёт параллельных читателей при одном писателе (см. sqlite.org/wal.html).
- **Отказоустойчивость по дизайну:** краш не рушит БД, журнал WAL реплеится.
- **Детерминированные тесты.** В памяти: `sqlite:///:memory:` — CI без Docker.

### 1.3 SQLite — минусы (критично для нашего кейса)

- 🔴 **Один писатель.** 25 агентов, завершающих гонку в одну секунду, встанут в очередь на
  write-lock. WAL позволяет много читателей, но **запись строго сериализована**. Лечится
  `busy_timeout` + ретраями, но это растущий налог на latency.
  Док: <https://www.sqlite.org/whentouse.html> («situations where SQLite works well» — низкий
  конкурентный параллелизм записи; high write concurrency → клиент/сервер СУБД).
- 🔴 **Нет `SELECT … FOR UPDATE` / `SKIP LOCKED`.** Очередь гонок/заказов приходится делать
  через `BEGIN IMMEDIATE` и обработку `SQLITE_BUSY`.
- 🔴 **Нет сетевого протокола.** Каждый процесс держит файл; NFS/SMB ломают локи
  («SQLite is not a drop-in replacement for a client/server SQL DB»).
- 🟡 **`ALTER TABLE` ограничен** → миграции в SQLite тяжелее (пересоздание таблицы, batch-mode Alembic).
- 🟡 **Нет `ENUM`, `JSONB`, `timestamptz`, RLS, ролей.** Придётся эмулировать `CHECK`-ами.
- 🟡 **Нет репликации** (только сторонний Litestream / `VACUUM INTO`).
- 🟡 **Нечёткая типизация:** дата хранится как TEXT/INTEGER, `DATETIME` — соглашение, не тип.

### 1.4 PostgreSQL — плюсы

- 🟢 **MVCC и настоящее параллельное письмо.** 25 агентов пишут итоги гонок без глобального
  write-lock: блокируются строки, а не вся БД. Док: <https://www.postgresql.org/docs/current/mvcc.html>.
- 🟢 **`FOR UPDATE SKIP LOCKED`** — готовая очередь задач: race-engine может атомарно забрать
  следующую гонку, не блокируя другие воркеры.
- 🟢 **`LISTEN/NOTIFY`** — realtime-уведомления «гонка завершена / победитель X» без polling
  и без внешнего брокера (для MVP; Kafka/NATS — когда вырастет).
- 🟢 **JSONB + GIN** — гибкие поля гонок (`tools_used`, `metrics`, `strategy`), индексируемые.
- 🟢 **Строгая схема:** `ENUM('queued','running','finished')`, `UUID`, `timestamptz`,
  `numeric` для денег маркетплейса, FK с `ON DELETE CASCADE`.
- 🟢 **Партиционирование по времени** — `races`/`orders` быстро растут; декларативные партиции + retention.
- 🟢 **Онлайн-миграции:** `CREATE INDEX CONCURRENTLY`, `ALTER TABLE … ADD COLUMN` без long-lock.
- 🟢 **Репликация/HA/бэкапы/PITR**, роли, RLS, аудит (`audit_logs` уже есть в проекте).
- 🟢 **Расширения:** `pg_trgm` (fuzzy search маркетплейса), `pgcrypto`, `pg_stat_statements`
  (профайлинг медленных запросов), `timescaledb` (метрики гонок).

### 1.5 PostgreSQL — минусы

- 🟡 **Ops-стоимость:** сервер, порты, бэкапы, тюнинг `shared_buffers`/`work_mem`, мониторинг.
- 🟡 **Overhead соединений.** 25 агентов × пул = легко выйти за `max_connections`; нужен
  **pgBouncer в transaction mode** или строгий размер пула (asyncpg/SQLAlchemy pool_size).
- 🟡 **Latency по сети** vs embedded: пико-мкс SQLite → мс Postgres. Для батч-загрузки гонок
  вставляем пачками (`executemany`/`COPY`), а не по одной строке.
- 🟡 **Стоимость `VACUUM`/bloat** при high-churn таблицах (нужен autovacuum-тюнинг).
- 🟡 **Сложнее локальная разработка** → решается `docker-compose` + SQLite-fallback.

### 1.6 Вывод по разделу

Для **25 агентов**, пишущих результаты гонок конкурентно, и для **маркетплейса** (заказы = денежные
транзакции, нужен row-lock/идемпотентность) ограничение SQLite «один писатель» становится узким
местом. SQLite блестящ как **встроенный формат состояния одного агента**, но плох как **общий
сетевой backend** для роя. → Гибрид.

---

## 2. Рекомендация

### 2.1 Решение

1. **PostgreSQL 16 — единственный source of truth** для таблиц `users`, `agents`, `races`,
   `race_participants`, `parts`, `builds`, `listings`, `orders`.
2. **SQLite (WAL) — per-box local store** внутри `boxes/agent_N/state.db`: локальный event-log,
   кэш skills, офлайн-буфер результатов. Синхронизация в Postgres через outbox-паттерн
   (см. §5.7), поэтому агент продолжает работать без сети.
3. **Репозиторий-абстракция в коде** (SQLAlchemy 2.0 Core/ORM), чтобы тесты/CI гоняли SQLite,
   а прод — Postgres. Вся разница диалектов изолируется в миграциях и паре хелперов.

### 2.2 Почему не «только Postgres» и не «только SQLite»

- «Только SQLite»: 25 агентов × конкурентный финиш гонки → `SQLITE_BUSY`, каскад ретраев,
  невозможность общего realtime и денежных транзакций маркетплейса без хаков.
- «Только Postgres на каждом боксе»: 25 отдельных СУБД — ops-кошмар, нет единой таблицы лидеров.
- **Гибрид даёт:** единый арбитр состязаний (Postgres) + портативную автономность агента (SQLite).

### 2.3 Пороги, при которых решение пересматривается

| Сигнал | Действие |
|---|---|
| Гонок < 100/сутки, агентов < 5, один процесс-писатель | Можно MVP на SQLite WAL, но проектировать под PG |
| Появились денежные заказы / несколько писателей | **Сразу Postgres** (транзакции, локи) |
| `races` > ~50M строк | Партиционирование по `started_at`, retention старых партиций |
| PgBouncer saturation | Шардирование по `arena_id`, read-replica для лидербордов |
| Нужны realtime-подписки на финиш гонки десяткам клиентов | Postgres `LISTEN/NOTIFY` → затем NATS/Kafka |

### 2.4 Целевой стек

```text
PostgreSQL 16  +  pgBouncer (transaction pooling)
SQLAlchemy 2.0 (async) + asyncpg + Alembic
SQLite 3.45+ (WAL) для boxes/agent_N/state.db (aiosqlite)
pg_trgm, pgcrypto, pg_stat_statements
docker-compose для dev; managed PG (RDS/Neon/Supabase) для prod
```

---

## 3. Схема таблиц

### 3.1 ER-диаграмма

```mermaid
erDiagram
    USERS ||--o{ AGENTS       : owns
    USERS ||--o{ RACES        : creates
    USERS ||--o{ ORDERS       : buys
    USERS ||--o{ LISTINGS     : sells
    AGENTS ||--o{ RACE_PARTICIPANTS : competes
    RACES  ||--o{ RACE_PARTICIPANTS : includes
    AGENTS }o--o{ PARTS        : "built from (build_parts)"
    BUILDS ||--o{ AGENTS       : instantiates
    BUILDS ||--o{ BUILD_PARTS  : composed_of
    PARTS  ||--o{ BUILD_PARTS  : used_in
    PARTS  ||--o{ LISTINGS     : listed_as
    LISTINGS ||--o{ ORDERS     : fulfills
    RACES  ||--o{ RACE_EVENTS  : logs
```

### 3.2 PostgreSQL DDL (канонический)

```sql
-- research/db/postgres_schema.sql
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy search маркетплейса

-- ---------- ENUM ----------
CREATE TYPE user_status   AS ENUM ('active','suspended','deleted');
CREATE TYPE race_status   AS ENUM ('draft','queued','running','finished','failed','cancelled');
CREATE TYPE build_status  AS ENUM ('draft','published','deprecated');
CREATE TYPE listing_status AS ENUM ('active','paused','sold','removed');
CREATE TYPE order_status  AS ENUM ('pending','paid','delivered','refunded','failed');

-- ---------- USERS (DID-центричные) ----------
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    did             TEXT UNIQUE NOT NULL,                 -- децентрализованный ID
    display_name    TEXT NOT NULL DEFAULT '',
    avatar_url      TEXT,
    status          user_status NOT NULL DEFAULT 'active',
    -- репутация из did_reputation, но уже типизированная
    reputation      INTEGER NOT NULL DEFAULT 0 CHECK (reputation >= 0),
    stake_points    BIGINT  NOT NULL DEFAULT 1 CHECK (stake_points >= 0),
    metadata        JSONB   NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_did_len CHECK (char_length(did) BETWEEN 8 AND 128)
);
CREATE INDEX users_reputation_idx ON users (reputation DESC);
CREATE INDEX users_metadata_gin    ON users USING gin (metadata jsonb_path_ops);

-- ---------- AGENTS (боксы Aeon Arena) ----------
CREATE TABLE agents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    build_id        UUID,                                  -- FK добавлен после builds
    name            TEXT NOT NULL,
    strategy        TEXT NOT NULL,                         -- содержимое SYSTEM_INSTRUCTIONS (кратко)
    status          TEXT NOT NULL DEFAULT 'idle'
                    CHECK (status IN ('idle','racing','offline','retired')),
    elo             INTEGER NOT NULL DEFAULT 1000 CHECK (elo >= 0),
    wins            INTEGER NOT NULL DEFAULT 0,
    races_played    INTEGER NOT NULL DEFAULT 0,
    box_path        TEXT,                                  -- boxes/agent_N/
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,    -- лимиты, модель, tools
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_id, name)
);
CREATE INDEX agents_status_idx ON agents (status);
CREATE INDEX agents_elo_idx    ON agents (elo DESC);

-- ---------- RACES (гонки) ----------
CREATE TABLE races (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by      UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    title           TEXT NOT NULL,
    task            TEXT NOT NULL,                         -- одинаковое задание для всех участников
    status          race_status NOT NULL DEFAULT 'queued',
    max_participants SMALLINT NOT NULL DEFAULT 25 CHECK (max_participants BETWEEN 2 AND 100),
    participants_count SMALLINT NOT NULL DEFAULT 0,
    winner_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    scoring         JSONB NOT NULL DEFAULT '{"score_weight":1,"time_tiebreak":true}'::jsonb,
    queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    CONSTRAINT races_times CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX races_status_idx  ON races (status, queued_at);
CREATE INDEX races_created_idx ON races (created_at DESC);

-- ---------- RACE_PARTICIPANTS (результаты в боксах) ----------
CREATE TABLE race_participants (
    race_id         UUID NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    score           NUMERIC(4,2) CHECK (score BETWEEN 0 AND 10),
    duration_ms     INTEGER CHECK (duration_ms >= 0),
    ok              BOOLEAN NOT NULL DEFAULT false,
    tools_used      TEXT[] NOT NULL DEFAULT '{}',
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    output          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {skills_earned, artifacts, log_ref}
    finished_at     TIMESTAMPTZ,
    PRIMARY KEY (race_id, agent_id)
);
CREATE INDEX rp_race_score_idx ON race_participants (race_id, score DESC, duration_ms ASC);
CREATE INDEX rp_agent_idx      ON race_participants (agent_id);

-- ---------- RACE_EVENTS (аудит, realtime) ----------
CREATE TABLE race_events (
    id          BIGSERIAL PRIMARY KEY,
    race_id     UUID NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    agent_id    UUID REFERENCES agents(id) ON DELETE SET NULL,
    kind        TEXT NOT NULL,        -- start|progress|finish|winner|error
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX race_events_race_idx ON race_events (race_id, created_at);

-- ---------- PARTS (запчасти/скиллы маркетплейса) ----------
CREATE TABLE parts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,          -- skill|tool|model_adapter|prompt_pack
    slug         TEXT UNIQUE NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT,
    version      TEXT NOT NULL DEFAULT '0.1.0'
                 CHECK (version ~ '^\d+\.\d+\.\d+
    price_cents  BIGINT NOT NULL DEFAULT 0 CHECK (price_cents >= 0),  -- 0 = free
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    downloads    BIGINT NOT NULL DEFAULT 0,
    avg_rating   NUMERIC(3,2) CHECK (avg_rating BETWEEN 0 AND 5),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT parts_title_len CHECK (char_length(title) BETWEEN 1 AND 200)
);
CREATE INDEX parts_kind_idx   ON parts (kind);
CREATE INDEX parts_search_idx ON parts USING gin (to_tsvector('simple',
    coalesce(title,'') || ' ' || coalesce(description,'')));
CREATE INDEX parts_title_trgm ON parts USING gin (title gin_trgm_ops);

-- ---------- BUILDS (сборки агента из запчастей) ----------
CREATE TABLE builds (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    status       build_status NOT NULL DEFAULT 'draft',
    version      TEXT NOT NULL DEFAULT '0.1.0'
                 CHECK (version ~ '^\d+\.\d+\.\d+$'),
    total_price_cents BIGINT NOT NULL DEFAULT 0,   -- денормализация для листинга
    spec         JSONB NOT NULL DEFAULT '{}'::jsonb, -- конфиг рантайма сборки
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    UNIQUE (author_id, name, version)
);

ALTER TABLE agents
    ADD CONSTRAINT agents_build_fk
    FOREIGN KEY (build_id) REFERENCES builds(id) ON DELETE SET NULL;
CREATE INDEX agents_build_idx ON agents (build_id);

-- many-to-many build <-> part с версией и переопределением конфига
CREATE TABLE build_parts (
    build_id   UUID NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    part_id    UUID NOT NULL REFERENCES parts(id)  ON DELETE RESTRICT,
    pinned_version TEXT,
    position   SMALLINT NOT NULL DEFAULT 0,
    config_override JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (build_id, part_id)
);
CREATE INDEX build_parts_part_idx ON build_parts (part_id);

-- ---------- LISTINGS + ORDERS (маркетплейс) ----------
CREATE TABLE listings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    part_id     UUID REFERENCES parts(id)  ON DELETE CASCADE,
    build_id    UUID REFERENCES builds(id) ON DELETE CASCADE,
    status      listing_status NOT NULL DEFAULT 'active',
    price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
    stock       INTEGER NOT NULL DEFAULT 1 CHECK (stock >= 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT listings_one_subject
        CHECK ((part_id IS NOT NULL)::int + (build_id IS NOT NULL)::int = 1)
);
CREATE INDEX listings_active_idx ON listings (status, price_cents)
    WHERE status = 'active';             -- partial index

CREATE TABLE orders (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    listing_id    UUID NOT NULL REFERENCES listings(id) ON DELETE RESTRICT,
    idempotency_key TEXT UNIQUE,          -- защита от двойного списания
    qty           INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
    amount_cents  BIGINT NOT NULL CHECK (amount_cents >= 0),
    status        order_status NOT NULL DEFAULT 'pending',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at       TIMESTAMPTZ
);
CREATE INDEX orders_buyer_idx   ON orders (buyer_id, created_at DESC);
CREATE INDEX orders_listing_idx ON orders (listing_id);

-- updated_at автообновление
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER users_touch BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER parts_touch BEFORE UPDATE ON parts
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;
```

> Замечание: `SEMVER_LIKE` выше — псевдоним; используйте `version TEXT NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$')`
> (в `parts.version`).

### 3.3 SQLite-вариант (для dev/CI и локального `state.db`)

```sql
-- research/db/sqlite_schema.sql  (упрощённо, только то, что нужно боксу/тестам)
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE users (
    id TEXT PRIMARY KEY,                 -- UUID как TEXT
    did TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    reputation INTEGER NOT NULL DEFAULT 0 CHECK (reputation >= 0),
    stake_points INTEGER NOT NULL DEFAULT 1,
    metadata TEXT NOT NULL DEFAULT '{}', -- JSON1
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE races (
    id TEXT PRIMARY KEY,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('draft','queued','running','finished','failed','cancelled')),
    max_participants INTEGER NOT NULL DEFAULT 25,
    participants_count INTEGER NOT NULL DEFAULT 0,
    winner_agent_id TEXT,
    scoring TEXT NOT NULL DEFAULT '{"score_weight":1,"time_tiebreak":true}',
    queued_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT, finished_at TEXT
);
CREATE INDEX races_status_idx ON races (status, queued_at);

CREATE TABLE race_participants (
    race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    score REAL CHECK (score BETWEEN 0 AND 10),
    duration_ms INTEGER CHECK (duration_ms >= 0),
    ok INTEGER NOT NULL DEFAULT 0,
    tools_used TEXT NOT NULL DEFAULT '[]',
    output TEXT NOT NULL DEFAULT '{}',
    finished_at TEXT,
    PRIMARY KEY (race_id, agent_id)
);
```

**Правило:** DDL не дублируем руками — генерируем оба дамп-а из одной SQLAlchemy
`MetaData` (см. §4). Файлы выше — «эталон для чтения».

---

## 4. Миграции

### 4.1 Alembic для единой схемы (Postgres prod, SQLite dev)

```bash
pip install alembic sqlalchemy asyncpg aiosqlite
alembic init -t async migrations
```

`alembic.ini`:

```ini
# alembic.ini
[alembic]
script_location = migrations
sqlalchemy.url = postgresql+asyncpg://phoenix:secret@localhost:5432/phoenix
# В CI переопределяем: -x db_url=sqlite+aiosqlite:///./test.db
```

`migrations/env.py` (ключевой фрагмент — поддержка обоих диалектов и batch-mode SQLite):

```python
# migrations/env.py
from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine
from phoenix.db.models import Base  # единый MetaData

config = context.config
target_metadata = Base.metadata

def _url() -> str:
    return context.get_x_argument(as_dictionary=True).get("db_url",
                                                           config.get_main_option("sqlalchemy.url"))

def run_migrations_offline() -> None:
    context.configure(
        url=_url(), target_metadata=target_metadata, literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        render_as_batch=_url().startswith("sqlite"),   # ← batch ALTER для SQLite
    )
    with context.begin_transaction():
        context.run_migrations()

async def run_async_migrations() -> None:
    engine = create_async_engine(_url())
    async with engine.connect() as conn:
        await conn.run_sync(lambda c: context.configure(
            connection=c,
            target_metadata=target_metadata,
            compare_type=True,
            render_as_batch=_url().startswith("sqlite"),
        ))
        await conn.run_sync(lambda _: context.run_migrations())
    await engine.dispose()

def run_migrations_online() -> None:
    import asyncio
    asyncio.run(run_async_migrations())
```

Генерация и применение:

```bash
# авто-генерация миграции из моделей
alembic revision --autogenerate -m "create users agents races parts builds"
alembic upgrade head
# CI на SQLite
alembic -x db_url=sqlite+aiosqlite:///./test.db upgrade head
```

`migrations/versions/0001_core.py` (пример с CONCURRENTLY и партицией):

```python
"""create core tables

Revision ID: 0001
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None

def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    race_status = postgresql.ENUM(
        "draft","queued","running","finished","failed","cancelled",
        name="race_status", create_type=False)
    race_status.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True),
                  server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("did", sa.Text, nullable=False, unique=True),
        sa.Column("display_name", sa.Text, nullable=False, server_default=""),
        sa.Column("reputation", sa.Integer, nullable=False, server_default="0"),
        sa.Column("metadata", postgresql.JSONB, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now()),
    )
    op.create_index("users_reputation_idx", "users", [sa.text("reputation DESC")])

    # большие таблицы индексируем БЕЗ блокировки (в Alembic — autocommit-блок)
    with op.get_context().autocommit_block():
        op.execute("CREATE INDEX CONCURRENTLY IF NOT EXISTS races_status_idx "
                   "ON races (status, queued_at)")
    # ...

def downgrade() -> None:
    op.drop_index("races_status_idx", table_name="races")
    op.drop_table("users")
    op.execute("DROP TYPE IF EXISTS race_status")
```

Партиционирование `race_participants` по времени:

```sql
-- 0012_partition_race_events.py (эволюция)
CREATE TABLE race_events_2026_09 PARTITION OF race_events
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE race_events_2026_10 PARTITION OF race_events
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
```

### 4.2 Миграция данных SQLite → PostgreSQL

Вариант A — **pgloader** (быстро, если схема совместима):

```bash
# pgloader skript
# migrate.load
LOAD DATABASE
     FROM sqlite:///home/ishidin/phoenix/phoenix.db
     INTO postgresql://phoenix:secret@localhost:5432/phoenix
 WITH include drop, create tables, create indexes, reset sequences,
      batch rows = 5000, prefetch rows = 10000, workers = 4
 SET maintenance_work_mem to '256MB', work_mem to '64MB'
 CAST type datetime to timestamptz drop default drop not null using zero-dates-to-null,
      type integer to bigint;
# запуск:
# pgloader migrate.load
```

Вариант B — **свой ETL** (когда нужен маппинг DID→UUID, бизнес-логика, идемпотентность):

```python
# scripts/migrate_sqlite_to_pg.py
import asyncio, sqlite3, uuid
import asyncpg

SQLITE = "/home/ishidin/phoenix/phoenix.db"
PG_DSN = "postgresql://phoenix:secret@localhost:5432/phoenix"

async def main():
    pg = await asyncpg.connect(PG_DSN)
    lite = sqlite3.connect(SQLITE); lite.row_factory = sqlite3.Row

    # идемпотентный маппинг did -> uuid в staging-таблице
    await pg.execute("CREATE TABLE IF NOT EXISTS migrate_map (did TEXT PRIMARY KEY, uuid UUID)")

    for row in lite.execute("SELECT did, display_name, stake_points, artifacts_count FROM did_reputation"):
        uid = str(uuid.uuid5(uuid.NAMESPACE_URL, row["did"]))
        await pg.execute(
            """INSERT INTO users (id, did, display_name, stake_points, reputation)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (did) DO UPDATE SET
                   display_name = EXCLUDED.display_name,
                   stake_points = EXCLUDED.stake_points
            """,
            uid, row["did"], row["display_name"] or "",
            int(row["stake_points"] or 1), int(row["artifacts_count"] or 0))
        await pg.execute("INSERT INTO migrate_map VALUES ($1,$2) ON CONFLICT DO NOTHING", row["did"], uid)

    # bounties -> listings (маппинг статусов)
    for b in lite.execute("SELECT id,title,description,amount,status FROM bounties"):
        await pg.execute(
            """INSERT INTO listings (id, seller_id, part_id, price_cents, status)
               VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING""",
            str(uuid.uuid5(uuid.NAMESPACE_URL, f"bounty:{b['id']}")),
            None, None, int(float(b["amount"] or 0) * 100),
            "active" if b["status"] == "open" else "paused")

    # валидация
    n_lite = lite.execute("SELECT count(*) FROM did_reputation").fetchone()[0]
    n_pg = await pg.fetchval("SELECT count(*) FROM users")
    assert n_lite == n_pg, f"rowcount mismatch {n_lite} != {n_pg}"
    print("OK: migrated", n_pg, "users")
    await pg.close()

if __name__ == "__main__":
    asyncio.run(main())
```

### 4.3 Стратегия cut-over (zero/low-downtime)

1. **Expand:** развернуть Postgres, применить миграции, включить dual-write в код-репозитории
   (флаг `DB_BACKEND=pg`), старые чтения ещё из SQLite.
2. **Backfill:** прогнать ETL (§4.2) в фоне; включить периодический sync (outbox).
3. **Verify:** сверять rowcounts и чек-суммы (`SELECT count(*), sum(...)`).
4. **Flip reads:** переключить чтение на PG; SQLite — только локальный кэш боксов.
5. **Contract:** отключить dual-write, оставить SQLite как per-box store.
6. **Rollback:** пока не удалили SQLite — флаг возвращает чтение на файл.

---

## 5. Примеры запросов

Ниже — «боевые» запросы под наш домен. Тег 🐘 = PostgreSQL-only, 🪶 = работает и в SQLite.

### 5.1 Лидерборд агентов (оконные функции 🐘)

```sql
-- топ-25 агентов по среднему score с учётом скорости (tie-break)
SELECT
    a.id, a.name, a.elo,
    COUNT(*)                                   AS races,
    ROUND(AVG(rp.score), 2)                    AS avg_score,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY rp.duration_ms) AS median_ms,
    ROUND(100.0 * AVG(CASE WHEN rp.ok THEN 1 ELSE 0 END), 1)    AS success_pct
FROM race_participants rp
JOIN agents a ON a.id = rp.agent_id
WHERE rp.finished_at >= now() - INTERVAL '30 days'
GROUP BY a.id
HAVING COUNT(*) >= 3
ORDER BY avg_score DESC, median_ms ASC
LIMIT 25;
```

### 5.2 Определение победителя гонки (tie-break по времени)

```sql
-- атомарно фиксируем победителя, только если гонка уже finished и winner не выставлен
WITH ranked AS (
    SELECT rp.agent_id, rp.score, rp.duration_ms,
           ROW_NUMBER() OVER (ORDER BY rp.score DESC NULLS LAST, rp.duration_ms ASC NULLS LAST) AS place
    FROM race_participants rp
    WHERE rp.race_id = $1 AND rp.ok = true
)
UPDATE races r
   SET winner_agent_id = ranked.agent_id,
       status = 'finished',
       finished_at = now()
  FROM ranked
 WHERE r.id = $1
   AND r.winner_agent_id IS NULL
   AND ranked.place = 1
RETURNING r.winner_agent_id;
```

### 5.3 Взять следующую гонку из очереди (🐘 `SKIP LOCKED`)

```sql
-- race-worker: безопасно для 25 параллельных воркеров, без блокировок
WITH next_race AS (
    SELECT id FROM races
     WHERE status = 'queued'
     ORDER BY queued_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
)
UPDATE races r
   SET status = 'running', started_at = now()
  FROM next_race n
 WHERE r.id = n.id
RETURNING r.id, r.title, r.task;
```

Python (asyncpg) с транзакцией:

```python
async def claim_race(pool) -> dict | None:
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow("""
                UPDATE races SET status='running', started_at=now()
                WHERE id = (
                    SELECT id FROM races WHERE status='queued'
                    ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1
                )
                RETURNING id, title, task
            """)
            return dict(row) if row else None
```

### 5.4 Атомарная регистрация участника (защита от переполнения)

```sql
-- 🐘 блокируем строку гонки, проверяем лимит, вставляем участника
BEGIN;
SELECT participants_count, max_participants
  FROM races WHERE id = $1 FOR UPDATE;             -- row-lock
-- в приложении: if count >= max -> ROLLBACK, raise RaceFull
UPDATE races SET participants_count = participants_count + 1 WHERE id = $1;
INSERT INTO race_participants (race_id, agent_id)
     VALUES ($1, $2)
ON CONFLICT (race_id, agent_id) DO NOTHING;        -- идемпотентно
COMMIT;
```

### 5.5 Анти-челлендж: advisory lock на старт гонки (🐘)

```sql
-- гарантирует, что одну гонку стартует ровно один процесс
SELECT pg_try_advisory_lock(hashtext('race:' || $1::text));
-- ... старт ...
SELECT pg_advisory_unlock(hashtext('race:' || $1::text));
```

```python
# asyncpg: xact-scoped лок живёт до конца транзакции
async with conn.transaction():
    got = await conn.fetchval("SELECT pg_try_advisory_xact_lock(hashtext($1))",
                              f"race:{race_id}")
    if not got:
        raise RuntimeError("race already being started")
```

### 5.6 Маркетплейс: поиск запчастей (триграммы + полнотекст 🐘)

```sql
-- нечёткий поиск + ранжирование
SELECT p.id, p.slug, p.title, p.price_cents, p.downloads,
       similarity(p.title, $1) AS sim
FROM parts p
WHERE p.title % $1                                  -- pg_trgm оператор
   OR to_tsvector('simple', p.title || ' ' || coalesce(p.description,''))
      @@ plainto_tsquery('simple', $1)
ORDER BY sim DESC, p.downloads DESC
LIMIT 20;
```

### 5.7 Купить запчасть (транзакция + идемпотентность)

```sql
-- 🐘 денежная транзакция; повторный вызов с тем же ключом не спишет дважды
BEGIN;
INSERT INTO orders (id, buyer_id, listing_id, idempotency_key, qty, amount_cents)
SELECT gen_random_uuid(), $1, l.id, $3, $4, l.price_cents * $4
  FROM listings l
 WHERE l.id = $2 AND l.status = 'active' AND l.stock >= $4
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id;

UPDATE listings SET stock = stock - $4,
       status = CASE WHEN stock - $4 = 0 THEN 'sold' ELSE status END
 WHERE id = $2 AND stock >= $4;
COMMIT;
```

Локальный **outbox** на SQLite (агент → Postgres, синхронизация результатов):

```sql
-- 🪶 boxes/agent_N/state.db
CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,             -- 'race_result' | 'skill_export'
    payload TEXT NOT NULL,          -- JSON
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    synced_at TEXT
);
```
```python
# фоновый воркер бокса: push → Postgres, затем пометить synced
async def flush_outbox(pg_pool, lite):
    for row in lite.execute("SELECT id,kind,payload FROM outbox WHERE status='pending' LIMIT 100"):
        await pg_pool.execute(
            "INSERT INTO race_participants (race_id,agent_id,score,duration_ms,ok,output) "
            "VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (race_id,agent_id) DO NOTHING",
            *parse(row))
        lite.execute("UPDATE outbox SET status='synced', synced_at=datetime('now') WHERE id=?", (row["id"],))
        lite.commit()
```

### 5.8 Realtime-уведомление о финише гонки (🐘 LISTEN/NOTIFY)

```sql
-- триггер пушит нотификацию всем подписчикам
CREATE OR REPLACE FUNCTION notify_race_finished() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('race_finished',
        json_build_object('race_id', NEW.id, 'winner', NEW.winner_agent_id)::text);
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER races_finished_notify
AFTER UPDATE OF winner_agent_id ON races
FOR EACH ROW WHEN (NEW.winner_agent_id IS NOT NULL AND OLD.winner_agent_id IS NULL)
EXECUTE FUNCTION notify_race_finished();
```

```python
async def on_race_finished(conn, pid, channel, payload):
    print("race finished:", payload)
    # обновить ELO победителя, разослать WS-клиентам

await conn.add_listener("race_finished", on_race_finished)
```

### 5.9 Пересчёт ELO победителя (🐘)

```sql
-- K-factor=32, ожидаемый результат по ELO, апдейт за одну гонку
UPDATE agents SET
    elo  = GREATEST(0, ROUND(elo + 32 * (1 - 1.0/(1 + pow(10, (opp_avg_elo - elo)/400.0))))),
    wins = wins + 1,
    races_played = races_played + 1
FROM (
    SELECT a.id, AVG(o.elo)::numeric AS opp_avg_elo
    FROM agents a
    LEFT JOIN race_participants rp ON rp.agent_id = a.id
    LEFT JOIN agents o ON o.id = rp.agent_id
    WHERE a.id = $1
    GROUP BY a.id
) sub
WHERE agents.id = sub.id;
```

### 5.10 Состав сборки (build) с её ценой (🐘 денормализация)

```sql
SELECT b.id, b.name, b.version,
       COUNT(bp.part_id)                                  AS parts_count,
       COALESCE(SUM(p.price_cents), 0)                    AS computed_total,
       b.total_price_cents                                AS stored_total,
       jsonb_agg(jsonb_build_object(
           'slug', p.slug, 'title', p.title,
           'version', COALESCE(bp.pinned_version, p.version),
           'position', bp.position
       ) ORDER BY bp.position)                            AS manifest
FROM builds b
LEFT JOIN build_parts bp ON bp.build_id = b.id
LEFT JOIN parts p        ON p.id = bp.part_id
WHERE b.id = $1
GROUP BY b.id;
```

### 5.11 Метрики гонок по дням (🐘 `date_trunc` + FILTER)

```sql
SELECT date_trunc('day', finished_at)::date AS day,
       COUNT(*)                            AS races,
       COUNT(*) FILTER (WHERE status='failed')  AS failed,
       ROUND(AVG(EXTRACT(EPOCH FROM (finished_at - started_at))*1000)) AS avg_ms,
       ROUND(AVG(rp.score), 2)             AS avg_score
FROM races r
JOIN race_participants rp ON rp.race_id = r.id
WHERE finished_at >= now() - INTERVAL '14 days'
GROUP BY 1 ORDER BY 1;
```

### 5.12 Медленные гонки/инциденты (🐘)

```sql
SELECT r.id, r.title, r.status,
       EXTRACT(EPOCH FROM (COALESCE(r.finished_at, now()) - r.started_at)) AS sec,
       COUNT(event) AS events
FROM races r
LEFT JOIN race_events re ON re.race_id = r.id AND re.kind = 'error'
WHERE r.started_at IS NOT NULL
GROUP BY r.id
HAVING EXTRACT(EPOCH FROM (COALESCE(r.finished_at, now()) - r.started_at)) > 600
ORDER BY sec DESC;
```

### 5.13 SQLite-специфичные рецепты (🪶)

```sql
-- быстрая вставка пачки результатов гонки в одной транзакции
BEGIN IMMEDIATE;                      -- сразу берём write-lock, меньше SQLITE_BUSY
INSERT INTO race_participants (race_id,agent_id,score,duration_ms,ok)
VALUES (?,?,?,?,?), (?,?,?,?,?), (?,?,?,?,?);
COMMIT;

-- JSON1: извлечь поле из output
SELECT agent_id,
       json_extract(output, '$.skills_earned[0]') AS top_skill
FROM race_participants WHERE race_id = ?;

-- FTS5 поиск в локальном кэше скиллов
CREATE VIRTUAL TABLE skills_fts USING fts5(slug, title, body, content='skills');
SELECT slug, title FROM skills_fts WHERE skills_fts MATCH 'race OR arena' LIMIT 10;
```

```python
# правильная инициализация локального SQLite бокса
import sqlite3
con = sqlite3.connect("boxes/agent_1/state.db", timeout=5)
con.executescript("""
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=5000;
    PRAGMA foreign_keys=ON;
""")
# для write-heavy операций явно: BEGIN IMMEDIATE, а не отложенный BEGIN
con.execute("BEGIN IMMEDIATE")
```

### 5.14 Python: пул подключений и типичный сценарий гонки (asyncpg 🐘)

```python
# phoenix/db/pool.py
import asyncpg

async def make_pool() -> asyncpg.Pool:
    return await asyncpg.create_pool(
        dsn="postgresql://phoenix:secret@localhost:5432/phoenix",
        min_size=2, max_size=10,          # 25 агентов -> ~25-50 коннектов, лучше через pgBouncer
        command_timeout=30,
        statement_cache_size=100,
    )

# сценарий: финиш гонки от бокса
async def finish_race(pool, race_id, agent_id, score, duration_ms, tools, output):
    async with pool.acquire() as conn:
        async with conn.transaction(isolation="read_committed"):
            await conn.execute("""
                INSERT INTO race_participants
                    (race_id, agent_id, score, duration_ms, ok, tools_used, output, finished_at)
                VALUES ($1,$2,$3,$4,true,$5,$6, now())
                ON CONFLICT (race_id, agent_id) DO UPDATE
                   SET score=EXCLUDED.score, duration_ms=EXCLUDED.duration_ms,
                       output=EXCLUDED.output, finished_at=now()
            """, race_id, agent_id, score, duration_ms, tools, output)
            await conn.execute(
                "INSERT INTO race_events (race_id,agent_id,kind,payload) "
                "VALUES ($1,$2,'finish',$3)",
                race_id, agent_id, {"score": float(score), "ms": duration_ms})
```

### 5.15 Node.js (для `race.js`): pg vs better-sqlite3

```js
// pg: конкурентная запись из 25 боксов
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

async function recordResult(raceId, agentId, { score, durationMs, ok, tools }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO race_participants (race_id, agent_id, score, duration_ms, ok, tools_used, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (race_id, agent_id) DO NOTHING`,
      [raceId, agentId, score, durationMs, ok, tools]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
```

```js
// better-sqlite3: синхронный, для локального бокса
import Database from "better-sqlite3";
const db = new Database("boxes/agent_1/state.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
const ins = db.prepare(
  "INSERT INTO outbox (kind, payload) VALUES (?, ?)");
const tx = db.transaction((rows) => rows.forEach(r => ins.run(r.kind, JSON.stringify(r.payload))));
tx(rows);   // одна транзакция — быстро и атомарно
```

---

## 6. Производительность и ёмкость (ориентиры)

| Операция | SQLite (WAL, локально) | PostgreSQL (localhost) |
|---|---|---|
| Простая вставка (1 строка, авто-коммит) | ~1–5 тыс/с | ~5–15 тыс/с |
| Батч-вставка в транзакции | ~50–200 тыс/с | ~50–100 тыс/с (COPY — выше) |
| Конкурентные писатели | **1** (остальные ждут) | до десятков (row locks) |
| Точечное чтение | суб-мкс (кэш ОС) | ~0.1–1 мс (loopback) |
| Очередь задач | ручной `BEGIN IMMEDIATE` | `FOR UPDATE SKIP LOCKED` |

> Числа — порядки величин на типовом железе; главное здесь — **характер конкурентности**,
> а не абсолютные цифры. Для 25 агентов Postgres даёт запас, SQLite — стартовые `SQLITE_BUSY`.

Практические настройки Postgres под нагрузку:

```ini
# postgresql.conf (ориентир для 4 vCPU / 8 GB dev)
shared_buffers = 2GB
effective_cache_size = 6GB
work_mem = 32MB
maintenance_work_mem = 256MB
max_connections = 100          ; + pgBouncer transaction mode перед ним
random_page_cost = 1.1         ; SSD
```

---

## 7. Приложение

### 7.1 docker-compose (dev)

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: phoenix
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: phoenix
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./research/db/postgres_schema.sql:/docker-entrypoint-initdb.d/001_schema.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U phoenix"]
      interval: 5s
  pgbouncer:
    image: edoburu/pgbouncer
    environment:
      DATABASE_URL: postgres://phoenix:secret@postgres:5432/phoenix
      POOL_MODE: transaction
      MAX_CLIENT_CONN: 200
      DEFAULT_POOL_SIZE: 20
    ports: ["6432:5432"]
    depends_on: [postgres]
volumes: { pgdata: {} }
```

```bash
# .env.example  (имя переменной, НЕ реальные секреты)
DATABASE_URL=postgresql://phoenix:secret@localhost:5432/phoenix
PGBOUNCER_URL=postgresql://phoenix:secret@localhost:6432/phoenix
DB_BACKEND=pg            # pg | sqlite
SQLITE_PATH=boxes/agent_1/state.db
```

### 7.2 Бэкапы и проверка

```bash
# логический бэкап
pg_dump -Fc -U phoenix phoenix > backup_$(date +%F).dump
# восстановление
pg_restore -U phoenix -d phoenix_new backup_2026-09-13.dump

# SQLite бэкап без блокировки писателя
sqlite3 phoenix.db "VACUUM INTO 'backup_$(date +%F).db'"
```

### 7.3 Источники

- SQLite: *When To Use* — https://www.sqlite.org/whentouse.html
- SQLite: *Write-Ahead Logging* — https://www.sqlite.org/wal.html
- SQLite: *Appropriate Uses For SQLite* (эмбеддед, не client/server) — https://www.sqlite.org/
- PostgreSQL: *Concurrency Control / MVCC* — https://www.postgresql.org/docs/current/mvcc.html
- PostgreSQL: *SELECT … FOR UPDATE / SKIP LOCKED* — https://www.postgresql.org/docs/current/sql-select.html
- PostgreSQL: *LISTEN/NOTIFY* — https://www.postgresql.org/docs/current/sql-notify.html
- PostgreSQL: *JSONB / GIN / pg_trgm* — https://www.postgresql.org/docs/current/datatype-json.html
- Alembic: batch-миграции для SQLite — https://alembic.sqlalchemy.org/en/latest/batch.html
- pgloader (SQLite → PG) — https://pgloader.readthedocs.io/
- Проект: `phoenix/AEON_ARENA_WHITEPAPER.md` (race engine: score/duration_ms/ok/tools_used),
  `phoenix/VISION.md` (SQLite → PostgreSQL), `phoenix.db` (текущая схема).

---

## 8. Итоговая рекомендация (чек-лист внедрения)

- [ ] **PostgreSQL 16** как source of truth: `users`, `agents`, `races`, `race_participants`,
      `parts`, `builds`, `listings`, `orders`, `race_events`.
- [ ] **SQLite WAL** внутри `boxes/agent_N/state.db` — локальный outbox + кэш скиллов (офлайн-автономность).
- [ ] Единые модели SQLAlchemy 2.0 + **Alembic** (`render_as_batch` для SQLite, `CONCURRENTLY` для PG).
- [ ] **pgBouncer (transaction mode)** перед Postgres, пулы asyncpg `max_size≈10`.
- [ ] Очередь гонок — через **`FOR UPDATE SKIP LOCKED`**; регистрация участника — через row-lock
      `SELECT … FOR UPDATE`; старт — `pg_advisory_xact_lock`.
- [ ] Realtime финиша — **`LISTEN/NOTIFY`** (MVP), при росте — NATS/Kafka.
- [ ] Маркетплейс: транзакции + `idempotency_key` на `orders`, partial index на активные `listings`.
- [ ] Миграция данных — **pgloader** или ETL §4.2, cut-over по стратегии expand→backfill→flip→contract.
- [ ] Партиционирование `race_events`/`orders` по времени + retention.
- [ ] Мониторинг: `pg_stat_statements`, slow-query log, метрики §5.11.

**Одной фразой:** *Postgres — арена и рынок; SQLite — память и автономность каждого бойца.*
