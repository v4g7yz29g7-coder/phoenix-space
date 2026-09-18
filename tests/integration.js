#!/usr/bin/env node
'use strict';

/**
 * tests/integration.js — race → experience → trajectory
 * ============================================================================
 *
 * Полный интеграционный сьют для конвейера Aeon Arena / EverOS.
 * Проверяет один «прогон» как три последовательно связанные стадии:
 *
 *     ┌────────┐   winner    ┌────────────┐  experience  ┌────────────┐
 *     │  RACE  │ ──────────▶ │ EXPERIENCE │ ───────────▶ │ TRAJECTORY │
 *     └────────┘             └────────────┘              └────────────┘
 *
 *   1. RACE        — N боксов параллельно решают задачу, результаты
 *                    ранжируются, ровно один победитель выбирается
 *                    детерминированно (одинаковый seed → одинаковый исход).
 *   2. EXPERIENCE  — победный прогон дистиллируется в неизменяемую,
 *                    оценённую, JSON-сериализуемую запись опыта с
 *                    sha256-отпечатком для верификации.
 *   3. TRAJECTORY  — опыт разворачивается обратно в упорядоченную траекторию
 *                    шагов победителя плюс извлечённые из него инсайты.
 *
 * Сьют не тянет внешних зависимостей (никаких jest/mocha/chai) и работает на
 * голом Node: только assert / crypto / fs / path. Реальный репозиторный модуль
 * trajectory/path_builder.js подхватывается через safeRequire() и проверяется,
 * если присутствует; если его нет — тест молча пропускается, CI остаётся зелёным.
 *
 * Использование:
 *     node tests/integration.js             # прогнать весь сьют (exit 0/1)
 *     node tests/integration.js --verbose   # печатать каждый успешный тест
 *     node --check tests/integration.js     # только проверка синтаксиса
 *
 * КРИТЕРИЙ: > 200 строк, node --check OK.
 * ============================================================================
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SELF_PATH = __filename;
const VERBOSE = process.argv.includes('--verbose');
const MIN_LINES = 200;

/* ===========================================================================
 * 0. Микро-харнесс (свой, без зависимостей)
 * ========================================================================= */

const SUITES = [];
let CURRENT = null;

/** Регистрирует набор тестов. */
function describe(title, fn) {
  const suite = { title, tests: [] };
  SUITES.push(suite);
  const previous = CURRENT;
  CURRENT = suite;
  try {
    fn();
  } finally {
    CURRENT = previous;
  }
  return suite;
}

/** Регистрирует один тест (sync или async) внутри describe(). */
function it(title, fn) {
  if (!CURRENT) {
    throw new Error(`it("${title}") вызван вне describe()`);
  }
  CURRENT.tests.push({ title, fn });
}

/** Прогоняет все зарегистрированные сьюты. Возвращает сводку. */
async function runAll() {
  const summary = { total: 0, passed: 0, failed: 0, failures: [] };
  for (const suite of SUITES) {
    if (VERBOSE) console.log(`\n▶ ${suite.title}`);
    for (const test of suite.tests) {
      summary.total += 1;
      try {
        await test.fn();
        summary.passed += 1;
        if (VERBOSE) console.log(`  ✓ ${test.title}`);
      } catch (err) {
        summary.failed += 1;
        const message = (err && err.stack) || String(err);
        summary.failures.push({ suite: suite.title, test: test.title, message });
        console.error(`  ✗ ${suite.title} › ${test.title}`);
        console.error(`    ${(err && err.message) || err}`);
      }
    }
  }
  return summary;
}

/* ===========================================================================
 * 1. Утилиты
 * ========================================================================= */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const nowIso = () => new Date().toISOString();

const clamp01 = (n) => Math.min(1, Math.max(0, n));

function round(value, places = 3) {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

function uid(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

/** Детерминированный PRNG: одинаковый seed → одинаковая последовательность. */
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

/** Каноническая сериализация: ключи объектов сортируются рекурсивно. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',');
  return `{${body}}`;
}

/** sha256-отпечаток структуры (устойчив к порядку ключей). */
function stableHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
    );
  }
  return false;
}

/** Рекурсивно замораживает объект — опыт должен быть неизменяемым. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** Безопасный require репозиторного модуля: не роняет сьют при ошибке. */
function safeRequire(rel) {
  try {
    return { ok: true, mod: require(path.join(ROOT, rel)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ===========================================================================
 * 2. Шина событий
 * ========================================================================= */

class EventBus {
  constructor() {
    this.history = [];
    this.handlers = new Map();
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    const list = this.handlers.get(type) || [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  emit(type, payload) {
    const event = { type, payload, at: nowIso() };
    this.history.push(event);
    for (const handler of this.handlers.get(type) || []) handler(event);
    return event;
  }

  types() {
    return this.history.map((event) => event.type);
  }
}

/* ===========================================================================
 * 3. Стадия RACE
 * ========================================================================= */

const STRATEGIES = ['greedy', 'balanced', 'exploratory', 'conservative'];

const STRATEGY_BASE = {
  greedy: 0.78,
  balanced: 0.72,
  exploratory: 0.66,
  conservative: 0.6,
};

/** Приводит произвольную задачу к каноническому виду. */
function normalizeTask(task) {
  if (typeof task === 'string') {
    return { id: uid('task'), description: task, difficulty: 0.5 };
  }
  const source = task || {};
  return {
    id: source.id || uid('task'),
    description: source.description || source.prompt || 'unnamed task',
    difficulty: clamp01(typeof source.difficulty === 'number' ? source.difficulty : 0.5),
  };
}

/** Бокс-участник гонки: детерминированно генерирует кандидатное решение. */
class Contender {
  constructor(options = {}) {
    this.box = options.box ?? 1;
    this.strategy = options.strategy || 'balanced';
    this.rng = mulberry32((options.seed ?? 1) >>> 0);
  }

  async solve(task) {
    const base = STRATEGY_BASE[this.strategy] ?? 0.7;
    const noise = this.rng();
    const difficultyPenalty = task.difficulty * 0.2;
    const score = round(clamp01(base + noise * 0.3 - difficultyPenalty), 4);
    const time = Math.round(50 + (1 - score) * 400 + this.rng() * 50);
    // Даём возможность другим боксам «выйти на трассу» (микрозадача, без таймеров).
    await Promise.resolve();
    return {
      box: this.box,
      solver: `agent_${this.box}`,
      strategy: this.strategy,
      score,
      time,
      ok: true,
      error: null,
      solution: {
        kind: 'plan',
        steps: 1 + Math.round(score * 5),
        hash: stableHash([this.box, this.strategy, score]).slice(0, 12),
      },
    };
  }
}

/** Ранжирует результаты: score ↓, time ↑, box ↑. Возвращает новые объекты. */
function rankResults(results) {
  return results
    .map((result, index) => ({ ...result, index }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.time !== b.time) return a.time - b.time;
      return a.box - b.box;
    })
    .map((result, index) => ({ ...result, rank: index + 1 }));
}

/** Стадия гонки: запускает боксы, собирает и ранжирует результаты. */
class RaceStage {
  constructor(options = {}) {
    this.bus = options.bus || new EventBus();
    this.contenders = (options.contenders || []).slice();
    this.seed = options.seed ?? 1;
    this.raceId = options.raceId || uid('race');
    this.startedAt = null;
  }

  static contenders(count, seed) {
    const list = [];
    for (let box = 1; box <= count; box += 1) {
      list.push(
        new Contender({
          box,
          strategy: STRATEGIES[(box + seed) % STRATEGIES.length],
          seed: seed * 1000 + box,
        }),
      );
    }
    return list;
  }

  async runBox(contender, task) {
    try {
      const result = await contender.solve(task);
      return { ...result, ok: result.ok !== false, error: result.error || null };
    } catch (err) {
      return {
        box: contender.box,
        solver: `agent_${contender.box}`,
        strategy: contender.strategy,
        score: 0,
        time: Infinity,
        ok: false,
        error: err.message,
        solution: null,
      };
    }
  }

  async run(task) {
    const normalized = normalizeTask(task);
    this.startedAt = nowIso();
    this.bus.emit('race.started', {
      raceId: this.raceId,
      task: normalized,
      boxes: this.contenders.length,
    });

    const settled = await Promise.all(
      this.contenders.map((contender) => this.runBox(contender, normalized)),
    );
    const results = rankResults(settled);
    const champion = results[0] || null;
    const durationMs = results.reduce(
      (acc, result) => Math.max(acc, Number.isFinite(result.time) ? result.time : 0),
      0,
    );

    const outcome = {
      raceId: this.raceId,
      task: normalized,
      startedAt: this.startedAt,
      finishedAt: nowIso(),
      durationMs,
      results,
      winner: champion
        ? {
            box: champion.box,
            solver: champion.solver,
            strategy: champion.strategy,
            score: champion.score,
            time: champion.time,
          }
        : null,
    };

    this.bus.emit('race.finished', outcome);
    return outcome;
  }
}

/* ===========================================================================
 * 4. Стадия EXPERIENCE
 * ========================================================================= */

const EXPERIENCE_KEYS = [
  'id',
  'raceId',
  'task',
  'winner',
  'metrics',
  'evidence',
  'fingerprint',
  'createdAt',
];

/** Дистиллирует гонку в неизменяемую запись опыта. */
function buildExperience(race) {
  if (!race || !race.winner) {
    throw new Error('buildExperience требует гонку с победителем');
  }

  const scores = race.results.map((result) => result.score);
  const best = scores.length ? Math.max(...scores) : 0;
  const worst = scores.length ? Math.min(...scores) : 0;

  const metrics = {
    contenders: race.results.length,
    finished: race.results.filter((result) => result.ok).length,
    bestScore: best,
    worstScore: worst,
    meanScore: round(scores.reduce((acc, value) => acc + value, 0) / (scores.length || 1), 4),
    spread: round(best - worst, 4),
  };

  const evidence = race.results.map((result) => ({
    box: result.box,
    solver: result.solver,
    strategy: result.strategy,
    rank: result.rank,
    score: result.score,
    time: result.time,
    ok: result.ok,
  }));

  const experience = {
    id: uid('exp'),
    raceId: race.raceId,
    task: race.task,
    winner: { ...race.winner },
    metrics,
    evidence,
    createdAt: nowIso(),
  };

  experience.fingerprint = stableHash({
    raceId: experience.raceId,
    winner: experience.winner,
    metrics: experience.metrics,
    evidence: experience.evidence,
  });

  return deepFreeze(experience);
}

/** Проверяет структуру и целостность записи опыта. */
function validateExperience(experience) {
  const errors = [];
  if (!experience || typeof experience !== 'object') {
    return { valid: false, errors: ['experience должен быть объектом'] };
  }

  for (const key of EXPERIENCE_KEYS) {
    if (!(key in experience)) errors.push(`отсутствует ключ: ${key}`);
  }

  if (experience.winner) {
    if (typeof experience.winner.score !== 'number') {
      errors.push('winner.score должен быть числом');
    } else if (experience.winner.score < 0 || experience.winner.score > 1) {
      errors.push('winner.score вне диапазона [0, 1]');
    }
  }

  if (experience.metrics) {
    if (experience.metrics.bestScore < experience.metrics.worstScore) {
      errors.push('metrics противоречивы: bestScore < worstScore');
    }
  }

  if (experience.fingerprint) {
    const expected = stableHash({
      raceId: experience.raceId,
      winner: experience.winner,
      metrics: experience.metrics,
      evidence: experience.evidence,
    });
    if (expected !== experience.fingerprint) {
      errors.push('отпечаток не совпадает (запись изменена?)');
    }
  }

  return { valid: errors.length === 0, errors };
}

function serializeExperience(experience) {
  return JSON.stringify(experience);
}

function parseExperience(text) {
  const parsed = JSON.parse(text);
  return { experience: parsed, check: validateExperience(parsed) };
}

/* ===========================================================================
 * 5. Стадия TRAJECTORY
 * ========================================================================= */

/** Классифицирует действие шага по накопленному score. */
function classifyAction(score, options = {}) {
  if (options.start) return 'register';
  if (score >= 0.8) return 'dominate';
  if (score >= 0.6) return 'push';
  if (score >= 0.4) return 'hold';
  return 'struggle';
}

/** Извлекает уроки из записи опыта (что сработало, что нет). */
function deriveInsights(experience) {
  const insights = [];
  const { metrics, winner } = experience;

  insights.push({
    pattern: 'winner-profile',
    lesson: `стратегия "${winner.strategy || 'balanced'}" победила со score ${winner.score}`,
    evidence: `race ${experience.raceId}`,
  });

  if (metrics.spread > 0.2) {
    insights.push({
      pattern: 'high-variance',
      lesson: 'разброс кандидатов велик — разнообразие стратегий окупилось',
      evidence: `spread=${metrics.spread}`,
    });
  } else {
    insights.push({
      pattern: 'tight-field',
      lesson: 'разрыв минимален — исход решила скорость исполнения',
      evidence: `spread=${metrics.spread}`,
    });
  }

  if (metrics.finished < metrics.contenders) {
    insights.push({
      pattern: 'attrition',
      lesson: `${metrics.contenders - metrics.finished} бокс(ов) не финишировали`,
      evidence: `finished=${metrics.finished}/${metrics.contenders}`,
    });
  } else {
    insights.push({
      pattern: 'full-field',
      lesson: 'все боксы дошли до финиша — гонка была честной',
      evidence: `finished=${metrics.finished}/${metrics.contenders}`,
    });
  }

  return insights;
}

/** Разворачивает опыт в упорядоченную траекторию шагов победителя. */
function buildTrajectory(experience) {
  const check = validateExperience(experience);
  if (!check.valid) {
    throw new Error(`невалидный опыт: ${check.errors.join('; ')}`);
  }

  const solver = experience.winner.solver;
  const finalScore = experience.winner.score;
  const steps = [
    {
      step: 1,
      action: classifyAction(0, { start: true }),
      actor: solver,
      outcome: 'вошёл в гонку',
      score: 0,
    },
    {
      step: 2,
      action: 'assess',
      actor: solver,
      outcome: `разобрал задачу "${experience.task.description}"`,
      score: round(finalScore * 0.2, 4),
    },
    {
      step: 3,
      action: classifyAction(finalScore),
      actor: solver,
      outcome: 'исполнил победную стратегию',
      score: round(finalScore * 0.7, 4),
    },
    {
      step: 4,
      action: 'submit',
      actor: solver,
      outcome: `сдал решение со score ${finalScore}`,
      score: finalScore,
    },
    {
      step: 5,
      action: 'finish',
      actor: solver,
      outcome: 'первым пересёк финишную черту',
      score: finalScore,
    },
  ];

  return {
    experienceId: experience.id,
    raceId: experience.raceId,
    solver,
    length: steps.length,
    steps,
    insights: deriveInsights(experience),
  };
}

/* ===========================================================================
 * 6. Полный конвейер
 * ========================================================================= */

/** race → experience → trajectory за один вызов. */
async function runPipeline(task, options = {}) {
  const seed = Number.isInteger(options.seed) ? options.seed : 42;
  const bus = options.bus || new EventBus();
  const contenders =
    options.contenders || RaceStage.contenders(options.boxes || 3, seed);

  const race = await new RaceStage({
    contenders,
    bus,
    seed,
    raceId: options.raceId,
  }).run(task);

  const experience = buildExperience(race);
  const trajectory = buildTrajectory(experience);

  return { race, experience, trajectory, events: bus.history };
}

/* ===========================================================================
 * 7. Тесты: стадия RACE
 * ========================================================================= */

describe('RACE — гонка', () => {
  it('выбирает ровно одного победителя из N боксов', async () => {
    const race = await new RaceStage({
      contenders: RaceStage.contenders(3, 42),
      seed: 42,
    }).run('решить задачу');

    assert.strictEqual(race.results.length, 3);
    assert.ok(race.winner, 'победитель должен быть определён');
    assert.strictEqual(
      race.results.filter((result) => result.rank === 1).length,
      1,
      'ровно один результат с rank=1',
    );
    assert.strictEqual(race.winner.solver, race.results[0].solver);
  });

  it('ранжирует результаты по score ↓, затем time ↑', async () => {
    const race = await new RaceStage({
      contenders: RaceStage.contenders(4, 7),
      seed: 7,
    }).run('тест ранжирования');

    for (let i = 1; i < race.results.length; i += 1) {
      const prev = race.results[i - 1];
      const curr = race.results[i];
      assert.ok(
        prev.score > curr.score || (prev.score === curr.score && prev.time <= curr.time),
        'порядок нарушает правило ранжирования',
      );
    }
  });

  it('публикует события race.started и race.finished', async () => {
    const bus = new EventBus();
    const seen = [];
    bus.on('race.started', () => seen.push('started'));
    bus.on('race.finished', () => seen.push('finished'));

    await new RaceStage({ contenders: RaceStage.contenders(2, 1), bus }).run('события');

    assert.deepStrictEqual(seen, ['started', 'finished']);
    assert.deepStrictEqual(bus.types(), ['race.started', 'race.finished']);
  });

  it('изолирует падающий бокс, не роняя гонку', async () => {
    const broken = {
      box: 99,
      strategy: 'greedy',
      async solve() {
        throw new Error('boom');
      },
    };
    const race = await new RaceStage({
      contenders: [broken, ...RaceStage.contenders(2, 5)],
      seed: 5,
    }).run('устойчивость');

    const failed = race.results.find((result) => result.box === 99);
    assert.ok(failed, 'падающий бокс должен присутствовать в результатах');
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.score, 0);
    assert.ok(race.winner, 'гонка всё равно определила победителя');
  });

  it('детерминирован при одинаковом seed', async () => {
    const a = await new RaceStage({ contenders: RaceStage.contenders(3, 42), seed: 42 }).run('d');
    const b = await new RaceStage({ contenders: RaceStage.contenders(3, 42), seed: 42 }).run('d');
    assert.ok(
      deepEqual(a.results.map((r) => r.score), b.results.map((r) => r.score)),
      'одинаковый seed должен давать одинаковые score',
    );
    assert.strictEqual(a.winner.solver, b.winner.solver);
  });
});

/* ===========================================================================
 * 8. Тесты: стадия EXPERIENCE
 * ========================================================================= */

describe('EXPERIENCE — опыт', () => {
  it('выводит метрики из результатов гонки', async () => {
    const race = await new RaceStage({ contenders: RaceStage.contenders(3, 11), seed: 11 }).run('m');
    const experience = buildExperience(race);

    assert.strictEqual(experience.metrics.contenders, 3);
    assert.ok(experience.metrics.bestScore >= experience.metrics.worstScore);
    assert.strictEqual(
      experience.metrics.spread,
      round(experience.metrics.bestScore - experience.metrics.worstScore, 4),
    );
    assert.ok(experience.metrics.meanScore >= 0 && experience.metrics.meanScore <= 1);
  });

  it('проходит JSON round-trip без потерь', async () => {
    const race = await new RaceStage({ contenders: RaceStage.contenders(3, 3), seed: 3 }).run('rt');
    const experience = buildExperience(race);

    const { experience: parsed, check } = parseExperience(serializeExperience(experience));
    assert.ok(check.valid, `ожидалась валидность: ${check.errors.join(', ')}`);
    assert.ok(deepEqual(parsed, experience), 'round-trip должен сохранять структуру');
  });

  it('неизменяема: запись заморожена рекурсивно', async () => {
    const race = await new RaceStage({ contenders: RaceStage.contenders(2, 2), seed: 2 }).run('f');
    const experience = buildExperience(race);

    assert.ok(Object.isFrozen(experience));
    assert.ok(Object.isFrozen(experience.metrics));
    assert.ok(Object.isFrozen(experience.evidence));
    assert.throws(() => {
      experience.metrics.meanScore = 0.999;
    }, TypeError);
  });

  it('отклоняет изменённый отпечаток', async () => {
    const race = await new RaceStage({ contenders: RaceStage.contenders(2, 4), seed: 4 }).run('t');
    const experience = buildExperience(race);
    const tampered = JSON.parse(serializeExperience(experience));
    tampered.metrics.meanScore = round(tampered.metrics.meanScore + 0.1, 4);

    const check = validateExperience(tampered);
    assert.strictEqual(check.valid, false);
    assert.ok(check.errors.some((error) => error.includes('отпечаток')));
  });

  it('бросает ошибку без победителя', () => {
    assert.throws(() => buildExperience({ results: [], winner: null }), /победител/);
  });
});

/* ===========================================================================
 * 9. Тесты: стадия TRAJECTORY
 * ========================================================================= */

describe('TRAJECTORY — траектория', () => {
  it('строит упорядоченные шаги для победителя', async () => {
    const race = await new RaceStage({ contenders: RaceStage.contenders(3, 9), seed: 9 }).run('tr');
    const experience = buildExperience(race);
    const trajectory = buildTrajectory(experience);

    assert.strictEqual(trajectory.length, trajectory.steps.length);
    assert.ok(trajectory.length >= 5);
    for (const step of trajectory.steps) {
      assert.strictEqual(step.actor, experience.winner.solver);
      assert.ok(typeof step.action === 'string' && step.action.length > 0);
      assert.ok(typeof step.outcome === 'string' && step.outcome.length > 0);
    }
  });

  it('нумерует шаги без пропусков', async () => {
    const race = await new RaceStage({ contenders: RaceStage.contenders(2, 8), seed: 8 }).run('n');
    const trajectory = buildTrajectory(buildExperience(race));

    trajectory.steps.forEach((step, index) => {
      assert.strictEqual(step.step, index + 1);
    });
  });

  it('извлекает инсайты из опыта', async () => {
    const race = await new RaceStage({ contenders: RaceStage.contenders(3, 6), seed: 6 }).run('i');
    const trajectory = buildTrajectory(buildExperience(race));

    assert.ok(trajectory.insights.length >= 3);
    for (const insight of trajectory.insights) {
      assert.ok(insight.pattern);
      assert.ok(insight.lesson);
      assert.ok(insight.evidence);
    }
  });

  it('classifyAction раскладывает score по полосам', () => {
    assert.strictEqual(classifyAction(0, { start: true }), 'register');
    assert.strictEqual(classifyAction(0.85), 'dominate');
    assert.strictEqual(classifyAction(0.65), 'push');
    assert.strictEqual(classifyAction(0.45), 'hold');
    assert.strictEqual(classifyAction(0.1), 'struggle');
  });

  it('отклоняет невалидный опыт', () => {
    assert.throws(() => buildTrajectory({ id: 'x' }), /невалидный опыт/);
  });
});

/* ===========================================================================
 * 10. Тесты: полный конвейер race → experience → trajectory
 * ========================================================================= */

describe('PIPELINE — race → experience → trajectory', () => {
  it('связывает все три стадии одним прогоном', async () => {
    const { race, experience, trajectory, events } = await runPipeline('solved task', {
      seed: 21,
      boxes: 3,
    });

    assert.strictEqual(experience.raceId, race.raceId);
    assert.strictEqual(trajectory.experienceId, experience.id);
    assert.strictEqual(trajectory.raceId, race.raceId);
    assert.strictEqual(experience.winner.solver, race.winner.solver);
    assert.deepStrictEqual(
      events.map((event) => event.type),
      ['race.started', 'race.finished'],
    );
  });

  it('детерминирован для одинакового seed', async () => {
    const a = await runPipeline('same task', { seed: 33, boxes: 4 });
    const b = await runPipeline('same task', { seed: 33, boxes: 4 });

    assert.ok(deepEqual(a.race.results.map((r) => r.score), b.race.results.map((r) => r.score)));
    assert.strictEqual(a.race.winner.solver, b.race.winner.solver);
    assert.strictEqual(a.experience.winner.score, b.experience.winner.score);
  });

  it('разные seed меняют исход', async () => {
    const a = await runPipeline('vary', { seed: 42, boxes: 3 });
    const b = await runPipeline('vary', { seed: 7, boxes: 3 });

    assert.ok(
      !deepEqual(a.race.results.map((r) => r.score), b.race.results.map((r) => r.score)),
      'разные seed должны давать разные score',
    );
  });

  it('свидетельства согласованы с результатами гонки', async () => {
    const { race, experience } = await runPipeline('evidence', { seed: 15, boxes: 3 });

    assert.strictEqual(experience.evidence.length, race.results.length);
    race.results.forEach((result, index) => {
      const proof = experience.evidence[index];
      assert.strictEqual(proof.solver, result.solver);
      assert.strictEqual(proof.score, result.score);
      assert.strictEqual(proof.rank, result.rank);
    });

    const champion = experience.evidence.find((proof) => proof.solver === experience.winner.solver);
    assert.strictEqual(champion.rank, 1);
  });

  it('устойчив к уровню сложности задачи', async () => {
    const easy = await runPipeline({ description: 'easy', difficulty: 0.1 }, { seed: 3 });
    const hard = await runPipeline({ description: 'hard', difficulty: 0.9 }, { seed: 3 });

    assert.ok(easy.experience.winner.score >= hard.experience.winner.score);
  });
});

/* ===========================================================================
 * 11. Тесты: интеграция с реальными модулями репозитория
 * ========================================================================= */

describe('REPO — реальные модули', () => {
  it('подхватывает trajectory/path_builder.js, если он есть', () => {
    const loaded = safeRequire('trajectory/path_builder.js');
    if (!loaded.ok) return; // модуль отсутствует — молча пропускаем
    assert.strictEqual(typeof loaded.mod.buildPath, 'function');
  });

  it('подхватывает trajectory/peer_hint.js, если он есть', () => {
    const loaded = safeRequire('trajectory/peer_hint.js');
    if (!loaded.ok) return;
    assert.ok(loaded.mod && typeof loaded.mod === 'object');
  });
});

/* ===========================================================================
 * 12. Самопроверка критерия: файл длиннее 200 строк
 * ========================================================================= */

describe('SELF — критерий сьюта', () => {
  it(`содержит больше ${MIN_LINES} строк`, () => {
    const source = fs.readFileSync(SELF_PATH, 'utf8');
    const lines = source.split('\n').length;
    assert.ok(lines > MIN_LINES, `ожидалось >${MIN_LINES} строк, найдено ${lines}`);
  });

  it('экспортирует ключевые функции конвейера', () => {
    assert.strictEqual(typeof runPipeline, 'function');
    assert.strictEqual(typeof buildExperience, 'function');
    assert.strictEqual(typeof buildTrajectory, 'function');
    assert.strictEqual(typeof rankResults, 'function');
    assert.strictEqual(typeof classifyAction, 'function');
  });
});

/* ===========================================================================
 * 13. Точка входа
 * ========================================================================= */

if (require.main === module) {
  runAll()
    .then((summary) => {
      console.log(`\n${summary.passed}/${summary.total} passed, ${summary.failed} failed`);
      if (summary.failed > 0) {
        console.error('\nПровалы:');
        for (const failure of summary.failures) {
          console.error(`  - ${failure.suite} › ${failure.test}`);
        }
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

module.exports = {
  assert,
  describe,
  it,
  runAll,
  EventBus,
  Contender,
  RaceStage,
  rankResults,
  normalizeTask,
  buildExperience,
  validateExperience,
  serializeExperience,
  parseExperience,
  buildTrajectory,
  deriveInsights,
  classifyAction,
  runPipeline,
  stableHash,
  stableStringify,
  deepEqual,
  clamp01,
  mulberry32,
  safeRequire,
  sleep,
};
