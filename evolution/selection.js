// evolution/selection.js
// ─────────────────────────────────────────────────────────────────────────────
// Selection — единая точка входа для стратегий отбора родителей.
//
// Реализованы три чистые (без side effects) стратегии, работающие с массивом
// агентов вида { genome, fitness }:
//
//   tournament(pop, k)         — k-турнирный отбор, возвращает ровно 1 агента
//   roulette(pop, fitnessKey)  — рулетка/пропорциональный отбор, 1 агент
//   elitism(pop, n)            — элитизм, top-N агентов по fitness
//
//   select(pop, strategy, opts) — диспетчер: строка-имя или сама функция.
//
// Публичный API:
//     select(pop, strategy, opts) -> [{ genome, fitness }]
//     tournament(pop, k)          -> [{ genome, fitness }]  // длина 1
//     roulette(pop, fitnessKey)   -> [{ genome, fitness }]  // длина 1
//     elitism(pop, n)             -> [{ genome, fitness }]  // длина n
//     STRATEGIES                  -> { tournament, roulette, elitism }
//
// Инварианты: входной массив не мутируется, возвращаются новые объекты.
// Зависимости: только Node core. Ничего не пишет на диск.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Утилиты
// ─────────────────────────────────────────────────────────────────────────────

function asPopulation(pop) {
  return Array.isArray(pop) ? pop : [];
}

function fitnessOf(agent, key) {
  const raw = agent ? agent[key] : undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

// Возвращаем новый объект — входной агент не мутируется.
function cloneAgent(agent) {
  return {
    genome: agent ? agent.genome : undefined,
    fitness: agent ? agent.fitness : undefined,
  };
}

function pickIndex(rng, maxExclusive) {
  return Math.floor(rng() * maxExclusive);
}

// ─────────────────────────────────────────────────────────────────────────────
// Стратегии
// ─────────────────────────────────────────────────────────────────────────────

// k-турнирный отбор: берём k случайных агентов, побеждает лучший по fitness.
// Возвращает массив ровно из одного победителя (или [] для пустой популяции).
function tournament(pop, k, opts) {
  const population = asPopulation(pop);
  if (population.length === 0) return [];

  const options = opts || {};
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const key = options.fitnessKey || 'fitness';

  let size = Number.isFinite(Number(k)) ? Math.floor(Number(k)) : 2;
  if (size < 1) size = 1;
  if (size > population.length) size = population.length;

  let best = null;
  let bestFitness = -Infinity;

  for (let i = 0; i < size; i += 1) {
    const idx = pickIndex(rng, population.length);
    const candidate = population[idx];
    const f = fitnessOf(candidate, key);
    if (best === null || f > bestFitness) {
      best = candidate;
      bestFitness = f;
    }
  }

  return [cloneAgent(best)];
}

// Рулетка (fitness-proportional): вероятность пропорциональна fitness.
// Устойчива к краевому случаю, когда все фитнесы = 0 (uniform fallback),
// а также к отрицательным значениям (обрезаем до 0).
function roulette(pop, fitnessKey, opts) {
  const population = asPopulation(pop);
  if (population.length === 0) return [];

  const options = opts || {};
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const key = typeof fitnessKey === 'string' && fitnessKey ? fitnessKey : options.fitnessKey || 'fitness';

  const weights = population.map((a) => {
    const f = fitnessOf(a, key);
    return f > 0 ? f : 0; // отрицательные/NaN → 0
  });

  const total = weights.reduce((s, w) => s + w, 0);

  // Краевой случай: сумма весов 0 → равномерный выбор (не падаем).
  if (!(total > 0)) {
    return [cloneAgent(population[pickIndex(rng, population.length)])];
  }

  let threshold = rng() * total;
  for (let i = 0; i < population.length; i += 1) {
    threshold -= weights[i];
    if (threshold < 0) return [cloneAgent(population[i])];
  }
  // Страховка от накопленной погрешности с плавающей точкой.
  return [cloneAgent(population[population.length - 1])];
}

// Элитизм: возвращаем top-N агентов по fitness (по убыванию).
function elitism(pop, n, opts) {
  const population = asPopulation(pop);
  if (population.length === 0) return [];

  const options = opts || {};
  const key = options.fitnessKey || 'fitness';

  let size = Number.isFinite(Number(n)) ? Math.floor(Number(n)) : 1;
  if (size < 0) size = 0;
  if (size > population.length) size = population.length;

  return population
    .map((agent, index) => ({ agent, index, fitness: fitnessOf(agent, key) }))
    .sort((a, b) => (b.fitness - a.fitness) || (a.index - b.index))
    .slice(0, size)
    .map((entry) => cloneAgent(entry.agent));
}

// ─────────────────────────────────────────────────────────────────────────────
// Диспетчер
// ─────────────────────────────────────────────────────────────────────────────

const STRATEGIES = {
  tournament,
  roulette,
  elitism,
};

// select(pop, strategy, opts)
//   strategy — имя ('tournament'|'roulette'|'elitism') или функция
//   opts     — { k, n, fitnessKey, rng, ... }
function select(pop, strategy, opts) {
  const options = opts || {};

  if (typeof strategy === 'function') {
    return strategy(pop, options.k != null ? options.k : options.n, options);
  }

  const name = String(strategy || '').toLowerCase();
  switch (name) {
    case 'tournament':
      return tournament(pop, options.k, options);
    case 'roulette':
      return roulette(pop, options.fitnessKey, options);
    case 'elitism':
      return elitism(pop, options.n != null ? options.n : options.k, options);
    default:
      throw new Error(`select: unknown strategy "${strategy}"`);
  }
}

module.exports = {
  select,
  tournament,
  roulette,
  elitism,
  STRATEGIES,
};

// ─────────────────────────────────────────────────────────────────────────────
// Smoke-тест (node evolution/selection.js)
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const pop = Array.from({ length: 10 }, (_, i) => ({
    genome: { id: i, genes: [i, i + 1, i + 2] },
    fitness: (i * 7) % 10, // гарантированно включает нули
  }));

  // 1) tournament -> ровно 1 победитель
  const t = select(pop, 'tournament', { k: 4 });
  if (!Array.isArray(t) || t.length !== 1) {
    throw new Error(`tournament должен вернуть ровно 1, получено ${t.length}`);
  }
  const tDirect = tournament(pop, 3);
  if (tDirect.length !== 1) {
    throw new Error('tournament(pop, k) должен вернуть ровно 1');
  }

  // 2) elitism -> ровно n
  const n = 4;
  const e = select(pop, 'elitism', { n });
  if (e.length !== n) {
    throw new Error(`elitism должен вернуть ровно ${n}, получено ${e.length}`);
  }
  // top-N отсортирован по убыванию fitness
  for (let i = 1; i < e.length; i += 1) {
    if (e[i - 1].fitness < e[i].fitness) {
      throw new Error('elitism вернул не отсортированный top-N');
    }
  }

  // 3) roulette не падает при нулевых фитнесах
  const zeroPop = Array.from({ length: 10 }, (_, i) => ({
    genome: { id: i },
    fitness: 0,
  }));
  const r = select(zeroPop, 'roulette', { fitnessKey: 'fitness' });
  if (!Array.isArray(r) || r.length !== 1) {
    throw new Error('roulette должен вернуть ровно 1 агента');
  }
  const rNormal = roulette(pop, 'fitness');
  if (rNormal.length !== 1) {
    throw new Error('roulette(pop, fitnessKey) должен вернуть ровно 1');
  }

  // Чистота: входной массив не изменился
  if (pop.length !== 10 || pop[0].fitness !== 0) {
    throw new Error('стратегии не должны мутировать входную популяцию');
  }

  console.log('selection smoke OK: 3 strategies, edge case fitness=0 passed');
}
