'use strict';

/**
 * evolution/species_guard.js
 * ============================================================================
 * Species Guard — «защита видов от вымирания».
 *
 * Назначение
 * ----------
 * Модуль следит за популяциями видов экосистемы Phoenix и для каждого вида
 * вычисляет числовой индекс риска вымирания (0 — процветает, 100 — doomed),
 * относит вид к категории риска и подбирает конкретное действие по спасению.
 *
 * Факторы риска (аддитивная модель с потолком 100):
 *   1. population   — абсолютная уязвимость малой численности;
 *   2. growthRate   — отрицательная динамика (коллапс популяции);
 *   3. generation   — молодость/незрелость линии (нет исторической памяти);
 *   4. fitnest      — низкая приспособленность (низкое качество генома);
 *   5. habitat      — деградация среды обитания (штраф за хрупкие биомы);
 *   6. stagnation   — стагнация (нулевой рост) как ранний сигнал риска.
 *
 * Категории риска (по возрастанию):
 *   stable < low < medium < high < critical
 *
 * Публичное API
 * -------------
 *   check()                 -> [{ species, risk, action, score, detail }]  ← главное
 *   check(list)             -> то же для произвольного списка видов
 *   register(entry|[] )     -> добавить вид(ы) во внутренний реестр
 *   update(name, patch)     -> обновить запись реестра
 *   remove(name)            -> удалить вид из реестра
 *   get(name)               -> запись | null
 *   list()                  -> все записи реестра
 *   setRegistry(source)     -> подменить источник данных
 *   summary()               -> агрегированная сводка по последнему check()
 *   urgent(report)          -> виды, требующие немедленного вмешательства
 *   configure(options)      -> текущая конфигурация
 *   reset()                 -> сброс к демонстрационному набору видов
 *
 * Зависимости: только встроенные модули Node.js (fs, path).
 * Детерминизм: результат полностью определяется входными данными.
 * API: check() -> [{species, risk, action}]
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

/* -------------------------------------------------------------------------- */
/* 1. Константы и пороги                                                      */
/* -------------------------------------------------------------------------- */

const RISK_LEVELS = Object.freeze({
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  STABLE: 'stable',
});

// Порядок уровней риска по возрастанию тяжести.
const RISK_ORDER = ['stable', 'low', 'medium', 'high', 'critical'];

// Пороговые значения (по умолчанию инъектируемы через configure()).
const DEFAULTS = Object.freeze({
  criticalPopulation: 5,   // популяция <= 5  -> критика
  endangeredPopulation: 20,// популяция <= 20 -> высокий риск
  vulnerablePopulation: 40,// популяция <= 40 -> средний риск
  minGeneration: 3,        // линия моложе 3 поколений -> штраф
  minFitnest: 0.35,        // приспособленность ниже 0.35 -> штраф
  collapseGrowth: -0.25,   // падение > 25% за цикл -> коллапс
  staleGrowth: 0.0,        // нулевой/отрицательный рост -> стагнация
  fragileHabitats: ['volcanic-rift', 'tundra-shelf', 'obsidian-plain'],
});

// Действия по умолчанию для каждой категории риска.
const ACTIONS = Object.freeze({
  critical: 'emergency-clone-backup',
  high: 'habitat-stabilization',
  medium: 'genetic-diversity-boost',
  low: 'monitor-and-sample',
  stable: 'archival-logging',
});

// Метаданные действий: приоритет (0 — фон), бюджет, срок реакции (сутки).
const ACTION_META = Object.freeze({
  'archival-logging': { priority: 0, budget: 0, reactInDays: 90 },
  'monitor-and-sample': { priority: 1, budget: 2, reactInDays: 45 },
  'genetic-diversity-boost': { priority: 2, budget: 4, reactInDays: 21 },
  'habitat-stabilization': { priority: 3, budget: 6, reactInDays: 10 },
  'relocation-and-seed-bank': { priority: 4, budget: 8, reactInDays: 7 },
  'emergency-clone-backup': { priority: 5, budget: 12, reactInDays: 1 },
});

// Демонстрационный набор видов (используется, если реестр пуст).
const DEFAULT_SPECIES = Object.freeze([
  { name: 'Aozora',     population: 12,  growthRate: -0.18, habitat: 'cloud-canopy',   generation: 4, fitnest: 0.42 },
  { name: 'Mirefrost',  population: 3,   growthRate: -0.31, habitat: 'tundra-shelf',   generation: 2, fitnest: 0.61 },
  { name: 'Kelpvane',   population: 240, growthRate: 0.05,  habitat: 'shelf-reef',     generation: 9, fitnest: 0.88 },
  { name: 'Sablequill', population: 7,   growthRate: -0.09, habitat: 'obsidian-plain', generation: 6, fitnest: 0.33 },
  { name: 'Palechorus', population: 58,  growthRate: 0.0,   habitat: 'river-delta',    generation: 7, fitnest: 0.72 },
  { name: 'Emberdrift', population: 1,   growthRate: -0.55, habitat: 'volcanic-rift',  generation: 1, fitnest: 0.18 },
  { name: 'Nimbuswake', population: 96,  growthRate: 0.12,  habitat: 'highland-mesa',  generation: 8, fitnest: 0.81 },
  { name: 'Thornweave', population: 22,  growthRate: -0.02, habitat: 'crystal-grove',  generation: 5, fitnest: 0.57 },
]);

/* -------------------------------------------------------------------------- */
/* 2. Внутреннее состояние                                                    */
/* -------------------------------------------------------------------------- */

let CONFIG = Object.assign({}, DEFAULTS);
let _registry = DEFAULT_SPECIES.map((s) => Object.assign({}, s));
let _lastReport = [];
let _checkCount = 0;

/** Переопределить конфигурацию модуля. */
function configure(options) {
  if (options && typeof options === 'object') {
    Object.keys(options).forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) CONFIG[k] = options[k];
    });
  }
  return Object.assign({}, CONFIG);
}

/** Полный сброс состояния к значениям по умолчанию. */
function reset() {
  CONFIG = Object.assign({}, DEFAULTS);
  _registry = DEFAULT_SPECIES.map((s) => Object.assign({}, s));
  _lastReport = [];
  _checkCount = 0;
  return module.exports;
}

/* -------------------------------------------------------------------------- */
/* 3. Реестр видов                                                            */
/* -------------------------------------------------------------------------- */

/** Подменить источник данных (массив видов). */
function setRegistry(source) {
  if (Array.isArray(source)) {
    _registry = source.map((s) => Object.assign({}, s));
  }
  return _registry.length;
}

/** Добавить вид(ы) в реестр; возвращает число добавленных записей. */
function register(entry) {
  const items = Array.isArray(entry) ? entry : [entry];
  let added = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || !item.name) continue;
    const idx = _registry.findIndex((s) => s.name === item.name);
    if (idx >= 0) Object.assign(_registry[idx], item);
    else _registry.push(Object.assign({}, item));
    added += 1;
  }
  return added;
}

/** Обновить запись вида по имени. */
function update(name, patch) {
  const rec = _registry.find((s) => s.name === name);
  if (!rec) return null;
  Object.assign(rec, patch || {});
  return rec;
}

/** Удалить вид из реестра. */
function remove(name) {
  const before = _registry.length;
  _registry = _registry.filter((s) => s.name !== name);
  return _registry.length < before;
}

/** Получить запись вида. */
function get(name) {
  return _registry.find((s) => s.name === name) || null;
}

/** Список видов реестра (копии). */
function list() {
  return _registry.map((s) => Object.assign({}, s));
}

/* -------------------------------------------------------------------------- */
/* 4. Нормализация и расчёт риска                                             */
/* -------------------------------------------------------------------------- */

/** Приводит «сырую» запись вида к безопасной структуре. */
function normalizeSpecies(raw) {
  const s = raw || {};
  return {
    name: String(s.name || s.species || 'unknown'),
    population: Number.isFinite(s.population) ? s.population : 0,
    growthRate: Number.isFinite(s.growthRate) ? s.growthRate : 0,
    habitat: String(s.habitat || 'unknown'),
    generation: Number.isFinite(s.generation) ? s.generation : 0,
    fitnest: Number.isFinite(s.fitnest) ? s.fitnest : 0,
  };
}

/**
 * Числовой балл риска вымирания (0 — стабилен, 100 — вымирание).
 * @param {object} species нормализованный вид
 * @returns {number} 0..100
 */
function extinctionScore(species) {
  const t = CONFIG;
  let score = 0;

  // 1. Численность популяции.
  if (species.population <= t.criticalPopulation) score += 60;
  else if (species.population <= t.endangeredPopulation) score += 40;
  else if (species.population <= t.vulnerablePopulation) score += 20;

  // 2. Динамика популяции.
  if (species.growthRate <= t.collapseGrowth) score += 25;
  else if (species.growthRate < t.staleGrowth) score += 12;
  else if (species.growthRate === t.staleGrowth) score += 4; // стагнация

  // 3. Зрелость линии.
  if (species.generation < t.minGeneration) score += 10;

  // 4. Приспособленность.
  if (species.fitnest < t.minFitnest) score += 15;
  else if (species.fitnest < 0.6) score += 6;

  // 5. Хрупкость среды обитания.
  if (t.fragileHabitats.indexOf(species.habitat) !== -1) score += 8;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Классификация уровня риска по баллу. */
function classifyRisk(score) {
  if (score >= 70) return RISK_LEVELS.CRITICAL;
  if (score >= 45) return RISK_LEVELS.HIGH;
  if (score >= 25) return RISK_LEVELS.MEDIUM;
  if (score >= 10) return RISK_LEVELS.LOW;
  return RISK_LEVELS.STABLE;
}

/** Подбор действия по уровню риска и характеру вида. */
function chooseAction(species, risk, score) {
  if (risk === RISK_LEVELS.CRITICAL) return ACTIONS.critical;
  if (risk === RISK_LEVELS.HIGH) {
    // Виды в особо хрупких биомах эвакуируем с закладкой семенного банка.
    return CONFIG.fragileHabitats.indexOf(species.habitat) !== -1
      ? 'relocation-and-seed-bank'
      : ACTIONS.high;
  }
  if (risk === RISK_LEVELS.MEDIUM) {
    // Средний риск + падающая приспособленность -> усилить разнообразие.
    return species.fitnest < 0.5 ? 'genetic-diversity-boost' : ACTIONS.medium;
  }
  if (risk === RISK_LEVELS.LOW) return ACTIONS.low;
  return ACTIONS.stable;
}

/** Человекочитаемое пояснение решения. */
function explain(species, risk, score) {
  return [
    `${species.name} population=${species.population}`,
    `growth=${species.growthRate}`,
    `fitnest=${species.fitnest}`,
    `habitat=${species.habitat}`,
    `score=${score}`,
    `risk=${risk}`,
  ].join(' | ');
}

/* -------------------------------------------------------------------------- */
/* 5. Главная функция                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Основная проверка: принимает список видов (или берет реестр) и возвращает
 * массив решений [{ species, risk, action, score, detail }].
 * @param {Array} [speciesList]
 * @returns {Array<{species:string,risk:string,action:string,score:number,detail:string}>}
 */
function check(speciesList) {
  const list = Array.isArray(speciesList) && speciesList.length
    ? speciesList
    : _registry;

  const report = list.map((raw) => {
    const species = normalizeSpecies(raw);
    const score = extinctionScore(species);
    const risk = classifyRisk(score);
    const action = chooseAction(species, risk, score);
    return {
      species: species.name,
      risk,
      action,
      score,
      detail: explain(species, risk, score),
    };
  });

  _lastReport = report;
  _checkCount += 1;
  return report;
}

/** Сводка по последнему отчёту: количество видов на каждом уровне риска. */
function summarize(report) {
  const src = Array.isArray(report) ? report : _lastReport;
  const out = { total: src.length };
  for (const level of RISK_ORDER) out[level] = 0;
  for (const entry of src) {
    out[entry.risk] = (out[entry.risk] || 0) + 1;
  }
  return out;
}

/** Виды, требующие немедленного вмешательства (high + critical). */
function urgent(report) {
  const src = Array.isArray(report) ? report : _lastReport;
  return src.filter(
    (e) => e.risk === RISK_LEVELS.CRITICAL || e.risk === RISK_LEVELS.HIGH
  );
}

/** Агрегированная статистика модуля. */
function stats() {
  const s = summarize(_lastReport);
  return {
    checks: _checkCount,
    registrySize: _registry.length,
    summary: s,
    actionPriority: _lastReport
      .map((e) => (ACTION_META[e.action] ? ACTION_META[e.action].priority : 0))
      .reduce((a, b) => Math.max(a, b), 0),
  };
}

/** Best-effort чтение списка видов с диска. */
function loadSpecies(file) {
  try {
    const target = file || path.join(__dirname, '..', 'data', 'species.json');
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.species)) return parsed.species;
  } catch (e) {
    /* молча игнорируем: работы без внешних данных допустима */
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 6. CLI                                                                     */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const args = { json: false, file: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--file') args.file = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const fromDisk = args.file ? loadSpecies(args.file) : null;
  if (fromDisk) setRegistry(fromDisk);

  const report = check();
  if (args.json) {
    console.log(JSON.stringify({ report, summary: summarize(report) }, null, 2));
  } else {
    console.log('=== Species Guard ===');
    for (const e of report) {
      console.log(`  [${e.risk.padEnd(8)}] ${e.species.padEnd(12)} -> ${e.action}`);
    }
    const s = summarize(report);
    console.log('summary:', JSON.stringify(s));
    const u = urgent(report);
    if (u.length) {
      console.log(`!! ${u.length} вид(ов) требуют вмешательства`);
      process.exitCode = 0;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 7. Экспорт                                                                 */
/* -------------------------------------------------------------------------- */

module.exports = {
  check,
  summarize,
  urgent,
  stats,
  loadSpecies,
  extinctionScore,
  classifyRisk,
  chooseAction,
  normalizeSpecies,
  register,
  update,
  remove,
  get,
  list,
  setRegistry,
  configure,
  reset,
  RISK_LEVELS,
  RISK_ORDER,
  ACTIONS,
  ACTION_META,
  DEFAULT_SPECIES,
  DEFAULTS,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
}
