#!/usr/bin/env node
'use strict';

/**
 * pool/retry_backoff.js
 * ---------------------------------------------------------------------------
 * Ядро retry-логики ночного пула (обобщение a17c1b16).
 *
 * Отличия от pool/retry_failed.js (v1, base=30s/cap=600s):
 *   • base       = 1000 ms   -> 1s, 2s, 4s, 8s, 16s
 *   • factor     = 2
 *   • maxAttempts = 5        -> ровно 5 попыток, затем exhausted
 *   • jitterRatio = 0.2      -> jitter ∈ [0, 20%] от задержки
 *   • классификация ошибок transient/fatal: fatal НЕ ретраится
 *   • счётчик attempts в статусе задачи растёт строго монотонно
 *
 * Всё инъектируемо, чтобы тестировать без реального времени:
 *   • sleep   — заменяется моком (не ждём реально)
 *   • now     — виртуальные часы (() => ms)
 *   • random  — сид для детерминированного jitter
 *
 * Инварианты:
 *   • delayForAttempt(n) = computeBackoff(n) + jitter, jitter ∈ [0, 0.2*backoff].
 *   • computeBackoff(n) = base * factor^(n-1)  (1s,2s,4s,8s,16s для n=1..5).
 *   • transient-ошибка -> sleep(backoff) -> следующая попытка.
 *   • fatal-ошибка     -> немедленный стоп, retriable=false, sleep НЕ зовётся.
 *   • attempts инкрементится ровно один раз на каждый вызов operation.
 */

const CONFIG = Object.freeze({
  base: 1000, // ms (1s)
  factor: 2, // экспоненциальный множитель
  maxAttempts: 5, // максимум попыток
  jitterRatio: 0.2, // верхняя граница jitter = 20%
});

const MAX_ATTEMPTS = CONFIG.maxAttempts;

/* ========================================================================= *
 * Опции
 * ========================================================================= */

function numOr(v, dflt) {
  return Number.isFinite(v) ? v : dflt;
}

function resolveOptions(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  return {
    base: numOr(o.base, CONFIG.base),
    factor: numOr(o.factor, CONFIG.factor),
    maxAttempts: Math.max(1, Math.floor(numOr(o.maxAttempts, CONFIG.maxAttempts))),
    jitterRatio: Math.max(0, numOr(o.jitterRatio, CONFIG.jitterRatio)),
    minDelay: numOr(o.minDelay, 0),
    maxDelay: Number.isFinite(o.maxDelay) ? o.maxDelay : Infinity,
  };
}

/* ========================================================================= *
 * Backoff + jitter
 * ========================================================================= */

/** Базовая (без jitter) задержка для 1-based попытки: 1s,2s,4s,8s,16s. */
function computeBackoff(attempt, opts = {}) {
  const o = resolveOptions(opts);
  const n = Math.max(1, Math.floor(numOr(attempt, 1)));
  const raw = o.base * Math.pow(o.factor, n - 1);
  return Math.min(o.maxDelay, Math.max(o.minDelay, raw));
}

/** Полное расписание базовых задержек на maxAttempts попыток. */
function backoffSchedule(opts = {}) {
  const o = resolveOptions(opts);
  const out = [];
  for (let i = 1; i <= o.maxAttempts; i += 1) out.push(computeBackoff(i, o));
  return out;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Величина jitter в ms: delay * r * jitterRatio, где r=rand() ∈ [0,1]. */
function jitterFor(delay, rand = Math.random, opts = {}) {
  const o = resolveOptions(opts);
  const r = clamp01(typeof rand === 'function' ? rand() : rand);
  return delay * r * o.jitterRatio;
}

/** Итоговая задержка попытки: base(n) + jitter ∈ [base(n), base(n)*1.2]. */
function delayForAttempt(attempt, rand = Math.random, opts = {}) {
  const base = computeBackoff(attempt, opts);
  return base + jitterFor(base, rand, opts);
}

/* ========================================================================= *
 * Классификация ошибок
 * ========================================================================= */

const FATAL_CODES = Object.freeze([
  400, 401, 403, 404, 405, 409, 410, 422,
  'FATAL', 'INVALID', 'VALIDATION', 'VALIDATION_ERROR',
  'AUTH', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'BAD_REQUEST',
]);

const TRANSIENT_CODES = Object.freeze([
  408, 425, 429, 500, 502, 503, 504,
  'TRANSIENT', 'TIMEOUT', 'RATE_LIMIT', 'SERVICE_UNAVAILABLE',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
]);

const FATAL_ERROR_NAMES = Object.freeze(['SyntaxError', 'TypeError', 'ReferenceError', 'RangeError']);

function errorCodeOf(err) {
  if (err.code !== undefined && err.code !== null) return err.code;
  if (err.status !== undefined && err.status !== null) return err.status;
  if (err.statusCode !== undefined && err.statusCode !== null) return err.statusCode;
  if (typeof err.errno === 'number') return err.errno;
  return undefined;
}

/**
 * Классифицирует ошибку как 'transient' (ретраим) или 'fatal' (не ретраим).
 * Приоритет: явный флаг fatal > кастомный classify > retryable/transient >
 * code/status > имя класса ошибки > дефолт 'transient'.
 */
function classifyError(err, classify) {
  if (typeof classify === 'function') {
    const c = classify(err);
    if (c === 'fatal' || c === 'transient') return c;
  }
  if (err == null) return 'transient';
  if (typeof err === 'string') {
    const up = err.toUpperCase();
    if (FATAL_CODES.includes(up)) return 'fatal';
    if (TRANSIENT_CODES.includes(up)) return 'transient';
    return 'transient';
  }
  if (err.fatal === true) return 'fatal';
  if (err.transient === true || err.retryable === true) return 'transient';
  if (err.retryable === false) return 'fatal';

  const code = errorCodeOf(err);
  if (code !== undefined) {
    if (FATAL_CODES.includes(code)) return 'fatal';
    if (TRANSIENT_CODES.includes(code)) return 'transient';
    if (typeof code === 'number') {
      if (code >= 500) return 'transient';
      if (code >= 400 && code < 500) return 'fatal';
    }
  }
  if (typeof err.name === 'string' && FATAL_ERROR_NAMES.includes(err.name)) return 'fatal';
  return 'transient';
}

function isRetriable(err, classify) {
  return classifyError(err, classify) === 'transient';
}

/* ========================================================================= *
 * Время и sleep (инъектируемые)
 * ========================================================================= */

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Виртуальные часы: now() -> ms, advance(ms), set(ms). */
function createClock(start = 0) {
  let t = Number.isFinite(start) ? start : Date.parse(start);
  if (!Number.isFinite(t)) t = 0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
    set: (ms) => {
      t = ms;
      return t;
    },
  };
}

/** Мок sleep: не ждёт реально, копит вызовы и двигает виртуальные часы. */
function createMockSleep(clock = createClock(0)) {
  const calls = [];
  const fn = (ms) => {
    calls.push(ms);
    clock.advance(ms);
    return Promise.resolve();
  };
  fn.calls = calls;
  fn.total = () => calls.reduce((a, b) => a + b, 0);
  return fn;
}

/* ========================================================================= *
 * Статус задачи (attempts растёт монотонно)
 * ========================================================================= */

function makeTaskStatus(taskId) {
  return {
    task_id: taskId == null ? null : taskId,
    attempts: 0,
    status: 'pending',
    last_error: null,
    last_error_class: null,
    delays: [],
    history: [],
  };
}

/** Инкрементит attempts ровно на 1 и пишет запись в историю (монотонность). */
function recordAttempt(status, info = {}) {
  status.attempts = (Number.isFinite(status.attempts) ? status.attempts : 0) + 1;
  status.status = 'running';
  status.last_error = info.error ? info.error.message || String(info.error) : null;
  status.last_error_class = info.errorClass || null;
  if (info.delay != null) status.delays.push(info.delay);
  status.history.push({
    attempt: status.attempts,
    at: Number.isFinite(info.at) ? info.at : null,
    delay: info.delay == null ? null : info.delay,
    errorClass: info.errorClass || null,
  });
  return status.attempts;
}

/* ========================================================================= *
 * Движок
 * ========================================================================= */

/**
 * Запускает operation с ретраями по exponential backoff + jitter.
 *
 * @param {string} taskId
 * @param {(attempt:number,status:object)=>any} operation
 * @param {object} [options] { maxAttempts, base, factor, jitterRatio, classify,
 *                             sleep, now, random, status }
 * @returns {Promise<{ok:boolean, attempts:number, result:any, error:any,
 *                    errorClass:string|null, fatal:boolean, exhausted:boolean,
 *                    retriable:boolean, status:object, history:Array}>}
 */
async function runWithRetry(taskId, operation, options = {}) {
  const o = resolveOptions(options);
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;
  const rand = typeof options.random === 'function' ? options.random : Math.random;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const status = options.status || makeTaskStatus(taskId);
  let lastError = null;

  for (let attempt = 1; attempt <= o.maxAttempts; attempt += 1) {
    try {
      const result = await operation(attempt, status);
      recordAttempt(status, { at: now(), delay: null, errorClass: null, error: null });
      status.status = 'succeeded';
      return {
        ok: true,
        attempts: status.attempts,
        result,
        error: null,
        errorClass: null,
        fatal: false,
        exhausted: false,
        retriable: false,
        status,
        history: status.history.slice(),
      };
    } catch (err) {
      lastError = err;
      const cls = classifyError(err, options.classify);

      if (cls === 'fatal') {
        recordAttempt(status, { at: now(), delay: null, errorClass: cls, error: err });
        status.status = 'failed_fatal';
        return {
          ok: false,
          attempts: status.attempts,
          result: null,
          error: err,
          errorClass: cls,
          fatal: true,
          exhausted: false,
          retriable: false,
          status,
          history: status.history.slice(),
        };
      }

      if (attempt >= o.maxAttempts) {
        recordAttempt(status, { at: now(), delay: null, errorClass: cls, error: err });
        status.status = 'exhausted';
        return {
          ok: false,
          attempts: status.attempts,
          result: null,
          error: err,
          errorClass: cls,
          fatal: false,
          exhausted: true,
          retriable: false,
          status,
          history: status.history.slice(),
        };
      }

      const delay = delayForAttempt(attempt, rand, o);
      recordAttempt(status, { at: now(), delay, errorClass: cls, error: err });
      await sleep(delay, attempt);
    }
  }

  return {
    ok: false,
    attempts: status.attempts,
    result: null,
    error: lastError,
    errorClass: lastError ? classifyError(lastError, options.classify) : null,
    fatal: false,
    exhausted: true,
    retriable: false,
    status,
    history: status.history.slice(),
  };
}

module.exports = {
  CONFIG,
  MAX_ATTEMPTS,
  FATAL_CODES,
  TRANSIENT_CODES,
  resolveOptions,
  computeBackoff,
  backoffSchedule,
  jitterFor,
  delayForAttempt,
  classifyError,
  isRetriable,
  defaultSleep,
  createClock,
  createMockSleep,
  makeTaskStatus,
  recordAttempt,
  runWithRetry,
};
