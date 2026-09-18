/**
 * evolution/generation_report.js
 * -------------------------------------------------------------
 * Генератор отчёта поколения (generation report).
 *
 * Модуль собирает сводку по одному поколению эволюции: список агентов,
 * их приспособленность, динамику изменений относительно предыдущего
 * поколения, распределение стратегий, выживаемость, мутации и итоговый
 * вердикт. Работает полностью офлайн и детерминированно.
 *
 * API:
 *   report(gen) -> GenerationReport
 *
 * GenerationReport:
 *   {
 *     generation,            // номер поколения
 *     createdAt,             // ISO timestamp
 *     population,            // число агентов
 *     fitness: {min,max,avg,survivalRate},
 *     strategies: {name: count},
 *     mutations,             // число мутаций
 *     mutationsByType,       // {type: count}
 *     best, worst,           // записи агентов
 *     prevComparison,        // сравнение с предыдущим поколением
 *     verdict,               // 'ascend' | 'stay' | 'collapse'
 *     text                   // человекочитаемый отчёт
 *   }
 * -------------------------------------------------------------
 */

'use strict';

const VERSION = '1.0.0';

/* ------------------------------------------------------------------ */
/* Вспомогательные утилиты                                            */
/* ------------------------------------------------------------------ */

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round(v, digits) {
  const p = Math.pow(10, digits == null ? 2 : digits);
  return Math.round(v * p) / p;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = mean(arr.map((x) => (x - m) * (x - m)));
  return Math.sqrt(v);
}

/* ------------------------------------------------------------------ */
/* Нормализация входа                                                 */
/* ------------------------------------------------------------------ */

/**
 * Приводит произвольное описание поколения к единому виду.
 * Поддерживает несколько распространённых форматов входа.
 */
function normalizeGen(gen) {
  if (Array.isArray(gen)) {
    return { generation: 0, agents: gen, mutations: [] };
  }
  if (!isObj(gen)) {
    return { generation: 0, agents: [], mutations: [] };
  }
  const agents = Array.isArray(gen.agents)
    ? gen.agents
    : Array.isArray(gen.population)
    ? gen.population
    : [];
  const mutations = Array.isArray(gen.mutations) ? gen.mutations : [];
  return {
    generation: num(gen.generation != null ? gen.generation : gen.gen, 0),
    agents,
    mutations,
    prev: isObj(gen.prev) ? gen.prev : null,
    meta: isObj(gen.meta) ? gen.meta : {},
  };
}

function normalizeAgent(a, idx) {
  if (typeof a === 'number') {
    return { id: 'agent-' + idx, fitness: a, strategy: 'default', alive: true };
  }
  const o = isObj(a) ? a : {};
  const fit = num(
    o.fitness != null ? o.fitness : o.score != null ? o.score : o.f,
    0
  );
  return {
    id: o.id != null ? String(o.id) : 'agent-' + idx,
    fitness: fit,
    strategy: o.strategy != null ? String(o.strategy) : o.role || 'default',
    alive: o.alive !== false && o.dead !== true,
    parent: o.parent != null ? String(o.parent) : null,
    age: num(o.age, 0),
    raw: o,
  };
}

/* ------------------------------------------------------------------ */
/* Анализ популяции                                                   */
/* ------------------------------------------------------------------ */

function analyzePopulation(agents) {
  const fits = agents.map((a) => a.fitness);
  const alive = agents.filter((a) => a.alive);
  return {
    population: agents.length,
    aliveCount: alive.length,
    deadCount: agents.length - alive.length,
    fitness: {
      min: fits.length ? Math.min.apply(null, fits) : 0,
      max: fits.length ? Math.max.apply(null, fits) : 0,
      avg: round(mean(fits), 3),
      median: round(median(fits), 3),
      stdev: round(stdev(fits), 3),
      total: round(fits.reduce((s, x) => s + x, 0), 3),
    },
    survivalRate: agents.length
      ? round(alive.length / agents.length, 3)
      : 0,
  };
}

function countStrategies(agents) {
  const out = {};
  for (const a of agents) {
    const key = a.strategy || 'default';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function countMutations(mutations) {
  const byType = {};
  let total = 0;
  for (const m of mutations) {
    const t = isObj(m) ? m.type || m.kind || 'unknown' : String(m);
    byType[t] = (byType[t] || 0) + 1;
    total++;
  }
  return { total, byType };
}

function pickExtremes(agents) {
  if (!agents.length) return { best: null, worst: null };
  let best = agents[0];
  let worst = agents[0];
  for (const a of agents) {
    if (a.fitness > best.fitness) best = a;
    if (a.fitness < worst.fitness) worst = a;
  }
  return {
    best: { id: best.id, fitness: best.fitness, strategy: best.strategy },
    worst: { id: worst.id, fitness: worst.fitness, strategy: worst.strategy },
  };
}

/* ------------------------------------------------------------------ */
/* Сравнение с предыдущим поколением                                  */
/* ------------------------------------------------------------------ */

function compareWithPrev(cur, prev) {
  if (!prev) {
    return {
      available: false,
      deltaAvgFitness: null,
      deltaPopulation: null,
      deltaSurvival: null,
      trend: 'baseline',
    };
  }
  const p = normalizeGen(prev);
  const pAgents = p.agents.map(normalizeAgent);
  const pStats = analyzePopulation(pAgents);
  const deltaAvg = round(cur.fitness.avg - pStats.fitness.avg, 3);
  const deltaPop = cur.population - pStats.population;
  const deltaSurv = round(cur.survivalRate - pStats.survivalRate, 3);
  let trend = 'flat';
  if (deltaAvg > 0.01) trend = 'up';
  else if (deltaAvg < -0.01) trend = 'down';
  return {
    available: true,
    deltaAvgFitness: deltaAvg,
    deltaPopulation: deltaPop,
    deltaSurvival: deltaSurv,
    trend,
  };
}

/* ------------------------------------------------------------------ */
/* Вердикт поколения                                                  */
/* ------------------------------------------------------------------ */

function decideVerdict(stats, cmp) {
  const surv = stats.survivalRate;
  const trend = cmp.available ? cmp.trend : 'baseline';

  if (surv >= 0.5 && (trend === 'up' || trend === 'baseline')) {
    return 'ascend';
  }
  if (surv < 0.2) return 'collapse';
  if (trend === 'down' && surv < 0.5) return 'collapse';
  return 'stay';
}

/* ------------------------------------------------------------------ */
/* Форматирование текстового отчёта                                   */
/* ------------------------------------------------------------------ */

function formatText(rep) {
  const L = [];
  L.push('=== GENERATION REPORT #' + rep.generation + ' ===');
  L.push('version: ' + VERSION + '  created: ' + rep.createdAt);
  L.push('');
  L.push('POPULATION: ' + rep.population +
    ' (alive ' + rep.aliveCount + ' / dead ' + rep.deadCount + ')');
  L.push('SURVIVAL RATE: ' + (rep.survivalRate * 100).toFixed(1) + '%');
  L.push('');
  L.push('FITNESS:');
  L.push('  min    = ' + rep.fitness.min);
  L.push('  max    = ' + rep.fitness.max);
  L.push('  avg    = ' + rep.fitness.avg);
  L.push('  median = ' + rep.fitness.median);
  L.push('  stdev  = ' + rep.fitness.stdev);
  L.push('');
  L.push('STRATEGIES:');
  const keys = Object.keys(rep.strategies);
  if (!keys.length) L.push('  (none)');
  for (const k of keys) L.push('  ' + k + ' -> ' + rep.strategies[k]);
  L.push('');
  L.push('MUTATIONS: ' + rep.mutations);
  for (const t of Object.keys(rep.mutationsByType)) {
    L.push('  ' + t + ' -> ' + rep.mutationsByType[t]);
  }
  L.push('');
  if (rep.best) {
    L.push('BEST:  ' + rep.best.id +
      ' (fit=' + rep.best.fitness + ', strat=' + rep.best.strategy + ')');
  }
  if (rep.worst) {
    L.push('WORST: ' + rep.worst.id +
      ' (fit=' + rep.worst.fitness + ', strat=' + rep.worst.strategy + ')');
  }
  L.push('');
  if (rep.prevComparison.available) {
    L.push('VS PREVIOUS GENERATION:');
    L.push('  dAvgFitness = ' + rep.prevComparison.deltaAvgFitness);
    L.push('  dPopulation = ' + rep.prevComparison.deltaPopulation);
    L.push('  dSurvival   = ' + rep.prevComparison.deltaSurvival);
    L.push('  trend       = ' + rep.prevComparison.trend);
  } else {
    L.push('VS PREVIOUS: baseline (no previous generation)');
  }
  L.push('');
  L.push('VERDICT: ' + rep.verdict.toUpperCase());
  L.push('=====================================');
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* Главная функция                                                    */
/* ------------------------------------------------------------------ */

/**
 * Строит отчёт поколения.
 * @param {object|Array} gen — описание поколения.
 * @returns {object} GenerationReport
 */
function report(gen) {
  const g = normalizeGen(gen);
  const agents = g.agents.map(normalizeAgent);
  const stats = analyzePopulation(agents);
  const strategies = countStrategies(agents);
  const mut = countMutations(g.mutations);
  const extremes = pickExtremes(agents);
  const cmp = compareWithPrev(stats, g.prev);
  const verdict = decideVerdict(stats, cmp);

  const out = {
    generation: g.generation,
    version: VERSION,
    createdAt: new Date().toISOString(),
    population: stats.population,
    aliveCount: stats.aliveCount,
    deadCount: stats.deadCount,
    survivalRate: stats.survivalRate,
    fitness: stats.fitness,
    strategies,
    mutations: mut.total,
    mutationsByType: mut.byType,
    best: extremes.best,
    worst: extremes.worst,
    prevComparison: cmp,
    verdict,
    meta: g.meta,
  };
  out.text = formatText(out);
  return out;
}

/* ------------------------------------------------------------------ */
/* Дополнительные хелперы                                             */
/* ------------------------------------------------------------------ */

/** Быстрая проверка здоровья популяции. */
function isHealthy(rep) {
  return rep.verdict === 'ascend' && rep.survivalRate >= 0.5;
}

/** Серия отчётов по массиву поколений. */
function reportSeries(gens) {
  return (gens || []).map((g, i) => {
    const copy = isObj(g) ? Object.assign({}, g) : { agents: g };
    if (copy.generation == null) copy.generation = i;
    if (i > 0 && copy.prev == null) copy.prev = gens[i - 1];
    return report(copy);
  });
}

module.exports = {
  report,
  reportSeries,
  isHealthy,
  VERSION,
  _internal: {
    normalizeGen,
    normalizeAgent,
    analyzePopulation,
    compareWithPrev,
    decideVerdict,
    formatText,
    mean,
    median,
    stdev,
    round,
    clamp,
  },
};
