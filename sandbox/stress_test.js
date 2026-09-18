'use strict';

/**
 * sandbox/stress_test.js — стресс-тест агента по его идентификатору.
 * ==========================================================================
 *
 * Публичный API:
 *     stress(agentId) -> {
 *        ok, agentId, seed, config, phases: [...], metrics: {...},
 *        timeline: [...], verdict
 *     }
 *
 * Идея: по agentId детерминированно (стабильный хэш) строится «профиль
 * нагрузки», затем агент прогоняется через набор фаз стресс-теста.
 * Одинаковый agentId -> одинаковый отчёт (см. seedFromString).
 *
 * Фазы:
 *   1.  ramp-up             плавный рост нагрузки
 *   2.  steady-state        удержание пиковой нагрузки
 *   3.  spike               мгновенный всплеск
 *   4.  soak                длительная выдержка (утечки/деградация)
 *   5.  bursty              рваный трафик
 *   6.  gaussian-noise      аддитивный шум
 *   7.  contention          конкуренция за ресурсы
 *   8.  recovery            проверка восстановления после пика
 *   9.  backpressure        отказоустойчивость при перегрузке
 *   10. chaos-injection     случайные деградации
 *
 * Чистый Node.js, без внешних зависимостей и без побочных эффектов.
 * Запуск напрямую:  node stress_test.js [agentId]
 */

const VERSION = '1.1.0';

/* ------------------------------------------------------------------ */
/* 0. Утилиты                                                          */
/* ------------------------------------------------------------------ */

/** Что угодно -> строка без сюрпризов. */
function asString(x) {
  if (x === null || x === undefined) return 'null';
  if (typeof x === 'number' && !Number.isFinite(x)) return String(x);
  return String(x);
}

/** Детерминированный 32-битный хэш строки (FNV-1a). */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Строка -> seed. */
function seedFromString(str) {
  const h = hashString(str);
  return (h % 2147483647) || 1;
}

/** Детерминированный ПСЧ (mulberry32). */
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Зажимает x в [lo, hi]. */
function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/** Округление до n знаков. */
function round(x, n) {
  const p = Math.pow(10, n);
  return Math.round(x * p) / p;
}

/** Среднее. */
function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

/** Стандартное отклонение (выборочное). */
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    s += d * d;
  }
  return Math.sqrt(s / (arr.length - 1));
}

/** Перцентиль по уже отсортированному массиву. */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = clamp(Math.floor((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

/** Максимум. */
function max(arr) {
  let m = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return arr.length ? m : 0;
}

/** Гауссова величина (Box-Muller), детерминированная. */
function gauss(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ------------------------------------------------------------------ */
/* 1. Профиль агента                                                   */
/* ------------------------------------------------------------------ */

/**
 * Строит детерминированный профиль нагрузки по agentId.
 */
function buildProfile(agentId) {
  const id = asString(agentId);
  const seed = seedFromString(id);
  const rng = makeRng(seed);

  return {
    id,
    seed,
    baseLatency: round(4 + rng() * 14, 2),      // базовая задержка, мс
    jitter: round(1 + rng() * 5, 2),            // случайное дрожание, мс
    errorBase: round(0.002 + rng() * 0.01, 4),  // базовая доля ошибок
    capacity: Math.floor(60 + rng() * 160),     // rps до насыщения
    maxWorkers: Math.floor(8 + rng() * 24),     // потолок параллелизма
    recovery: round(0.4 + rng() * 0.45, 2),     // скорость восстановления
    leakPerUnit: round(rng() * 0.004, 5),       // «утечка» на единицу работы
  };
}

/* ------------------------------------------------------------------ */
/* 2. Модель агента                                                    */
/* ------------------------------------------------------------------ */

/**
 * Модель состояния агента под нагрузкой: учитывает насыщение,
 * деградацию, очередь и восстановление.
 */
function makeAgentModel(profile, seed) {
  const rng = makeRng((seed ^ 0x9e3779b9) >>> 0);
  let health = 1;
  let degradation = 0;
  let queue = 0;

  function utilization(rps, workers) {
    const load = rps / profile.capacity;
    const conc = workers / profile.maxWorkers;
    return Math.max(load, conc);
  }

  /** Обработать один «тик» нагрузки, вернуть сэмпл запроса. */
  function tick(rps, workers) {
    const util = utilization(rps, workers);
    const overload = Math.max(0, util - 0.8);

    // Деградация растёт под перегрузкой и медленно заживает.
    degradation = clamp(degradation + overload * 0.03 - profile.recovery * 0.01, 0, 1);
    // Очередь копится при util > 1.
    queue = clamp(queue + (util - 1) * (util > 1 ? 1 : -profile.recovery), 0, 5000);
    // Здоровье падает при большой очереди.
    health = clamp(health - queue * 0.0008 + profile.recovery * 0.004, 0, 1);

    const latency =
      profile.baseLatency +
      profile.jitter * rng() +
      overload * 45 +
      degradation * 120 * (1 - health) +
      queue * 0.05 +
      Math.max(0, gauss(rng)) * profile.jitter;

    const err =
      profile.errorBase +
      degradation * 0.25 +
      Math.max(0, util - 1) * 0.08 +
      (queue > 2000 ? 0.1 : 0);
    const error = clamp(err, 0, 0.95);

    const r = rng();
    return {
      latency: round(latency, 3),
      ok: r >= error,
      error: r < error ? 'overloaded' : null,
      utilization: round(util, 4),
      degradation: round(degradation, 4),
      health: round(health, 4),
      queue: Math.round(queue),
    };
  }

  function snapshot() {
    return {
      health: round(health, 4),
      degradation: round(degradation, 4),
      queue: Math.round(queue),
    };
  }

  return { tick, snapshot };
}

/* ------------------------------------------------------------------ */
/* 3. Фазы                                                             */
/* ------------------------------------------------------------------ */

/** Универсальный гонщик фазы: rounds шагов, на каждом — requestsPerStep. */
function runPhase(model, { rps, workers, steps, requestsPerStep }) {
  const samples = [];
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < requestsPerStep; i++) {
      samples.push(model.tick(rps, workers));
    }
  }
  return samples;
}

function phaseRampUp(model, profile, cfg) {
  const samples = [];
  const steps = cfg.rampSteps;
  for (let s = 1; s <= steps; s++) {
    const rps = Math.round((profile.capacity * 1.2 * s) / steps);
    const workers = Math.max(1, Math.round((profile.maxWorkers * s) / steps));
    samples.push(...runPhase(model, { rps, workers, steps: 1, requestsPerStep: cfg.perStep }));
  }
  return samples;
}

function phaseSteady(model, profile, cfg) {
  return runPhase(model, {
    rps: Math.round(profile.capacity * 0.9),
    workers: Math.round(profile.maxWorkers * 0.8),
    steps: cfg.steadySteps,
    requestsPerStep: cfg.perStep,
  });
}

function phaseSpike(model, profile, cfg) {
  return runPhase(model, {
    rps: Math.round(profile.capacity * 3),
    workers: profile.maxWorkers * 2,
    steps: cfg.spikeSteps,
    requestsPerStep: cfg.perStep,
  });
}

function phaseSoak(model, profile, cfg) {
  return runPhase(model, {
    rps: Math.round(profile.capacity * 0.6),
    workers: Math.round(profile.maxWorkers * 0.6),
    steps: cfg.soakSteps,
    requestsPerStep: cfg.perStep,
  });
}

function phaseBursty(model, profile, cfg, rng) {
  const samples = [];
  for (let s = 0; s < cfg.burstSteps; s++) {
    const high = rng() > 0.5;
    const rps = Math.round(profile.capacity * (high ? 1.6 : 0.3));
    samples.push(...runPhase(model, {
      rps,
      workers: high ? profile.maxWorkers : Math.round(profile.maxWorkers * 0.4),
      steps: 1,
      requestsPerStep: cfg.perStep,
    }));
  }
  return samples;
}

function phaseGaussian(model, profile, cfg, rng) {
  const samples = [];
  for (let s = 0; s < cfg.gaussSteps; s++) {
    const noise = 1 + gauss(rng) * 0.25;
    const rps = Math.max(1, Math.round(profile.capacity * 0.7 * noise));
    samples.push(...runPhase(model, {
      rps,
      workers: Math.round(profile.maxWorkers * 0.7),
      steps: 1,
      requestsPerStep: cfg.perStep,
    }));
  }
  return samples;
}

function phaseContention(model, profile, cfg) {
  return runPhase(model, {
    rps: Math.round(profile.capacity * 0.5),
    workers: profile.maxWorkers * 3,
    steps: cfg.contentionSteps,
    requestsPerStep: cfg.perStep,
  });
}

function phaseRecovery(model, profile, cfg) {
  const samples = [];
  // резкий пик
  samples.push(...runPhase(model, {
    rps: Math.round(profile.capacity * 2.5),
    workers: profile.maxWorkers * 2,
    steps: 2,
    requestsPerStep: cfg.perStep,
  }));
  // сброс нагрузки -> наблюдаем восстановление
  samples.push(...runPhase(model, {
    rps: Math.round(profile.capacity * 0.2),
    workers: 2,
    steps: cfg.recoverySteps,
    requestsPerStep: cfg.perStep,
  }));
  return samples;
}

function phaseBackpressure(model, profile, cfg) {
  return runPhase(model, {
    rps: Math.round(profile.capacity * 4),
    workers: profile.maxWorkers * 4,
    steps: cfg.backpressureSteps,
    requestsPerStep: cfg.perStep,
  });
}

function phaseChaos(model, profile, cfg, rng) {
  const samples = [];
  for (let s = 0; s < cfg.chaosSteps; s++) {
    const inject = rng() < 0.4;
    const rps = Math.round(profile.capacity * (inject ? 3.5 : 0.5));
    const row = runPhase(model, {
      rps,
      workers: inject ? profile.maxWorkers * 3 : 2,
      steps: 1,
      requestsPerStep: cfg.perStep,
    });
    samples.push(...row);
  }
  return samples;
}

/* ------------------------------------------------------------------ */
/* 4. Метрики и вердикт                                                */
/* ------------------------------------------------------------------ */

function computeMetrics(samples) {
  const lat = samples.map((s) => s.latency).sort((a, b) => a - b);
  const errors = samples.filter((s) => !s.ok).length;
  const total = samples.length || 1;
  const tail = lat.slice(Math.floor(lat.length * 0.95));
  return {
    requests: samples.length,
    errors,
    errorRate: round(errors / total, 4),
    latency: {
      min: round(lat.length ? lat[0] : 0, 3),
      p50: round(percentile(lat, 50), 3),
      p95: round(percentile(lat, 95), 3),
      p99: round(percentile(lat, 99), 3),
      max: round(max(lat), 3),
      mean: round(mean(lat), 3),
      stddev: round(stddev(lat), 3),
    },
    tailMean: round(mean(tail), 3),
    meanUtilization: round(mean(samples.map((s) => s.utilization)), 4),
    maxDegradation: round(max(samples.map((s) => s.degradation)), 4),
    minHealth: round(Math.min(1, ...samples.map((s) => s.health)), 4),
  };
}

function makeVerdict(metrics, thresholds) {
  const fails = [];
  if (metrics.errorRate > thresholds.errorRate) fails.push('errorRate');
  if (metrics.latency.p95 > thresholds.p95Ms) fails.push('p95');
  if (metrics.latency.max > thresholds.maxMs) fails.push('maxLatency');
  return {
    passed: fails.length === 0,
    fails,
    thresholds,
  };
}

/* ------------------------------------------------------------------ */
/* 5. Главный вход                                                     */
/* ------------------------------------------------------------------ */

const DEFAULT_THRESHOLDS = {
  errorRate: 0.02,
  p95Ms: 120,
  maxMs: 4000,
};

function stress(agentId) {
  const t0 = Date.now();
  const profile = buildProfile(agentId);
  const model = makeAgentModel(profile, profile.seed);
  const rng = makeRng((profile.seed ^ 0x1234567) >>> 0);

  const cfg = {
    rampSteps: 6,
    steadySteps: 6,
    spikeSteps: 3,
    soakSteps: 10,
    burstSteps: 8,
    gaussSteps: 8,
    contentionSteps: 5,
    recoverySteps: 6,
    backpressureSteps: 5,
    chaosSteps: 8,
    perStep: 12,
  };

  const phases = [];
  const timeline = [];

  function record(name, samples, note) {
    const metrics = computeMetrics(samples);
    phases.push({ name, metrics, note });
    timeline.push({ name, avgLatency: metrics.latency.mean, p95: metrics.latency.p95, note });
  }

  record('ramp-up', phaseRampUp(model, profile, cfg), 'плавный рост нагрузки');
  record('steady-state', phaseSteady(model, profile, cfg), 'удержание пика');
  record('spike', phaseSpike(model, profile, cfg), 'мгновенный всплеск');
  record('soak', phaseSoak(model, profile, cfg), 'длительная выдержка');
  record('bursty', phaseBursty(model, profile, cfg, rng), 'рваный трафик');
  record('gaussian-noise', phaseGaussian(model, profile, cfg, rng), 'аддитивный шум');
  record('contention', phaseContention(model, profile, cfg), 'конкуренция за ресурсы');
  record('recovery', phaseRecovery(model, profile, cfg), 'восстановление после пика');
  record('backpressure', phaseBackpressure(model, profile, cfg), 'отказоустойчивость');
  record('chaos-injection', phaseChaos(model, profile, cfg, rng), 'случайные деградации');

  const allSamples = [];
  for (const p of phases) {
    // повторный агрегированный замер пропущен: метрики уже посчитаны
    void p;
  }
  // Собираем «сквозные» метрики по всем фазам.
  const merged = phases.reduce((acc, p) => {
    acc.requests += p.metrics.requests;
    acc.errors += p.metrics.errors;
    acc.latencies.push(p.metrics.latency.mean);
    acc.maxDegradation = Math.max(acc.maxDegradation, p.metrics.maxDegradation);
    acc.minHealth = Math.min(acc.minHealth, p.metrics.minHealth);
    acc.meanUtilization.push(p.metrics.meanUtilization);
    return acc;
  }, {
    requests: 0,
    errors: 0,
    latencies: [],
    maxDegradation: 0,
    minHealth: 1,
    meanUtilization: [],
  });

  const metrics = {
    requests: merged.requests,
    errors: merged.errors,
    errorRate: round(merged.errors / (merged.requests || 1), 4),
    phaseAvgLatency: round(mean(merged.latencies), 3),
    meanUtilization: round(mean(merged.meanUtilization), 4),
    maxDegradation: round(merged.maxDegradation, 4),
    minHealth: round(clamp(merged.minHealth, 0, 1), 4),
    finalState: model.snapshot(),
  };

  const verdict = makeVerdict(
    {
      errorRate: metrics.errorRate,
      latency: { p95: phases.reduce((m, p) => Math.max(m, p.metrics.latency.p95), 0), max: phases.reduce((m, p) => Math.max(m, p.metrics.latency.max), 0) },
    },
    DEFAULT_THRESHOLDS
  );

  return {
    version: VERSION,
    ok: verdict.passed,
    agentId: profile.id,
    seed: profile.seed,
    config: profile,
    phases,
    timeline,
    metrics,
    verdict,
    elapsedMs: Date.now() - t0,
  };
}

/* ------------------------------------------------------------------ */
/* 6. CLI                                                              */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  const agentId = process.argv[2] !== undefined ? process.argv[2] : 'agent-default';
  const out = stress(agentId);
  const summary = {
    version: out.version,
    agentId: out.agentId,
    seed: out.seed,
    ok: out.ok,
    metrics: out.metrics,
    verdict: out.verdict,
    timeline: out.timeline.map((t) => `${t.name}:${t.avgLatency}ms p95=${t.p95}ms`),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

module.exports = {
  stress,
  buildProfile,
  makeAgentModel,
  seedFromString,
  makeRng,
  percentile,
  stddev,
  VERSION,
};
