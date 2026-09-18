'use strict';

/**
 * observability/arena_health.js
 * ---------------------------------------------------------------------------
 * Health-check агентов арены (пилотов боксов).
 *
 * Источник истины — журнал гонок: `memory/races/race_*.json`. Каждый файл
 * содержит поле `ts` (ISO-время старта гонки) и массив `results`, где у
 * каждого результата есть `box` (id пилота), `ok` (успех/провал) и
 * `duration_ms`.
 *
 * Публичный API:
 *   - checkAgent(agentId[, options]) -> {status, last_seen_sec, fails_10, ok_rate}
 *   - checkAll(agents[, options])    -> { [agentId]: health }
 *   - checkArena([options])          -> полный отчёт по 25 боксам
 *
 * Статусы (строго по ТЗ):
 *   alive  — last_seen_sec <  300
 *   stale  — last_seen_sec < 1800
 *   dead   — last_seen_sec >= 1800 (или агент вообще не встречался)
 *
 * Результат — обычный объект (только строки/числа/null), поэтому корректно
 * переживает JSON.parse(JSON.stringify(x)).
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_RACE_DIR = path.join(__dirname, '..', 'memory', 'races');

const ALIVE_SEC = 300;   // < 5 минут  -> alive
const STALE_SEC = 1800;  // < 30 минут -> stale, иначе dead
const WINDOW = 10;       // сколько последних заездов учитывать в fails_10

// 25 канонических боксов арены (agent_16 исторически пропущен в FS, но
// присутствует в журнале гонок — поэтому держим его в списке).
const DEFAULT_AGENTS = Object.freeze(
  Array.from({ length: 25 }, (_, i) => 'agent_' + (i + 1)),
);

// ---------------------------------------------------------------------------
// Загрузка журнала гонок
// ---------------------------------------------------------------------------

/** Список файлов `race_*.json` в каталоге (без сортировки). */
function listRaceFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    return [];
  }
  return names.filter((n) => /^race_.*\.json$/i.test(n));
}

/** Достаёт timestamp (ms) из данных гонки; fallback — из имени файла. */
function raceTimestamp(race, file, stat) {
  if (race && typeof race.ts === 'string') {
    const t = Date.parse(race.ts);
    if (Number.isFinite(t)) return t;
  }
  const m = /race_(\d+)/.exec(String(file));
  if (m) {
    const n = Number(m[1]);
    // В проекте id гонки — миллисекунды (13 цифр), но встречаются и секунды.
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
  }
  if (stat && Number.isFinite(stat.mtimeMs)) return stat.mtimeMs;
  return 0;
}

/**
 * Читает все валидные race_*.json и возвращает массив записей
 * {file, race, ts}, отсортированный по возрастанию времени.
 * Битые файлы молча пропускаются.
 */
function loadRaces(options) {
  const opts = options || {};
  const dir = opts.dir || DEFAULT_RACE_DIR;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : Infinity;

  const records = [];
  for (const file of listRaceFiles(dir)) {
    const full = path.join(dir, file);
    let race;
    let stat;
    try {
      race = JSON.parse(fs.readFileSync(full, 'utf8'));
      stat = fs.statSync(full);
    } catch (err) {
      continue; // битый/недочитанный файл — не роняем health-check
    }
    if (!race || typeof race !== 'object') continue;
    records.push({ file, race, ts: raceTimestamp(race, file, stat) });
  }

  records.sort((a, b) => a.ts - b.ts || String(a.file).localeCompare(String(b.file)));
  return limit === Infinity ? records : records.slice(-limit);
}

// ---------------------------------------------------------------------------
// Извлечение appearances агента
// ---------------------------------------------------------------------------

/** ok-флаг результата: true только при явном ok === true либо score > 0. */
function isOkResult(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.ok === true) return true;
  if (entry.ok === false) return false;
  return Number(entry.score) > 0;
}

/** Может ли race быть массивом результатов (старые/альтернативные форматы). */
function resultsOf(race) {
  if (Array.isArray(race)) return race;
  if (race && Array.isArray(race.results)) return race.results;
  return [];
}

/**
 * Все появления агента в загруженном журнале (по возрастанию времени).
 * Возвращает [{ts, ok, duration_ms}].
 */
function appearancesOf(records, agentId) {
  const id = String(agentId);
  const out = [];
  for (const rec of records) {
    const race = rec.race;
    let found = null;
    for (const entry of resultsOf(race)) {
      if (entry && String(entry.box) === id) {
        found = entry;
        break;
      }
    }
    if (found) {
      out.push({
        ts: rec.ts,
        ok: isOkResult(found),
        duration_ms: Number.isFinite(found.duration_ms) ? found.duration_ms : null,
      });
      continue;
    }
    // Если агент не в results, но объявлен победителем — считаем успехом.
    if (race && !Array.isArray(race) && String(race.winner) === id) {
      out.push({ ts: rec.ts, ok: true, duration_ms: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Расчёт здоровья
// ---------------------------------------------------------------------------

/** Статус по возрасту последней активности (сек). null -> dead. */
function statusFor(lastSeenSec) {
  if (lastSeenSec === null || !Number.isFinite(lastSeenSec)) return 'dead';
  if (lastSeenSec < ALIVE_SEC) return 'alive';
  if (lastSeenSec < STALE_SEC) return 'stale';
  return 'dead';
}

/** Округление до 3 знаков (JSON-стабильно). */
function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function buildHealth(appearances, now) {
  const empty = {
    status: 'dead',
    last_seen_sec: null,
    fails_10: 0,
    ok_rate: 0,
  };
  if (!appearances.length) return empty;

  const last = appearances[appearances.length - 1];
  const ageMs = Math.max(0, now - last.ts);
  const lastSeenSec = Math.round(ageMs / 1000);

  const window = appearances.slice(-WINDOW);
  let ok = 0;
  for (const a of window) if (a.ok) ok += 1;
  const fails = window.length - ok;

  return {
    status: statusFor(lastSeenSec),
    last_seen_sec: lastSeenSec,
    fails_10: fails,
    ok_rate: window.length ? round3(ok / window.length) : 0,
  };
}

/**
 * Health одного агента.
 * @param {string} agentId
 * @param {{dir?:string, now?:number, limit?:number, records?:Array}} [options]
 * @returns {{status:'alive'|'stale'|'dead', last_seen_sec:number|null, fails_10:number, ok_rate:number}}
 */
function checkAgent(agentId, options) {
  const opts = options || {};
  if (agentId === undefined || agentId === null) {
    throw new TypeError('checkAgent: agentId is required');
  }
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const records = opts.records || loadRaces(opts);
  return buildHealth(appearancesOf(records, agentId), now);
}

/**
 * Health для набора агентов. Журнал читается один раз.
 * @param {Array<string|{id:string}>} agents
 * @param {object} [options]
 * @returns {Object<string, object>} карта id -> health
 */
function checkAll(agents, options) {
  const opts = options || {};
  if (!Array.isArray(agents)) {
    throw new TypeError('checkAll: agents must be an array');
  }
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const records = opts.records || loadRaces(opts);

  const report = {};
  for (const a of agents) {
    const id = typeof a === 'string' ? a : a && a.id;
    if (id === undefined || id === null) continue;
    report[String(id)] = buildHealth(appearancesOf(records, id), now);
  }
  return report;
}

/**
 * Полный отчёт по 25 канонам арены + сводка.
 * @returns {{generated_at:number, total:number, counts:object, agents:object}}
 */
function checkArena(options) {
  const opts = options || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const agents = opts.agents || DEFAULT_AGENTS;
  const map = checkAll(agents, Object.assign({}, opts, { now }));

  const counts = { alive: 0, stale: 0, dead: 0 };
  for (const id of Object.keys(map)) counts[map[id].status] += 1;

  return {
    generated_at: now,
    total: Object.keys(map).length,
    counts,
    agents: map,
  };
}

module.exports = {
  checkAgent,
  checkAll,
  checkArena,
  // вспомогательные / для тестов
  loadRaces,
  listRaceFiles,
  appearancesOf,
  statusFor,
  DEFAULT_AGENTS,
  DEFAULT_RACE_DIR,
  ALIVE_SEC,
  STALE_SEC,
  WINDOW,
};
