-- ЗАДАЧА 6.2 — Каноническая схема БД AI-1 (FORMULA I1)
-- Диалект: PostgreSQL. Зеркало типов из arena_lab/src/scene/DbSchema.tsx.
-- Версия схемы: см. DB_SCHEMA_VERSION в DbSchema.tsx.

CREATE TABLE IF NOT EXISTS pilots (
  id          BIGSERIAL PRIMARY KEY,
  handle      TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL UNIQUE,
  password    TEXT NOT NULL,            -- bcrypt/scrypt hash, НЕ plaintext
  role        TEXT NOT NULL DEFAULT 'pilot'
              CHECK (role IN ('pilot', 'engineer', 'admin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  color       TEXT NOT NULL DEFAULT '#4dd0ff',
  owner_id    BIGINT REFERENCES pilots(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  pilot_id    BIGINT REFERENCES pilots(id) ON DELETE CASCADE,
  team_id     BIGINT REFERENCES teams(id)  ON DELETE SET NULL,
  model       TEXT NOT NULL DEFAULT 'gpt',
  status      TEXT NOT NULL DEFAULT 'idle'
              CHECK (status IN ('idle', 'running', 'finished', 'failed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS races (
  id          BIGSERIAL PRIMARY KEY,
  task        TEXT NOT NULL,
  track_id    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'countdown', 'running', 'finished', 'aborted')),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS race_results (
  id          BIGSERIAL PRIMARY KEY,
  race_id     BIGINT NOT NULL REFERENCES races(id)  ON DELETE CASCADE,
  agent_id    BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL CHECK (position >= 1),
  progress    DOUBLE PRECISION NOT NULL DEFAULT 0,
  time_ms     INTEGER,
  UNIQUE (race_id, agent_id)
);

CREATE TABLE IF NOT EXISTS tuning_parts (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL
              CHECK (category IN ('engine', 'aero', 'tyres', 'brakes', 'suspension')),
  price       NUMERIC(10, 2) NOT NULL DEFAULT 0,
  stats       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS builds (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  part_id     BIGINT NOT NULL REFERENCES tuning_parts(id) ON DELETE RESTRICT,
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skills (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  level       INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 10),
  UNIQUE (agent_id, name)
);

CREATE TABLE IF NOT EXISTS flag_events (
  id          BIGSERIAL PRIMARY KEY,
  race_id     BIGINT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL
              CHECK (kind IN ('green', 'yellow', 'red', 'blue', 'checkered', 'safety')),
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadmap_tasks (
  id          TEXT PRIMARY KEY,       -- напр. '6.2'
  title       TEXT NOT NULL,
  stage       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Индексы под горячие запросы лидерборда и телеметрии.
CREATE INDEX IF NOT EXISTS idx_race_results_race   ON race_results (race_id, position);
CREATE INDEX IF NOT EXISTS idx_agents_pilot        ON agents (pilot_id);
CREATE INDEX IF NOT EXISTS idx_flag_events_race_ts ON flag_events (race_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_builds_agent        ON builds (agent_id);
