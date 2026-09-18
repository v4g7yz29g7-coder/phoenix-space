#!/usr/bin/env node
'use strict';

/**
 * evolution/niche_finder.js — Поиск нишей (Niche Finder)
 * ============================================================================
 * Назначение:
 *   Модуль исследует экосистему агентов и находит свободные или недозаполненные
 *   экологические ниши. В отличие от biologist_taxonomy.js (который лишь
 *   классифицирует агента по уже существующей нише), Niche Finder моделирует
 *   «ландшафт возможностей»: сколько ниш занято, насколько они насыщены, где
 *   конкуренция высока, а где есть ресурсный зазор — то есть куда стоит
 *   направлять размножение и мутации новых агентов.
 *
 *   Конвейер:
 *     1. Нормализация популяции агентов (registry / agents.json / аргумент).
 *     2. Токенизация признаков и скоринг близости агента к каждой нише.
 *     3. Расчёт занятости (occupancy), насыщения (saturation) и конкуренции.
 *     4. Оценка привлекательности ниши (opportunity):
 *          opportunity = спрос * (1 - насыщение) * (1 - конкуренция) * дефицит.
 *     5. Детекция зазоров (gaps) — ниш, где opportunity выше порога.
 *     6. Ранжирование и формирование рекомендаций (findNiches).
 *
 * Публичный API (модуль):
 *   - findNiches(options)            -> NicheReport       основная функция
 *   - findNiches()                   -> NicheReport       с автозагрузкой данных
 *   - niches(options)                -> NicheReport       алиас findNiches
 *   - findGaps(options)              -> Gap[]             только зазоры
 *   - scoreNiche(key, options)       -> ScoredNiche       одна ниша
 *   - injectRegistry(source)         -> Map               передать популяцию
 *   - autoLoad()                     -> number            собрать из файлов
 *   - configure(options)             -> config
 *   - stats()                        -> object
 *   - reset()                        -> this
 *   - renderReport(report)           -> string            ASCII-отчёт
 *   - NICHE_SIGNATURES               -> правило[]         словарь ниш
 *
 * Форма NicheReport:
 *   {
 *     niches:   [ ScoredNiche, ... ],   // отсортированы по opportunity desc
 *     gaps:     [ Gap, ... ],           // opportunity >= gapThreshold
 *     saturated:[ ScoredNiche, ... ],   // насыщение >= 0.9
 *     summary:  { total, occupied, empty, meanSaturation,
 *                 meanOpportunity, best, population, ts },
 *     meta:     { seed, options }
 *   }
 *
 * Форма ScoredNiche:
 *   { key, label, resource, capacity, occupancy, saturation, competition,
 *     demand, deficit, density, opportunity, agents: [id...], label_ru }
 *
 * Время и ГПСЧ инъектируются — модуль детерминирован и пригоден для тестов:
 *   configure({ now, rng, seed }).
 * ----------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Словарь ниш: сигнатуры признаков, ёмкость среды и рыночный спрос
// ---------------------------------------------------------------------------

const NICHE_SIGNATURES = [
  {
    key: 'producer',
    label: 'Producer',
    label_ru: 'Продуцент',
    resource: 'creation',
    keywords: ['generate', 'create', 'build', 'synth', 'compose', 'forge', 'scaffold', 'produce'],
    capacity: 12,
    demand: 0.85,
    weight: 1.0,
  },
  {
    key: 'consumer',
    label: 'Consumer',
    label_ru: 'Консумент',
    resource: 'ingestion',
    keywords: ['fetch', 'read', 'parse', 'consume', 'ingest', 'load', 'watch', 'collect'],
    capacity: 10,
    demand: 0.70,
    weight: 1.0,
  },
  {
    key: 'decomposer',
    label: 'Decomposer',
    label_ru: 'Редуцент',
    resource: 'recycling',
    keywords: ['cleanup', 'gc', 'prune', 'refactor', 'revive', 'recover', 'migrate', 'recycle'],
    capacity: 8,
    demand: 0.60,
    weight: 1.0,
  },
  {
    key: 'predator',
    label: 'Predator',
    label_ru: 'Хищник',
    resource: 'authority',
    keywords: ['kill', 'terminate', 'throttle', 'block', 'ban', 'quarantine', 'defend', 'hunt'],
    capacity: 6,
    demand: 0.75,
    weight: 1.0,
  },
  {
    key: 'symbiont',
    label: 'Symbiont',
    label_ru: 'Симбионт',
    resource: 'trust',
    keywords: ['sync', 'share', 'merge', 'negotiate', 'bridge', 'coordinate', 'relay', 'partner'],
    capacity: 14,
    demand: 0.90,
    weight: 1.0,
  },
  {
    key: 'pollinator',
    label: 'Pollinator',
    label_ru: 'Опылитель',
    resource: 'attention',
    keywords: ['notify', 'broadcast', 'dispatch', 'signal', 'ping', 'emit', 'alert', 'amplify'],
    capacity: 12,
    demand: 0.80,
    weight: 1.0,
  },
  {
    key: 'architect',
    label: 'Architect',
    label_ru: 'Архитектор',
    resource: 'structure',
    keywords: ['design', 'plan', 'architect', 'orchestrate', 'model', 'schema', 'framework'],
    capacity: 7,
    demand: 0.65,
    weight: 1.2,
  },
  {
    key: 'guardian',
    label: 'Guardian',
    label_ru: 'Хранитель',
    resource: 'safety',
    keywords: ['guard', 'secure', 'watch', 'audit', 'verify', 'protect', 'monitor', 'sentry'],
    capacity: 9,
    demand: 0.72,
    weight: 1.1,
  },
];

// ---------------------------------------------------------------------------
// Настройки по умолчанию
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS = Object.freeze({
  gapThreshold: 0.35, // opportunity, начиная с которой ниша считается зазором
  saturationThreshold: 0.9, // насыщение, при котором ниша перегрета
  minOccupancyForCompetition: 1, // ниже — конкуренция не считается
  population: null, // явная популяция вместо автозагрузки
  seed: 1337,
  limit: 0, // 0 => без ограничения
  includeEmpty: true,
});

const CANDIDATE_SOURCES = [
  'evolution/agents.json',
  'data/agents.json',
  'agents.json',
  'evolution/registry.json',
];

// ---------------------------------------------------------------------------
// Внутреннее состояние
// ---------------------------------------------------------------------------

let POPULATION = [];
let CONFIG = {
  now: () => Date.now(),
  rng: Math.random,
  seed: DEFAULT_OPTIONS.seed,
};
let LAST_REPORT = null;

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, lo, hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function round(value, digits) {
  const f = Math.pow(10, digits == null ? 3 : digits);
  return Math.round(value * f) / f;
}

function nowMs() {
  try {
    return CONFIG.now();
  } catch (_) {
    return Date.now();
  }
}

function rand() {
  try {
    const v = CONFIG.rng();
    return Number.isFinite(v) ? v : Math.random();
  } catch (_) {
    return Math.random();
  }
}

/**
 * Детерминированный mulberry32 — компактный seedable PRNG.
 */
function mulberry32(seed) {
  let a = (Number(seed) || 0) >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function slug(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9а-я]+/gi, '_')
    .replace(/^_+|_+$/g, '');
}

function tokenize(text) {
  return slug(text).split('_').filter(Boolean);
}

function unique(list) {
  return Array.from(new Set(list));
}

function mean(list) {
  if (!list.length) return 0;
  let sum = 0;
  for (const v of list) sum += numberOr(v, 0);
  return sum / list.length;
}

function signatureByKey(key) {
  return NICHE_SIGNATURES.find((s) => s.key === key) || null;
}

// ---------------------------------------------------------------------------
// Нормализация популяции
// ---------------------------------------------------------------------------

function normalizeAgent(raw, index) {
  if (raw == null) return null;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const id = String(raw);
    return {
      id,
      name: id,
      domain: 'core',
      tokens: tokenize(id),
      energy: 50,
      mass: 1,
      fitness: 0.5,
      generation: 0,
      raw,
    };
  }
  if (typeof raw !== 'object') return null;

  const id =
    raw.id != null
      ? String(raw.id)
      : raw.agentId != null
      ? String(raw.agentId)
      : raw.name != null
      ? String(raw.name)
      : `agent_${index}`;

  const traits = Array.isArray(raw.traits) ? raw.traits : [];
  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  const abilities = Array.isArray(raw.abilities) ? raw.abilities : [];
  const keywords = Array.isArray(raw.keywords) ? raw.keywords : [];

  const text = [
    raw.name,
    raw.role,
    raw.description,
    raw.niche,
    raw.layer,
    ...traits,
    ...tags,
    ...abilities,
    ...keywords,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    id,
    name: raw.name || id,
    domain: raw.domain || raw.layer || 'core',
    explicitNiche: raw.niche || raw.role || null,
    tokens: tokenize(`${id} ${text}`),
    energy: numberOr(raw.energy, 50),
    mass: numberOr(raw.mass, 1),
    fitness: numberOr(raw.fitness, 0.5),
    generation: numberOr(raw.generation, 0),
    raw,
  };
}

/**
 * Инъекция внешней популяции агентов.
 * @param {Array|Object} source
 * @returns {number} количество принятых агентов
 */
function injectRegistry(source) {
  POPULATION = [];
  if (!source) return 0;

  const entries = Array.isArray(source)
    ? source
    : source.agents || source.population || Object.values(source);

  if (!Array.isArray(entries)) return 0;

  let i = 0;
  for (const raw of entries) {
    const agent = normalizeAgent(raw, i);
    if (agent) {
      POPULATION.push(agent);
      i += 1;
    }
  }
  return POPULATION.length;
}

/**
 * Попытка собрать популяцию из известных источников на диске.
 * @returns {number}
 */
function autoLoad() {
  if (POPULATION.length > 0) return POPULATION.length;
  for (const rel of CANDIDATE_SOURCES) {
    const p = path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel);
    try {
      if (!fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      const n = injectRegistry(parsed);
      if (n > 0) return n;
    } catch (_) {
      /* игнорируем повреждённые источники */
    }
  }
  return POPULATION.length;
}

// ---------------------------------------------------------------------------
// Анализ ниш
// ---------------------------------------------------------------------------

/**
 * Скор близости агента к сигнатуре ниши.
 */
function keywordScore(agent, signature) {
  let score = 0;
  const tokenSet = new Set(agent.tokens);
  for (const kw of signature.keywords) {
    if (tokenSet.has(kw)) score += signature.weight;
  }
  // явное указание ниши в поле role/niche усиливает скор
  if (agent.explicitNiche) {
    const explicit = slug(agent.explicitNiche);
    if (explicit === signature.key || explicit === signature.label.toLowerCase()) {
      score += 2 * signature.weight;
    }
  }
  return score;
}

/**
 * Распределение агента по нишам (нормированный скор).
 */
function agentDistribution(agent) {
  const dist = {};
  let total = 0;
  for (const signature of NICHE_SIGNATURES) {
    const s = keywordScore(agent, signature);
    dist[signature.key] = s;
    total += s;
  }
  if (total <= 0) {
    // равномерный фоллбэк по домену
    const domainMap = {
      evolution: 'producer',
      market: 'predator',
      network: 'symbiont',
      memory: 'consumer',
      safety: 'guardian',
      structure: 'architect',
    };
    const fallback = domainMap[agent.domain] || 'producer';
    dist[fallback] = 1;
    total = 1;
  }
  for (const key of Object.keys(dist)) dist[key] = dist[key] / total;
  return dist;
}

/**
 * Основная ниша агента (argmax).
 */
function primaryNiche(agent) {
  const dist = agentDistribution(agent);
  let best = null;
  let bestScore = -1;
  for (const key of Object.keys(dist)) {
    if (dist[key] > bestScore) {
      bestScore = dist[key];
      best = key;
    }
  }
  return best || 'producer';
}

/**
 * Расчёт занятости ниш текущей популяцией.
 */
function buildOccupancy(population) {
  const map = new Map();
  for (const signature of NICHE_SIGNATURES) {
    map.set(signature.key, { agents: [], energy: [], fitness: [], mass: [] });
  }

  const effective = population.length ? population : [];
  for (const agent of effective) {
    const slot = map.get(primaryNiche(agent));
    if (!slot) continue;
    slot.agents.push(agent.id);
    slot.energy.push(agent.energy);
    slot.fitness.push(agent.fitness);
    slot.mass.push(agent.mass);
  }
  return map;
}

/**
 * Насыщение ниши: доля занятой ёмкости.
 */
function computeSaturation(occupancy, capacity) {
  if (!capacity) return 0;
  return clamp(occupancy / capacity, 0, 1);
}

/**
 * Конкуренция: сила давления внутри переполненной ниши.
 */
function computeCompetition(count, minOccupancy) {
  if (count <= minOccupancy) return 0;
  const excess = count - minOccupancy;
  return clamp(excess / (minOccupancy + excess), 0, 1);
}

/**
 * Оценка одной ниши по правилу сигнатуры и статистике занятости.
 */
function evaluateNiche(signature, slot, options) {
  const count = slot.agents.length;
  const occupancy = count;
  const saturation = computeSaturation(occupancy, signature.capacity);
  const competition = computeCompetition(count, options.minOccupancyForCompetition);
  const deficit = clamp(1 - saturation, 0, 1);
  const density = signature.capacity ? count / signature.capacity : 0;

  // средний ресурс обитателей ниши (здоровье популяции)
  const vitality = count
    ? clamp(
        0.5 * clamp(mean(slot.fitness), 0, 1) +
          0.5 * clamp(mean(slot.energy) / 100, 0, 1),
        0,
        1
      )
    : 0;

  // Привлекательность ниши: спрос * дефицит * (1 - конкуренция) + бонус пустоты
  const rawOpportunity =
    signature.demand * deficit * (1 - competition) + (count === 0 ? 0.1 : 0);
  const opportunity = clamp(rawOpportunity * (0.75 + 0.25 * (1 - vitality)), 0, 1);

  return {
    key: signature.key,
    label: signature.label,
    label_ru: signature.label_ru,
    resource: signature.resource,
    capacity: signature.capacity,
    occupancy,
    saturation: round(saturation, 4),
    competition: round(competition, 4),
    demand: signature.demand,
    deficit: round(deficit, 4),
    density: round(density, 4),
    vitality: round(vitality, 4),
    opportunity: round(opportunity, 4),
    agents: slot.agents.slice(),
  };
}

/**
 * scoreNiche(key, options) -> ScoredNiche | null
 */
function scoreNiche(key, options) {
  const signature = signatureByKey(key);
  if (!signature) return null;
  const opts = Object.assign({}, DEFAULT_OPTIONS, options || {});
  const population = Array.isArray(opts.population) ? opts.population : null;
  const pop = population
    ? population.map(normalizeAgent).filter(Boolean)
    : POPULATION.length
    ? POPULATION
    : [];
  const occupancy = buildOccupancy(pop);
  const slot = occupancy.get(key);
  if (!slot) return null;
  return evaluateNiche(signature, slot, opts);
}

/**
 * Детекция зазоров — ниш, чья opportunity >= порога.
 */
function detectGaps(scored, options) {
  return scored.filter((n) => n.opportunity >= options.gapThreshold);
}

/**
 * findNiches(options) -> NicheReport
 * Главная функция поиска нишей.
 */
function findNiches(options) {
  const opts = Object.assign({}, DEFAULT_OPTIONS, options || {});

  // популяция: явная из опций либо внутренняя/автозагрузка
  let pop;
  if (Array.isArray(opts.population)) {
    pop = opts.population.map(normalizeAgent).filter(Boolean);
  } else {
    if (POPULATION.length === 0 && !CONFIG._manual) {
      autoLoad();
    }
    pop = POPULATION;
  }

  const occupancy = buildOccupancy(pop);
  const scored = NICHE_SIGNATURES.map((signature) =>
    evaluateNiche(signature, occupancy.get(signature.key), opts)
  );

  scored.sort((a, b) => {
    if (b.opportunity !== a.opportunity) return b.opportunity - a.opportunity;
    if (b.deficit !== a.deficit) return b.deficit - a.deficit;
    return a.occupancy - b.occupancy;
  });

  const gaps = detectGaps(scored, opts);
  const saturated = scored.filter(
    (n) => n.saturation >= opts.saturationThreshold
  );
  const occupied = scored.filter((n) => n.occupancy > 0);

  let limited = scored;
  if (opts.limit && opts.limit > 0) limited = scored.slice(0, opts.limit);

  const summary = {
    total: scored.length,
    occupied: occupied.length,
    empty: scored.length - occupied.length,
    gaps: gaps.length,
    saturated: saturated.length,
    meanSaturation: round(mean(scored.map((n) => n.saturation)), 4),
    meanOpportunity: round(mean(scored.map((n) => n.opportunity)), 4),
    best: scored.length ? scored[0].key : null,
    population: pop.length,
    ts: nowMs(),
  };

  LAST_REPORT = {
    niches: limited,
    gaps,
    saturated,
    summary,
    meta: {
      seed: opts.seed,
      options: {
        gapThreshold: opts.gapThreshold,
        saturationThreshold: opts.saturationThreshold,
        includeEmpty: opts.includeEmpty,
      },
    },
  };

  return LAST_REPORT;
}

/**
 * niches(options) — алиас findNiches.
 */
function niches(options) {
  return findNiches(options);
}

/**
 * findGaps(options) -> Gap[]
 */
function findGaps(options) {
  const report = findNiches(options);
  return report.gaps;
}

/**
 * ASCII-отчёт по результату findNiches.
 */
function renderReport(report) {
  const r = report || LAST_REPORT || findNiches();
  const lines = [];
  lines.push('NICHE FINDER — карта экологических нишей');
  lines.push('========================================');
  lines.push(
    `pop=${r.summary.population} niches=${r.summary.total} ` +
      `occupied=${r.summary.occupied} empty=${r.summary.empty} ` +
      `gaps=${r.summary.gaps}`
  );
  lines.push(
    `meanSaturation=${r.summary.meanSaturation} ` +
      `meanOpportunity=${r.summary.meanOpportunity} best=${r.summary.best}`
  );
  lines.push('----------------------------------------');
  lines.push('KEY         OCC/CAP  SAT    COMP   OPP    FLAG');
  for (const n of r.niches) {
    const flag =
      n.opportunity >= 0.35
        ? 'GAP'
        : n.saturation >= 0.9
        ? 'SATURATED'
        : 'ok';
    const occ = `${n.occupancy}/${n.capacity}`;
    lines.push(
      `${n.key.padEnd(11)} ${occ.padEnd(7)} ` +
        `${String(n.saturation).padEnd(6)} ${String(n.competition).padEnd(6)} ` +
        `${String(n.opportunity).padEnd(6)} ${flag}`
    );
  }
  lines.push('----------------------------------------');
  if (r.gaps.length) {
    lines.push('Открытые зазоры: ' + r.gaps.map((g) => g.key).join(', '));
  } else {
    lines.push('Открытых зазоров нет — экосистема насыщена.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Конфигурация и диагностика
// ---------------------------------------------------------------------------

/**
 * configure(options) -> config
 * Позволяет инъектировать now/rng/seed для детерминизма.
 */
function configure(options) {
  const opts = options || {};
  if (typeof opts.now === 'function') CONFIG.now = opts.now;
  if (typeof opts.rng === 'function') {
    CONFIG.rng = opts.rng;
    CONFIG._manual = true;
  }
  if (opts.seed != null) {
    CONFIG.seed = opts.seed;
    CONFIG.rng = mulberry32(opts.seed);
    CONFIG._manual = true;
  }
  return Object.assign({}, CONFIG);
}

/**
 * stats() -> снимок внутреннего состояния.
 */
function stats() {
  return {
    population: POPULATION.length,
    niches: NICHE_SIGNATURES.length,
    hasReport: Boolean(LAST_REPORT),
    lastBest: LAST_REPORT ? LAST_REPORT.summary.best : null,
    seed: CONFIG.seed,
  };
}

/**
 * reset() -> this
 */
function reset() {
  POPULATION = [];
  LAST_REPORT = null;
  CONFIG = {
    now: () => Date.now(),
    rng: Math.random,
    seed: DEFAULT_OPTIONS.seed,
  };
  return module.exports;
}

// ---------------------------------------------------------------------------
// CLI-режим: node evolution/niche_finder.js [--json]
// ---------------------------------------------------------------------------

function cli() {
  const argv = process.argv.slice(2);
  const report = findNiches();
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderReport(report) + '\n');
  }
}

if (require.main === module) {
  try {
    cli();
  } catch (err) {
    process.stderr.write(`niche_finder: ${err && err.message}\n`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

module.exports = {
  findNiches,
  niches,
  findGaps,
  scoreNiche,
  injectRegistry,
  autoLoad,
  configure,
  stats,
  reset,
  renderReport,
  // низкоуровневые помощники (полезны для тестов)
  NICHE_SIGNATURES,
  DEFAULT_OPTIONS,
  agentDistribution,
  primaryNiche,
  buildOccupancy,
  mulberry32,
};
