#!/usr/bin/env node
/**
 * evolution/mutation_logger.js — Журнал мутаций (Mutation Logger)
 * ============================================================================
 * Назначение:
 *   Единая точка записи и чтения мутаций агентов эволюции. Каждая мутация
 *   (изменение промпта, параметра, набора инструментов, весов и т.п.)
 *   сериализуется в одну строку JSON и дописывается в журнал
 *   `memory/mutations.jsonl` (формат JSON Lines — одна запись = одна строка).
 *
 *   Формат JSONL выбран намеренно:
 *     • append-only — запись атомарна и не перезаписывает историю;
 *     • потоковое чтение — можно читать гигабайты построчно;
 *     • дружелюбен к git-диффам и grep.
 *
 * Схема записи (нормализована):
 *   {
 *     id:         детерминированно-уникальный идентификатор записи,
 *     ts:         ISO-8601 время мутации,
 *     agentId:    идентификатор агента-мутанта (обязателен),
 *     type:       тип: prompt | param | grant | revoke | weight | gene | meta,
 *     gene:       название мутируемого гена/поля,
 *     from:       прежнее значение,
 *     to:         новое значение,
 *     reason:     текстовое обоснование (почему мутировали),
 *     generation: номер поколения (или null),
 *     fitness:    приспособленность на момент мутации (или null),
 *     meta:       произвольные дополнительные данные (объект),
 *   }
 *
 * Публичный API (модуль):
 *   - log(mutation)                -> record   записать мутацию, вернуть запись
 *   - logMany(mutations)           -> record[] записать пачку мутаций
 *   - history(agentId, options)    -> record[] история мутаций агента
 *   - historyAll(options)          -> record[] вся история (без фильтра агента)
 *   - latest(agentId, n)           -> record[] последние N мутаций агента
 *   - tail(n)                      -> record[] последние N записей журнала
 *   - count(agentId)               -> number   число мутаций агента
 *   - stats(agentId)               -> object   агрегированная статистика
 *   - byType(agentId, type)        -> record[] мутации заданного типа
 *   - replay(agentId)              -> object   свёртка истории в состояние генов
 *   - agents()                     -> string[] список агентов в журнале
 *   - clear(options)               -> number   очистка журнала (опц. по агенту)
 *   - configure(options)           -> config   настройка пути/часов/лимита
 *   - reset()                      -> module.exports  сброс конфигурации
 *
 * Время и файловая система инъектируются через configure({ now, fs }),
 * что делает модуль предсказуемым и пригодным для unit-тестов.
 *
 * CLI:
 *   node evolution/mutation_logger.js history <agentId>
 *   node evolution/mutation_logger.js tail 10
 *   node evolution/mutation_logger.js stats <agentId>
 * ----------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* -------------------------------------------------------------------------- */
/* Константы и конфигурация                                                    */
/* -------------------------------------------------------------------------- */

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_LOG_PATH = path.join(ROOT, 'memory', 'mutations.jsonl');

const MUTATION_TYPES = Object.freeze([
  'prompt',
  'param',
  'grant',
  'revoke',
  'weight',
  'gene',
  'meta',
  'unknown',
]);

const DEFAULTS = Object.freeze({
  logPath: DEFAULT_LOG_PATH,
  ensureDir: true,   // создавать каталог журнала автоматически
  limitLog: 0,       // 0 = без ограничения; N>0 = хранить последние N строк
  newestFirst: false,
  types: MUTATION_TYPES,
});

let config = Object.assign({}, DEFAULTS);
let _seq = 0;

/* -------------------------------------------------------------------------- */
/* Служебные помощники                                                         */
/* -------------------------------------------------------------------------- */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneConfig(c) {
  return Object.assign({}, c);
}

function nowIso() {
  if (typeof config.now === 'function') {
    try {
      return config.now();
    } catch (_) {
      /* fall back below */
    }
  }
  return new Date().toISOString();
}

function safeString(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch (_) {
    return '';
  }
}

function makeId() {
  _seq += 1;
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `mut_${t}_${_seq}_${r}`;
}

function fsModule() {
  return config.fs || fs;
}

function logPath() {
  return config.logPath || DEFAULT_LOG_PATH;
}

function ensureDir() {
  if (!config.ensureDir) return true;
  const dir = path.dirname(logPath());
  try {
    fsModule().mkdirSync(dir, { recursive: true });
    return true;
  } catch (_) {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Настройка модуля                                                            */
/* -------------------------------------------------------------------------- */

function configure(options) {
  if (isPlainObject(options)) {
    config = Object.assign({}, config, options);
  }
  return cloneConfig(config);
}

function reset() {
  config = Object.assign({}, DEFAULTS);
  _seq = 0;
  return module.exports;
}

/* -------------------------------------------------------------------------- */
/* Валидация и нормализация записи                                             */
/* -------------------------------------------------------------------------- */

function validate(mutation) {
  if (!isPlainObject(mutation)) {
    return 'mutation must be a plain object';
  }
  if (!mutation.agentId || typeof mutation.agentId !== 'string') {
    return 'mutation.agentId is required and must be a non-empty string';
  }
  return null;
}

function normalize(mutation, generation) {
  const record = {
    id: mutation.id || makeId(),
    ts: mutation.ts || mutation.timestamp || nowIso(),
    agentId: mutation.agentId,
    type: mutation.type || 'unknown',
    gene: mutation.gene !== undefined ? mutation.gene : (mutation.target || null),
    from: mutation.from !== undefined ? mutation.from : null,
    to: mutation.to !== undefined ? mutation.to : null,
    reason: safeString(mutation.reason !== undefined ? mutation.reason : mutation.reasoning),
    generation: typeof mutation.generation === 'number' ? mutation.generation : generation,
    fitness: typeof mutation.fitness === 'number' ? mutation.fitness : null,
    meta: isPlainObject(mutation.meta) ? mutation.meta : {},
  };

  // Сохраняем произвольные дополнительные поля, не перетирая канонические.
  for (const key of Object.keys(mutation)) {
    if (!(key in record)) record[key] = mutation[key];
  }
  return record;
}

/* -------------------------------------------------------------------------- */
/* Низкоуровневый доступ к файлу                                               */
/* -------------------------------------------------------------------------- */

function readLinesRaw() {
  const file = logPath();
  try {
    if (!fsModule().existsSync(file)) return [];
    const raw = fsModule().readFileSync(file, 'utf8');
    return raw.split('\n').filter((line) => line.trim().length > 0);
  } catch (_) {
    return [];
  }
}

function readAll() {
  const out = [];
  for (const line of readLinesRaw()) {
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      // Повреждённые строки пропускаем, но чтение продолжаем.
    }
  }
  return out;
}

function enforceLimit() {
  if (!config.limitLog || config.limitLog <= 0) return;
  const lines = readLinesRaw();
  if (lines.length <= config.limitLog) return;
  const keep = lines.slice(-config.limitLog);
  try {
    fsModule().writeFileSync(logPath(), keep.join('\n') + '\n', 'utf8');
  } catch (_) {
    /* не критично для append-only журнала */
  }
}

function appendRecord(record) {
  if (!ensureDir()) {
    throw new Error('mutation_logger: cannot create log directory');
  }
  fsModule().appendFileSync(logPath(), JSON.stringify(record) + '\n', 'utf8');
  enforceLimit();
}

function nextGeneration(agentId) {
  const all = readAll();
  let max = 0;
  for (const r of all) {
    if (r && r.agentId === agentId && typeof r.generation === 'number') {
      if (r.generation > max) max = r.generation;
    }
  }
  return max + 1;
}

/* -------------------------------------------------------------------------- */
/* Публичный API: запись                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Записать мутацию. Бросает TypeError, если agentId отсутствует.
 * @param {object} mutation
 * @returns {object} нормализованная запись
 */
function log(mutation) {
  const err = validate(mutation);
  if (err) {
    throw new TypeError('mutation_logger.log: ' + err);
  }
  const generation = nextGeneration(mutation.agentId);
  const record = normalize(mutation, generation);
  appendRecord(record);
  return record;
}

/**
 * Записать пачку мутаций.
 * @param {Array<object>} mutations
 * @returns {Array<object>} массив записанных записей
 */
function logMany(mutations) {
  if (!Array.isArray(mutations)) {
    throw new TypeError('mutation_logger.logMany: mutations must be an array');
  }
  const written = [];
  for (const mutation of mutations) {
    written.push(log(mutation));
  }
  return written;
}

// Обратная совместимость с ранними версиями модуля.
const logBatch = logMany;

/* -------------------------------------------------------------------------- */
/* Публичный API: чтение                                                       */
/* -------------------------------------------------------------------------- */

function history(agentId, options) {
  const opts = isPlainObject(options) ? options : {};
  let records = readAll().filter((r) => r && r.agentId === agentId);
  if (opts.type) {
    records = records.filter((r) => r.type === opts.type);
  }
  if (typeof opts.limit === 'number' && opts.limit >= 0) {
    records = records.slice(-opts.limit);
  }
  const newestFirst = opts.newestFirst !== undefined ? opts.newestFirst : config.newestFirst;
  if (newestFirst) records = records.slice().reverse();
  return records;
}

function historyAll(options) {
  const opts = isPlainObject(options) ? options : {};
  let records = readAll();
  if (opts.type) {
    records = records.filter((r) => r.type === opts.type);
  }
  if (opts.agentId) {
    records = records.filter((r) => r.agentId === opts.agentId);
  }
  if (typeof opts.limit === 'number' && opts.limit >= 0) {
    records = records.slice(-opts.limit);
  }
  if (opts.newestFirst) records = records.slice().reverse();
  return records;
}

function latest(agentId, n) {
  const limit = typeof n === 'number' && n > 0 ? n : 1;
  return history(agentId, { limit });
}

function tail(n) {
  const limit = typeof n === 'number' && n > 0 ? n : 10;
  return historyAll({ limit });
}

function count(agentId) {
  return history(agentId).length;
}

function byType(agentId, type) {
  return history(agentId, { type });
}

function agents() {
  const set = new Set();
  for (const r of readAll()) {
    if (r && typeof r.agentId === 'string') set.add(r.agentId);
  }
  return Array.from(set);
}

function stats(agentId) {
  const records = history(agentId);
  const types = {};
  const genes = {};
  for (const r of records) {
    const t = r.type || 'unknown';
    types[t] = (types[t] || 0) + 1;
    if (r.gene) genes[r.gene] = (genes[r.gene] || 0) + 1;
  }
  return {
    agentId,
    total: records.length,
    types,
    genes,
    first: records.length ? records[0].ts : null,
    last: records.length ? records[records.length - 1].ts : null,
  };
}

/**
 * Свернуть хронологию мутаций агента в итоговое состояние генов.
 * grant добавляет значения в набор, revoke — удаляет,
 * прочие типы присваивают state[gene] = to.
 */
function replay(agentId) {
  const records = history(agentId);
  const state = {};
  for (const r of records) {
    const gene = r.gene;
    if (!gene) continue;
    const asList = (v) => (Array.isArray(v) ? v : [v]);
    if (r.type === 'grant') {
      const set = new Set(Array.isArray(state[gene]) ? state[gene] : []);
      for (const v of asList(r.to)) if (v !== null && v !== undefined) set.add(v);
      state[gene] = Array.from(set);
    } else if (r.type === 'revoke') {
      const set = new Set(Array.isArray(state[gene]) ? state[gene] : []);
      for (const v of asList(r.to)) set.delete(v);
      state[gene] = Array.from(set);
    } else {
      state[gene] = r.to;
    }
  }
  return { agentId, records, state };
}

/* -------------------------------------------------------------------------- */
/* Публичный API: очистка                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Очистить журнал. clear({ agentId }) удаляет только записи агента.
 * @returns {number} число удалённых записей
 */
function clear(options) {
  const opts = isPlainObject(options) ? options : {};
  const all = readAll();
  let keep;
  if (opts.agentId) {
    keep = all.filter((r) => r.agentId !== opts.agentId);
  } else {
    keep = [];
  }
  const removed = all.length - keep.length;
  if (!ensureDir()) {
    throw new Error('mutation_logger: cannot create log directory');
  }
  const body = keep.length ? keep.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
  fsModule().writeFileSync(logPath(), body, 'utf8');
  return removed;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

function runCli(argv) {
  const [cmd, arg] = argv;
  switch (cmd) {
    case 'history':
      return history(arg || '');
    case 'all':
      return historyAll();
    case 'tail':
      return tail(Number(arg) || 10);
    case 'stats':
      return stats(arg || '');
    case 'agents':
      return agents();
    case 'replay':
      return replay(arg || '');
    default:
      return { usage: 'history <agentId> | all | tail <n> | stats <agentId> | agents | replay <agentId>' };
  }
}

/* -------------------------------------------------------------------------- */
/* Экспорт                                                                     */
/* -------------------------------------------------------------------------- */

module.exports = {
  log,
  logMany,
  logBatch,
  history,
  historyAll,
  latest,
  tail,
  count,
  stats,
  byType,
  replay,
  agents,
  clear,
  configure,
  reset,
  MUTATION_TYPES,
  DEFAULT_LOG_PATH,
  runCli,
};

if (require.main === module) {
  const out = runCli(process.argv.slice(2));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2));
}
