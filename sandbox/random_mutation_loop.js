'use strict';

/**
 * sandbox/random_mutation_loop.js
 * ===============================
 *
 * A dependency-free "random mutation loop": an evolutionary engine that,
 * on every tick, mutates a small population of genomes, scores each one
 * with a fitness function and keeps the best individual. It is meant as a
 * sandbox playground for chaos/evolution experiments inside the project.
 *
 * Public API
 * ----------
 *   start(interval) -> starts the loop; runs a mutation batch every
 *                      `interval` milliseconds (defaults to 1000 ms).
 *                      Calling start() on an already running loop is a
 *                      no-op that simply returns the current state.
 *   stop()          -> stops the loop and returns a summary report
 *                      ({ generation, best, bestFitness, ticks, elapsedMs }).
 *
 * Extra helpers (handy for tests and embedding):
 *   once()          -> runs exactly one mutation batch synchronously
 *   onTick(fn)      -> subscribe to tick records (returns an unsubscribe fn)
 *   offTick(fn)     -> unsubscribe a previously registered listener
 *   getState()      -> returns a snapshot of the engine state
 *   reset()         -> clears all state back to defaults
 *
 * The engine never depends on external packages, so it can run in plain
 * Node, in a worker thread, or be required as a module.
 *
 * Standalone usage:
 *   node random_mutation_loop.js [interval] [ticks]
 */

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

const DEFAULT_INTERVAL = 1000; // ms between ticks
const DEFAULT_MUTATION_RATE = 0.25; // probability a gene mutates per tick
const DEFAULT_GENE_LENGTH = 32; // genome length in bases
const DEFAULT_POPULATION = 12; // number of individuals per generation
const MAX_HISTORY = 100; // ring-buffer size for tick records
const ALPHABET = 'ACGT'; // candidate "genes" (a tiny genome)

/* ------------------------------------------------------------------ */
/* Utilities                                                          */
/* ------------------------------------------------------------------ */

/** Random integer in [0, max). */
function randInt(max) {
  return Math.floor(Math.random() * max);
}

/** Pick a random element of an array. */
function pick(arr) {
  return arr[randInt(arr.length)];
}

/** Clamp a number into [lo, hi]. */
function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Arithmetic mean of an array of numbers. */
function mean(arr) {
  if (!arr.length) return 0;
  let sum = 0;
  for (const x of arr) sum += x;
  return sum / arr.length;
}

/* ------------------------------------------------------------------ */
/* Genome helpers                                                     */
/* ------------------------------------------------------------------ */

/** Create a random genome of the given length. */
function randomGene(length) {
  let out = '';
  for (let i = 0; i < length; i++) out += pick(ALPHABET);
  return out;
}

/** Split a genome into a mutable array of bases. */
function cloneGene(gene) {
  return gene.split('');
}

/* ------------------------------------------------------------------ */
/* Mutation strategies                                                */
/* ------------------------------------------------------------------ */

/**
 * Point mutation: flip a single base to a (different) random base.
 */
function mutatePoint(gene) {
  const bases = cloneGene(gene);
  const idx = randInt(bases.length);
  let replacement = pick(ALPHABET);
  while (replacement === bases[idx] && ALPHABET.length > 1) {
    replacement = pick(ALPHABET);
  }
  bases[idx] = replacement;
  return bases.join('');
}

/**
 * Insertion: add a random base at a random position.
 */
function mutateInsert(gene) {
  const bases = cloneGene(gene);
  const idx = randInt(bases.length + 1);
  bases.splice(idx, 0, pick(ALPHABET));
  return bases.join('');
}

/**
 * Deletion: remove a base (never shrinks below length 1).
 */
function mutateDelete(gene) {
  if (gene.length <= 1) return gene;
  const bases = cloneGene(gene);
  const idx = randInt(bases.length);
  bases.splice(idx, 1);
  return bases.join('');
}

/**
 * Inversion: reverse a random contiguous slice of the genome.
 */
function mutateInvert(gene) {
  if (gene.length < 2) return gene;
  const bases = cloneGene(gene);
  let a = randInt(bases.length);
  let b = randInt(bases.length);
  if (a > b) [a, b] = [b, a];
  const head = bases.slice(0, a);
  const mid = bases.slice(a, b + 1).reverse();
  const tail = bases.slice(b + 1);
  return head.concat(mid, tail).join('');
}

/**
 * Duplication: copy a slice and splice it back in elsewhere.
 */
function mutateDuplicate(gene) {
  if (gene.length < 2) return gene;
  const bases = cloneGene(gene);
  let a = randInt(bases.length);
  let b = randInt(bases.length);
  if (a > b) [a, b] = [b, a];
  const slice = bases.slice(a, b + 1);
  const insertAt = randInt(bases.length + 1);
  bases.splice(insertAt, 0, ...slice);
  return bases.join('');
}

/** Weighted catalogue of mutation strategies. */
const STRATEGIES = [
  { name: 'point', fn: mutatePoint, weight: 5 },
  { name: 'insert', fn: mutateInsert, weight: 2 },
  { name: 'delete', fn: mutateDelete, weight: 2 },
  { name: 'invert', fn: mutateInvert, weight: 1 },
  { name: 'duplicate', fn: mutateDuplicate, weight: 1 },
];

/** Choose a strategy respecting the configured weights. */
function weightedStrategy() {
  const total = STRATEGIES.reduce((sum, s) => sum + s.weight, 0);
  let r = Math.random() * total;
  for (const s of STRATEGIES) {
    r -= s.weight;
    if (r <= 0) return s;
  }
  return STRATEGIES[0];
}

/* ------------------------------------------------------------------ */
/* Fitness                                                            */
/* ------------------------------------------------------------------ */

/**
 * A toy fitness function: rewards GC-rich sequences close to the target
 * length. Real deployments would swap this out for something domain
 * specific. Higher is better.
 */
function fitness(gene) {
  let gc = 0;
  for (const c of gene) {
    if (c === 'G' || c === 'C') gc++;
  }
  const gcRatio = gc / (gene.length || 1);
  const lengthPenalty = Math.abs(gene.length - DEFAULT_GENE_LENGTH) * 0.01;
  return gcRatio - lengthPenalty;
}

/* ------------------------------------------------------------------ */
/* Engine                                                             */
/* ------------------------------------------------------------------ */

const state = {
  running: false,
  interval: DEFAULT_INTERVAL,
  mutationRate: DEFAULT_MUTATION_RATE,
  generation: 0,
  population: [],
  best: null,
  bestFitness: -Infinity,
  startedAt: null,
  lastTickAt: null,
  history: [],
};

let timer = null;
const listeners = new Set();

/** Seed the population if it is still empty. */
function seedPopulation() {
  if (state.population.length > 0) return;
  for (let i = 0; i < DEFAULT_POPULATION; i++) {
    state.population.push(randomGene(DEFAULT_GENE_LENGTH));
  }
}

/**
 * Perform one mutation batch synchronously and return a record describing
 * what happened.
 */
function tick() {
  state.generation += 1;
  state.lastTickAt = Date.now();

  seedPopulation();

  const mutations = [];
  for (let i = 0; i < state.population.length; i++) {
    if (Math.random() < state.mutationRate) {
      const strategy = weightedStrategy();
      const before = state.population[i];
      const after = strategy.fn(before);
      state.population[i] = after;
      mutations.push({ index: i, strategy: strategy.name, before, after });
    }
  }

  // Evaluate fitness and track the best individual of this generation.
  let genBest = null;
  let genBestFitness = -Infinity;
  for (const gene of state.population) {
    const f = fitness(gene);
    if (f > genBestFitness) {
      genBestFitness = f;
      genBest = gene;
    }
  }

  if (genBestFitness > state.bestFitness) {
    state.best = genBest;
    state.bestFitness = genBestFitness;
  }

  const record = {
    generation: state.generation,
    at: state.lastTickAt,
    mutations,
    generationBestFitness: genBestFitness,
    overallBestFitness: state.bestFitness,
    populationSize: state.population.length,
  };

  state.history.push(record);
  if (state.history.length > MAX_HISTORY) state.history.shift();

  for (const fn of listeners) {
    try {
      fn(record);
    } catch (err) {
      // A faulty listener must never break the loop.
      // eslint-disable-next-line no-console
      console.error('[random_mutation_loop] listener error:', err && err.message);
    }
  }

  return record;
}

/**
 * Run exactly one mutation batch synchronously.
 */
function once() {
  return tick();
}

/**
 * Start the mutation loop. Safe to call multiple times.
 * @param {number} [interval] milliseconds between ticks (> 0)
 * @returns {object} current state snapshot
 */
function start(interval) {
  if (typeof interval === 'number' && interval > 0) {
    state.interval = interval;
  }
  if (state.running) {
    return getState();
  }
  state.running = true;
  state.startedAt = Date.now();
  timer = setInterval(tick, state.interval);
  // Allow the process to exit if nothing else keeps the event loop alive.
  if (timer && typeof timer.unref === 'function') timer.unref();
  return getState();
}

/**
 * Stop the mutation loop.
 * @returns {{generation:number, best:?string, bestFitness:number, ticks:number, elapsedMs:number, running:boolean}}
 */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  state.running = false;
  return {
    generation: state.generation,
    best: state.best,
    bestFitness: state.bestFitness,
    ticks: state.history.length,
    elapsedMs: state.startedAt ? Date.now() - state.startedAt : 0,
    running: state.running,
  };
}

/**
 * Subscribe to tick records.
 * @param {Function} fn
 * @returns {Function} unsubscribe handle
 */
function onTick(fn) {
  if (typeof fn === 'function') {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  return () => {};
}

/**
 * Unsubscribe a previously registered tick listener.
 * @param {Function} fn
 */
function offTick(fn) {
  listeners.delete(fn);
}

/** Return an immutable snapshot of the engine state. */
function getState() {
  const fits = state.population.map(fitness);
  return {
    running: state.running,
    interval: state.interval,
    mutationRate: state.mutationRate,
    generation: state.generation,
    populationSize: state.population.length,
    best: state.best,
    bestFitness: state.bestFitness,
    startedAt: state.startedAt,
    lastTickAt: state.lastTickAt,
    historyLength: state.history.length,
    meanFitness: fits.length ? mean(fits) : 0,
  };
}

/** Clear all state back to defaults. */
function reset() {
  stop();
  state.generation = 0;
  state.population = [];
  state.best = null;
  state.bestFitness = -Infinity;
  state.startedAt = null;
  state.lastTickAt = null;
  state.history = [];
  return getState();
}

/* ------------------------------------------------------------------ */
/* Standalone runner                                                  */
/* ------------------------------------------------------------------ */

function main() {
  const argv = process.argv.slice(2);
  const interval = parseInt(argv[0], 10) || DEFAULT_INTERVAL;
  const ticks = parseInt(argv[1], 10) || 20;

  let n = 0;
  onTick((rec) => {
    n += 1;
    if (n === 1 || n % 5 === 0) {
      console.log(
        `[gen ${String(rec.generation).padStart(4)}] ` +
          `gen_best=${rec.generationBestFitness.toFixed(4)} ` +
          `overall=${rec.overallBestFitness.toFixed(4)} ` +
          `mutations=${rec.mutations.length}`
      );
    }
    if (n >= ticks) {
      const report = stop();
      console.log('\n=== REPORT ===');
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }
  });

  start(interval);
}

if (require.main === module) {
  main();
}

module.exports = {
  // public API
  start,
  stop,
  // helpers
  once,
  onTick,
  offTick,
  getState,
  reset,
  // internals exposed for testing
  fitness,
  tick,
  randomGene,
  weightedStrategy,
  STRATEGIES,
  DEFAULT_INTERVAL,
};
