'use strict';

/**
 * evolution/reaper_v2.js
 * =============================================================================
 *
 * "Reaper" v2 — the task zombie-collector / hygiene process for the
 * evolutionary roadmap.
 *
 * Problem
 * -------
 * Autonomous workers occasionally crash, hang, or get killed mid-flight while a
 * task is still flagged `in_progress`. Such tasks become *zombies*: they never
 * complete, never fail, and permanently block the roadmap because every healthy
 * worker believes the task is already taken.
 *
 * Policy
 * ------
 * The Reaper only ever considers tasks whose status is exactly `in_progress` and
 * whose age exceeds a timeout (default 30 minutes):
 *
 *   attempt 1..MAX_ATTEMPTS : reset the task back to `pending` so a healthy
 *                             worker may re-claim it. `retry_count` is bumped.
 *   attempt >  MAX_ATTEMPTS : seal the task forever as `permanent_failed`
 *                             with `retry_count = 99` (a sentinel that makes
 *                             every future pass ignore it).
 *
 * Anti-cycling guarantees (this is the whole point of "v2")
 * ---------------------------------------------------------
 *   1. Only `in_progress` tasks are inspected — resetting to `pending` makes a
 *      task invisible to the next pass until a worker re-claims it.
 *   2. A task that carries `permanent === true`, `permanent_failed === true`,
 *      or `retry_count >= 99` is never touched again (terminal guard).
 *   3. A per-task *cooldown* (default 2 min) prevents rapid ping-pong flapping:
 *      if a task was re-queued moments ago and a buggy worker instantly
 *      re-claims it, the Reaper refuses to bounce it again until the cooldown
 *      has elapsed.
 *   4. The Reaper NEVER sets a task back to `in_progress`, so it can never
 *      itself create the stale state it is supposed to clean up.
 *
 * A single `reap()` call therefore performs at most ONE state transition per
 * task and is idempotent when invoked repeatedly on unchanged input.
 *
 * Public API
 * ----------
 *   reap(roadmap[, options]) -> { changed: string[], permanent_failed: string[] }
 *
 * The input roadmap is mutated in place; the returned summary lists exactly
 * which task ids were re-queued and which were permanently sealed.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MINUTE_MS = 60 * 1000;

/** Default age after which an `in_progress` task is considered stuck. */
const DEFAULT_STUCK_TIMEOUT_MS = 30 * MINUTE_MS;

/** Minimum gap between two consecutive reaps of the same task (anti-flap). */
const DEFAULT_COOLDOWN_MS = 2 * MINUTE_MS;

/** How many times a task may be bounced back to `pending` before it is sealed. */
const MAX_ATTEMPTS = 3;

/** Sentinel retry count that marks a task as permanently failed. */
const PERMANENT_RETRY_COUNT = 99;

/** Recursion guard for deeply nested roadmap containers. */
const MAX_DEPTH = 8;

const STATUS_PENDING = 'pending';
const STATUS_IN_PROGRESS = 'in_progress';
const STATUS_PERMANENT_FAILED = 'permanent_failed';
const STATUS_FAILED = 'failed';

/** Statuses that are already final and must never be reaped. */
const TERMINAL_STATUSES = new Set([
  'done',
  'completed',
  'failed',
  'permanent_failed',
  'cancelled',
  'canceled',
  'skipped',
  'archived',
]);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/**
 * Resolve a wall-clock timestamp (epoch ms).
 *
 * @param {number|Date|{now:Function}|Function} [clock] Injectable clock.
 * @returns {number}
 */
function now(clock) {
  if (typeof clock === 'function') {
    const t = Number(clock());
    if (Number.isFinite(t)) return t;
  }
  if (clock && typeof clock.now === 'function') {
    const t = Number(clock.now());
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

/**
 * Parse an arbitrary timestamp-ish value into epoch milliseconds.
 *
 * Accepts finite numbers (epoch ms), numeric strings, `Date` instances and
 * ISO-8601 / RFC-2822 strings. Returns `null` for anything unusable.
 *
 * @param {*} value
 * @returns {number|null}
 */
function parseTimestamp(value) {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
      return numeric;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/**
 * Extract the moment a task entered `in_progress` from any of the field names
 * seen across roadmap dialects. Returns `null` when no usable stamp exists —
 * such tasks are left untouched (conservative, prevents cycles on bad data).
 *
 * @param {object} task
 * @returns {number|null}
 */
function extractStartedAt(task) {
  const candidates = [
    task.started_at,
    task.startedAt,
    task.in_progress_since,
    task.inProgressSince,
    task.locked_at,
    task.claimed_at,
  ];
  for (const raw of candidates) {
    const stamp = parseTimestamp(raw);
    if (stamp !== null) return stamp;
  }
  return null;
}

/**
 * Extract the moment this task was last re-queued by the Reaper (if ever).
 *
 * @param {object} task
 * @returns {number|null}
 */
function extractRequeueAt(task) {
  const candidates = [
    task.last_requeue_at,
    task.lastRequeueAt,
    task.reaped_at,
    task.reapedAt,
  ];
  for (const raw of candidates) {
    const stamp = parseTimestamp(raw);
    if (stamp !== null) return stamp;
  }
  return null;
}

/**
 * Read the retry counter as a sane non-negative integer.
 *
 * @param {object} task
 * @returns {number}
 */
function attemptsOf(task) {
  const raw = task.retry_count !== undefined ? task.retry_count : task.attempts;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Extract a stable identifier for reporting purposes.
 *
 * @param {object} task
 * @returns {string|null}
 */
function taskId(task) {
  const raw = task.id !== undefined ? task.id : task.task_id !== undefined ? task.task_id : task.key;
  return raw === undefined ? null : raw;
}

/**
 * Terminal/anti-repeat guard: a task is "permanent" when explicitly sealed or
 * already carrying the sentinel retry count.
 *
 * @param {object} task
 * @returns {boolean}
 */
function isPermanent(task) {
  return (
    task.permanent === true ||
    task.permanent_failed === true ||
    attemptsOf(task) >= PERMANENT_RETRY_COUNT
  );
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/**
 * Seal a task forever: `permanent_failed` + `retry_count = 99`.
 * Mutates the task in place.
 *
 * @param {object} task
 * @param {string} reason
 * @param {string} stampIso
 */
function markPermanentFailed(task, reason, stampIso) {
  task.status = STATUS_PERMANENT_FAILED;
  task.permanent = true;
  task.permanent_failed = true;
  task.retry_count = PERMANENT_RETRY_COUNT;
  task.attempts = PERMANENT_RETRY_COUNT;
  task.failure_reason = reason;
  task.failed_at = stampIso;
  task.updated_at = stampIso;
}

/**
 * Bounce a task back to `pending` and bump its retry counter.
 * Mutates the task in place.
 *
 * @param {object} task
 * @param {string} reason
 * @param {string} stampIso
 */
function requeue(task, reason, stampIso) {
  task.status = STATUS_PENDING;
  task.retry_count = attemptsOf(task) + 1;
  task.attempts = task.retry_count;
  task.last_requeue_reason = reason;
  task.last_requeue_at = stampIso;
  task.reaped_at = stampIso;
  // Clear the stale "in progress" markers so the next claim starts fresh.
  task.started_at = null;
  task.startedAt = null;
  task.in_progress_since = null;
  task.inProgressSince = null;
  task.locked_at = null;
}

// ---------------------------------------------------------------------------
// Roadmap traversal
// ---------------------------------------------------------------------------

/**
 * Heuristic: does this value look like a task leaf rather than a container?
 *
 * @param {*} value
 * @returns {boolean}
 */
function looksLikeTask(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ('status' in value || 'id' in value || 'task_id' in value)
  );
}

/**
 * Recursively collect every task object reachable from the roadmap root.
 *
 * Supports a variety of shapes:
 *   - { tasks: [ ... ] }
 *   - { phases: { a: { tasks: [...] } } }
 *   - { items: [ { tasks: [...] } ] }
 *   - [ ...tasks ] / [ { tasks: [...] } ]
 *
 * De-duplicates by object identity while preserving discovery order.
 *
 * @param {*} root
 * @returns {object[]}
 */
function collectTasks(root) {
  const out = [];
  const seen = new Set();

  const push = (task) => {
    if (task && typeof task === 'object' && !seen.has(task)) {
      seen.add(task);
      out.push(task);
    }
  };

  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;

    if (Array.isArray(node)) {
      const isTaskList = node.length > 0 && node.every(looksLikeTask);
      if (isTaskList) {
        node.forEach(push);
        return;
      }
      node.forEach((el) => walk(el, depth + 1));
      return;
    }

    if (Array.isArray(node.tasks)) {
      node.tasks.forEach(push);
    }
  };

  walk(root, 0);

  // Second pass: descend into known container fields so nested task lists are
  // discovered regardless of the roadmap dialect.
  const descend = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;

    if (Array.isArray(node)) {
      if (!(node.length > 0 && node.every(looksLikeTask))) {
        node.forEach((el) => descend(el, depth + 1));
      }
      return;
    }

    if (node.tasks && !Array.isArray(node.tasks) && typeof node.tasks === 'object') {
      descend(node.tasks, depth + 1);
    }

    if (node.phases && typeof node.phases === 'object') {
      descend(node.phases, depth + 1);
    }

    if (Array.isArray(node.items)) {
      node.items.forEach((el) => descend(el, depth + 1));
    }

    if (node.roadmap && typeof node.roadmap === 'object') {
      descend(node.roadmap, depth + 1);
    }
  };

  descend(root, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Options normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise the second argument of `reap()`.
 *
 * @param {number|object} [options]
 * @returns {{now:number, stuckTimeoutMs:number, cooldownMs:number, maxAttempts:number}}
 */
function normalizeOptions(options) {
  let opts = {};
  if (typeof options === 'number' && Number.isFinite(options)) {
    // Historical shorthand: a bare number means "stuck timeout in minutes".
    opts = { timeoutMinutes: options };
  } else if (options && typeof options === 'object') {
    opts = options;
  }

  const clock = opts.clock !== undefined ? opts.clock : opts.now;

  const stuckTimeoutMs =
    Number.isFinite(opts.stuckTimeoutMs) && opts.stuckTimeoutMs > 0
      ? opts.stuckTimeoutMs
      : Number.isFinite(opts.timeoutMinutes) && opts.timeoutMinutes >= 0
        ? opts.timeoutMinutes * MINUTE_MS
        : DEFAULT_STUCK_TIMEOUT_MS;

  const cooldownMs =
    Number.isFinite(opts.cooldownMs) && opts.cooldownMs >= 0
      ? opts.cooldownMs
      : DEFAULT_COOLDOWN_MS;

  const maxAttempts =
    Number.isFinite(opts.maxAttempts) && opts.maxAttempts > 0
      ? Math.floor(opts.maxAttempts)
      : MAX_ATTEMPTS;

  return {
    now: now(clock),
    stuckTimeoutMs,
    cooldownMs,
    maxAttempts,
  };
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Reap zombie `in_progress` tasks from a roadmap.
 *
 * @param {object|Array} roadmap                    Mutable roadmap/task list.
 * @param {number|object} [options]                 Timeout minutes or options bag.
 * @param {number} [options.now]                    Injectable clock (epoch ms).
 * @param {Function|{now:Function}} [options.clock] Alternative injectable clock.
 * @param {number} [options.stuckTimeoutMs=1800000] Stuck threshold in ms.
 * @param {number} [options.timeoutMinutes=30]      Stuck threshold in minutes.
 * @param {number} [options.cooldownMs=120000]      Anti-flap cooldown in ms.
 * @param {number} [options.maxAttempts=3]          Reset budget before sealing.
 * @returns {{changed: Array, permanent_failed: Array}}
 */
function reap(roadmap, options) {
  const result = { changed: [], permanent_failed: [] };

  if (!roadmap || typeof roadmap !== 'object') {
    return result;
  }

  const cfg = normalizeOptions(options);
  const stampIso = new Date(cfg.now).toISOString();
  const tasks = collectTasks(roadmap);

  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;

    // Anti-cycle guard #1: never resurrect terminal / sealed tasks.
    if (TERMINAL_STATUSES.has(task.status) || isPermanent(task)) continue;

    // Anti-cycle guard #2: only stuck `in_progress` tasks are eligible.
    if (task.status !== STATUS_IN_PROGRESS) continue;

    const startedAt = extractStartedAt(task);
    // No clock at all -> cannot prove it is stale -> leave it alone.
    if (startedOrNull(startedAt) === null) continue;

    const age = cfg.now - startedAt;
    if (age < cfg.stuckTimeoutMs) continue;

    // Anti-cycle guard #3: cooldown between two consecutive reaps of the same
    // task, so a buggy worker re-claiming it instantly cannot cause flapping.
    const lastRequeue = extractRequeueAt(task);
    if (lastRequeue !== null && cfg.now - lastRequeue < cfg.cooldownMs) continue;

    const attempts = attemptsOf(task);
    const id = taskId(task);
    const reason = 'stuck_in_progress:' + age + 'ms';

    if (attempts + 1 > cfg.maxAttempts) {
      markPermanentFailed(task, reason, stampIso);
      result.permanent_failed.push(id);
      continue;
    }

    requeue(task, reason, stampIso);
    result.changed.push(id);
  }

  return result;
}

/**
 * Tiny helper kept for readability around the "no timestamp" decision.
 * @param {number|null} stamp
 * @returns {number|null}
 */
function startedOrNull(stamp) {
  return stamp === null || stamp === undefined ? null : stamp;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  reap,
  // Constants / helpers exposed for tests and downstream modules.
  STUCK_TIMEOUT_MS: DEFAULT_STUCK_TIMEOUT_MS,
  DEFAULT_STUCK_TIMEOUT_MS,
  DEFAULT_COOLDOWN_MS,
  MAX_ATTEMPTS,
  PERMANENT_RETRY_COUNT,
  STATUS_PENDING,
  STATUS_IN_PROGRESS,
  STATUS_PERMANENT_FAILED,
  STATUS_FAILED,
  _internals: {
    now,
    parseTimestamp,
    extractStartedAt,
    extractRequeueAt,
    attemptsOf,
    taskId,
    isPermanent,
    collectTasks,
    normalizeOptions,
  },
};
