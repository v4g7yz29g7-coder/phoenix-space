'use strict';

/**
 * pool/retry_failed.test.js
 * ---------------------------------------------------------------------------
 * Тесты планировщика ретраев `pool/retry_failed.js`.
 *
 * Покрытие по критерию задачи:
 *   • backoff(3) == 30/60/120s
 *   • cap == 600s (10 min) и не превышается
 *   • skip completed / in_progress
 *   • exhausted после maxAttempts
 *   • state ключуется по task_id
 *   • идемпотентность повторного запуска (state не растёт без новых failures)
 *   • dry-run по реальному пулу: eligible: N, N ≤ 183
 *
 * Запуск:
 *   node pool/retry_failed.test.js                 # standalone
 *   node tests/runner.js pool/retry_failed.test.js # через общий раннер
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = require('./retry_failed.js');

const POOL = path.join(__dirname, '..', 'tasks_night_pool.json');

/* ========================================================================= *
 * Мини-раннер (совместим и со standalone, и с tests/runner.js)
 * ========================================================================= */

const tests = {};

function t(name, fn) {
  tests[name] = fn;
}

function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-state-'));
  return path.join(dir, 'retry_state.json');
}

const NOW = new Date('2026-09-17T12:00:00.000Z');

/* ========================================================================= *
 * Backoff
 * ========================================================================= */

t('01. backoff(3) == [30, 60, 120] секунд', () => {
  assert.deepStrictEqual(R.backoffSchedule(3), [30, 60, 120]);
});

t('02. computeBackoff(1..3) == 30/60/120', () => {
  assert.strictEqual(R.computeBackoff(1), 30);
  assert.strictEqual(R.computeBackoff(2), 60);
  assert.strictEqual(R.computeBackoff(3), 120);
});

t('03. cap: 4..5 попытки растут, 6-я упирается в 600s', () => {
  assert.strictEqual(R.computeBackoff(4), 240);
  assert.strictEqual(R.computeBackoff(5), 480);
  assert.strictEqual(R.computeBackoff(6), 600); // 30*2^5 = 960 -> cap 600
  assert.strictEqual(R.computeBackoff(20), 600);
});

t('04. cap никогда не превышается во всём расписании', () => {
  const sched = R.backoffSchedule(12);
  assert.strictEqual(sched.length, 12);
  assert.ok(sched.every((s) => s <= 600), 'каждая задержка <= cap');
  assert.strictEqual(sched[sched.length - 1], 600);
});

t('05. custom base/multiplier/cap соблюдаются', () => {
  assert.deepStrictEqual(R.backoffSchedule(3, { base: 5, multiplier: 3, cap: 100 }), [5, 15, 45]);
  assert.strictEqual(R.computeBackoff(10, { base: 5, multiplier: 3, cap: 100 }), 100);
});

t('06. backoff(0) == [] и attempt<1 не ломает формулу', () => {
  assert.deepStrictEqual(R.backoffSchedule(0), []);
  assert.strictEqual(R.computeBackoff(0), 30);
  assert.strictEqual(R.computeBackoff(-5), 30);
});

/* ========================================================================= *
 * Terminal statuses / eligibility
 * ========================================================================= */

t('07. status=completed не трогаем', () => {
  const info = R.inspect({ id: 'C1', status: 'completed' }, R.emptyState(), NOW);
  assert.strictEqual(info.eligible, false);
  assert.strictEqual(info.reason, 'skip_status:completed');
});

t('08. status=in_progress не трогаем', () => {
  const info = R.inspect({ id: 'I1', status: 'in_progress' }, R.emptyState(), NOW);
  assert.strictEqual(info.eligible, false);
  assert.strictEqual(info.reason, 'skip_status:in_progress');
});

t('09. isTerminalStatus знает оба статуса и не трогает failed', () => {
  assert.strictEqual(R.isTerminalStatus('completed'), true);
  assert.strictEqual(R.isTerminalStatus('in_progress'), true);
  assert.strictEqual(R.isTerminalStatus('failed'), false);
  assert.strictEqual(R.isTerminalStatus('pending'), false);
});

t('10. status=failed без state — eligible, delay=30', () => {
  const info = R.inspect({ id: 'F1', status: 'failed' }, R.emptyState(), NOW);
  assert.strictEqual(info.eligible, true);
  assert.strictEqual(info.reason, 'ok');
  assert.strictEqual(info.delay, 30);
  assert.strictEqual(info.attempts, 0);
});

t('11. status=pending (не failed) пропускается', () => {
  const info = R.inspect({ id: 'P1', status: 'pending' }, R.emptyState(), NOW);
  assert.strictEqual(info.eligible, false);
  assert.strictEqual(info.reason, 'not_failed:pending');
});

/* ========================================================================= *
 * Exhausted / backoff wait
 * ========================================================================= */

t('12. после 3 попыток задача exhausted → не eligible', () => {
  const state = R.emptyState();
  state.tasks['F2'] = { attempts: 3, next_attempt_at: new Date(NOW.getTime() - 1).toISOString() };
  const info = R.inspect({ id: 'F2', status: 'failed' }, state, NOW);
  assert.strictEqual(info.eligible, false);
  assert.strictEqual(info.reason, 'exhausted');
});

t('13. next_attempt_at в будущем → backoff_wait (не eligible)', () => {
  const state = R.emptyState();
  state.tasks['F3'] = { attempts: 1, next_attempt_at: new Date(NOW.getTime() + 30_000).toISOString() };
  const info = R.inspect({ id: 'F3', status: 'failed' }, state, NOW);
  assert.strictEqual(info.eligible, false);
  assert.strictEqual(info.reason, 'backoff_wait');
});

t('14. next_attempt_at в прошлом → снова eligible, delay=60', () => {
  const state = R.emptyState();
  state.tasks['F4'] = { attempts: 1, next_attempt_at: new Date(NOW.getTime() - 1).toISOString() };
  const info = R.inspect({ id: 'F4', status: 'failed' }, state, NOW);
  assert.strictEqual(info.eligible, true);
  assert.strictEqual(info.delay, 60); // attempt #2
});

/* ========================================================================= *
 * Apply / state / идемпотентность
 * ========================================================================= */

const FIXTURE = [
  { id: 'A', status: 'failed' },
  { id: 'B', status: 'failed' },
  { id: 'C', status: 'completed' },
  { id: 'D', status: 'in_progress' },
  { id: 'E', status: 'pending' },
];

t('15. state ключуется по task_id, а не по индексу', () => {
  const state = R.emptyState();
  const res = R.applyRetries(FIXTURE, state, NOW);
  const keys = Object.keys(res.state.tasks).sort();
  assert.deepStrictEqual(keys, ['A', 'B']);
  assert.ok(!res.state.tasks[2], 'нет записей по индексам');
  assert.strictEqual(res.state.tasks.A.attempts, 1);
});

t('16. apply: completed/in_progress/pending не попадают в state', () => {
  const state = R.emptyState();
  const res = R.applyRetries(FIXTURE, state, NOW);
  assert.strictEqual(res.changed, 2);
  assert.strictEqual(res.skipped, 3);
  assert.strictEqual(res.state.tasks.C, undefined);
  assert.strictEqual(res.state.tasks.D, undefined);
  assert.strictEqual(res.state.tasks.E, undefined);
});

t('17. попытки инкрементят задержку 30 → 60 → 120 по расписанию', () => {
  let state = R.emptyState();
  let now = new Date(NOW.getTime());
  const one = [{ id: 'X', status: 'failed' }];

  let res = R.applyRetries(one, state, now);
  assert.strictEqual(res.state.tasks.X.attempts, 1);
  assert.strictEqual(res.state.tasks.X.backoff_seconds, 30);

  now = new Date(now.getTime() + 30_000); // переждали backoff #1
  res = R.applyRetries(one, state, now);
  assert.strictEqual(res.state.tasks.X.attempts, 2);
  assert.strictEqual(res.state.tasks.X.backoff_seconds, 60);

  now = new Date(now.getTime() + 60_000);
  res = R.applyRetries(one, state, now);
  assert.strictEqual(res.state.tasks.X.attempts, 3);
  assert.strictEqual(res.state.tasks.X.backoff_seconds, 120);

  // 4-й запуск без нового failure — exhausted, state не растёт
  now = new Date(now.getTime() + 120_000);
  res = R.applyRetries(one, state, now);
  assert.strictEqual(res.changed, 0);
  assert.strictEqual(res.state.tasks.X.attempts, 3);
});

t('18. повторный apply с тем же now идемпотентен (state не растёт)', () => {
  const state = R.emptyState();
  const first = R.applyRetries(FIXTURE, state, NOW);
  const snapshot = JSON.stringify(first.state);
  const size1 = Object.keys(first.state.tasks).length;
  assert.strictEqual(size1, 2);

  const second = R.applyRetries(FIXTURE, first.state, NOW);
  assert.strictEqual(second.changed, 0, 'второй прогон ничего не меняет');
  assert.strictEqual(second.state.tasks.A.attempts, 1, 'attempts не удваивается');
  assert.deepStrictEqual(second.state.tasks, first.state.tasks, 'записи идентичны');
  assert.strictEqual(JSON.stringify(second.state), snapshot);
});

t('19. save/load state сохраняют структуру и не растут повторно', () => {
  const file = tmpStateFile();
  const state = R.emptyState();
  const res = R.applyRetries([{ id: 'Z', status: 'failed' }], state, NOW);
  R.saveState(file, res.state);

  const loaded = R.loadState(file);
  assert.strictEqual(loaded.tasks.Z.attempts, 1);
  assert.strictEqual(loaded.tasks.Z.backoff_seconds, 30);

  // повторная загрузка+apply с тем же now — ничего не добавляет
  const again = R.applyRetries([{ id: 'Z', status: 'failed' }], loaded, NOW);
  assert.strictEqual(again.changed, 0);
  assert.strictEqual(Object.keys(again.state.tasks).length, 1);
});

t('20. state отсутствует на диске → пустой state, а не падение', () => {
  const file = path.join(os.tmpdir(), `no-such-${Date.now()}.json`);
  const st = R.loadState(file);
  assert.deepStrictEqual(st.tasks, {});
  assert.strictEqual(st.version, 1);
});

/* ========================================================================= *
 * Интеграция с реальным пулом (read-only)
 * ========================================================================= */

t('21. dry-run по tasks_night_pool.json: eligible ≤ 183 и ≤ числа failed', () => {
  const tasks = R.loadPool(POOL);
  const failed = tasks.filter((x) => x.status === 'failed').length;
  const eligible = R.planEligible(tasks, R.emptyState(), NOW);

  assert.ok(tasks.length > 0, 'пул не пустой');
  assert.ok(failed >= 1, `есть failed-задачи (найдено ${failed})`);
  assert.ok(eligible.length <= failed, 'eligible не больше failed');
  assert.ok(eligible.length <= 183, `eligible (${eligible.length}) ≤ 183`);
  assert.ok(eligible.every((e) => e.task.status === 'failed'), 'все eligible — failed');
});

t('22. completed/in_progress из реального пула никогда не eligible', () => {
  const tasks = R.loadPool(POOL);
  const terminal = tasks.filter((x) => x.status === 'completed' || x.status === 'in_progress');
  const infos = R.inspectAll(terminal, R.emptyState(), NOW);
  assert.ok(terminal.length > 0, 'в пуле есть terminal-задачи');
  assert.ok(infos.every((i) => i.eligible === false), 'ни одна terminal не eligible');
});

/* ========================================================================= *
 * Standalone runner
 * ========================================================================= */

function runSuite() {
  const names = Object.keys(tests);
  let failed = 0;
  console.log(`\npool/retry_failed.js — ${names.length} тест-кейсов`);
  for (const name of names) {
    try {
      tests[name]();
      console.log(`  \u2713 ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  \u2717 ${name}\n      ${(err && err.message) || err}`);
    }
  }
  const passed = names.length - failed;
  console.log(`\n${passed}/${names.length} passed${failed ? `, ${failed} FAILED` : ' \u2014 ALL PASSED'}\n`);
  if (failed) process.exitCode = 1;
  return failed;
}

Object.defineProperty(tests, 'run', { value: runSuite, enumerable: false });

if (require.main === module) {
  runSuite();
}

module.exports = tests;
