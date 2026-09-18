'use strict';

/**
 * evolution/species_classifier.js
 * ============================================================================
 * Автоклассификация агентов по биологическим видам (автономный модуль).
 *
 * Назначение
 * ----------
 * Модуль принимает нового агента (agentId), которого ещё нет в таксономическом
 * дереве, и автоматически определяет его вид (species) на основе нескольких
 * независимых осей:
 *
 *   1. niche      — экологическая роль (продуцент/консумент/редуцент/...)
 *   2. domain     — функциональный слой системы (core/market/memory/...)
 *   3. dnaClass   — зрелость и потенциал агента
 *   4. morphology — форма и поведение (swarm/solitary/colony/parasite)
 *
 * Результатом является устойчивый строковый отпечаток вида (fingerprint) и
 * предложенное латиноподобное имя. Если отпечаток уже встречался, агент
 * причисляется к известному виду (population + 1), иначе регистрируется новый.
 *
 * Публичное API
 * -------------
 *   classifyNew(agentId[, options]) -> профиль вида агента   (основное)
 *   classifyBatch(ids[, options])   -> профиль[]
 *   listSpecies()                   -> виды, сортировка по популяции
 *   getSpecies(fingerprint)         -> вид | null
 *   injectRegistry(source)          -> подмена источника данных об агентах
 *   setTraitProvider(fn)            -> внешний источник фенотипов
 *   stats()                         -> агрегированная статистика
 *   reset()                         -> сброс внутреннего состояния (тесты)
 *
 * Модуль автономен: при отсутствии внешних данных строит детерминированный
 * профиль агента из одного лишь идентификатора (FNV-1a + LCG), поэтому
 * классификация воспроизводима между запусками.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Таксономические константы
// ---------------------------------------------------------------------------

const NICHE = Object.freeze({
  PRODUCER: 'producer',
  CONSUMER: 'consumer',
  DECOMPOSER: 'decomposer',
  PREDATOR: 'predator',
  SYMBIONT: 'symbiont',
  POLLINATOR: 'pollinator',
});

const DNA_CLASS = Object.freeze({
  APEX: 'apex',
  THRIVING: 'thriving',
  STABLE: 'stable',
  FRAGILE: 'fragile',
  DORMANT: 'dormant',
});

const MORPHOLOGY = Object.freeze({
  SWARM: 'swarm',
  SOLITARY: 'solitary',
  COLONY: 'colony',
  PARASITE: 'parasite',
});

// ---------------------------------------------------------------------------
// Словарь признаков -> ниша
// ---------------------------------------------------------------------------

const NICHE_RULES = [
  {
    niche: NICHE.PRODUCER,
    label: 'Продуцент',
    keywords: ['generate', 'create', 'build', 'synth', 'compose', 'forge', 'scaffold', 'mint'],
  },
  {
    niche: NICHE.CONSUMER,
    label: 'Консумент',
    keywords: ['fetch', 'read', 'parse', 'consume', 'ingest', 'load', 'watch', 'scan'],
  },
  {
    niche: NICHE.DECOMPOSER,
    label: 'Редуцент',
    keywords: ['cleanup', 'gc', 'prune', 'refactor', 'revive', 'recover', 'migrate', 'recycle'],
  },
  {
    niche: NICHE.PREDATOR,
    label: 'Хищник',
    keywords: ['kill', 'terminate', 'throttle', 'block', 'ban', 'quarantine', 'defend', 'audit'],
  },
  {
    niche: NICHE.SYMBIONT,
    label: 'Симбионт',
    keywords: ['sync', 'share', 'merge', 'negotiate', 'bridge', 'coordinate', 'relay', 'federate'],
  },
  {
    niche: NICHE.POLLINATOR,
    label: 'Опылитель',
    keywords: ['notify', 'broadcast', 'dispatch', 'signal', 'ping', 'emit', 'alert', 'announce'],
  },
];

/** Суффиксы для генерации латиноподобных имён видов. */
const NAME_SUFFIX = Object.freeze({
  [NICHE.PRODUCER]: 'faber',
  [NICHE.CONSUMER]: 'vorax',
  [NICHE.DECOMPOSER]: 'reductor',
  [NICHE.PREDATOR]: 'raptor',
  [NICHE.SYMBIONT]: 'socius',
  [NICHE.POLLINATOR]: 'vector',
});

/** Отображаемое имя по умолчанию, если домен не распознан. */
const DEFAULT_DOMAIN = 'core';

// ---------------------------------------------------------------------------
// Настройки по умолчанию
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  /** Писать ли аудит-лог классификаций на диск. */
  persist: false,
  /** Максимальный размер истории в памяти. */
  maxHistory: 4000,
  /** Каталог для необязательного аудита. */
  memoryDir: path.join(__dirname, '..', 'memory'),
});

let config = Object.assign({}, DEFAULTS);

// ---------------------------------------------------------------------------
// Внутреннее состояние
// ---------------------------------------------------------------------------

/** id агента -> нормализованная запись */
let REGISTRY = new Map();
/** fingerprint -> запись вида */
const SPECIES_INDEX = new Map();
/** монотонный счётчик зарегистрированных видов */
let SPECIES_COUNTER = 0;
/** порядок классификаций для истории/аудита */
const HISTORY = [];
/** внешний источник фенотипов */
let traitProvider = null;

const counters = {
  calls: 0,
  known: 0,
  novel: 0,
  errors: 0,
};

// ---------------------------------------------------------------------------
// Низкоуровневые утилиты
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit — быстрый детерминированный хеш строки. */
function hashString(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Линейный конгруэнтный генератор для синтетических признаков. */
function lcg(seed) {
  let state = seed >>> 0 || 1;
  return function next() {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 0xffffffff;
  };
}

/** Безопасное приведение к числу с fallback. */
function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Обрезка строки до разумной длины. */
function trim(value, max) {
  const s = String(value == null ? '' : value);
  return s.length > max ? s.slice(0, max) : s;
}

/** Приведение к диапазону [0, 1]; нечисловые значения -> 0. */
function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** Округление до заданного числа знаков после запятой. */
function round(value, digits = 4) {
  const f = 10 ** digits;
  return Math.round(Number(value) * f) / f;
}

// ---------------------------------------------------------------------------
// Инъекция и нормализация агентов
// ---------------------------------------------------------------------------

/**
 * Подмена источника данных об агентах.
 * @param {Array|Object} source
 * @returns {Map}
 */
function injectRegistry(source) {
  REGISTRY = new Map();
  if (!source) return REGISTRY;

  const entries = Array.isArray(source) ? source : Object.values(source);
  for (const raw of entries) {
    if (!raw) continue;
    const id = resolveId(raw);
    if (!id) continue;
    REGISTRY.set(String(id), normalizeAgent(String(id), raw));
  }
  return REGISTRY;
}

/** Извлекает идентификатор из произвольной записи. */
function resolveId(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  return raw.id || raw.agentId || raw.name || raw.slug || null;
}

/** Приводит произвольную запись агента к канонической форме. */
function normalizeAgent(id, raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const traits = Array.isArray(src.traits) ? src.traits.slice() : [];
  const tags = Array.isArray(src.tags) ? src.tags.slice() : [];
  const abilities = Array.isArray(src.abilities) ? src.abilities.slice() : [];

  return {
    id,
    name: src.name || id,
    domain: src.domain || src.layer || guessDomain(src),
    traits,
    tags,
    abilities,
    tokens: String(
      [src.description, src.role, ...traits, ...tags, ...abilities]
        .filter(Boolean)
        .join(' ')
    ).toLowerCase(),
    energy: numberOr(src.energy, 50),
    mass: numberOr(src.mass, 1),
    fitness: numberOr(src.fitness, 0.5),
    generation: numberOr(src.generation, 0),
    lineage: src.lineage || src.origin || null,
    raw: src,
  };
}

/** Угадывает домен по текстовым признакам записи. */
function guessDomain(raw) {
  const s = String(raw.role || raw.description || raw.name || '').toLowerCase();
  if (/market|trade|price|econom/.test(s)) return 'market';
  if (/evo|breed|mutat|species/.test(s)) return 'evolution';
  if (/network|gossip|mesh|p2p/.test(s)) return 'network';
  if (/memory|store|persist|index/.test(s)) return 'memory';
  if (/guard|secure|watch|audit/.test(s)) return 'safety';
  return DEFAULT_DOMAIN;
}

/** Детерминированно синтезирует агента из одного идентификатора. */
function synthesizeAgent(id) {
  const rnd = lcg(hashString(id));
  const roles = Object.values(NICHE);
  const domains = ['core', 'market', 'evolution', 'network', 'memory', 'safety'];
  return normalizeAgent(id, {
    id,
    name: id,
    role: pick(roles, rnd()),
    domain: pick(domains, rnd()),
    energy: Math.round(rnd() * 100),
    mass: Math.round(rnd() * 20) + 1,
    fitness: rnd(),
    generation: Math.floor(rnd() * 12),
  });
}

/** Детерминированный выбор элемента массива по доле [0,1). */
function pick(arr, ratio) {
  const idx = Math.min(arr.length - 1, Math.floor(ratio * arr.length));
  return arr[idx];
}

/** Резолвер агента: registry -> trait-provider -> профиль -> синтез. */
function resolveAgent(id, options = {}) {
  let agent = REGISTRY.get(id) || null;

  if (options.agent && typeof options.agent === 'object') {
    agent = normalizeAgent(id, options.agent);
  }

  if (!agent && typeof traitProvider === 'function') {
    try {
      const provided = traitProvider(id);
      if (provided && typeof provided === 'object') {
        agent = normalizeAgent(id, provided.traits ? provided : { traits: provided });
      }
    } catch (err) {
      counters.errors += 1;
    }
  }

  if (!agent) {
    const profile = readAgentProfile(id);
    if (profile) agent = normalizeAgent(id, profile);
  }

  if (!agent) agent = synthesizeAgent(id);
  return agent;
}

/** Пытается прочитать профиль агента из memory/agents/<id>.json. */
function readAgentProfile(id) {
  try {
    const file = path.join(config.memoryDir, 'agents', String(id) + '.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    counters.errors += 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ниша
// ---------------------------------------------------------------------------

/** Считает вхождения ключевых слов для каждой ниши. */
function scoreNiches(tokens) {
  const scores = {};
  for (const rule of NICHE_RULES) {
    let score = 0;
    for (const kw of rule.keywords) {
      if (tokens.includes(kw)) score += 1;
    }
    scores[rule.niche] = score;
  }
  return scores;
}

/** Выбирает наиболее подходящую нишу (с детерминированным тай-брейком). */
function pickNiche(tokens, fallbackDomain) {
  const scores = scoreNiches(tokens);
  let best = null;
  let bestScore = 0;
  for (const rule of NICHE_RULES) {
    if (scores[rule.niche] > bestScore) {
      bestScore = scores[rule.niche];
      best = rule;
    }
  }
  if (!best) {
    const domainMap = {
      evolution: NICHE.PRODUCER,
      market: NICHE.CONSUMER,
      memory: NICHE.DECOMPOSER,
      safety: NICHE.PREDATOR,
      network: NICHE.SYMBIONT,
    };
    const niche = domainMap[fallbackDomain] || NICHE.CONSUMER;
    best = NICHE_RULES.find((r) => r.niche === niche);
    bestScore = 0;
  }
  return { key: best.niche, label: best.label, score: bestScore, scores };
}

// ---------------------------------------------------------------------------
// ДНК-класс и морфология
// ---------------------------------------------------------------------------

/** Классифицирует агента по «генетическому» потенциалу. */
function classifyByDna(agent) {
  const fitness = clamp01(agent.fitness);
  const energy = clamp01(agent.energy / 100);
  const maturity = clamp01(agent.generation / 10);
  const power = 0.5 * fitness + 0.3 * energy + 0.2 * maturity;

  let cls = DNA_CLASS.DORMANT;
  if (power >= 0.85) cls = DNA_CLASS.APEX;
  else if (power >= 0.65) cls = DNA_CLASS.THRIVING;
  else if (power >= 0.45) cls = DNA_CLASS.STABLE;
  else if (power >= 0.25) cls = DNA_CLASS.FRAGILE;

  return { class: cls, power: round(power, 3) };
}

/** Определяет морфологию агента по массе, энергии и нише. */
function detectMorphology(agent) {
  const mass = Math.max(1, agent.mass);
  const energy = clamp01(agent.energy / 100);
  if (mass >= 12 && energy >= 0.4) return MORPHOLOGY.COLONY;
  if (mass <= 2 && energy >= 0.6) return MORPHOLOGY.SWARM;
  if (mass >= 8) return MORPHOLOGY.SOLITARY;
  return MORPHOLOGY.PARASITE;
}

// ---------------------------------------------------------------------------
// Отпечаток и регистрация вида
// ---------------------------------------------------------------------------

/** Строит устойчивый отпечаток вида из ключевых осей. */
function fingerprint(agent, nicheKey, dnaClass, morphology) {
  const parts = [
    nicheKey,
    morphology,
    dnaClass.class,
    trim(agent.domain, 24),
    String(Math.round(agent.mass)),
  ];
  const raw = parts.join('|');
  return 'sp_' + hashString(raw).toString(16).padStart(8, '0');
}

/** Генерирует латиноподобное имя вида. */
function buildSpeciesName(agent, nicheKey, morphology) {
  const base = String(agent.domain || DEFAULT_DOMAIN).replace(/[^a-z]/gi, '').toLowerCase();
  const suffix = NAME_SUFFIX[nicheKey] || 'forma';
  const morph = String(morphology).slice(0, 4);
  return trim(`${base || 'agent'}${morph}.${suffix}`, 40);
}

/** Регистрирует отпечаток вида или увеличивает его популяцию. */
function registerSpecies(fp, name) {
  const existing = SPECIES_INDEX.get(fp);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = Date.now();
    return { record: existing, isNew: false };
  }
  SPECIES_COUNTER += 1;
  const record = {
    id: SPECIES_COUNTER,
    name,
    fingerprint: fp,
    count: 1,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
  };
  SPECIES_INDEX.set(fp, record);
  return { record, isNew: true };
}

// ---------------------------------------------------------------------------
// Публичный API
// ---------------------------------------------------------------------------

/**
 * classifyNew(agentId) -> профиль автоматической классификации агента.
 * @param {string} agentId
 * @param {object} [options]
 * @returns {object}
 */
function classifyNew(agentId, options = {}) {
  counters.calls += 1;
  const id = String(agentId == null ? '' : agentId);
  try {
    const agent = resolveAgent(id, options);
    const niche = pickNiche(agent.tokens, agent.domain);
    const dnaClass = classifyByDna(agent);
    const morphology = detectMorphology(agent);
    const fp = fingerprint(agent, niche.key, dnaClass, morphology);
    const { record, isNew } = registerSpecies(fp, buildSpeciesName(agent, niche.key, morphology));

    if (isNew) counters.novel += 1;
    else counters.known += 1;

    const result = {
      agentId: id,
      species: {
        id: record.id,
        name: record.name,
        fingerprint: fp,
        isNew,
        population: record.count,
      },
      niche,
      dnaClass,
      morphology,
      lineage: agent.lineage,
      confidence: computeConfidence(niche.score, agent),
      classifiedAt: Date.now(),
    };

    pushHistory(result);
    if (config.persist) persist(result);
    return result;
  } catch (err) {
    counters.errors += 1;
    return {
      agentId: id,
      error: String(err && err.message ? err.message : err),
      confidence: 0,
      classifiedAt: Date.now(),
    };
  }
}

/** Пакетная классификация списка идентификаторов. */
function classifyBatch(ids, options = {}) {
  const list = Array.isArray(ids) ? ids : [];
  return list.map((id) => classifyNew(id, options));
}

/** Оценка уверенности классификации. */
function computeConfidence(nicheScore, agent) {
  const signal = Math.min(1, nicheScore / 3);
  const maturity = Math.min(1, agent.generation / 10);
  const base = 0.3 + 0.5 * signal + 0.2 * maturity;
  return Math.round(Math.min(1, base) * 100) / 100;
}

/** Добавляет запись в ограниченную историю. */
function pushHistory(record) {
  HISTORY.push(record);
  if (HISTORY.length > config.maxHistory) HISTORY.shift();
}

/** Необязательная запись аудита в memory/*.jsonl. */
function persist(record) {
  try {
    if (!fs.existsSync(config.memoryDir)) fs.mkdirSync(config.memoryDir, { recursive: true });
    const file = path.join(config.memoryDir, 'species_classifications.jsonl');
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    counters.errors += 1;
  }
}

/** Список зарегистрированных видов, отсортированный по популяции. */
function listSpecies() {
  return Array.from(SPECIES_INDEX.values())
    .slice()
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Возвращает вид по отпечатку. */
function getSpecies(fp) {
  return SPECIES_INDEX.get(fp) || null;
}

/** Устанавливает внешний источник фенотипов. */
function setTraitProvider(fn) {
  traitProvider = typeof fn === 'function' ? fn : null;
  return traitProvider;
}

/** Агрегированная статистика модуля. */
function stats() {
  const speciesCount = SPECIES_INDEX.size;
  const totalPopulation = listSpecies().reduce((sum, s) => sum + s.count, 0);
  return {
    calls: counters.calls,
    known: counters.known,
    novel: counters.novel,
    errors: counters.errors,
    speciesCount,
    totalPopulation,
    historySize: HISTORY.length,
    config: Object.assign({}, config),
  };
}

/** Изменение настроек модуля. */
function configure(opts = {}) {
  config = Object.assign({}, config, opts);
  return module.exports;
}

/** Сброс внутреннего состояния (для тестов). */
function reset() {
  REGISTRY = new Map();
  SPECIES_INDEX.clear();
  SPECIES_COUNTER = 0;
  HISTORY.length = 0;
  traitProvider = null;
  counters.calls = 0;
  counters.known = 0;
  counters.novel = 0;
  counters.errors = 0;
  config = Object.assign({}, DEFAULTS);
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

module.exports = {
  classifyNew,
  classifyBatch,
  listSpecies,
  getSpecies,
  injectRegistry,
  setTraitProvider,
  stats,
  configure,
  reset,
  NICHE,
  DNA_CLASS,
  MORPHOLOGY,
  NICHE_RULES,
};
