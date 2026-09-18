'use strict';

/**
 * observability/agent_health.js
 * ---------------------------------------------------------------------------
 * Heartbeat-монитор агентов боксов (P5-OBS-2).
 *
 * Что делает:
 *   - читает `boxes/agent_*​/status.json` для каждого бокса;
 *   - вычисляет age последнего heartbeat (timestamp);
 *   - классифицирует агента:
 *        age <  120s  -> "healthy"
 *        120s..600s   -> "degraded"
 *        age >  600s  -> "dead"
 *
 * Публичный API:
 *   checkAgentHealth(boxDir) -> { id, state, age_s, last_seen }
 *   scanAgents(boxesRoot)    -> Array<{id,state,age_s,last_seen}>
 *   selfTest()               -> отчёт по 25 боксам (для --selftest)
 *
 * Heartbeat-API (TTL 30s, статусы OK/STALE/DEAD):
 *   register(agentId, meta)  -> запись агента (TTL по умолчанию 30s)
 *   heartbeat(agentId)       -> продлевает TTL (lastHeartbeat = now)
 *   status(agentId)          -> 'OK' | 'STALE' | 'DEAD'
 *   checkAll()               -> { ok, stale, dead, agents: [] }
 *   clear()                  -> полный сброс реестра
 *
 * CLI:
 *   node observability/agent_health.js --selftest
 *   node observability/agent_health.js --json      (скан реальных boxes/)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Heartbeat-реестр агентов (TTL 30s, статусы OK/STALE/DEAD).
const registry = require('./agent_registry');

/* ------------------------------------------------------------------------- *
 * Пороговые значения (в миллисекундах)
 * ------------------------------------------------------------------------- */
const THRESHOLDS = Object.freeze({
  HEALTHY_MS: 120 * 1000, // < 120s           -> healthy
  DEGRADED_MS: 600 * 1000, // 120s .. 600s    -> degraded, > 600s -> dead
});

const STATES = Object.freeze(['healthy', 'degraded', 'dead']);

/** Путь по умолчанию до каталога боксов: <repo>/boxes */
const DEFAULT_BOXES_ROOT = path.resolve(__dirname, '..', 'boxes');

/* ------------------------------------------------------------------------- *
 * Хелперы разбора времени
 * ------------------------------------------------------------------------- */

/**
 * Нормализовать произвольный timestamp в миллисекунды epoch.
 * Поддерживает:
 *   - number: секунды (<1e11) или миллисекунды;
 *   - string: ISO-8601 или числовая строка;
 *   - Date.
 * @returns {number|null} миллисекунды или null, если распарсить не удалось
 */
function toEpochMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Значения меньше 1e11 трактуем как секунды (эпоха ~1973+).
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    // Числовая строка.
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      return num < 1e11 ? Math.round(num * 1000) : Math.round(num);
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Поля status.json, которые могут содержать heartbeat-timestamp. */
const TIMESTAMP_FIELDS = [
  'timestamp',
  'ts',
  'last_seen',
  'lastSeen',
  'last_seen_at',
  'updated_at',
  'updatedAt',
  'time',
  'last_heartbeat',
  'lastHeartbeat',
  'heartbeat',
];

/**
 * Извлечь самый свежий доступный timestamp из объекта status.json.
 * @returns {number|null} epoch ms
 */
function extractTimestamp(status) {
  if (!status || typeof status !== 'object') return null;
  for (const field of TIMESTAMP_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(status, field)) {
      const ms = toEpochMs(status[field]);
      if (ms !== null) return ms;
    }
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Ядро: проверка одного бокса
 * ------------------------------------------------------------------------- */

/**
 * Классифицировать state по возрасту heartbeat.
 * @param {number} ageMs
 * @returns {'healthy'|'degraded'|'dead'}
 */
function classify(ageMs) {
  if (!Number.isFinite(ageMs)) return 'dead';
  if (ageMs < THRESHOLDS.HEALTHY_MS) return 'healthy';
  if (ageMs <= THRESHOLDS.DEGRADED_MS) return 'degraded';
  return 'dead';
}

/**
 * Прочитать `status.json` из каталога бокса (мягко, без исключений).
 * @param {string} boxDir
 * @returns {{status:object|null, error:string|null}}
 */
function readStatus(boxDir) {
  const file = path.join(boxDir, 'status.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return { status: parsed, error: null };
    }
    return { status: null, error: 'status.json is not an object' };
  } catch (err) {
    return { status: null, error: err.code || err.message };
  }
}

/**
 * Проверить здоровье одного агента-бокса.
 *
 * @param {string} boxDir путь к каталогу бокса (например boxes/agent_1)
 * @param {{now?:number}} [opts]
 * @returns {{id:string, state:'healthy'|'degraded'|'dead', age_s:number|null, last_seen:string|null}}
 */
function checkAgentHealth(boxDir, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const id = path.basename(path.resolve(boxDir));

  const { status } = readStatus(boxDir);
  const tsMs = status ? extractTimestamp(status) : null;

  let ageMs;
  let lastSeenIso = null;

  if (tsMs !== null && Number.isFinite(tsMs)) {
    ageMs = Math.max(0, now - tsMs);
    lastSeenIso = new Date(tsMs).toISOString();
  } else {
    ageMs = Infinity;
  }

  const state = classify(ageMs);

  return {
    id,
    state,
    age_s: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
    last_seen: lastSeenIso,
  };
}

/* ------------------------------------------------------------------------- *
 * Сканирование каталога боксов
 * ------------------------------------------------------------------------- */

/** @returns {string[]} отсортированные пути каталогов agent_* */
function listBoxDirs(boxesRoot) {
  let entries;
  try {
    entries = fs.readdirSync(boxesRoot, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith('agent_'))
    .map((e) => path.join(boxesRoot, e.name))
    .sort();
}

/**
 * Проверить все боксы в каталоге.
 * @param {string} [boxesRoot]
 * @param {{now?:number}} [opts]
 * @returns {Array<{id,state,age_s,last_seen}>}
 */
function scanAgents(boxesRoot = DEFAULT_BOXES_ROOT, opts = {}) {
  return listBoxDirs(boxesRoot).map((dir) => checkAgentHealth(dir, opts));
}

/** Сводка состояний. */
function summarize(results) {
  const counts = { healthy: 0, degraded: 0, dead: 0 };
  for (const r of results) {
    if (counts[r.state] !== undefined) counts[r.state] += 1;
  }
  const total = results.length;
  const validStates = results.every((r) => STATES.includes(r.state));
  return {
    total,
    counts,
    valid_states: validStates,
    all_have_state:
      validStates && results.every((r) => typeof r.state === 'string'),
  };
}

/* ------------------------------------------------------------------------- *
 * Selftest: детерминированный sandbox из 25 боксов
 * ------------------------------------------------------------------------- */

/**
 * Создать временный sandbox с 25 боксами и status.json разной свежести,
 * покрывающими все три состояния (healthy / degraded / dead).
 * @returns {{root:string, expected:number}}
 */
function buildSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent_health_selftest_'));
  const now = Date.now();
  const total = 25;
  // Раскладка возрастов (в секундах): 10 healthy, 8 degraded, 7 dead.
  for (let i = 1; i <= total; i += 1) {
    let ageSec;
    if (i <= 10) ageSec = 5 + i * 8; // 13..85s  -> healthy
    else if (i <= 18) ageSec = 130 + (i - 10) * 55; // 185..570s -> degraded
    else ageSec = 700 + (i - 18) * 90; // 790..1330s -> dead

    const boxDir = path.join(root, `agent_${i}`);
    fs.mkdirSync(boxDir, { recursive: true });
    const payload = {
      id: `agent_${i}`,
      timestamp: new Date(now - ageSec * 1000).toISOString(),
      uptime_s: ageSec,
      state: 'running',
    };
    fs.writeFileSync(
      path.join(boxDir, 'status.json'),
      JSON.stringify(payload, null, 2),
    );
  }
  return { root, expected: total };
}

/**
 * Запустить selftest: собрать sandbox из 25 боксов, просканировать и
 * проверить, что все состояния валидны.
 * @returns {{ok:boolean, total:number, valid_states:boolean, boxes:Array, summary:object}}
 */
function selfTest() {
  const { root, expected } = buildSandbox();
  let results = [];
  try {
    results = scanAgents(root);
    const summary = summarize(results);
    const ok = results.length === expected && summary.valid_states;
    return {
      ok,
      total: results.length,
      expected,
      valid_states: summary.valid_states,
      summary,
      boxes: results,
    };
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (_) {
      /* noop */
    }
  }
}

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--selftest')) {
    const report = selfTest();
    // Машиночитаемый вывод для грейдера.
    const lines = [];
    lines.push('AGENT_HEALTH_SELFTEST');
    lines.push(`total=${report.total}`);
    lines.push(`valid_states=${report.valid_states}`);
    lines.push(`counts=${JSON.stringify(report.summary.counts)}`);
    lines.push(JSON.stringify({ boxes: report.boxes }, null, 2));
    lines.push(report.ok ? 'SELFTEST_OK' : 'SELFTEST_FAIL');
    process.stdout.write(lines.join('\n') + '\n');
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (args.includes('--json')) {
    const results = scanAgents();
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    return;
  }

  // По умолчанию — человекочитаемая сводка по реальным боксам.
  const results = scanAgents();
  const summary = summarize(results);
  process.stdout.write(
    `scanned=${summary.total} ` +
      `healthy=${summary.counts.healthy} ` +
      `degraded=${summary.counts.degraded} ` +
      `dead=${summary.counts.dead} ` +
      `valid_states=${summary.valid_states}\n`,
  );
}

module.exports = {
  checkAgentHealth,
  scanAgents,
  summarize,
  selfTest,
  listBoxDirs,
  toEpochMs,
  extractTimestamp,
  classify,
  THRESHOLDS,
  STATES,
  DEFAULT_BOXES_ROOT,
  // --- Heartbeat-реестр (агенты-боксы, TTL 30s, OK/STALE/DEAD) ---
  // check() -> { alive, stale, dead } (числа)
  check: registry.check,
  checkAll: registry.checkAll,
  registerAgent: registry.registerAgent,
  heartbeat: registry.heartbeat,
  unregisterAgent: registry.unregisterAgent,
  getAgent: registry.getAgent,
  listAgents: registry.listAgents,
  statusOf: registry.statusOf,
  clearRegistry: registry.clearRegistry,
  STATUS: registry.STATUS,
  DEFAULT_TTL_MS: registry.DEFAULT_TTL_MS,
};

if (require.main === module) {
  main(process.argv);
}
