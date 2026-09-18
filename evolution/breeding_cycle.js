#!/usr/bin/env node
/**
 * evolution/breeding_cycle.js — Цикл размножения (Breeding Cycle)
 * ============================================================================
 * Назначение:
 *   Моделирует один или несколько циклов полового размножения в эволюции
 *   агентов. На входе — популяция геномов, на выходе — новое поколение,
 *   полученное через отбор родителей, кроссовер, мутацию и элитизм.
 *
 *   Цикл устроен как конвейер стадий:
 *     1. Оценка приспособленности (fitness) каждого генома.
 *     2. Отбор родителей (tournament / roulette / rank / truncation).
 *     3. Формирование пар и кроссовер геномов.
 *     4. Мутация потомков с заданной интенсивностью.
 *     5. Элитизм — лучшие особи переходят в новое поколение без изменений.
 *     6. Заполнение популяции до целевого размера и смена поколения.
 *
 * Публичный API (модуль):
 *   - cycle(population, options) -> Generation
 *       Основная функция. Прогоняет один полный цикл размножения.
 *
 *   - Genome                         класс генома (genes, fitness, mutate)
 *   - createPopulation(size, opts)   -> Genome[]
 *   - evaluate(pop, fn)              -> Genome[]
 *   - select(pop, count, strategy)   -> Genome[]
 *   - crossover(a, b, options)       -> Genome
 *   - configure(options)             -> config
 *   - stats()                        -> object
 *   - reset()                        -> this
 *
 * Модель Generation:
 *   { index, parents, offspring, population, best, mean, diversity, ts }
 *
 * Время и генератор случайных чисел инъектируются, что делает модуль
 * детерминированным и пригодным для тестов:
 *   configure({ now, rng, fitness }).
 * ----------------------------------------------------------------------------
 */

'use strict';

/* -------------------------------------------------------------------------- */
/* Константы                                                                   */
/* -------------------------------------------------------------------------- */

const STRATEGIES = Object.freeze({
  TOURNAMENT: 'tournament',
  ROULETTE: 'roulette',
  RANK: 'rank',
  TRUNCATION: 'truncation',
});

const DEFAULTS = {
  populationSize: 40,
  eliteCount: 4,           // сколько лучших переходит без изменений
  tournamentSize: 3,       // размер турнира при отборе
  mutationRate: 0.08,      // вероятность мутации отдельного гена
  mutationScale: 0.25,     // амплитуда мутации относительно диапазона гена
  crossoverMix: 0.5,       // «вес» родителя A в потомке (uniform crossover)
  strategy: STRATEGIES.TOURNAMENT,
  geneCount: 8,
  geneMin: 0,
  geneMax: 1,
  seedGenes: null,         // функция либо массив стартовых значений
};

/* -------------------------------------------------------------------------- */
/* Внутреннее состояние модуля                                                 */
/* -------------------------------------------------------------------------- */

let _cycleIndex = 0;
let _seq = 0;
let _now = () => Date.now();
let _rng = Math.random;
let _fitnessFn = null;                 // пользовательская функция приспособленности
const _history = [];                   // история прогонов cycle()
const _counters = { cycles: 0, offspring: 0, mutations: 0, evaluated: 0 };

/* -------------------------------------------------------------------------- */
/* Утилиты                                                                     */
/* -------------------------------------------------------------------------- */

function _isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function _isFunction(value) {
  return typeof value === 'function';
}

function _clamp(value, lo, hi) {
  if (typeof value !== 'number' || Number.isNaN(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

function _nextId() {
  _seq += 1;
  return `genome-${_seq.toString(36)}`;
}

function _rand() {
  const value = _rng();
  if (typeof value !== 'number' || Number.isNaN(value)) return Math.random();
  return value < 0 ? 0 : value >= 1 ? 0.999999 : value;
}

function _randInt(maxExclusive) {
  return Math.floor(_rand() * maxExclusive);
}

function _shuffle(array) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = _randInt(i + 1);
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

function _mean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  return sum / values.length;
}

/* -------------------------------------------------------------------------- */
/* Genome                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Геном — вектор числовых генов в пределах [min, max] плюс приспособленность.
 */
class Genome {
  constructor({ genes, min, max, origin, parents, generation }) {
    this.id = _nextId();
    this.genes = Array.isArray(genes) ? genes.slice() : [];
    this.min = typeof min === 'number' ? min : DEFAULTS.geneMin;
    this.max = typeof max === 'number' ? max : DEFAULTS.geneMax;
    this.fitness = null;
    this.origin = origin || 'seed';      // seed | elite | crossover | mutation
    this.parents = Array.isArray(parents) ? parents.slice() : [];
    this.generation = typeof generation === 'number' ? generation : 0;
    this.mutations = 0;
    this.createdAt = _now();
  }

  /** Число генов (длина хромосомы). */
  get size() {
    return this.genes.length;
  }

  /** Оценка приспособленности; значение кэшируется. */
  evaluate(fn) {
    const scorer = _isFunction(fn) ? fn : _fitnessFn;
    if (!_isFunction(scorer)) {
      throw new TypeError('Genome.evaluate: fitness function is required');
    }
    this.fitness = Number(scorer(this)) || 0;
    _counters.evaluated += 1;
    return this.fitness;
  }

  /** Точечная мутация генов с заданной вероятностью и амплитудой. */
  mutate(rate, scale) {
    const p = _clamp(typeof rate === 'number' ? rate : DEFAULTS.mutationRate, 0, 1);
    const s = _clamp(typeof scale === 'number' ? scale : DEFAULTS.mutationScale, 0, 1);
    const span = this.max - this.min;
    let count = 0;
    for (let i = 0; i < this.genes.length; i += 1) {
      if (_rand() < p) {
        const delta = (_rand() * 2 - 1) * span * s;
        this.genes[i] = _clamp(this.genes[i] + delta, this.min, this.max);
        count += 1;
      }
    }
    this.mutations += count;
    _counters.mutations += count;
    return count;
  }

  /** Копия генома (для элитизма). */
  clone(origin) {
    const copy = new Genome({
      genes: this.genes,
      min: this.min,
      max: this.max,
      origin: origin || 'elite',
      parents: [this.id],
      generation: this.generation,
    });
    copy.fitness = this.fitness;
    return copy;
  }

  toJSON() {
    return {
      id: this.id,
      genes: this.genes.map((g) => +g.toFixed(6)),
      fitness: this.fitness,
      origin: this.origin,
      generation: this.generation,
      mutations: this.mutations,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Фабрика популяции                                                           */
/* -------------------------------------------------------------------------- */

function _randomGenes(count, min, max) {
  const genes = new Array(count);
  for (let i = 0; i < count; i += 1) genes[i] = min + _rand() * (max - min);
  return genes;
}

/**
 * Создать стартовую популяцию из `size` случайных геномов.
 */
function createPopulation(size, options) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  const count = Math.max(1, Math.floor(size || opts.populationSize));
  const pop = [];
  for (let i = 0; i < count; i += 1) {
    let genes;
    if (_isFunction(opts.seedGenes)) genes = opts.seedGenes(i, opts);
    else if (Array.isArray(opts.seedGenes) && opts.seedGenes[i]) genes = opts.seedGenes[i];
    else genes = _randomGenes(opts.geneCount, opts.geneMin, opts.geneMax);
    pop.push(new Genome({
      genes,
      min: opts.geneMin,
      max: opts.geneMax,
      origin: 'seed',
      generation: 0,
    }));
  }
  return pop;
}

/* -------------------------------------------------------------------------- */
/* Оценка и отбор                                                              */
/* -------------------------------------------------------------------------- */

/** Оценить приспособленность всей популяции; возвращает отсортированный массив. */
function evaluate(pop, fn) {
  for (let i = 0; i < pop.length; i += 1) pop[i].evaluate(fn);
  return pop.slice().sort((a, b) => b.fitness - a.fitness);
}

/** Турнирный отбор одной особи. */
function _tournament(pop, size) {
  const k = Math.max(1, Math.floor(size || DEFAULTS.tournamentSize));
  let best = null;
  for (let i = 0; i < k; i += 1) {
    const candidate = pop[_randInt(pop.length)];
    if (!best || candidate.fitness > best.fitness) best = candidate;
  }
  return best;
}

/** Рулеточный отбор (пропорционально приспособленности). */
function _roulette(pop) {
  const minFit = Math.min(...pop.map((g) => g.fitness));
  const shift = minFit < 0 ? -minFit + 1e-9 : 0;
  const total = pop.reduce((acc, g) => acc + (g.fitness + shift), 0);
  if (total <= 0) return pop[_randInt(pop.length)];
  let pick = _rand() * total;
  for (let i = 0; i < pop.length; i += 1) {
    pick -= pop[i].fitness + shift;
    if (pick <= 0) return pop[i];
  }
  return pop[pop.length - 1];
}

/** Ранговый отбор (линейные ранги). */
function _rank(pop) {
  const sorted = pop.slice().sort((a, b) => a.fitness - b.fitness);
  const n = sorted.length;
  const total = (n * (n + 1)) / 2;
  let pick = _rand() * total;
  for (let i = 0; i < n; i += 1) {
    pick -= i + 1;
    if (pick <= 0) return sorted[i];
  }
  return sorted[n - 1];
}

/**
 * Отобрать `count` родителей заданной стратегией.
 * `pop` предполагается уже отсортированной по убыванию fitness.
 */
function select(pop, count, strategy, options) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  const need = Math.max(0, Math.floor(count));
  const chosen = [];
  const strat = strategy || opts.strategy;

  if (strat === STRATEGIES.TRUNCATION) {
    for (let i = 0; i < need; i += 1) chosen.push(pop[i % pop.length]);
    return chosen;
  }

  if (strat === STRATEGIES.ROULETTE) {
    for (let i = 0; i < need; i += 1) chosen.push(_roulette(pop));
    return chosen;
  }

  if (strat === STRATEGIES.RANK) {
    for (let i = 0; i < need; i += 1) chosen.push(_rank(pop));
    return chosen;
  }

  for (let i = 0; i < need; i += 1) chosen.push(_tournament(pop, opts.tournamentSize));
  return chosen;
}

/* -------------------------------------------------------------------------- */
/* Скрещивание и мутация                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Uniform-кроссовер двух родителей -> новый геном-потомок.
 */
function crossover(parentA, parentB, options) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  const mix = _clamp(opts.crossoverMix, 0, 1);
  const len = Math.min(parentA.genes.length, parentB.genes.length);
  const genes = new Array(len);
  for (let i = 0; i < len; i += 1) {
    genes[i] = _rand() < mix ? parentA.genes[i] : parentB.genes[i];
  }
  const child = new Genome({
    genes,
    min: parentA.min,
    max: parentA.max,
    origin: 'crossover',
    parents: [parentA.id, parentB.id],
    generation: Math.max(parentA.generation, parentB.generation) + 1,
  });
  _counters.offspring += 1;
  return child;
}

/**
 * Сформировать пару из пула родителей (без самоспаривания, если возможно).
 */
function _pair(pool, used) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const a = pool[_randInt(pool.length)];
    const b = pool[_randInt(pool.length)];
    if (a !== b && a.id !== b.id) return [a, b];
  }
  // fallback: перемешать и взять две непохожие записи
  const shuffled = _shuffle(pool);
  const a = shuffled[0];
  const b = shuffled[1] || shuffled[0];
  used.add(a.id);
  used.add(b.id);
  return [a, b];
}

/* -------------------------------------------------------------------------- */
/* Метрики                                                                     */
/* -------------------------------------------------------------------------- */

/** Генетическое разнообразие = средняя попарная дистанция по генам. */
function diversity(pop) {
  if (pop.length < 2) return 0;
  const dims = pop[0].genes.length || 1;
  let sum = 0;
  let pairs = 0;
  const cap = Math.min(pop.length, 30);
  for (let i = 0; i < cap; i += 1) {
    for (let j = i + 1; j < cap; j += 1) {
      let dist = 0;
      for (let k = 0; k < dims; k += 1) {
        dist += Math.abs((pop[i].genes[k] || 0) - (pop[j].genes[k] || 0));
      }
      sum += dist / dims;
      pairs += 1;
    }
  }
  return pairs ? sum / pairs : 0;
}

function _summarize(pop) {
  const fits = pop.map((g) => g.fitness || 0);
  const sorted = pop.slice().sort((a, b) => b.fitness - a.fitness);
  return {
    best: sorted[0] || null,
    worst: sorted[sorted.length - 1] || null,
    meanFitness: +_mean(fits).toFixed(6),
    maxFitness: sorted.length ? sorted[0].fitness : 0,
    diversity: +diversity(pop).toFixed(6),
  };
}

/* -------------------------------------------------------------------------- */
/* Основной цикл                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Прогнать один полный цикл размножения.
 *
 * @param {Genome[]} [population]  текущая популяция (если не задана — создаётся)
 * @param {object}   [options]    переопределение настроек цикла
 * @returns {object} Generation    описание нового поколения
 */

// 15.09: loadPopulation — загрузка реальных агентов из боксов + fitness.json
function loadPopulation() {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');

  // 1. Список боксов
  const boxesDir = path.join(ROOT, 'boxes');
  let agentNames = [];
  try {
    agentNames = fs.readdirSync(boxesDir)
      .filter(f => /^agent_\d+$/.test(f) || /^agent_g2_[a-f0-9]+$/.test(f))
      .sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]));
  } catch (e) {}

  if (!agentNames.length) return [];

  // 2. fitness.json
  let fitnessData = { agents: {} };
  try {
    const f = path.join(ROOT, 'memory', 'fitness.json');
    if (fs.existsSync(f)) fitnessData = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {}

  // 3. Создаём настоящие Genome
  const agents = [];
  for (const name of agentNames) {
    const f = fitnessData.agents && fitnessData.agents[name];
    if (!f) continue;

    const seed = parseInt(name.split('_')[1]) || 1;
    const genes = [];
    for (let i = 0; i < 8; i++) {
      genes.push(((seed * (i + 1) * 13) % 100) / 100);
    }

    const g = new Genome({ genes, generation: 0 });
    g.name = name;
    g.fitness_external = f.fitness || 0;
    g.wins = f.wins_total || 0;
    g.races = f.runs_total || 0;
    g.score = f.last_score_avg || 0;

    // Переопределяем evaluate — 70% внешний fitness + 30% внутренний
    const origEval = g.evaluate.bind(g);
    g.evaluate = function(fn) {
      const external = (this.fitness_external || 0) / 10;
      const internal = origEval(fn) || 0;
      this.fitness = 0.7 * external + 0.3 * internal;
      return this.fitness;
    };

    // Фиксируем fitness сразу — чтобы до evaluate был не null
    g.fitness = g.fitness_external / 10;

    agents.push(g);
  }

  console.log(`[loadPopulation] ${agents.length} Genome (external fitness)`);
  return agents;
}


function cycle(population, options) {
  // 15.09: авто-загрузка из fitness.json, если population не передан
  if (!Array.isArray(population) || !population.length) {
    try {
      population = loadPopulation();
      if (!population.length) {
        console.error('[cycle] loadPopulation вернул 0 агентов');
        return { ok: false, error: 'empty population' };
      }
    } catch (e) {
      console.error('[cycle] loadPopulation падает:', e.message);
      return { ok: false, error: e.message };
    }
  }
  const opts = { ...DEFAULTS, ...(options || {}) };
  const fitnessFn = _isFunction(opts.fitness) ? opts.fitness : _fitnessFn;
  // Если фитнес-функция не задана — используем эвристику по норме генов.
  const scorer = _isFunction(fitnessFn)
    ? fitnessFn
    : (g) => g.genes.reduce((acc, v) => acc + v * v, 0);

  let pop = Array.isArray(population) && population.length
    ? population.slice()
    : createPopulation(opts.populationSize, opts);

  // 1. Оценка приспособленности.
  pop = evaluate(pop, scorer);

  // 2. Отбор родителей.
  const parentCount = Math.max(2, Math.floor(pop.length * 0.6));
  const parents = select(pop, parentCount, opts.strategy, opts);

  // 3. Элитизм.
  const eliteCount = _clamp(Math.floor(opts.eliteCount), 0, pop.length);
  const next = [];
  for (let i = 0; i < eliteCount; i += 1) {
    next.push(pop[i].clone('elite'));
  }

  // 4. Размножение до заполнения популяции.
  const target = Math.max(1, Math.floor(opts.populationSize || pop.length));
  const used = new Set();
  let guard = 0;
  while (next.length < target && guard < target * 20) {
    guard += 1;
    const [a, b] = _pair(parents, used);
    const child = crossover(a, b, opts);
    child.mutate(opts.mutationRate, opts.mutationScale);
    child.evaluate(scorer);
    next.push(child);
  }

  // 5. Заполнение «хвоста», если guard не успел.
  while (next.length < target) {
    const parent = parents[_randInt(parents.length)] || pop[0];
    const child = parent.clone('elite');
    child.mutate(opts.mutationRate, opts.mutationScale);
    child.evaluate(scorer);
    next.push(child);
  }

  // 6. Сортировка и смена поколения.
  next.sort((x, y) => y.fitness - x.fitness);
  _cycleIndex += 1;
  _counters.cycles += 1;

  const summary = _summarize(next);
  const generation = {
    index: _cycleIndex,
    parents: parents.map((g) => g.id),
    offspring: next.length,
    elite: eliteCount,
    strategy: opts.strategy,
    best: summary.best ? summary.best.toJSON() : null,
    mean: summary.meanFitness,
    max: summary.maxFitness,
    diversity: summary.diversity,
    population: next,
    ts: _now(),
  };

  _history.push({
    index: generation.index,
    size: next.length,
    max: generation.max,
    mean: generation.mean,
    diversity: generation.diversity,
    ts: generation.ts,
  });

  // 15.09: логирование цикла в memory/breeding_cycles.jsonl
  try {
    const fs = require('fs');
    const path = require('path');
    const logFile = path.join(__dirname, '..', 'memory', 'breeding_cycles.jsonl');

    const record = {
      id: require('crypto').randomBytes(8).toString('hex'),
      generation: generation.index,
      parents: (parents || []).map((g) => ({
        id: g.id || g,
        name: g.name || g.id || g,
        fitness: typeof g === 'object' ? g.fitness : null,
        fitness_external: typeof g === 'object' ? g.fitness_external : null,
      })),
      offspring: (next || []).filter((g) => g.origin === 'crossover').slice(0, 8).map((g) => ({
        id: g.id,
        name: g.name || g.id,
        fitness: g.fitness,
        parents: g.parents,
        origin: g.origin,
        generation: g.generation,
      })),
      fitness: {
        parents: generation.parents && generation.parents.length
          ? +(generation.parents.reduce((s, g) => s + (g.fitness || 0), 0) / generation.parents.length).toFixed(4)
          : 0,
        offspring: generation.mean || 0,
        max: generation.max || 0,
      },
      population: {
        before: population.length,
        after: next.length,
      },
      diversity: generation.diversity,
      ts: new Date().toISOString(),
    };

    fs.appendFileSync(logFile, JSON.stringify(record) + '\n');
  } catch (e) {
    console.error('[cycle] лог-ошибка:', e.message);
  }

  // 16.09: ДЕТИ → БОКСЫ (эволюция в ФС)
  // Топ-3 crossover-ребёнка создаются как boxes/agent_g2_<hash>/
  try {
    materializeChildren(next, population);
  } catch (e) {
    console.error('[cycle] materialize ошибка:', e.message);
  }

  return generation;
}

// === 16.09: Материализация детей в boxes/ ===
function materializeChildren(next, parents) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const ROOT = path.join(__dirname, '..');
  const BOXES = path.join(ROOT, 'boxes');

  // 1. Топ-3 crossover-ребёнка
  const children = (next || [])
    .filter(g => g.origin === 'crossover' && g.genes && g.genes.length)
    .slice(0, 3);

  if (!children.length) return;

  // 2. Эталон _runner.js
  const templateRunner = fs.readFileSync(
    path.join(BOXES, 'agent_1', '_runner.js'), 'utf8'
  );

  // 3. Для каждого — создать бокс
  for (const child of children) {
    const hash = crypto.createHash('sha1')
      .update(JSON.stringify(child.genes))
      .digest('hex').slice(0, 6);
    const boxName = `agent_g2_${hash}`;
    const boxDir = path.join(BOXES, boxName);

    if (fs.existsSync(boxDir)) continue;   // уже есть

    fs.mkdirSync(boxDir, { recursive: true });
    fs.writeFileSync(path.join(boxDir, '_runner.js'), templateRunner);

    // DNA.md — гены
    const dnaLines = [
      `# ${boxName}`,
      '',
      `**Рождён:** ${new Date().toISOString()}`,
      `**Origin:** crossover`,
      `**Generation:** ${child.generation || 1}`,
      `**Fitness (на момент рождения):** ${child.fitness}`,
      `**Parents:** ${(child.parents || []).join(', ')}`,
      '',
      '## Гены',
      '```json',
      JSON.stringify(child.genes, null, 2),
      '```',
      '',
      '## Родители',
      ...(parents || [])
        .filter(p => p.fitness)
        .sort((a, b) => (b.fitness || 0) - (a.fitness || 0))
        .slice(0, 5)
        .map(p => `- ${p.name}: fitness=${p.fitness}, ext=${p.fitness_external || '—'}`),
    ];
    fs.writeFileSync(path.join(boxDir, 'DNA.md'), dnaLines.join('\n'));

    // .env из эталона (для ключей)
    try {
      const envSrc = path.join(BOXES, 'agent_1', '.env');
      if (fs.existsSync(envSrc)) {
        fs.copyFileSync(envSrc, path.join(boxDir, '.env'));
      }
    } catch (e) {}

    console.log(`[materialize] ✅ Создан бокс: ${boxName} (fitness=${child.fitness})`);

    // 4. Fitness.json — добавляем ребёнка
    try {
      const fitnessFile = path.join(ROOT, 'memory', 'fitness.json');
      const fit = JSON.parse(fs.readFileSync(fitnessFile, 'utf8'));
      if (!fit.agents[boxName]) {
        fit.agents[boxName] = {
          box: boxName,
          fitness: child.fitness || 0,
          runs_total: 0,
          wins_total: 0,
          last_score_avg: 0,
          born_at: new Date().toISOString(),
          parents: child.parents,
          generation: child.generation || 1,
        };
        fs.writeFileSync(fitnessFile, JSON.stringify(fit, null, 2));
      }
    } catch (e) {}
  }
}

/* -------------------------------------------------------------------------- */
/* Конфигурация и статистика                                                   */
/* -------------------------------------------------------------------------- */

/** Задать пользовательские настройки (rng, now, fitness). */
function configure(options) {
  const opts = options || {};
  if (_isFunction(opts.rng)) _rng = opts.rng;
  if (_isFunction(opts.now)) _now = opts.now;
  if (_isFunction(opts.fitness)) _fitnessFn = opts.fitness;
  return { ...DEFAULTS };
}

/** Сводная статистика по всем прогонам. */
function stats() {
  const maxima = _history.map((h) => h.max);
  const means = _history.map((h) => h.mean);
  return {
    cycles: _counters.cycles,
    offspring: _counters.offspring,
    mutations: _counters.mutations,
    evaluated: _counters.evaluated,
    bestEver: maxima.length ? Math.max(...maxima) : null,
    meanOfMeans: +_mean(means).toFixed(6),
    lastDiversity: _history.length ? _history[_history.length - 1].diversity : 0,
    history: _history.slice(),
  };
}

/** Полный сброс состояния модуля. */
function reset() {
  _cycleIndex = 0;
  _seq = 0;
  _rng = Math.random;
  _now = () => Date.now();
  _fitnessFn = null;
  _history.length = 0;
  _counters.cycles = 0;
  _counters.offspring = 0;
  _counters.mutations = 0;
  _counters.evaluated = 0;
  return module.exports;
}

/* -------------------------------------------------------------------------- */
/* Экспорт                                                                     */
/* -------------------------------------------------------------------------- */

module.exports = { loadPopulation,
  cycle,
  Genome,
  createPopulation,
  evaluate,
  select,
  crossover,
  diversity,
  configure,
  stats,
  reset,
  STRATEGIES,
  DEFAULTS,
  _internals: { _tournament, _roulette, _rank, _shuffle, _rand },
};

/* -------------------------------------------------------------------------- */
/* CLI: быстрый демонстрационный прогон                                        */
/* -------------------------------------------------------------------------- */

if (require.main === module) {
  configure({
    fitness: (g) => 1 - g.genes.reduce((acc, v) => acc + (v - 0.7) ** 2, 0),
  });
  let pop = createPopulation(DEFAULTS.populationSize);
  for (let i = 0; i < 5; i += 1) {
    const gen = cycle(pop);
    pop = gen.population;
    console.log(
      `gen ${gen.index}: max=${gen.max.toFixed(4)} ` +
      `mean=${gen.mean.toFixed(4)} div=${gen.diversity.toFixed(4)}`,
    );
  }
  console.log('stats:', JSON.stringify(stats(), null, 0).slice(0, 200));
}
