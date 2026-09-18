'use strict';

/**
 * api/tests.js
 * ---------------------------------------------------------------------------
 * Dependency-free API test-suite for the Phoenix HTTP API.
 *
 * Primary entry point (as required):
 *
 *   run()          -> Promise<{ ok, passed, failed, skipped, total,
 *                               durationMs, results: [...], generatedAt }>
 *   run(options)   -> same shape, tuned by:
 *                    {
 *                      silent:    boolean,  // suppress console output
 *                      timeout:   number,   // per-request timeout in ms
 *                      keepAlive: boolean   // reuse socket agent
 *                    }
 *
 * Supporting API:
 *   assert(condition, message)     -> throws AssertionError on failure
 *   assertEqual(actual, expected)  -> strict deep-ish equality
 *   assertStatus(res, code)        -> HTTP status assertion
 *   createServer()                 -> in-process mock API server
 *   createClient(baseUrl)          -> tiny promise-based HTTP client
 *   suite(name, fn) / test(name, fn)
 *   reporter                      -> collects and prints results
 *   resetRegistry()               -> clears registered suites
 *   DEFAULTS                      -> frozen default configuration
 *
 * The module is side-effect free at import time: it does not open sockets
 * or start servers until run() is invoked. When executed directly
 * (`node api/tests.js`) it runs the suite and sets a non-zero exit code on
 * failure so it can be wired into CI.
 * ---------------------------------------------------------------------------
 */

const http = require('http');
const assert = require('assert');

/* =========================================================================
 * Configuration
 * ========================================================================= */

const DEFAULTS = Object.freeze({
  silent: false,
  timeout: 5000,
  keepAlive: false,
});

/* =========================================================================
 * Assertion helpers (small, explicit wrappers around node:assert)
 * ========================================================================= */

/** Throw a descriptive AssertionError when `condition` is falsy. */
function assert_(condition, message) {
  if (!condition) {
    throw new assert.AssertionError({
      message: message || 'expected condition to be truthy',
    });
  }
}

/** Deep strict equality with a readable message. */
function assertEqual(actual, expected, message) {
  assert.deepStrictEqual(
    actual,
    expected,
    message || 'values are not deeply equal'
  );
}

/** Assert an HTTP response carries the expected status code. */
function assertStatus(res, code, message) {
  assert_(
    res && typeof res.status === 'number',
    'response object must expose a numeric status'
  );
  assertEqual(
    res.status,
    code,
    message || 'expected HTTP ' + code + ' but got ' + res.status
  );
}

/* =========================================================================
 * Minimal promise-based HTTP client
 * ========================================================================= */

/**
 * Perform a single HTTP request against `baseUrl`.
 *
 * @param {string} baseUrl  e.g. http://127.0.0.1:PORT
 * @param {object} opts     { method, path, headers, body, timeout, agent }
 * @returns {Promise<{status:number, headers:object, body:string, json:any}>}
 */
function request(baseUrl, opts) {
  const o = opts || {};
  return new Promise(function executor(resolve, reject) {
    let payload = null;
    if (o.body !== undefined && o.body !== null) {
      payload = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    }

    const headers = Object.assign({}, o.headers);
    if (payload !== null && headers['Content-Length'] === undefined) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (payload !== null && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const target = new URL(o.path || '/', baseUrl);
    const req = http.request(
      {
        method: o.method || 'GET',
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        headers: headers,
        agent: o.agent,
      },
      function onResponse(res) {
        const chunks = [];
        res.on('data', function onData(chunk) {
          chunks.push(chunk);
        });
        res.on('end', function onEnd() {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = body.length ? JSON.parse(body) : null;
          } catch (err) {
            json = null;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: body,
            json: json,
          });
        });
      }
    );

    req.on('error', reject);

    const timeout = Number.isFinite(o.timeout) ? o.timeout : DEFAULTS.timeout;
    req.setTimeout(timeout, function onTimeout() {
      req.destroy(new Error('request timed out after ' + timeout + 'ms'));
    });

    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

/** Convenience factory returning a bound request function. */
function createClient(baseUrl) {
  return {
    get: function get(path, extra) {
      return request(baseUrl, Object.assign({ method: 'GET', path: path }, extra));
    },
    post: function post(path, body, extra) {
      return request(
        baseUrl,
        Object.assign({ method: 'POST', path: path, body: body }, extra)
      );
    },
    del: function del(path, extra) {
      return request(
        baseUrl,
        Object.assign({ method: 'DELETE', path: path }, extra)
      );
    },
  };
}

/* =========================================================================
 * Mock API server used by the integration-style tests
 * ========================================================================= */

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 1000;

/** Small in-memory store so tests never touch real persistence. */
const store = {
  users: new Map(),
  rate: new Map(),
};

function nowMs() {
  return Date.now();
}

function resetStore() {
  store.users.clear();
  store.rate.clear();
}

/** Very small router: returns { status, headers, body }. */
function route(req, method, path, body) {
  const requestId = 'req-' + Math.random().toString(36).slice(2, 10);

  if (method === 'GET' && path === '/health') {
    return {
      status: 200,
      body: { status: 'ok', uptime: 0.001, requestId: requestId },
    };
  }

  if (method === 'GET' && path === '/api/v1/status') {
    return {
      status: 200,
      body: { version: '1.0.0', service: 'phoenix-api', requestId: requestId },
    };
  }

  if (method === 'POST' && path === '/api/v1/echo') {
    if (!body || typeof body !== 'object') {
      return { status: 400, body: { error: 'invalid_json' } };
    }
    return { status: 200, body: { echo: body, requestId: requestId } };
  }

  if (method === 'POST' && path === '/api/v1/users') {
    const id = body && body.id;
    if (!id) return { status: 422, body: { error: 'id_required' } };
    if (store.users.has(id)) {
      return { status: 409, body: { error: 'already_exists', id: id } };
    }
    store.users.set(id, { id: id, name: (body && body.name) || null });
    return { status: 201, body: { created: true, id: id } };
  }

  if (method === 'GET' && path.indexOf('/api/v1/users/') === 0) {
    const id = path.slice('/api/v1/users/'.length);
    if (!store.users.has(id)) {
      return { status: 404, body: { error: 'not_found', id: id } };
    }
    return { status: 200, body: store.users.get(id) };
  }

  if (method === 'GET' && path === '/api/v1/secure') {
    const auth = req.headers['authorization'];
    if (auth !== 'Bearer test-token') {
      return {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer' },
        body: { error: 'unauthorized' },
      };
    }
    return { status: 200, body: { secret: 'granted' } };
  }

  if (method === 'GET' && path === '/api/v1/limited') {
    const key = 'global';
    const bucket = store.rate.get(key) || { count: 0, reset: nowMs() + RATE_LIMIT_WINDOW_MS };
    if (nowMs() > bucket.reset) {
      bucket.count = 0;
      bucket.reset = nowMs() + RATE_LIMIT_WINDOW_MS;
    }
    bucket.count += 1;
    store.rate.set(key, bucket);
    if (bucket.count > RATE_LIMIT_MAX) {
      return {
        status: 429,
        headers: { 'Retry-After': '1' },
        body: { error: 'rate_limited', count: bucket.count },
      };
    }
    return {
      status: 200,
      body: { count: bucket.count, limit: RATE_LIMIT_MAX, requestId: requestId },
    };
  }

  if (method === 'POST' && path === '/api/v1/boom') {
    return { status: 500, body: { error: 'internal_error', requestId: requestId } };
  }

  return { status: 404, body: { error: 'no_route', path: path, method: method } };
}

/**
 * Start the in-process mock server and resolve with { server, url, close }.
 * The server never throws on malformed requests; it answers 400 instead.
 */
function createServer() {
  return new Promise(function executor(resolve, reject) {
    const server = http.createServer(function handler(req, res) {
      const chunks = [];
      req.on('data', function onData(c) {
        chunks.push(c);
      });
      req.on('error', function onErr() {
        /* ignore client aborts */
      });
      req.on('end', function onEnd() {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        if (raw.length) {
          try {
            body = JSON.parse(raw);
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'malformed_json' }));
            return;
          }
        }

        const url = new URL(req.url, 'http://127.0.0.1');
        const out = route(req, req.method, url.pathname, body);
        const headers = Object.assign(
          { 'Content-Type': 'application/json' },
          out.headers || {}
        );
        res.writeHead(out.status, headers);
        res.end(out.body === undefined ? '' : JSON.stringify(out.body));
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', function onListening() {
      const addr = server.address();
      resolve({
        server: server,
        url: 'http://127.0.0.1:' + addr.port,
        close: function close() {
          return new Promise(function done(r) {
            server.close(function onClose() {
              r();
            });
          });
        },
      });
    });
  });
}

/* =========================================================================
 * Micro test framework (suite / test / reporter)
 * ========================================================================= */

const registry = [];
const reporter = { results: [], startedAt: null };

/** Reset the registry (useful between programmatic runs). */
function resetRegistry() {
  registry.length = 0;
  reporter.results.length = 0;
  return true;
}

/** Register a named suite that receives the shared context. */
function suite(name, fn) {
  registry.push({ name: String(name), fn: fn });
  return registry.length;
}

/** Sugar for registering a single test inside a suite body. */
function test(name, fn) {
  registry.push({
    name: 'test: ' + String(name),
    fn: function wrap(ctx) {
      return fn(ctx);
    },
  });
  return registry.length;
}

/** Run a single registered unit, capturing timing and errors. */
function runUnit(unit, ctx) {
  const startedAt = Date.now();
  return Promise.resolve()
    .then(function invoke() {
      return unit.fn(ctx);
    })
    .then(
      function ok() {
        return {
          name: unit.name,
          status: 'passed',
          durationMs: Date.now() - startedAt,
          error: null,
        };
      },
      function failed(err) {
        return {
          name: unit.name,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          error: (err && err.message) ? err.message : String(err),
        };
      }
    );
}

/* =========================================================================
 * Test cases
 * ========================================================================= */

function defineApiTests() {
  suite('health & status', function (ctx) {
    return Promise.resolve()
      .then(function () {
        return ctx.client.get('/health');
      })
      .then(function (res) {
        assertStatus(res, 200);
        assert_(res.json && res.json.status === 'ok', 'health payload');
        assert_(typeof res.json.requestId === 'string', 'requestId present');
        assert_(
          /application\/json/.test(res.headers['content-type'] || ''),
          'content-type is json'
        );
      })
      .then(function () {
        return ctx.client.get('/api/v1/status');
      })
      .then(function (res) {
        assertStatus(res, 200);
        assertEqual(res.json.service, 'phoenix-api');
        assert_(typeof res.json.version === 'string', 'version string');
      });
  });

  suite('echo roundtrip', function (ctx) {
    const payload = { hello: 'world', n: 42, nested: { ok: true } };
    return ctx.client.post('/api/v1/echo', payload).then(function (res) {
      assertStatus(res, 200);
      assertEqual(res.json.echo, payload);
    });
  });

  suite('users CRUD lifecycle', function (ctx) {
    const id = 'user-1';
    return ctx.client
      .post('/api/v1/users', { id: id, name: 'Ada' })
      .then(function (res) {
        assertStatus(res, 201);
        assertEqual(res.json.created, true);
        return ctx.client.get('/api/v1/users/' + id);
      })
      .then(function (res) {
        assertStatus(res, 200);
        assertEqual(res.json.name, 'Ada');
        return ctx.client.post('/api/v1/users', { id: id });
      })
      .then(function (res) {
        assertStatus(res, 409);
        assertEqual(res.json.error, 'already_exists');
      });
  });

  suite('auth guard', function (ctx) {
    return ctx.client
      .get('/api/v1/secure')
      .then(function (res) {
        assertStatus(res, 401);
        assertEqual(res.json.error, 'unauthorized');
        return ctx.client.get('/api/v1/secure', {
          headers: { Authorization: 'Bearer test-token' },
        });
      })
      .then(function (res) {
        assertStatus(res, 200);
        assertEqual(res.json.secret, 'granted');
      });
  });

  suite('rate limiting', function (ctx) {
    const calls = [];
    for (let i = 0; i < RATE_LIMIT_MAX + 2; i += 1) {
      calls.push(ctx.client.get('/api/v1/limited'));
    }
    return Promise.all(calls).then(function (responses) {
      const okCount = responses.filter(function (r) {
        return r.status === 200;
      }).length;
      const limited = responses.filter(function (r) {
        return r.status === 429;
      }).length;
      assertEqual(okCount, RATE_LIMIT_MAX, 'allowed requests');
      assert_(limited >= 1, 'at least one request was rate limited');
    });
  });

  suite('error handling', function (ctx) {
    return ctx.client
      .get('/api/v1/unknown')
      .then(function (res) {
        assertStatus(res, 404);
        assertEqual(res.json.error, 'no_route');
        return ctx.client.post('/api/v1/boom', {});
      })
      .then(function (res) {
        assertStatus(res, 500);
        assertEqual(res.json.error, 'internal_error');
      });
  });

  suite('client contract', function () {
    assert_(typeof request === 'function', 'request is a function');
    const c = createClient('http://127.0.0.1:1');
    assertEqual(typeof c.get, 'function');
    assertEqual(typeof c.post, 'function');
    assertEqual(typeof c.del, 'function');
    return undefined;
  });
}

/* =========================================================================
 * Public entry point: run()
 * ========================================================================= */

/**
 * Execute the full API test-suite against a freshly started mock server.
 * Returns a structured, JSON-serialisable summary. Never rejects: failures
 * are captured per-suite in `results`.
 */
function run(options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  resetRegistry();
  defineApiTests();
  resetStore();
  reporter.results = [];
  reporter.startedAt = nowMs();

  let serverCtx = null;

  return createServer()
    .then(function (ctx) {
      serverCtx = ctx;
      const shared = {
        url: ctx.url,
        client: createClient(ctx.url),
        store: store,
        assert: assert_,
        assertEqual: assertEqual,
        assertStatus: assertStatus,
      };
      return registry.reduce(function chain(promise, unit) {
        return promise.then(function () {
          return runUnit(unit, shared).then(function (result) {
            reporter.results.push(result);
            if (!opts.silent) {
              const mark = result.status === 'passed' ? 'ok  ' : 'FAIL';
              console.log('[' + mark + '] ' + result.name + ' (' + result.durationMs + 'ms)');
              if (result.error) console.log('       -> ' + result.error);
            }
            return result;
          });
        });
      }, Promise.resolve());
    })
    .catch(function (err) {
      reporter.results.push({
        name: 'bootstrap',
        status: 'failed',
        durationMs: 0,
        error: (err && err.message) ? err.message : String(err),
      });
    })
    .then(function () {
      if (serverCtx) {
        return serverCtx.close().then(function () {
          return null;
        });
      }
      return null;
    })
    .then(function () {
      const passed = reporter.results.filter(function (r) {
        return r.status === 'passed';
      }).length;
      const failed = reporter.results.filter(function (r) {
        return r.status === 'failed';
      }).length;
      const skipped = reporter.results.filter(function (r) {
        return r.status === 'skipped';
      }).length;
      const summary = {
        ok: failed === 0 && reporter.results.length > 0,
        passed: passed,
        failed: failed,
        skipped: skipped,
        total: reporter.results.length,
        durationMs: nowMs() - reporter.startedAt,
        results: reporter.results.slice(),
        generatedAt: new Date().toISOString(),
      };
      if (!opts.silent) {
        console.log(
          '\nAPI tests: ' + passed + ' passed, ' + failed + ' failed, ' +
            summary.total + ' total in ' + summary.durationMs + 'ms'
        );
      }
      return summary;
    });
}

/* =========================================================================
 * Direct execution support (CI wiring)
 * ========================================================================= */

if (require.main === module) {
  run()
    .then(function (summary) {
      process.exitCode = summary.ok ? 0 : 1;
      return summary;
    })
    .catch(function (err) {
      console.error('fatal:', err && err.stack ? err.stack : err);
      process.exitCode = 1;
    });
}

module.exports = {
  run: run,
  assert: assert_,
  assertEqual: assertEqual,
  assertStatus: assertStatus,
  request: request,
  createClient: createClient,
  createServer: createServer,
  suite: suite,
  test: test,
  resetRegistry: resetRegistry,
  reporter: reporter,
  store: store,
  DEFAULTS: DEFAULTS,
};
