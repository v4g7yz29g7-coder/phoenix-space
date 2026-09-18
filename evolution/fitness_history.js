'use strict';

/**
 * evolution/fitness_history.js — История приспособленности (fitness history)
 * ============================================================================
 * Назначение:
 *   Ведёт хронологию значений fitness для каждого агента и умеет отвечать
 *   на два вопроса:
 *     - history(agentId) — что было с конкретным агентом: все замеры,
 *       описательная статистика и направление динамики;
 *     - trends()         — что происходит со всей популяцией: кто растёт,
 *       кто деградирует, куда движется средний fitness.
 *
 *   Модуль намеренно zero-deps и детерминирован. Данные хранятся в памяти
 *   и опционально зеркалятся в JSONL-файл (`state/fitness_history.jsonl`),
 *   если того требует конфигурация. Внешние источники (EverOS / global
 *   FitnessStore / AgentRegistry) подхватываются, если доступны.
 *
 * Публичный API:
 *   history(agentId, options) -> {
 *     agentId, count, first, last, min, max, mean, median, stddev,
 *     delta, slope, direction, best, worst, entries, sparkline, window
 *   }
 *
 *   trends(options) -> {
 *     generatedAt, agents: [...], overall: {...},
 *     improving: [...], declining: [...], stable: [...],
 *     best, worst, window
 *   }
 *
 * Вспомогательное (не требуется критерием, но полезно):
 *   record(agentId, fitness, meta) -> entry
 *   recordMany(agentId, points)    -> entry[]
 *   latest(agentId)                -> entry | null
 *   agents()                       -> string[]
 *   reset()                        -> this
 *   configure(options)             -> config
 *
 * Направления динамики: 'improving' | 'declining' | 'stable'.
 * ----------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

/* -------------------------------------------------------------------------- */
/* Конфигурация                                                               */
/* -------------------------------------------------------------------------- */

const DEFAULTS = Object.freeze({
  // Минимальный наклон линейного тренда, чтобы движение считалось значимым.
  slopeEpsilon: 0.01,
  // Размер скользящего окна для сглаживания и оценки тренда.
  window: 5,
  // Сколько первых/последних точек учитывать при расчёте дельты.
  edgeSpan: 3,
  // Каталог/файл для персистентности. null — не писать на диск.
  storeFile: process.env.FITNESS_HISTORY_FILE || null,
  // Загружать ли историю с диска лениво при первом обращении.
  autoLoad: true,
  // Ограничение на размер возвращаемых entries (0 — без ограничения).
  maxEntries: 0,
});

const DIRECTION = Object.freeze({
  IMPROVING: 'improving',
  DECLINING: 'declining',
  STABLE: 'stable',
});

/* -------------------------------------------------------------------------- */
/* Внутреннее состояние модуля                                                */
/* -------------------------------------------------------------------------- */

let config = Object.assign({}, DEFAULTS);

// agentId -> [{ ts, fitness, generation, reason, meta }]
const STORE = new Map();
let loaded = false;

/* -------------------------------------------------------------------------- */
/* Утилиты                                                                    */
/* -------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function safeNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, digits = 4) {
  if (!Number.isFinite(v)) return null;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

function mean(arr) {
  if (!arr.length) return null;
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let acc = 0;
  for (const x of arr) acc += (x - m) * (x - m);
  return Math.sqrt(acc / (arr.length - 1));
}

/**
 * Метод наименьших квадратов: наклон прямой y = a + b*x.
 * Возвращает b (наклон) для массива значений, x = 0..n-1.
 */
function linearSlope(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = mean(arr);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (arr[i] - ym);
    den += (i - xm) * (i - xm);
  }
  return den === 0 ? 0 : num / den;
}

function ema(arr, span) {
  if (!arr.length) return null;
  const k = 2 / (span + 1);
  let prev = arr[0];
  for (let i = 1; i < arr.length; i++) prev = arr[i] * k + prev * (1 - k);
  return prev;
}

function directionOf(slope, epsilon) {
  if (slope > epsilon) return DIRECTION.IMPROVING;
  if (slope < -epsilon) return DIRECTION.DECLINING;
  return DIRECTION.STABLE;
}

function sparkline(values) {
  const glyphs = '▁▂▃▄▅▆▇█';
  if (!values.length) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v) => glyphs[clamp(Math.round(((v - min) / span) * (glyphs.length - 1)), 0, glyphs.length - 1)])
    .join('');
}

/* -------------------------------------------------------------------------- */
/* Нормализация точки и запись                                                */
/* -------------------------------------------------------------------------- */

function normalizePoint(agentId, point) {
  if (typeof point === 'number') {
    return { agentId, ts: nowIso(), fitness: point, generation: null, reason: null, meta: {} };
  }
  if (!point || typeof point !== 'object') return null;
  const fitness = safeNumber(point.fitness, safeNumber(point.score, null));
  if (fitness === null) return null;
  return {
    agentId,
    ts: point.ts || point.timestamp || nowIso(),
    fitness,
    generation: safeNumber(point.generation, null),
    reason: point.reason || null,
    meta: point.meta && typeof point.meta === 'object' ? point.meta : {},
  };
}

function record(agentId, fitness, meta = {}) {
  if (!agentId) throw new Error('fitness_history: agentId is required');
  const point = fitness && typeof fitness === 'object'
    ? Object.assign({}, fitness, meta)          // точка-объект: { fitness, ts, ... }
    : Object.assign({ fitness }, meta);         // число + метаданные
  const entry = normalizePoint(agentId, point);
  if (!entry) throw new Error('fitness_history: fitness must be numeric');
  if (!STORE.has(agentId)) STORE.set(agentId, []);
  STORE.get(agentId).push(entry);
  persist(entry);
  return entry;
}

function recordMany(agentId, points = []) {
  const out = [];
  for (const p of points) {
    const entry = normalizePoint(agentId, p);
    if (!entry) continue;
    if (!STORE.has(agentId)) STORE.set(agentId, []);
    STORE.get(agentId).push(entry);
    persist(entry);
    out.push(entry);
  }
  return out;
}

function ensureLoaded() {
  if (loaded || !config.autoLoad) return;
  loaded = true;
  const file = config.storeFile;
  if (!file) return;
  try {
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && entry.agentId && Number.isFinite(Number(entry.fitness))) {
          if (!STORE.has(entry.agentId)) STORE.set(entry.agentId, []);
          STORE.get(entry.agentId).push(entry);
        }
      } catch (_) { /* пропускаем битые строки */ }
    }
  } catch (_) { /* нет доступа — работаем в памяти */ }
}

function persist(entry) {
  const file = config.storeFile;
  if (!file) return;
  try {
    const dir = path.dirname(file);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (_) { /* персистентность необязательна */ }
}

/* -------------------------------------------------------------------------- */
/* Публичный API                                                              */
/* -------------------------------------------------------------------------- */

/**
 * history(agentId, options) — хронология и статистика по агенту.
 */
function history(agentId, options = {}) {
  ensureLoaded();
  const window = Math.max(1, safeNumber(options.window, config.window));
  const raw = STORE.get(agentId) || [];
  const entries = raw.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));

  if (!entries.length) {
    return {
      agentId,
      count: 0,
      first: null,
      last: null,
      min: null,
      max: null,
      mean: null,
      median: null,
      stddev: null,
      delta: null,
      slope: 0,
      direction: DIRECTION.STABLE,
      best: null,
      worst: null,
      entries: [],
      sparkline: '',
      window,
    };
  }

  const values = entries.map((e) => e.fitness);
  const lastValues = values.slice(-window);
  const slope = linearSlope(lastValues);
  const edge = Math.max(1, Math.min(config.edgeSpan, Math.floor(values.length / 2) || 1));
  const headAvg = mean(values.slice(0, edge));
  const tailAvg = mean(values.slice(-edge));
  const delta = tailAvg - headAvg;

  let best = entries[0];
  let worst = entries[0];
  for (const e of entries) {
    if (e.fitness > best.fitness) best = e;
    if (e.fitness < worst.fitness) worst = e;
  }

  const limited = config.maxEntries > 0 ? entries.slice(-config.maxEntries) : entries;

  return {
    agentId,
    count: entries.length,
    first: { ts: entries[0].ts, fitness: entries[0].fitness },
    last: { ts: entries[entries.length - 1].ts, fitness: entries[entries.length - 1].fitness },
    min: Math.min(...values),
    max: Math.max(...values),
    mean: round(mean(values)),
    median: round(median(values)),
    stddev: round(stddev(values)),
    delta: round(delta),
    slope: round(slope, 6),
    direction: directionOf(slope, config.slopeEpsilon),
    ema: round(ema(lastValues, window)),
    best: { ts: best.ts, fitness: best.fitness, generation: best.generation },
    worst: { ts: worst.ts, fitness: worst.fitness, generation: worst.generation },
    entries: limited,
    sparkline: sparkline(values.slice(-Math.max(window, 20))),
    window,
  };
}

/**
 * trends(options) — сводный тренд по всей популяции агентов.
 */
function trends(options = {}) {
  ensureLoaded();
  const window = Math.max(1, safeNumber(options.window, config.window));
  const ids = Array.from(STORE.keys()).sort();

  const agents = ids.map((id) => {
    const h = history(id, { window });
    return {
      agentId: id,
      count: h.count,
      last: h.last ? h.last.fitness : null,
      mean: h.mean,
      slope: h.slope,
      delta: h.delta,
      direction: h.direction,
      sparkline: h.sparkline,
    };
  });

  const improving = agents.filter((a) => a.direction === DIRECTION.IMPROVING)
    .sort((a, b) => b.slope - a.slope);
  const declining = agents.filter((a) => a.direction === DIRECTION.DECLINING)
    .sort((a, b) => a.slope - b.slope);
  const stable = agents.filter((a) => a.direction === DIRECTION.STABLE);

  const lasts = agents.map((a) => a.last).filter((v) => v !== null);
  const means = agents.map((a) => a.mean).filter((v) => v !== null);
  const overallMean = mean(means);
  const popSlope = linearSlope(
    agents.map((a) => a.last).filter((v) => v !== null)
  );

  const ranked = agents.filter((a) => a.last !== null).sort((a, b) => b.last - a.last);

  return {
    generatedAt: nowIso(),
    window,
    agentCount: agents.length,
    observationCount: agents.reduce((s, a) => s + a.count, 0),
    agents,
    overall: {
      mean: round(overallMean),
      lastMean: round(mean(lasts)),
      min: lasts.length ? Math.min(...lasts) : null,
      max: lasts.length ? Math.max(...lasts) : null,
      slope: round(popSlope, 6),
      direction: directionOf(popSlope, config.slopeEpsilon),
      improving: improving.length,
      declining: declining.length,
      stable: stable.length,
    },
    improving,
    declining,
    stable,
    best: ranked.length ? ranked[0] : null,
    worst: ranked.length ? ranked[ranked.length - 1] : null,
  };
}

function latest(agentId) {
  ensureLoaded();
  const arr = STORE.get(agentId);
  return arr && arr.length ? arr[arr.length - 1] : null;
}

function agents() {
  ensureLoaded();
  return Array.from(STORE.keys()).sort();
}

function reset() {
  STORE.clear();
  loaded = false;
  return module.exports;
}

function configure(options = {}) {
  config = Object.assign({}, config, options);
  return config;
}

module.exports = {
  history,
  trends,
  record,
  recordMany,
  latest,
  agents,
  reset,
  configure,
  // экспорт внутренних утилит — удобно для тестов и повторного использования
  _internals: { mean, median, stddev, linearSlope, ema, sparkline, directionOf },
  DIRECTION,
  DEFAULTS,
};
