'use strict';

/**
 * observability/race_validator.js
 * ---------------------------------------------------------------------------
 * Валидатор протоколов гонок в `memory/races/*.json`.
 *
 * Проблема: свежие гонки пишутся «пустыми» — в протоколе нет победителя
 * (`winner: null`), поэтому дашборд показывает «agent: —, time: —s».
 *
 * Контракт (см. критерий задачи):
 *   validateRace(obj) -> { ok: boolean, missing: string[] }
 *        - ok === true  => протокол валиден;
 *        - missing      => список невыполненных требований в порядке
 *                          ['winner', 'duration_ms', 'agents'].
 *
 *   Требования:
 *     winner       — непустая строка (id агента-победителя);
 *     duration_ms  — есть хотя бы один положительный замер времени (у агента
 *                    в results[], либо на верхнем уровне);
 *     agents       — участников >= 1 (results[]/agents[] или числовое поле).
 *
 *   scan(dir) -> { total, empty, valid, ... }
 *        - total — все *.json в каталоге;
 *        - valid — протоколы, прошедшие validateRace (ok === true);
 *        - empty — все остальные (пустые/битые/неполные), т.е. total = valid + empty;
 *        - дополнительно: broken, noWinner, byReason — детализация.
 *
 * Модуль намеренно zero-dependency (только fs/path) и безопасен к мусору:
 * битый JSON, null, массивы, не-объекты не бросают исключений.
 *
 * CLI:
 *   node observability/race_validator.js [dir]
 *   # по умолчанию dir = <repo>/memory/races
 */

const fs = require('fs');
const path = require('path');

/** Порядок проверяемых требований — фиксирован (важно для тестов). */
const REQUIRED_FIELDS = ['winner', 'duration_ms', 'agents'];

/** Причина для счётчика битого JSON в scan(). */
const REASON_BROKEN_JSON = 'broken_json';

// ---------------------------------------------------------------------------
// Примитивы
// ---------------------------------------------------------------------------

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function isPositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Список участников гонки: массив results[] либо массив agents[].
 * @returns {Array}
 */
function listAgents(obj) {
  if (!isObject(obj)) return [];
  if (Array.isArray(obj.results)) return obj.results;
  if (Array.isArray(obj.agents)) return obj.agents;
  return [];
}

/**
 * Число участников гонки.
 * Поддерживает results[]/agents[] (массивы) и числовое поле agents.
 * @returns {number}
 */
function countAgents(obj) {
  if (!isObject(obj)) return 0;
  if (Array.isArray(obj.results)) return obj.results.length;
  if (Array.isArray(obj.agents)) return obj.agents.length;
  if (typeof obj.agents === 'number' && Number.isFinite(obj.agents) && obj.agents > 0) {
    return Math.floor(obj.agents);
  }
  return 0;
}

function agentDuration(a) {
  if (!isObject(a)) return NaN;
  if (isPositiveNumber(a.duration_ms)) return a.duration_ms;
  if (isPositiveNumber(a.time_ms)) return a.time_ms;
  return NaN;
}

/**
 * Есть ли в протоколе хотя бы один положительный замер времени.
 */
function hasPositiveDuration(obj) {
  if (!isObject(obj)) return false;
  const agents = listAgents(obj);
  if (agents.some((a) => isPositiveNumber(agentDuration(a)))) return true;
  if (isPositiveNumber(obj.duration_ms)) return true;
  if (isPositiveNumber(obj.winner_time)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Публичный API
// ---------------------------------------------------------------------------

/**
 * Валидирует один протокол гонки.
 *
 * @param {*} obj — уже распарсенный объект протокола.
 * @returns {{ok: boolean, missing: string[]}}
 */
function validateRace(obj) {
  if (!isObject(obj)) {
    return { ok: false, missing: REQUIRED_FIELDS.slice() };
  }

  const satisfied = {
    winner: isNonEmptyString(obj.winner),
    duration_ms: hasPositiveDuration(obj),
    agents: countAgents(obj) >= 1,
  };

  const missing = REQUIRED_FIELDS.filter((k) => !satisfied[k]);
  return { ok: missing.length === 0, missing };
}

/**
 * Безопасно парсит JSON-строку протокола.
 *
 * @param {string} text
 * @returns {{ok: boolean, race: (*|null), error: (string|null)}}
 */
function parseRace(text) {
  if (typeof text !== 'string') {
    return { ok: false, race: null, error: 'not a string' };
  }
  try {
    return { ok: true, race: JSON.parse(text), error: null };
  } catch (e) {
    return { ok: false, race: null, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Читает и парсит файл протокола.
 *
 * @param {string} file
 * @returns {{ok: boolean, race: (*|null), error: (string|null), file: string}}
 */
function readRace(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, race: null, error: 'read: ' + (e && e.message ? e.message : e), file };
  }
  const parsed = parseRace(text);
  parsed.file = file;
  return parsed;
}

/**
 * Валидирует файл протокола целиком (чтение + парсинг + validateRace).
 *
 * @param {string} file
 * @returns {{ok: boolean, missing: string[], broken: boolean, error: (string|null), file: string}}
 */
function validateFile(file) {
  const parsed = readRace(file);
  if (!parsed.ok) {
    return {
      ok: false,
      missing: REQUIRED_FIELDS.slice(),
      broken: true,
      error: parsed.error,
      file,
    };
  }
  const v = validateRace(parsed.race);
  return { ok: v.ok, missing: v.missing, broken: false, error: null, file };
}

/**
 * Сканирует каталог с протоколами гонок и возвращает сводку.
 *
 * @param {string} dir
 * @returns {{dir: string, total: number, empty: number, valid: number,
 *            broken: number, noWinner: number, byReason: Object, error?: string}}
 */
function scan(dir) {
  const summary = {
    dir,
    total: 0,
    empty: 0,
    valid: 0,
    broken: 0,
    noWinner: 0,
    byReason: {},
  };

  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch (e) {
    summary.error = e && e.message ? e.message : String(e);
    return summary;
  }

  for (const name of files) {
    summary.total += 1;
    const parsed = readRace(path.join(dir, name));

    if (!parsed.ok) {
      summary.broken += 1;
      summary.empty += 1;
      summary.byReason[REASON_BROKEN_JSON] = (summary.byReason[REASON_BROKEN_JSON] || 0) + 1;
      continue;
    }

    const v = validateRace(parsed.race);
    if (v.ok) {
      summary.valid += 1;
      continue;
    }

    // Невалидный = «пустой» протокол.
    summary.empty += 1;
    for (const m of v.missing) {
      summary.byReason[m] = (summary.byReason[m] || 0) + 1;
    }
    if (v.missing.indexOf('winner') !== -1) summary.noWinner += 1;
  }

  return summary;
}

module.exports = {
  REQUIRED_FIELDS,
  validateRace,
  parseRace,
  readRace,
  validateFile,
  scan,
  // helpers (экспортируются для тестов/переиспользования)
  isObject,
  isNonEmptyString,
  isPositiveNumber,
  countAgents,
  hasPositiveDuration,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const dir = process.argv[2] || path.join(__dirname, '..', 'memory', 'races');
  const summary = scan(dir);
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}
