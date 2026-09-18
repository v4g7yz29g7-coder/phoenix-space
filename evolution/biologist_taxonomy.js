'use strict';

/**
 * evolution/biologist_taxonomy.js
 * ---------------------------------------------------------------
 * Биолог-таксономист для агентов эволюционной популяции.
 *
 * Классифицирует каждого агента по биологическим рангам:
 *   - вид        (species)    — уникальный профиль поведения/навыков
 *   - род        (genus)      — группа близких видов по архетипу
 *   - семейство  (family)     — надродовая общность по стратегии
 *   - ниша       (niche)      — экологическая роль в среде агентов
 *
 * Публичный API:
 *   classify(agentId) -> { agentId, species, genus, family, niche, ... }
 *   listSpecies()     -> [ { species, genus, family, niche, members, ... } ]
 *
 * Модуль детерминирован: одинаковый агент всегда классифицируется
 * в одну и ту же ветвь. Не имеет внешних зависимостей.
 * ---------------------------------------------------------------
 */

// =============================================================
// Константы таксономии
// =============================================================

/** Роды, сгруппированные по надстратегии. */
const GENUS_CATALOG = [
  { genus: 'Explorator', family: 'Pioneraceae', strategy: 'открытие', niche: 'Frontier' },
  { genus: 'Exploitator', family: 'Optimaceae', strategy: 'эксплуатация', niche: 'Kernel' },
  { genus: 'Optimizator', family: 'Optimaceae', strategy: 'оптимизация', niche: 'Refiner' },
  { genus: 'Defensor', family: 'Stabiliaceae', strategy: 'защита', niche: 'Guardian' },
  { genus: 'Replicator', family: 'Propagaceae', strategy: 'размножение', niche: 'Spreader' },
  { genus: 'Synthesor', family: 'Synthetaceae', strategy: 'синтез', niche: 'Weaver' },
  { genus: 'Symbiont', family: 'Coopaceae', strategy: 'кооперация', niche: 'Bridge' },
  { genus: 'Predator', family: 'Dominoceae', strategy: 'доминирование', niche: 'Apex' },
  { genus: 'Mutator', family: 'Pioneraceae', strategy: 'мутация', niche: 'Frontier' },
];

/** Семейства — крупные экологические группировки. */
const FAMILY_CATALOG = {
  Pioneraceae: 'пионеры, первыми занимают новую территорию',
  Optimaceae: 'оптимизаторы, доводят решения до эффективности',
  Stabiliaceae: 'стабилизаторы, удерживают систему от коллапса',
  Propagaceae: 'размножители, повышают численность',
  Synthetaceae: 'синтезаторы, склеивают разнородные модули',
  Coopaceae: 'кооператоры, усиливают связи внутри сети',
  Dominoceae: 'доминаторы, захватывают ресурсный максимум',
};

/** Экологические ниши с описанием роли. */
const NICHE_CATALOG = {
  Frontier: 'первопроходец, работает на границе знания',
  Kernel: 'ядро системы, замыкает основные потоки',
  Refiner: 'шлифовальщик, повышает качество и точность',
  Guardian: 'страж, следит за устойчивостью и рисками',
  Spreader: 'распространитель, тиражирует удачные решения',
  Weaver: 'ткач связей, соединяет компоненты в целое',
  Bridge: 'мост, транслирует данные между кластерами',
  Apex: 'вершина, потребляет максимум доступного ресурса',
};

/** Порог для выделения вида по композитному отпечатку. */
const SPECIES_BUCKETS = 6;

// =============================================================
// Утилиты
// =============================================================

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Простой стабильный хеш строки (FNV-подобный). */
function hash(str) {
  let h = 2166136261;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Псевдослучайное число в [0,1) из строки и соли. */
function rand(str, salt) {
  return (hash(str + '|' + salt) % 100000) / 100000;
}

/** Детерминированно выбирает элемент массива по ключу. */
function pick(arr, key, salt) {
  if (!arr.length) return null;
  const idx = hash(key + '|' + salt) % arr.length;
  return arr[idx];
}

/** Нормализует значение к [0..1]. */
function norm(v, min, max) {
  if (max === min) return 0;
  return clamp((v - min) / (max - min), 0, 1);
}

// =============================================================
// Адаптеры над агентами
// =============================================================

/** Мягкий доступ к полям агента с дефолтами. */
function readAgent(agent) {
  if (!agent || typeof agent !== 'object') return null;
  const fitness = num(agent.fitness, num(agent.score, 0));
  const energy = num(agent.energy, num(agent.tokens, 100));
  const age = num(agent.age, num(agent.generation, 0));
  const skills = Array.isArray(agent.skills) ? agent.skills : [];
  const tags = Array.isArray(agent.tags) ? agent.tags : [];
  const lineage = agent.lineage || agent.parent || null;
  return {
    id: agent.id != null ? agent.id : agent.agentId != null ? agent.agentId : 'unknown',
    fitness,
    energy,
    age,
    skills,
    tags,
    lineage,
    role: agent.role || agent.type || null,
    raw: agent,
  };
}

function num(v, dflt) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

// =============================================================
// Извлечение фенотипических признаков
// =============================================================

/**
 * Формирует вектор-отпечаток агента: набор нормализованных числовых
 * признаков, по которым определяется род/вид/ниша.
 */
function phenotype(a) {
  const fitness = norm(a.fitness, -100, 100);
  const energy = norm(a.energy, 0, 1000);
  const age = norm(a.age, 0, 500);
  const skillCount = norm(a.skills.length, 0, 20);
  const tagCount = norm(a.tags.length, 0, 20);

  // "Агрессия" — склонность давить на максимум ресурса.
  const aggression = clamp(fitness * 0.6 + (1 - energy / 1000) * 0.4, 0, 1);
  // "Стабильность" — зрелость и накопленный возраст.
  const stability = clamp(age * 0.7 + energy * 0.3, 0, 1);
  // "Адаптивность" — широта набора навыков/тегов.
  const adaptivity = clamp((skillCount + tagCount) / 2, 0, 1);
  // "Социальность" — наличие связей/линии наследования.
  const sociality = clamp((a.lineage ? 0.5 : 0) + a.tags.length / 40, 0, 1);

  return { fitness, energy, age, skillCount, tagCount, aggression, stability, adaptivity, sociality };
}

// =============================================================
// Таксономические решающие правила
// =============================================================

/** Определяет род по доминирующему признаку. */
function resolveGenus(a, p) {
  const scores = {
    Explorator: p.adaptivity * 0.6 + (1 - p.stability) * 0.4,
    Exploitator: p.aggression * 0.7 + p.fitness * 0.3,
    Optimizator: p.fitness * 0.5 + p.stability * 0.5,
    Defensor: p.stability * 0.8 + (1 - p.aggression) * 0.2,
    Replicator: p.energy * 0.5 + p.sociality * 0.5,
    Synthesor: p.adaptivity * 0.5 + p.sociality * 0.5,
    Symbiont: p.sociality * 0.8 + p.adaptivity * 0.2,
    Predator: p.aggression * 0.9 + (1 - p.sociality) * 0.1,
    Mutator: (1 - p.stability) * 0.6 + p.adaptivity * 0.4,
  };
  // Небольшой детерминированный шум, чтобы избежать ничьих.
  let best = null;
  let bestScore = -Infinity;
  for (const [genus, s] of Object.entries(scores)) {
    const jitter = rand(a.id, 'genus:' + genus) * 0.01;
    const total = s + jitter;
    if (total > bestScore) {
      bestScore = total;
      best = genus;
    }
  }
  return best || 'Explorator';
}

/** Возвращает метаданные рода из каталога. */
function genusMeta(genus) {
  return GENUS_CATALOG.find((g) => g.genus === genus) || GENUS_CATALOG[0];
}

/** Определяет вид как биномен: Genus + эпитет по отпечатку. */
function resolveSpecies(a, p, genus) {
  const bucket = Math.floor(p.fitness * SPECIES_BUCKETS);
  const epi = ['vulgaris', 'fortis', 'velox', 'sapiens', 'minimus', 'maximus',
    'solaris', 'noctis', 'robustus', 'elegans'][hash(a.id + ':epi') % 10];
  const suffix = ['a', 'b', 'c', 'd', 'e', 'f'][bucket] || 'x';
  return genus.toLowerCase() + '_' + epi + '_' + suffix;
}

/** Определяет семейство по роду. */
function resolveFamily(genus) {
  return genusMeta(genus).family;
}

/** Определяет нишу по признакам и роду. */
function resolveNiche(a, p, genus) {
  const base = genusMeta(genus).niche;
  // Коррекция ниши по экстремальным признакам.
  if (p.aggression > 0.85 && p.sociality < 0.3) return 'Apex';
  if (p.sociality > 0.75) return 'Bridge';
  if (p.stability > 0.8) return 'Guardian';
  return base;
}

// =============================================================
// Кэш и реестр
// =============================================================

/** Кэш классификаций по id агента. */
const cache = new Map();

/** Реестр видов: species -> запись. */
const speciesRegistry = new Map();

/** Регистрирует особь в реестре видов. */
function registerSpecies(record) {
  let entry = speciesRegistry.get(record.species);
  if (!entry) {
    entry = {
      species: record.species,
      genus: record.genus,
      family: record.family,
      niche: record.niche,
      members: [],
      firstSeen: record.timestamp,
      traits: record.traits,
    };
    speciesRegistry.set(record.species, entry);
  }
  if (!entry.members.includes(record.agentId)) {
    entry.members.push(record.agentId);
  }
  return entry;
}

// =============================================================
// Публичный API
// =============================================================

/**
 * Классифицирует агента по всем рангам.
 * @param {string|object} agentId — id агента или сам объект агента
 * @param {object} [agentSource] — опциональный источник данных агента
 * @returns {object} таксономическая запись
 */
function classify(agentId, agentSource) {
  const raw = agentSource && typeof agentSource === 'object' ? agentSource : null;
  const id = raw ? (raw.id != null ? raw.id : agentId) : agentId;

  if (cache.has(id) && !raw) {
    const cached = cache.get(id);
    return Object.assign({}, cached);
  }

  // Пытаемся получить объект агента из известных источников.
  let agent = raw;
  if (!agent && agentId && typeof agentId === 'object') agent = agentId;
  if (!agent) agent = lookupAgent(id);

  const a = readAgent(agent) || {
    id: id != null ? id : 'unknown',
    fitness: 0, energy: 100, age: 0, skills: [], tags: [],
    lineage: null, role: null, raw: null,
  };

  const p = phenotype(a);
  const genus = resolveGenus(a, p);
  const species = resolveSpecies(a, p, genus);
  const family = resolveFamily(genus);
  const niche = resolveNiche(a, p, genus);

  const record = {
    agentId: a.id,
    species,
    genus,
    family,
    familyNote: FAMILY_CATALOG[family] || '',
    niche,
    nicheNote: NICHE_CATALOG[niche] || '',
    timestamp: Date.now(),
    traits: {
      fitness: round(p.fitness, 3),
      energy: round(p.energy, 3),
      age: round(p.age, 3),
      adaptivity: round(p.adaptivity, 3),
      aggression: round(p.aggression, 3),
      stability: round(p.stability, 3),
      sociality: round(p.sociality, 3),
    },
  };

  cache.set(a.id, record);
  registerSpecies(record);
  return Object.assign({}, record);
}

/**
 * Возвращает список всех известных видов с агрегатами.
 * @returns {Array<object>}
 */
function listSpecies() {
  const out = [];
  for (const entry of speciesRegistry.values()) {
    out.push({
      species: entry.species,
      genus: entry.genus,
      family: entry.family,
      familyNote: FAMILY_CATALOG[entry.family] || '',
      niche: entry.niche,
      nicheNote: NICHE_CATALOG[entry.niche] || '',
      members: entry.members.slice(),
      population: entry.members.length,
      firstSeen: entry.firstSeen,
      traits: entry.traits,
    });
  }
  out.sort((x, y) => y.population - x.population || x.species.localeCompare(y.species));
  return out;
}

// =============================================================
// Источники агентов
// =============================================================

/** Подключает внешние источники данных агентов. */
const sources = [];
function registerSource(fn) {
  if (typeof fn === 'function') sources.push(fn);
}

function lookupAgent(id) {
  for (const src of sources) {
    try {
      const found = src(id);
      if (found) return found;
    } catch (_) { /* изолируем ошибки источников */ }
  }
  return null;
}

/** Простой статический источник для тестов/демо. */
const staticPool = new Map();
function seed(agent) {
  if (agent && agent.id != null) staticPool.set(agent.id, agent);
}
function staticSource(id) {
  return staticPool.get(id) || null;
}
registerSource(staticSource);

function round(v, d) {
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

// =============================================================
// Статистика и вспомогательные отчёты
// =============================================================

/** Сводка по семействам. */
function familySummary() {
  const map = {};
  for (const e of speciesRegistry.values()) {
    map[e.family] = map[e.family] || { family: e.family, species: 0, population: 0 };
    map[e.family].species += 1;
    map[e.family].population += e.members.length;
  }
  return Object.values(map).sort((a, b) => b.population - a.population);
}

/** Полный отчёт по популяции. */
function report() {
  return {
    species: listSpecies().length,
    individuals: cache.size,
    families: familySummary(),
    generatedAt: new Date().toISOString(),
  };
}

function reset() {
  cache.clear();
  speciesRegistry.clear();
}

// =============================================================
// Экспорт
// =============================================================

module.exports = {
  classify,
  listSpecies,
  registerSource,
  seed,
  familySummary,
  report,
  reset,
  // служебные, полезные для тестов/расширений
  _internals: { phenotype, resolveGenus, resolveSpecies, resolveNiche, hash, rand },
  GENUS_CATALOG,
  FAMILY_CATALOG,
  NICHE_CATALOG,
};
