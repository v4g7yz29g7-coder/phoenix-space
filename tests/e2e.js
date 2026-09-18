'use strict';

/**
 * tests/e2e.js
 * ============================================================================
 * Сквозной E2E-тест:   АГЕНТ  ->  ГОНКА  ->  EverOS
 * ============================================================================
 *
 * Один процесс, без сети и без внешних зависимостей — используются только
 * встроенные модули (node:crypto / node:fs / node:path). Проверяется полный
 * жизненный цикл задачи:
 *
 *   +----------+  register/solve   +-----------+  winner+score  +----------+
 *   |  АГЕНТ   | ----------------> |   ГОНКА   | -------------> |  EverOS  |
 *   +----------+                   +-----------+                +----------+
 *
 *   1. АГЕНТ   — регистрируется в шине событий, получает capability-токен,
 *                детерминированно (mulberry32) решает задачу и возвращает
 *                кандидатное решение со score в диапазоне [0, 1].
 *   2. ГОНКА   — N боксов параллельно генерируют кандидатов; движок собирает
 *                их, проверяет кворум, ранжирует и выбирает РОВНО одного
 *                победителя. Публикуются события race.started/race.finished.
 *   3. EverOS  — результат гонки (победитель + score + решение) коммитится в
 *                долговременную память, читается обратно по id/subject/search
 *                и верифицируется по sha256-хэшу.
 *
 * Детерминизм: одинаковый seed -> одинаковый победитель (отдельный тест),
 * поэтому сьют пригоден для CI без флаки.
 *
 * Запуск:
 *     node --check tests/e2e.js     # только синтаксическая проверка
 *     node tests/e2e.js             # прогон всего сьюта (exit 0/1)
 * ============================================================================
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SELF_PATH = path.join(__dirname, 'e2e.js');
const MIN_LINES = 180;

/* ============================================================================
 * 0. Утилиты
 * ========================================================================== */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const uid = (prefix = 'id') =>
  `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

const nowIso = () => new Date().toISOString();

/** Детерминированный PRNG: одинаковый seed -> одинаковая последовательность. */
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

function sha256(input) {
  return crypto
    .createHash('sha256')
    .update(typeof input === 'string' ? input : JSON.stringify(input))
    .digest('hex');
}

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ============================================================================
 * 1. AGENT — агент-исполнитель
 * ========================================================================== */

/** Простая шина событий для наблюдаемости жизненного цикла. */
class EventBus {
  constructor() {
    this.log = [];
    this.handlers = new Map();
  }

  on(type, handler) {
    const list = this.handlers.get(type) || [];
    list.push(handler);
    this.handlers.set(type, list);
    return this;
  }

  emit(type, payload = {}) {
    const event = { type, payload, at: nowIso() };
    this.log.push(event);
    for (const handler of this.handlers.get(type) || []) {
      handler(event);
    }
    return event;
  }

  count(type) {
    return this.log.filter((e) => e.type === type).length;
  }
}

/**
 * Агент: детерминированно решает задачу и возвращает кандидата.
 * score тем выше, чем выше skill агента и ниже сложность задачи.
 */
class Agent {
  constructor(spec = {}) {
    this.agentId = spec.id || uid('agent');
    this.seed = Number.isInteger(spec.seed) ? spec.seed : 1;
    this.skill = typeof spec.skill === 'number' ? spec.skill : 0.5;
    this.latency = spec.latency || 0;
    this.capability = null;
    this.state = 'idle';
    this.candidates = 0;
  }

  /** Регистрация в шине -> выдаём стабильный capability-токен. */
  register(bus) {
    this.capability = sha256(`${this.agentId}:${this.seed}`).slice(0, 16);
    this.state = 'ready';
    if (bus && typeof bus.emit === 'function') {
      bus.emit('agent.registered', { agentId: this.agentId, capability: this.capability });
    }
    return this.capability;
  }

  /** Синхронный детерминированный «расчёт» кандидата. */
  solve(task) {
    if (!task || !task.id) throw new Error('solve: task is required');
    const rng = mulberry32(this.seed + task.id.length);
    const complexity = typeof task.complexity === 'number' ? task.complexity : 0.5;
    const noise = (rng() - 0.5) * 0.15;
    const score = Math.min(1, Math.max(0, this.skill * (1 - complexity) + 0.4 + noise));
    const artifact = {
      algorithm: 'mulberry32',
      seed: this.seed,
      value: Math.floor(rng() * 1e9),
      digest: sha256(`${this.agentId}:${task.id}:${this.seed}`),
    };
    this.candidates += 1;
    return { agentId: this.agentId, taskId: task.id, score, artifact };
  }

  /** Асинхронная обёртка над solve() с имитацией сетевой задержки. */
  async run(task, bus) {
    this.state = 'running';
    if (bus) bus.emit('agent.started', { agentId: this.agentId, taskId: task.id });
    if (this.latency > 0) await sleep(this.latency);
    const candidate = this.solve(task);
    this.state = 'done';
    if (bus) bus.emit('agent.finished', { agentId: this.agentId, score: candidate.score });
    return candidate;
  }
}

/* ============================================================================
 * 2. RACE — гонка агентов за право записать результат
 * ========================================================================== */

/**
 * Race: все enrolled-агенты стартуют «одновременно» через Promise.all;
 * движок проверяет кворум, ранжирует кандидатов и выбирает ровно одного
 * победителя. Побеждает максимальный score; при равенстве — меньшая
 * задержка; при полном равенстве — первый зарегистрированный.
 */
class Race {
  constructor(task, opts = {}) {
    if (!task || !task.id) throw new Error('Race: task.id is required');
    this.id = opts.id || uid('race');
    this.task = task;
    this.minQuorum = opts.minQuorum || 1;
    this.bus = opts.eventBus || new EventBus();
    this.entrants = [];
    this.candidates = [];
    this.failures = [];
    this.winner = null;
    this.startedAt = null;
    this.finishedAt = null;
    this.durationMs = 0;
    this._ran = false;
  }

  enroll(agent) {
    if (this._ran) throw new Error('Race: enrollment closed');
    this.entrants.push(agent);
    return this;
  }

  hasQuorum() {
    return this.candidates.length >= this.minQuorum;
  }

  async run() {
    if (this._ran) throw new Error('Race: already ran');
    this._ran = true;
    this.startedAt = Date.now();
    this.bus.emit('race.started', { raceId: this.id, entrants: this.entrants.length });

    const settled = await Promise.all(
      this.entrants.map((agent) =>
        agent
          .run(this.task, this.bus)
          .then((candidate) => ({ ok: true, candidate }))
          .catch((err) => ({ ok: false, err }))
      )
    );

    for (const outcome of settled) {
      if (outcome.ok) this.candidates.push(outcome.candidate);
      else this.failures.push(outcome.err);
    }

    if (this.hasQuorum()) {
      const order = new Map(this.entrants.map((a, i) => [a.agentId, i]));
      const ranked = [...this.candidates].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return order.get(a.agentId) - order.get(b.agentId);
      });
      this.winner = ranked[0];
    }

    this.finishedAt = Date.now();
    this.durationMs = this.finishedAt - this.startedAt;
    this.bus.emit('race.finished', {
      raceId: this.id,
      winner: this.winner ? this.winner.agentId : null,
      score: this.winner ? this.winner.score : 0,
      durationMs: this.durationMs,
    });
    return this.winner;
  }

  summary() {
    return {
      raceId: this.id,
      taskId: this.task.id,
      entrants: this.entrants.length,
      candidates: this.candidates.length,
      quorum: this.hasQuorum(),
      winner: this.winner ? this.winner.agentId : null,
      bestScore: this.winner ? this.winner.score : 0,
      medianScore: median(this.candidates.map((c) => c.score)),
      durationMs: this.durationMs,
      failures: this.failures.length,
    };
  }
}

/* ============================================================================
 * 3. EVEROS — долговременная память
 * ========================================================================== */

/** In-memory EverOS: append-only журнал с запросами по id/subject/search. */
class EverOSMemory {
  constructor(opts = {}) {
    this.records = [];
    this.seq = 0;
    this.version = 1;
    this.dir = opts.dir || null;
  }

  commit(record) {
    const entry = {
      id: record.id || uid('mem'),
      seq: ++this.seq,
      subject: record.subject || 'race',
      taskId: record.taskId || null,
      winner: record.winner != null ? record.winner : null,
      score: record.score != null ? record.score : null,
      payload: record.payload != null ? record.payload : null,
      at: record.at || nowIso(),
    };
    entry.hash = sha256({
      id: entry.id,
      seq: entry.seq,
      subject: entry.subject,
      winner: entry.winner,
      score: entry.score,
      payload: entry.payload,
    });
    this.records.push(entry);
    this.version += 1;
    return entry;
  }

  get(id) {
    return this.records.find((r) => r.id === id) || null;
  }

  bySubject(subject) {
    return this.records.filter((r) => r.subject === subject);
  }

  byWinner(agentId) {
    return this.records.filter((r) => r.winner === agentId);
  }

  search(term) {
    const needle = String(term).toLowerCase();
    return this.records.filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
  }

  verify(entry) {
    if (!entry) return false;
    const expected = sha256({
      id: entry.id,
      seq: entry.seq,
      subject: entry.subject,
      winner: entry.winner,
      score: entry.score,
      payload: entry.payload,
    });
    return expected === entry.hash;
  }

  get size() {
    return this.records.length;
  }

  clear() {
    this.records = [];
    this.seq = 0;
    this.version = 1;
  }
}

/* ============================================================================
 * 4. ОРКЕСТРАТОР: агент -> гонка -> EverOS
 * ========================================================================== */

/**
 * Полный цикл: агенты соревнуются за задачу, победитель и его результат
 * коммитятся в EverOS. Возвращает всё необходимое для проверок.
 */
async function runE2E({ agents = [], task, memory, minQuorum = 1, bus } = {}) {
  if (!task || !task.id) throw new Error('runE2E: task.id is required');
  const eventBus = bus || new EventBus();
  const mem = memory || new EverOSMemory();

  const race = new Race(task, { minQuorum, eventBus });
  for (const spec of agents) {
    const agent = spec instanceof Agent ? spec : new Agent(spec);
    agent.register(eventBus);
    race.enroll(agent);
  }

  const winner = await race.run();
  const summary = race.summary();

  const entry = mem.commit({
    subject: `task/${task.id}`,
    taskId: task.id,
    winner: winner ? winner.agentId : null,
    score: winner ? winner.score : null,
    payload: {
      raceId: race.id,
      artifact: winner ? winner.artifact : null,
      note: winner ? 'ok' : 'no quorum',
    },
  });

  eventBus.emit('everos.committed', {
    memoryId: entry.id,
    winner: entry.winner,
    score: entry.score,
  });

  return { race, winner, entry, summary, memory: mem, bus: eventBus };
}

/* ============================================================================
 * 5. МИНИ-ФРЕЙМВОР ТЕСТОВ (без внешних зависимостей)
 * ========================================================================== */

const state = { passed: 0, failed: 0, results: [] };

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    state.passed += 1;
    state.results.push({ name, status: 'PASS', ms: Date.now() - started });
    console.log(`  \u2713 ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    state.failed += 1;
    state.results.push({ name, status: 'FAIL', ms: Date.now() - started, error: err.message });
    console.error(`  \u2717 ${name}`);
    console.error(`      ${err.message}`);
  }
}

async function describe(title, fn) {
  console.log(`\n${title}`);
  await fn();
}

function countLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').length;
}

/* ============================================================================
 * 6. СЦЕНАРИИ
 * ========================================================================== */

async function main() {
  console.log('# E2E: агент \u2192 гонка \u2192 EverOS');

  await describe('0. Метаданные', async () => {
    await test(`tests/e2e.js содержит >${MIN_LINES} строк`, () => {
      const lines = countLines(SELF_PATH);
      assert.ok(lines > MIN_LINES, `ожидалось >${MIN_LINES}, получено ${lines}`);
    });
    await test('файл существует в ROOT/tests', () => {
      assert.ok(fs.existsSync(SELF_PATH));
      assert.equal(path.basename(SELF_PATH), 'e2e.js');
      assert.ok(SELF_PATH.startsWith(ROOT));
    });
  });

  await describe('1. Агент', async () => {
    await test('solve() -> кандидат с score в [0,1] и digest-256', () => {
      const a = new Agent({ id: 'A1', seed: 42, skill: 0.8 });
      a.register(new EventBus());
      const c = a.solve({ id: 'T1', complexity: 0.3 });
      assert.equal(c.agentId, 'A1');
      assert.equal(c.taskId, 'T1');
      assert.ok(c.score >= 0 && c.score <= 1);
      assert.equal(c.artifact.digest.length, 64);
    });

    await test('детерминизм: один seed -> одинаковый score', () => {
      const mk = () => {
        const a = new Agent({ id: 'Det', seed: 1234, skill: 0.7 });
        a.register();
        return a.solve({ id: 'T', complexity: 0.5 }).score;
      };
      assert.equal(mk(), mk());
    });

    await test('register() выдаёт стабильный capability-токен (16 hex)', () => {
      const a = new Agent({ id: 'Cap', seed: 7 });
      const token = a.register(new EventBus());
      assert.match(token, /^[0-9a-f]{16}$/);
      assert.equal(a.capability, sha256('Cap:7').slice(0, 16));
    });

    await test('solve() без задачи бросает ошибку', () => {
      const a = new Agent({ id: 'F', seed: 1 });
      assert.throws(() => a.solve(null), /task is required/);
    });
  });

  await describe('2. Гонка', async () => {
    await test('энроллинг запрещён после старта', async () => {
      const race = new Race({ id: 'Tq' });
      race.enroll(new Agent({ id: 'X', seed: 1 }));
      await race.run();
      assert.throws(() => race.enroll(new Agent({ id: 'Y', seed: 2 })), /enrollment closed/);
    });

    await test('победитель ровно один, по максимальному score', async () => {
      const agents = [
        { id: 'low', seed: 11, skill: 0.2 },
        { id: 'high', seed: 22, skill: 0.95 },
        { id: 'mid', seed: 33, skill: 0.5 },
      ];
      const { winner, race } = await runE2E({ agents, task: { id: 'Tr', complexity: 0.2 } });
      assert.ok(winner, 'должен быть победитель');
      assert.equal(race.summary().candidates, 3);
      assert.equal(winner.agentId, 'high');
    });

    await test('кворум: без кандидатов победителя нет', async () => {
      const race = new Race({ id: 'Tn' }, { minQuorum: 2 });
      // агент с падающим run(), чтобы не набрать кворум
      const broken = new Agent({ id: 'broken', seed: 1 });
      broken.run = async () => {
        throw new Error('boom');
      };
      race.enroll(broken);
      const winner = await race.run();
      assert.equal(winner, null);
      assert.equal(race.summary().quorum, false);
      assert.equal(race.summary().failures, 1);
    });

    await test('публикуются события race.started / race.finished', async () => {
      const bus = new EventBus();
      await runE2E({ agents: [{ id: 'e1', seed: 5, skill: 0.6 }], task: { id: 'Te' }, bus });
      assert.equal(bus.count('race.started'), 1);
      assert.equal(bus.count('race.finished'), 1);
    });
  });

  await describe('3. EverOS', async () => {
    await test('commit() присваивает id, seq и sha256-хэш', () => {
      const mem = new EverOSMemory();
      const entry = mem.commit({ subject: 's', winner: 'w', score: 0.5 });
      assert.ok(entry.id);
      assert.equal(entry.seq, 1);
      assert.equal(entry.hash.length, 64);
      assert.ok(mem.verify(entry));
    });

    await test('чтение по id / subject / winner', async () => {
      const mem = new EverOSMemory();
      const e1 = mem.commit({ subject: 'task/T1', winner: 'a', score: 0.9 });
      mem.commit({ subject: 'task/T2', winner: 'b', score: 0.4 });
      assert.equal(mem.get(e1.id).id, e1.id);
      assert.equal(mem.bySubject('task/T1').length, 1);
      assert.equal(mem.byWinner('b').length, 1);
      assert.equal(mem.size, 2);
    });

    await test('поиск по подстроке (search)', () => {
      const mem = new EverOSMemory();
      mem.commit({ subject: 'task/alpha', winner: 'agent-7', score: 0.7 });
      assert.equal(mem.search('agent-7').length, 1);
      assert.equal(mem.search('nope').length, 0);
    });

    await test('верификация ловит подмену данных', () => {
      const mem = new EverOSMemory();
      const entry = mem.commit({ subject: 's', winner: 'w', score: 0.5 });
      assert.ok(mem.verify(entry));
      entry.score = 0.99; // подмена
      assert.equal(mem.verify(entry), false);
    });
  });

  await describe('4. Интеграция: агент -> гонка -> EverOS', async () => {
    await test('победитель и score попадают в EverOS', async () => {
      const { winner, entry, memory } = await runE2E({
        agents: [
          { id: 'p1', seed: 101, skill: 0.9 },
          { id: 'p2', seed: 202, skill: 0.3 },
        ],
        task: { id: 'Tint', complexity: 0.25 },
      });
      assert.ok(winner);
      assert.equal(entry.winner, winner.agentId);
      assert.equal(entry.score, winner.score);
      assert.equal(memory.size, 1);
      assert.ok(memory.verify(memory.get(entry.id)));
    });

    await test('детерминизм гонки: одинаковый вход -> одинаковый победитель', async () => {
      const mk = () =>
        runE2E({
          agents: [
            { id: 'd1', seed: 1, skill: 0.5 },
            { id: 'd2', seed: 2, skill: 0.75 },
            { id: 'd3', seed: 3, skill: 0.6 },
          ],
          task: { id: 'Tdet', complexity: 0.4 },
        }).then((r) => r.winner.agentId);
      assert.equal(await mk(), await mk());
    });

    await test('жизненный цикл порождает полный набор событий', async () => {
      const bus = new EventBus();
      const { winner } = await runE2E({
        agents: [
          { id: 'ev1', seed: 10, skill: 0.8 },
          { id: 'ev2', seed: 20, skill: 0.7 },
        ],
        task: { id: 'Tev' },
        bus,
      });
      assert.ok(winner);
      assert.equal(bus.count('agent.registered'), 2);
      assert.equal(bus.count('agent.started'), 2);
      assert.equal(bus.count('agent.finished'), 2);
      assert.equal(bus.count('everos.committed'), 1);
    });

    await test('победитель зависит от skill (ранжирование)', async () => {
      const { winner } = await runE2E({
        agents: [
          { id: 'weak', seed: 9, skill: 0.1 },
          { id: 'strong', seed: 9, skill: 0.99 },
        ],
        task: { id: 'Tskill', complexity: 0 },
      });
      assert.equal(winner.agentId, 'strong');
    });
  });

  // ---- Итог -------------------------------------------------------------
  const total = state.passed + state.failed;
  console.log('\n' + '-'.repeat(60));
  console.log(`ИТОГ: ${state.passed}/${total} passed, ${state.failed} failed`);
  if (state.failed > 0) {
    process.exitCode = 1;
  }
  return state;
}

main().catch((err) => {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

module.exports = { Agent, Race, EverOSMemory, EventBus, runE2E, mulberry32, sha256 };
