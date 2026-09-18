'use strict';

/**
 * Smoke test for api/rate_limiter.js
 * Verifies the public API contract: check(ip) and middleware().
 * Run: node api/_smoke_rate_limiter.js
 */

const rl = require('./rate_limiter');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

// --- check(ip) -----------------------------------------------------------
const limiter = rl.createRateLimiter({ windowMs: 1000, max: 3 });
const a = limiter.check('1.2.3.4');
assert(a.allowed === true, 'first request allowed');
assert(a.limit === 3, 'limit echoed');
assert(a.remaining === 2, 'remaining decremented');

limiter.check('1.2.3.4');
limiter.check('1.2.3.4');
const blocked = limiter.check('1.2.3.4');
assert(blocked.allowed === false, '4th request blocked');
assert(blocked.limited === true, 'limited flag set');
assert(blocked.retryAfter >= 0, 'retryAfter numeric');

// Independent keys do not share buckets.
const b = limiter.check('9.9.9.9');
assert(b.allowed === true, 'other ip independent');

// reset()
limiter.reset('1.2.3.4');
assert(limiter.check('1.2.3.4').allowed === true, 'reset clears bucket');

// bare default check(ip)
assert(typeof rl.check === 'function', 'default check exported');
assert(rl.check('8.8.8.8').limit > 0, 'default check works');

// middleware factory
assert(typeof rl.middleware === 'function', 'middleware exported');
const mw = rl.middleware({ windowMs: 1000, max: 1 });
assert(typeof mw === 'function', 'middleware returns handler');

let nextCalled = 0;
const req = { ip: '5.5.5.5', headers: {} };
const res = {
  headers: {},
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.code = c; return this; },
  json(p) { this.body = p; return this; },
};

mw(req, res, () => { nextCalled += 1; });
assert(nextCalled === 1, 'first request passes through');
mw(req, res, () => { nextCalled += 1; });
assert(nextCalled === 1, 'second request blocked before next');
assert(res.code === 429, 'blocked responds 429');
assert(res.headers['X-RateLimit-Limit'] === '1', 'rate limit header set');
assert(res.headers['Retry-After'] != null, 'retry-after header set');

console.log('OK: rate_limiter smoke passed');
