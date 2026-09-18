'use strict';

/**
 * reaper_v2.test.js — behavioural verification for the Reaper.
 *
 * Covers:
 *   - stale in_progress (>30min) -> pending, retry_count incremented
 *   - 3 attempts exhausted -> permanent_failed with retry_count = 99
 *   - anti-cycling: repeated reap() calls must be idempotent / no flapping
 *   - fresh tasks and terminal states are never touched
 *   - return shape is exactly { changed: [], permanent_failed: [] }
 */

const assert = require('assert');
const { reap } = require('./reaper_v2.js');

const MIN = 60 * 1000;
const NOW = Date.UTC(2025, 0, 1, 12, 0, 0); // fixed clock
const STALE = new Date(NOW - 45 * MIN).toISOString(); // 45 min ago
const FRESH = new Date(NOW - 5 * MIN).toISOString();  // 5 min ago

let passed = 0;

function check(name, fn) {
  fn();
  passed++;
  console.log('  ok -', name);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

console.log('reaper_v2 behaviour tests @', iso(NOW));

// 1. Return shape -----------------------------------------------------------
check('reap() returns {changed, permanent_failed} arrays', () => {
  const out = reap({ tasks: [] }, { now: NOW });
  assert.deepStrictEqual(Object.keys(out).sort(), ['changed', 'permanent_failed']);
  assert.ok(Array.isArray(out.changed));
  assert.ok(Array.isArray(out.permanent_failed));
  assert.strictEqual(out.changed.length, 0);
  assert.strictEqual(out.permanent_failed.length, 0);
});

// 2. Fresh in_progress is untouched ----------------------------------------
check('fresh in_progress (<30min) is left alone', () => {
  const task = { id: 'fresh', status: 'in_progress', started_at: FRESH };
  const out = reap({ tasks: [task] }, { now: NOW });
  assert.strictEqual(out.changed.length, 0);
  assert.strictEqual(task.status, 'in_progress');
  assert.strictEqual(task.retry_count, undefined);
});

// 3. Stale -> pending, retry counted ---------------------------------------
check('stale in_progress -> pending and retry_count=1', () => {
  const task = { id: 't1', status: 'in_progress', started_at: STALE, retry_count: 0 };
  const out = reap({ tasks: [task] }, { now: NOW });
  assert.deepStrictEqual(out.changed, ['t1']);
  assert.strictEqual(out.permanent_failed.length, 0);
  assert.strictEqual(task.status, 'pending');
  assert.strictEqual(task.retry_count, 1);
});

// 4. Retry budget exhaustion -> permanent_failed=99 -------------------------
check('retry_count >= 3 -> permanent_failed with retry_count=99', () => {
  const task = { id: 't2', status: 'in_progress', started_at: STALE, retry_count: 3 };
  const out = reap({ tasks: [task] }, { now: NOW });
  assert.deepStrictEqual(out.permanent_failed, ['t2']);
  assert.strictEqual(out.changed.length, 0);
  assert.strictEqual(task.status, 'permanent_failed');
  assert.strictEqual(task.retry_count, 99);
  assert.strictEqual(task.permanent_failed, true);
});

// 5. ANTI-CYCLING -----------------------------------------------------------
// Simulate the classic loop: worker re-takes the reset task, it goes stale
// again. Reaper must eventually stop resetting it (permanent_failed) and must
// NEVER reset a permanent failure again.
check('anti-cycling: 3 resets then terminal, never re-reset', () => {
  const task = { id: 'loop', status: 'in_progress', started_at: STALE, retry_count: 0 };

  // Pass 1..3: each pass the worker re-grabs it (status -> in_progress with a
  // stale timestamp) and the reaper must bounce it back, incrementing retries.
  for (let i = 1; i <= 3; i++) {
    task.status = 'in_progress';
    task.started_at = STALE;
    // advance clock past cooldown each pass
    const out = reap({ tasks: [task] }, { now: NOW + i * 5 * MIN });
    assert.deepStrictEqual(out.changed, ['loop'], 'pass ' + i + ' should reset');
    assert.strictEqual(task.status, 'pending');
    assert.strictEqual(task.retry_count, i);
  }

  // Pass 4: worker grabs it once more, it goes stale -> terminal now.
  task.status = 'in_progress';
  task.started_at = STALE;
  const final = reap({ tasks: [task] }, { now: NOW + 10 * 24 * 60 * MIN });
  assert.deepStrictEqual(final.permanent_failed, ['loop']);
  assert.strictEqual(task.retry_count, 99);
  assert.strictEqual(task.status, 'permanent_failed');

  // Pass 5+: even a forced stale in_progress sign is never reaped again.
  task.status = 'in_progress';
  task.started_at = STALE;
  const after = reap({ tasks: [task] }, { now: NOW + 20 * 24 * 60 * MIN });
  assert.strictEqual(after.changed.length, 0);
  assert.strictEqual(after.permanent_failed.length, 0);
  assert.strictEqual(task.retry_count, 99);
});

// 6. Double-reap within cooldown is a no-op (no flapping) -------------------
check('immediate double reap is idempotent (cooldown)', () => {
  const task = { id: 'cd', status: 'in_progress', started_at: STALE, retry_count: 0 };
  const first = reap({ tasks: [task] }, { now: NOW });
  assert.deepStrictEqual(first.changed, ['cd']);
  // worker instantly re-grabs; reaper called again the same tick
  task.status = 'in_progress';
  task.started_at = STALE;
  const second = reap({ tasks: [task] }, { now: NOW + 1000 });
  assert.strictEqual(second.changed.length, 0, 'cooldown must prevent flapping');
  assert.strictEqual(task.retry_count, 1);
});

// 7. Terminal states are never touched --------------------------------------
check('terminal / already-failed tasks are untouched', () => {
  const tasks = [
    { id: 'd', status: 'done', started_at: STALE, retry_count: 0 },
    { id: 'f', status: 'failed', started_at: STALE, retry_count: 1 },
    { id: 'pf', status: 'permanent_failed', started_at: STALE, retry_count: 99 },
    { id: 'retry99', status: 'in_progress', started_at: STALE, retry_count: 99 },
  ];
  const out = reap({ tasks }, { now: NOW });
  assert.strictEqual(out.changed.length, 0);
  assert.strictEqual(out.permanent_failed.length, 0);
});

// 8. Missing timestamp -> conservative (no reset, can't cycle) --------------
check('in_progress without a timestamp is left alone', () => {
  const task = { id: 'no-ts', status: 'in_progress', retry_count: 0 };
  const out = reap({ tasks: [task] }, { now: NOW });
  assert.strictEqual(out.changed.length, 0);
  assert.strictEqual(task.status, 'in_progress');
});

// 9. Nested roadmap shapes (phases/tasks, items/tasks) ----------------------
check('nested roadmap phases and items are scanned', () => {
  const roadmap = {
    phases: { a: { tasks: [{ id: 'p1', status: 'in_progress', started_at: STALE, retry_count: 0 }] } },
    items: [{ tasks: [{ id: 'i1', status: 'in_progress', started_at: STALE, retry_count: 0 }] }],
  };
  const out = reap(roadmap, { now: NOW });
  assert.deepStrictEqual(out.changed.sort(), ['i1', 'p1']);
});

console.log('\nreaper_v2: ' + passed + ' checks passed ✔');
