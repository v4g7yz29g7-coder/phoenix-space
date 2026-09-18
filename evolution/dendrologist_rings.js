'use strict';

/**
 * evolution/dendrologist_rings.js
 * ============================================================================
 * ДЕНДРОЛОГ КОЛЕЦ ДНК (Dendrologist DNA Rings) — «годовые кольца» агента.
 * ----------------------------------------------------------------------------
 * Дендрохронология восстанавливает историю дерева по его спилу: каждое кольцо
 * — один сезон роста, а его ширина и плотность кодируют условия, в которых
 * дерево росло. Этот модуль переносит ту же метафору на агента роя эволюции:
 * генетическая история агента представлена набором концентрических колец ДНК.
 *
 *   • сердцевина (core, index 0) — самый ранний «сезон» агента;
 *   • кора (bark, index N-1)    — самый свежий сезон, текущее состояние;
 *   • ширина кольца (width)     — интенсивность роста за сезон;
 *   • плотность (density)       — качество/структурность роста;
 *   • события (events/marker)   — мутации и переломы (морозобоины).
 *
 * Публичный API (обязательный контракт):
 *   const D = require('./evolution/dendrologist_rings.js');
 *
 *   D.rings(agentId, [opts])   -> { ok:true, agentId, rings:[...], age, count, ... }
 *   D.peaks(agentId, [opts])   -> { ok:true, agentId, peaks:[...], count, ... }
 *
 * Расширения:
 *   D.summary(agentId)         — компактная сводка по спилу
 *   D.depth(agentId)           — глубина (число колец) агента
 *   D.ringAt(agentId, index)   — одно конкретное кольцо (срез)
 *   D.render(agentId)          — ASCII-визуализация поперечного среза
 *   D.registerAgent(id, spec)  — зарегистрировать/обновить агента
 *   D.fromHistory(id, hist)    — построить агента из журнала сезонов
 *   D.listAgents() / D.clear() — реестр агентов
 *
 * Гарантии:
 *   • чистый JavaScript, ноль внешних зависимостей;
 *   • проходит `node --check`;
 *   • детерминирован: один и тот же agentId -> идентичные кольца (без Date.now);
 *   • вход НЕ мутируется;
 *   • `age === rings.length` и `count === peaks.length` всегда;
 *   • устойчив к пустым/битым данным — всегда синтезирует корректный спил;
 *   • для пустого/нулевого agentId бросает TypeError.
 * ============================================================================
 */

const VERSION = '2.0.0';

/** Опции чтения спила. */
const DEFAULTS = Object.freeze({
  maxRings: 64,        // потолок числа колец для одного агента
  minRings: 3,         // минимум колец, даже для «молодого» агента
  baseWidth: 1.0,      // базовая ширина кольца до модуляции ростом
  noise: 0.18,         // амплитуда синтетического шума (0..1)
  peakThreshold: 0.5,  // порог пика в единицах стандартного отклонения
  metric: 'width',     // 'width' | 'density' | 'growth' | 'tempo' | 'score'
});

/** Оси «генома» агента для снимка кольца. */
const TRAIT_AXES = Object.freeze([
  'vigor',        // сила роста / продуктивность
  'resilience',   // восстановление после стресса
  'cooperation',  // готовность к симбиозу
  'creativity',   // генерация новых стратегий
  'stability',    // консерватизм, устойчивость к шуму
  'curiosity',    // исследовательское поведение
]);

/** Возможные «породы» (архетипы) агента. */
const SPECIES = Object.freeze([
  'pine', 'oak', 'sequoia', 'birch', 'willow', 'cedar', 'larch', 'yew',
]);

/** Метки стрессовых событий, оставляющих морозобоину в кольце. */
const STRESS_MARKERS = Object.freeze([
  'context_overflow',
  'tool_failure',
  'timeout',
  'rollback',
  'contradiction',
  'memory_loss',
  'rate_limit',
  'hallucination',
]);

/** Словарь навыков, проявляющихся в сезоне. */
const SKILL_VOCAB = Object.freeze([
  'planning',
  'retrieval',
  'tool_use',
  'reflection',
  'summarization',
  'negotiation',
  'code_gen',
  'verification',
  'delegation',
  'abstraction',
  'orchestration',
  'calibration',
]);

// --------------------------------------------------------------------------- //
// Утилиты                                                                     //
// --------------------------------------------------------------------------- //

/** Привести id к непустой строке; иначе — TypeError. */
function toId(value) {
  if (value === null || value === undefined) {
    throw new TypeError('dendrologist_rings: agentId must not be null/undefined');
  }
  const s = String(value).trim();
  if (s.length === 0) {
    throw new TypeError('dendrologist_rings: agentId must be a non-empty string');
  }
  return s;
}

/** Детерминированный 32-битный хеш строки (FNV-1a). */
function hashCode(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Быстрый детерминированный PRNG (mulberry32). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** PRNG, привязанный к (agentId, salt) — воспроизводимый по построению. */
function rngFor(agentId, salt) {
  return mulberry32(hashCode(`${agentId}::${salt}`));
}

function clamp(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

function round(x, digits = 4) {
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let acc = 0;
  for (const v of arr) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (arr.length - 1));
}

function max(arr) {
  let m = -Infinity;
  for (const v of arr) if (v > m) m = v;
  return arr.length ? m : 0;
}

function min(arr) {
  let m = Infinity;
  for (const v of arr) if (v < m) m = v;
  return arr.length ? m : 0;
}

/** Нормализовать произвольный набор чисел в [0,1]. */
function normalizeSeries(arr) {
  if (!arr.length) return [];
  const lo = min(arr);
  const hi = max(arr);
  const span = hi - lo;
  if (span <= 1e-12) return arr.map(() => 0.5);
  return arr.map((v) => (v - lo) / span);
}

// --------------------------------------------------------------------------- //
// Реестр агентов                                                              //
// --------------------------------------------------------------------------- //

/** id -> запись агента { id, traits, history } */
const REGISTRY = new Map();

/**
 * Зарегистрировать агента.
 * @param {string} id
 * @param {object} [spec]
 * @param {object} [spec.traits]  числовые признаки по осям TRAIT_AXES
 * @param {Array}  [spec.history] журнал сезонов: [{ score, traits?, events? }]
 */
function registerAgent(id, spec = {}) {
  const key = toId(id);

  const traits = {};
  if (spec.traits && typeof spec.traits === 'object') {
    for (const axis of Object.keys(spec.traits)) {
      const v = Number(spec.traits[axis]);
      if (Number.isFinite(v)) traits[axis] = clamp(v, 0, 1);
    }
  }

  const history = Array.isArray(spec.history)
    ? spec.history
        .filter((h) => h && typeof h === 'object')
        .map((h) => ({
          score: Number.isFinite(Number(h.score)) ? clamp(Number(h.score), 0, 1) : null,
          traits: h.traits && typeof h.traits === 'object' ? { ...h.traits } : null,
          events: Array.isArray(h.events) ? h.events.map(String) : [],
          label: h.label != null ? String(h.label) : null,
        }))
    : [];

  const record = { id: key, traits, history };
  REGISTRY.set(key, record);
  return record;
}

/** Построить агента из журнала сезонов (сахар над registerAgent). */
function fromHistory(id, history, traits = {}) {
  return registerAgent(id, { history, traits });
}

function listAgents() {
  return [...REGISTRY.keys()];
}

function clear() {
  REGISTRY.clear();
}

/** Попытаться взять агента из внешнего реестра (global.AgentRegistry). */
function lookupExternal(agentId) {
  try {
    const ext = (typeof global !== 'undefined' && global.AgentRegistry) || null;
    if (!ext) return null;
    if (typeof ext.get === 'function') {
      const a = ext.get(agentId);
      if (a && typeof a === 'object') return a;
    }
    if (ext.agents && typeof ext.agents.get === 'function') {
      return ext.agents.get(agentId) || null;
    }
    if (ext.agents && typeof ext.agents === 'object') {
      return ext.agents[agentId] || null;
    }
  } catch (_) {
    /* внешний реестр необязателен */
  }
  return null;
}

/**
 * Разрешить агента: сначала локальный реестр, затем внешний, затем — синтез
 * стабильной записи по id (чтобы модуль всегда работал автономно).
 */
function resolveAgent(agentId) {
  const key = toId(agentId);

  let source = 'synthetic';
  let spec = { traits: {}, history: [] };

  if (REGISTRY.has(key)) {
    source = 'registry';
    spec = REGISTRY.get(key);
  } else {
    const ext = lookupExternal(key);
    if (ext) {
      source = 'external';
      spec = registerAgent(key, {
        traits: ext.traits || ext.genome || ext.scores || {},
        history: ext.history || ext.seasons || [],
      });
    }
  }

  const core = readCore(key, spec);
  return { key, source, core, traits: { ...spec.traits }, history: spec.history };
}

// --------------------------------------------------------------------------- //
// Сердцевина и кольца                                                         //
// --------------------------------------------------------------------------- //

/**
 * Считать сердцевину агента: возраст (число колец), породу и потенциал.
 * Если у агента есть журнал сезонов — возраст берётся из него (с зажимом).
 */
function readCore(agentId, spec = {}) {
  const key = toId(agentId);
  const rnd = rngFor(key, 'core');

  const span = DEFAULTS.maxRings - DEFAULTS.minRings + 1;
  let age = DEFAULTS.minRings + Math.floor(rnd() * span);
  if (Array.isArray(spec.history) && spec.history.length > 0) {
    age = clamp(spec.history.length, DEFAULTS.minRings, DEFAULTS.maxRings);
  }

  const species =
    SPECIES[Math.floor(rnd() * SPECIES.length) % SPECIES.length];
  const potential = clamp(0.35 + rnd() * 0.65, 0, 1);

  return {
    agentId: key,
    age,
    species,
    potential,
    seed: hashCode(key),
  };
}

/** Снять признаки агента из traits/истории в единый вектор [0,1]. */
function traitVector(traits, history, index) {
  const vec = {};
  const snap = history && history[index] && history[index].traits;

  for (const axis of TRAIT_AXES) {
    let v = 0.5;
    if (traits && Number.isFinite(Number(traits[axis]))) v = Number(traits[axis]);
    else if (snap && Number.isFinite(Number(snap[axis]))) v = Number(snap[axis]);
    vec[axis] = clamp(v, 0, 1);
  }
  return vec;
}

/**
 * Построить одно годовое кольцо на позиции `index`.
 * index 0 — сердцевина (древнее), index N-1 — кора (свежее).
 */
function buildRing(core, index, prev, rnd, traits, history) {
  const ageSpan = Math.max(1, core.age - 1);
  const progress = index / ageSpan;              // 0..1 от сердцевины к коре
  const climate = rnd();                          // «погода» сезона
  const tv = traitVector(traits, history, index);

  const growthBias = 0.6 + progress * 0.8;
  const noise = (rnd() - 0.5) * 2 * DEFAULTS.noise;

  const width = clamp(
    DEFAULTS.baseWidth *
      (0.5 + rnd() * 0.7) *
      growthBias *
      (0.6 + core.potential * 0.6) *
      (1 + tv.vigor * 0.4 + noise - tv.stability * 0.1),
    0.05,
    3.0
  );

  const density = clamp(0.25 + rnd() * 0.6 + tv.stability * 0.2, 0, 1);
  const xylem = clamp(width * density, 0, 3);        // древесина сезона
  const phloem = clamp(width * (1 - density), 0, 3); // луб сезона

  const skills = [];
  const skillCount = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < skillCount; i++) {
    const name = SKILL_VOCAB[Math.floor(rnd() * SKILL_VOCAB.length)];
    if (!skills.includes(name)) skills.push(name);
  }

  const events = [];
  const stressRoll = rnd();
  const frost = stressRoll < 0.15 - tv.resilience * 0.08;
  let marker = null;
  if (frost) {
    marker = STRESS_MARKERS[Math.floor(rnd() * STRESS_MARKERS.length)];
    events.push(marker);
  }
  if (history && history[index] && Array.isArray(history[index].events)) {
    for (const e of history[index].events) if (!events.includes(e)) events.push(e);
  }

  const increment = clamp(
    width * 0.45 +
      density * 0.35 +
      tv.resilience * 0.15 -
      (frost ? 0.3 : 0),
    0,
    2
  );
  const cumulative = (prev ? prev.cumulative : 0) + increment;
  const tempo = clamp(climate * width * 2, 0, 3);
  const score = clamp(width * 0.5 + density * 0.5 - (frost ? 0.2 : 0), 0, 1);

  return {
    id: `${core.agentId}#ring-${index}`,
    index,
    age: core.age - index,          // «лет на момент сезона»
    width: round(width, 4),
    density: round(density, 4),
    climate: round(climate, 4),
    xylem: round(xylem, 4),
    phloem: round(phloem, 4),
    growth: round(increment, 4),
    cumulative: round(cumulative, 4),
    tempo: round(tempo, 4),
    score: round(score, 4),
    frost,
    marker,
    events,
    skills,
    traits: {
      vigor: round(tv.vigor, 3),
      resilience: round(tv.resilience, 3),
      stability: round(tv.stability, 3),
      cooperation: round(tv.cooperation, 3),
      creativity: round(tv.creativity, 3),
      curiosity: round(tv.curiosity, 3),
    },
  };
}

/**
 * Оценка здоровья дерева по кольцам: плотность, морозобоины, стабильность.
 */
function assessHealth(layers) {
  if (!layers.length) {
    return { score: 0, verdict: 'dead', frostCount: 0, stability: 0, avgDensity: 0 };
  }
  const frostCount = layers.filter((r) => r.frost).length;
  const avgDensity = mean(layers.map((r) => r.density));
  const widths = layers.map((r) => r.width);
  const stability = clamp(1 - stddev(widths), 0, 1);
  const score = clamp(avgDensity * 0.5 + stability * 0.5 - frostCount * 0.03, 0, 1);

  let verdict = 'thriving';
  if (score < 0.35) verdict = 'struggling';
  if (score < 0.2) verdict = 'declining';
  if (frostCount > layers.length * 0.5) verdict = 'scarred';

  return {
    score: round(score, 4),
    verdict,
    frostCount,
    stability: round(stability, 4),
    avgDensity: round(avgDensity, 4),
  };
}

// --------------------------------------------------------------------------- //
// Публичный API                                                               //
// --------------------------------------------------------------------------- //

/**
 * rings(agentId) — считать все доступные кольца агента от сердцевины к коре.
 * Гарантирует `age === rings.length` и непустой массив колец.
 * @returns {{ok:boolean, agentId:string, age:number, count:number, rings:Array, ...}}
 */
function rings(agentId, opts = {}) {
  const key = toId(agentId); // пустой id -> TypeError
  const cfg = { ...DEFAULTS, ...(opts && typeof opts === 'object' ? opts : {}) };
  const resolved = resolveAgent(key);
  const core = resolved.core;

  const layers = [];
  let prev = null;
  const total = clamp(core.age, cfg.minRings, cfg.maxRings);

  for (let index = 0; index < total; index++) {
    const rnd = rngFor(key, `ring:${index}`);
    const ring = buildRing(core, index, prev, rnd, resolved.traits, resolved.history);
    layers.push(ring);
    prev = ring;
  }

  const bark = layers[layers.length - 1] || null;
  const health = assessHealth(layers);

  return {
    ok: true,
    agentId: key,
    version: VERSION,
    source: resolved.source,
    species: core.species,
    potential: round(core.potential, 4),
    seed: core.seed,
    age: layers.length,       // контракт: age === rings.length
    count: layers.length,
    depth: layers.length,
    rings: layers,
    bark,
    cambium: bark,           // синоним активного слоя
    totalGrowth: bark ? bark.cumulative : 0,
    health,
    traits: { ...resolved.traits },
  };
}

/**
 * peaks(agentId) — климатические оптимумы: сезоны аномально быстрого роста.
 * Гарантирует `count === peaks.length`.
 * @returns {{ok:boolean, agentId:string, metric:string, peaks:Array, count:number, ...}}
 */
function peaks(agentId, opts = {}) {
  const key = toId(agentId);
  const cfg = { ...DEFAULTS, ...(opts && typeof opts === 'object' ? opts : {}) };
  const metric = typeof cfg.metric === 'string' ? cfg.metric : 'width';

  const sample = rings(key, cfg);
  const layers = sample.rings;

  const values = layers.map((r) => (Number.isFinite(r[metric]) ? r[metric] : r.width));
  const m = mean(values);
  const sd = stddev(values);
  const threshold = m + sd * cfg.peakThreshold;

  const list = layers
    .map((r, i) => ({ ring: r, value: values[i] }))
    .filter((row) => row.value >= threshold)
    .map((row) => ({
      id: row.ring.id,
      index: row.ring.index,
      age: row.ring.age,
      metric,
      value: round(row.value, 4),
      width: row.ring.width,
      density: row.ring.density,
      tempo: row.ring.tempo,
      magnitude: round((row.value - m) / (sd || 1), 4),
      skills: row.ring.skills.slice(),
    }))
    .sort((a, b) => (b.magnitude - a.magnitude) || (a.index - b.index));

  const goldenAge = list[0] || null;

  return {
    ok: true,
    agentId: key,
    metric,
    mean: round(m, 4),
    stddev: round(sd, 4),
    threshold: round(threshold, 4),
    count: list.length,      // контракт: count === peaks.length
    peaks: list,
    goldenAge: goldenAge
      ? { index: goldenAge.index, age: goldenAge.age, magnitude: goldenAge.magnitude }
      : null,
  };
}

/** summary(agentId) — компактная сводка по спилу агента. */
function summary(agentId) {
  const sample = rings(agentId);
  const pk = peaks(agentId);
  const widths = sample.rings.map((r) => r.width);
  const frostCount = sample.rings.filter((r) => r.frost).length;

  // Тренд: сравнение среднего прироста кора/2 со средним сердцевиной.
  const half = Math.max(1, Math.floor(sample.rings.length / 2));
  const early = sample.rings.slice(0, half).map((r) => r.growth);
  const late = sample.rings.slice(-half).map((r) => r.growth);
  const trendDelta = mean(late) - mean(early);
  const trend = trendDelta > 0.05 ? 'up' : (trendDelta < -0.05 ? 'down' : 'flat');

  return {
    ok: true,
    agentId: sample.agentId,
    species: sample.species,
    age: sample.age,
    depth: sample.depth,
    health: sample.health,
    totalGrowth: sample.totalGrowth,
    meanWidth: round(mean(widths), 4),
    minWidth: round(min(widths), 4),
    maxWidth: round(max(widths), 4),
    frostCount,
    peakCount: pk.count,
    goldenAge: pk.goldenAge,
    trend,
  };
}

/** depth(agentId) — глубина агента (число колец в спиле). */
function depth(agentId) {
  return rings(agentId).age;
}

/** ringAt(agentId, index) — одно конкретное кольцо по индексу. */
function ringAt(agentId, index) {
  const sample = rings(agentId);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= sample.rings.length) {
    return { ok: false, agentId: sample.agentId, index: i, ring: null,
             reason: 'index out of range' };
  }
  return { ok: true, agentId: sample.agentId, index: i, ring: sample.rings[i] };
}

/** render(agentId) — ASCII-визуализация поперечного среза спила. */
function render(agentId) {
  const sample = rings(agentId);
  const norm = normalizeSeries(sample.rings.map((r) => r.width));
  const glyphs = ' .:-=+*#%@';
  const lines = [];

  lines.push(`СПИЛ ${sample.agentId} [${sample.species}] age=${sample.age}`);
  for (let i = sample.rings.length - 1; i >= 0; i--) {
    const r = sample.rings[i];
    const n = clamp(Math.round(norm[i] * 9), 0, 9);
    const bar = glyphs[n].repeat(2 + n * 2);
    const flag = r.frost ? ` !${r.marker}` : '';
    lines.push(
      `#${String(r.index).padStart(2, '0')} |${bar}` +
      ` w=${r.width.toFixed(3)} d=${r.density.toFixed(3)}${flag}`
    );
  }
  lines.push(`health=${sample.health.verdict} score=${sample.health.score}`);
  return lines.join('\n');
}

// --------------------------------------------------------------------------- //
// Экспорт                                                                     //
// --------------------------------------------------------------------------- //

module.exports = {
  VERSION,
  DEFAULTS,
  TRAIT_AXES,
  // обязательный контракт
  rings,
  peaks,
  // расширения
  summary,
  depth,
  ringAt,
  render,
  registerAgent,
  fromHistory,
  listAgents,
  clear,
  // внутренности для тестов и соседних модулей
  _internals: {
    toId,
    hashCode,
    mulberry32,
    readCore,
    buildRing,
    assessHealth,
    traitVector,
    normalizeSeries,
  },
};
