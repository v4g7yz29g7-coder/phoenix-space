'use strict';

/**
 * api/rate_limiter.js
 * ============================================================================
 * Dependency-free, in-memory, fixed-window rate limiter.
 *
 * Public API
 * ----------
 *   const rl = require('./rate_limiter');
 *
 *   // Module level convenience (shared default limiter)
 *   rl.check(ip);                                  // -> result object
 *   app.use(rl.middleware());                      // express/connect handler
 *
 *   // Isolated limiter instances
 *   const limiter = rl.createRateLimiter({ windowMs: 60_000, max: 120 });
 *   limiter.check(ip);
 *   limiter.reset(ip);
 *   app.use(limiter.middleware());
 *
 *   // Class form (backwards compatible)
 *   const { RateLimiter } = rl;
 *   const l = new RateLimiter({ max: 100, windowMs: 1000 });
 *
 * Result object returned by `check(key)`:
 *   {
 *     allowed:    boolean, // may the request proceed?
 *     limited:    boolean, // convenience inverse of `allowed`
 *     limit:      number,  // configured ceiling (max)
 *     remaining:  number,  // requests left in the current window
 *     reset:      number,  // epoch ms when the window resets
 *     retryAfter: number,  // whole seconds until reset (0 when allowed)
 *     total:      number,  // hits observed in the current window
 *   }
 *
 * Options
 * -------
 *   windowMs     {number}   window length in ms           (default 60000)
 *   max          {number}   max requests per window        (default 120)
 *                       (alias: limit)
 *   window       {number}   alias of windowMs
 *   statusCode   {number}   status when limited            (default 429)
 *   message      {string}   error message for 429          (default 'Too Many Requests')
 *   headers      {boolean}  emit X-RateLimit-* headers      (default true)
 *   keyGenerator {function} custom key fn(req)             (default IP extraction)
 *   skip         {function} predicate(req) -> bool         (default none)
 *   onLimit      {function} (req, res, info) hook          (default none)
 *
 * Design goals
 * ------------
 *   - zero runtime dependencies
 *   - deterministic, easily testable behaviour
 *   - O(1) amortised bookkeeping per request
 *   - bounded memory via periodic/opportunistic sweeping
 * ============================================================================
 */

/* ============================== Defaults ================================= */

const DEFAULTS = Object.freeze({
  windowMs: 60000,
  max: 120,
  statusCode: 429,
  message: 'Too Many Requests',
  headers: true,
  keyGenerator: null,
  skip: null,
  onLimit: null,
});

/** Clock isolated so tests can stub it if necessary. */
const now = () => Date.now();

/* ============================== Helpers ================================== */

/** Coerce anything into a stable string key. */
function toKey(value) {
  if (value == null || value === '') return 'unknown';
  return String(value);
}

/**
 * Best-effort client identifier extraction from an incoming request.
 * Honours common proxy headers and falls back to the socket address.
 *
 * @param {object} req
 * @returns {string}
 */
function defaultKeyGenerator(req) {
  if (!req) return 'unknown';

  const headers = req.headers || {};

  const forwarded = headers['x-forwarded-for'];
  if (forwarded) {
    const first = String(forwarded).split(',')[0].trim();
    if (first) return first;
  }

  const real = headers['x-real-ip'];
  if (real) {
    const trimmed = String(real).trim();
    if (trimmed) return trimmed;
  }

  if (req.ip) return String(req.ip);
  if (req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress);
  if (req.connection && req.connection.remoteAddress) {
    return String(req.connection.remoteAddress);
  }
  return 'unknown';
}

/**
 * Normalise options, accepting common aliases (`limit`/`max`, `window`/`windowMs`)
 * and rejecting obviously invalid input.
 *
 * @param {object} [options]
 * @returns {object}
 */
function normalizeOptions(options) {
  const raw = options && typeof options === 'object' ? options : {};
  const merged = Object.assign({}, raw);

  if (merged.max == null && merged.limit != null) merged.max = merged.limit;
  if (merged.windowMs == null && merged.window != null) merged.windowMs = merged.window;
  if (merged.windowMs == null && merged.interval != null) merged.windowMs = merged.interval;

  const opts = Object.assign({}, DEFAULTS, merged);

  if (typeof opts.windowMs !== 'number' || !(opts.windowMs > 0)) {
    throw new TypeError('rate_limiter: windowMs must be a positive number');
  }
  if (typeof opts.max !== 'number' || !(opts.max > 0)) {
    throw new TypeError('rate_limiter: max must be a positive number');
  }
  if (opts.keyGenerator != null && typeof opts.keyGenerator !== 'function') {
    throw new TypeError('rate_limiter: keyGenerator must be a function');
  }
  if (opts.skip != null && typeof opts.skip !== 'function') {
    throw new TypeError('rate_limiter: skip must be a function');
  }
  if (opts.onLimit != null && typeof opts.onLimit !== 'function') {
    throw new TypeError('rate_limiter: onLimit must be a function');
  }

  return opts;
}

/* ============================== RateLimiter ============================== */

class RateLimiter {
  /**
   * @param {object} [options]
   */
  constructor(options) {
    this.options = normalizeOptions(options);
    this.buckets = new Map(); // key -> { count, windowStart, resetAt, lastSeen }
    this._sweepCounter = 0;
    this._sweepTimer = null;

    // Periodic sweeper that must not keep the event loop alive.
    const interval = Math.max(1000, Math.floor(this.options.windowMs));
    if (typeof setInterval === 'function') {
      this._sweepTimer = setInterval(() => this.sweep(), interval);
      if (this._sweepTimer && typeof this._sweepTimer.unref === 'function') {
        this._sweepTimer.unref();
      }
    }
  }

  /** Number of currently tracked clients. */
  get size() {
    return this.buckets.size;
  }

  /** Fetch (or lazily create / roll over) the window bucket for a key. */
  _bucket(key) {
    const t = now();
    let bucket = this.buckets.get(key);

    if (!bucket || t >= bucket.resetAt) {
      bucket = {
        count: 0,
        windowStart: t,
        resetAt: t + this.options.windowMs,
        lastSeen: t,
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Register a hit for `ip` and report whether it is allowed.
   *
   * @param {string} ip client identifier (usually an IP)
   * @returns {{allowed:boolean, limited:boolean, limit:number,
   *            remaining:number, retryAfter:number, reset:number, total:number}}
   */
  check(ip) {
    const key = toKey(ip);
    const bucket = this._bucket(key);
    const limit = this.options.max;
    const t = now();

    bucket.lastSeen = t;
    bucket.count += 1;

    const allowed = bucket.count <= limit;
    const remaining = Math.max(0, limit - bucket.count);
    const retryAfter = Math.max(0, Math.ceil((bucket.resetAt - t) / 1000));

    return {
      allowed: allowed,
      limited: !allowed,
      limit: limit,
      remaining: remaining,
      retryAfter: retryAfter,
      reset: bucket.resetAt,
      total: bucket.count,
    };
  }

  /** Clear the bucket for a single key. */
  reset(ip) {
    this.buckets.delete(toKey(ip));
    return this;
  }

  /** Clear every bucket (used in tests and on config reload). */
  resetAll() {
    this.buckets.clear();
    return this;
  }

  /** Remove buckets whose window has already elapsed. */
  sweep() {
    const t = now();
    for (const [key, bucket] of this.buckets) {
      if (t >= bucket.resetAt) this.buckets.delete(key);
    }
    return this;
  }

  /** Debug helper: current state without mutating counters. */
  snapshot() {
    const t = now();
    const out = {};
    for (const [key, bucket] of this.buckets) {
      out[key] = {
        count: bucket.count,
        remaining: Math.max(0, this.options.max - bucket.count),
        resetAt: bucket.resetAt,
        ttlMs: Math.max(0, bucket.resetAt - t),
      };
    }
    return out;
  }

  /** Release the sweeper timer. */
  dispose() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    return this;
  }

  /**
   * Express/Connect compatible middleware bound to this limiter.
   *
   * @param {object} [overrides] option overrides for this handler only
   * @returns {function(req, res, next): void}
   */
  middleware(overrides) {
    const self = this;
    const opts = Object.assign({}, self.options, overrides || {});
    const keyGen = opts.keyGenerator || defaultKeyGenerator;

    return function rateLimitMiddleware(req, res, next) {
      if (typeof opts.skip === 'function' && opts.skip(req)) {
        return next();
      }

      const key = toKey(keyGen(req));
      const info = self.check(key);

      if (opts.headers && res && typeof res.setHeader === 'function') {
        res.setHeader('X-RateLimit-Limit', String(opts.max));
        res.setHeader('X-RateLimit-Remaining', String(info.remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(info.reset / 1000)));
      }

      if (!info.limited) {
        return next();
      }

      if (opts.headers && res && typeof res.setHeader === 'function') {
        res.setHeader('Retry-After', String(info.retryAfter));
      }

      if (typeof opts.onLimit === 'function') {
        try {
          opts.onLimit(req, res, info);
        } catch (e) {
          /* observability hooks must never break request handling */
        }
      }

      if (res && typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(opts.statusCode).json({
          error: opts.message,
          retryAfter: info.retryAfter,
        });
      }

      if (res && typeof res.writeHead === 'function') {
        res.writeHead(opts.statusCode, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: opts.message, retryAfter: info.retryAfter }));
      }

      const err = new Error(opts.message);
      err.status = opts.statusCode;
      err.retryAfter = info.retryAfter;
      return typeof next === 'function' ? next(err) : undefined;
    };
  }
}

/* ============================== Registry ================================= */

let defaultLimiter = new RateLimiter();

/** Lazily created shared limiter backing the module-level `check()`. */
function getDefaultLimiter() {
  if (!defaultLimiter) defaultLimiter = new RateLimiter();
  return defaultLimiter;
}

/**
 * Factory: build an isolated limiter instance.
 * @param {object} [options]
 * @returns {RateLimiter}
 */
function createRateLimiter(options) {
  return new RateLimiter(options);
}

/** Reconfigure (or replace) the module default limiter. */
function configure(options) {
  if (defaultLimiter && typeof defaultLimiter.dispose === 'function') {
    defaultLimiter.dispose();
  }
  defaultLimiter = new RateLimiter(options);
  return defaultLimiter;
}

/**
 * Module-level convenience `check(ip)` backed by a shared default limiter.
 * @param {string} ip
 * @returns {{allowed:boolean, limited:boolean, limit:number,
 *            remaining:number, retryAfter:number, reset:number, total:number}}
 */
function check(ip) {
  return getDefaultLimiter().check(ip);
}

/**
 * Module-level middleware factory (uses the shared default limiter).
 * @param {object} [options]
 * @returns {function}
 */
function middleware(options) {
  return getDefaultLimiter().middleware(options);
}

/** Reset the shared default limiter (mostly useful in tests). */
function resetDefault() {
  if (defaultLimiter) defaultLimiter.resetAll();
  return defaultLimiter;
}

/* ============================== Exports ================================== */

// Keep class-style usage (`new RateLimiter()`) working while exposing the
// task-mandated `check(ip)` / `middleware()` surface on the same object.
module.exports = RateLimiter;

module.exports.RateLimiter = RateLimiter;
module.exports.createRateLimiter = createRateLimiter;
module.exports.check = check;
module.exports.middleware = middleware;
module.exports.configure = configure;
module.exports.getDefaultLimiter = getDefaultLimiter;
module.exports.resetDefault = resetDefault;
module.exports.defaultKeyGenerator = defaultKeyGenerator;
module.exports.normalizeOptions = normalizeOptions;
module.exports.toKey = toKey;
module.exports.DEFAULTS = DEFAULTS;
