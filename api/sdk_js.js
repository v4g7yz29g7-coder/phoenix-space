/**
 * api/sdk_js.js — EverOS Platform JavaScript SDK
 * =================================================
 *
 * A small, dependency-free, universal (Node.js + browser) client SDK for the
 * EverOS HTTP API. It provides a predictable surface for talking to the
 * platform and a couple of production niceties: timeouts, retries with
 * exponential backoff + jitter, optional token-bucket rate limiting and an
 * event hook for the request/response lifecycle.
 *
 * Quick start
 * -----------
 *   const { Client, createClient } = require('./api/sdk_js');
 *
 *   const api = createClient({ baseUrl: 'http://localhost:8080', apiKey: 'secret' });
 *
 *   const page = await api.get('/api/memories', { limit: 10 });
 *   const task = await api.tasks.create({ agent: 'curator', input: '...' });
 *   const done = await api.waitForTask(task.id, { timeout: 60000 });
 *
 * Exports
 * -------
 *   Client, createClient, Transport, Emitter, RateLimiter
 *   SDKError, HTTPError, TimeoutError, ValidationError, NetworkError
 *   joinUrl, encodeQuery, isPlainObject, backoffDelay, sleep, deepMerge
 *
 * @module api/sdk_js
 */

'use strict';

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

const VERSION = '1.2.0';

const DEFAULT_BASE_URL = 'http://localhost:8080';
const DEFAULT_TIMEOUT = 30000; // ms
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF = 250; // ms base
const DEFAULT_MAX_BACKOFF = 5000; // ms cap
const DEFAULT_POLL_INTERVAL = 5000; // ms

/** HTTP status codes that are safe to retry. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/* ------------------------------------------------------------------ */
/* Errors                                                             */
/* ------------------------------------------------------------------ */

/**
 * Base class for every error produced by the SDK.
 */
class SDKError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'SDKError';
    this.code = opts.code || 'E_SDK';
    this.status = opts.status || 0;
    this.body = opts.body === undefined ? null : opts.body;
    this.url = opts.url || null;
    this.cause = opts.cause || null;
  }

  /** Serialisable representation (safe for logging). */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      message: this.message,
      url: this.url,
    };
  }
}

/**
 * Thrown when the server responds with a non-2xx status code.
 */
class HTTPError extends SDKError {
  constructor(status, body, url) {
    super('HTTP ' + status + ' for ' + url, {
      code: 'E_HTTP',
      status,
      body,
      url,
    });
    this.name = 'HTTPError';
  }
}

/**
 * Thrown when a request exceeds the configured timeout.
 */
class TimeoutError extends SDKError {
  constructor(url, timeout) {
    super('Request to ' + url + ' timed out after ' + timeout + 'ms', {
      code: 'E_TIMEOUT',
      url,
    });
    this.name = 'TimeoutError';
  }
}

/**
 * Thrown when the transport itself fails before an HTTP response exists.
 */
class NetworkError extends SDKError {
  constructor(message, opts = {}) {
    super(message, {
      code: 'E_NETWORK',
      url: opts.url || null,
      cause: opts.cause || null,
    });
    this.name = 'NetworkError';
  }
}

/**
 * Thrown for invalid client-side usage (bad arguments, missing deps).
 */
class ValidationError extends SDKError {
  constructor(message) {
    super(message, { code: 'E_VALIDATION' });
    this.name = 'ValidationError';
  }
}

/* ------------------------------------------------------------------ */
/* Utilities                                                          */
/* ------------------------------------------------------------------ */

/**
 * True only for plain `{}` objects (not arrays, not class instances).
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Encode a plain object into a URL query string.
 * Skips `undefined`/`null` values and expands arrays into repeated keys.
 *
 *   encodeQuery({ a: 1, b: 'x y', c: [1, 2] }) === '?a=1&b=x%20y&c=1&c=2'
 */
function encodeQuery(params) {
  if (!isPlainObject(params)) return '';
  const parts = [];
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(item)));
      }
    } else {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/**
 * Join a base URL and a path, normalising duplicate slashes.
 *
 *   joinUrl('http://x/', '/api/ping') === 'http://x/api/ping'
 *   joinUrl('http://x', 'api')        === 'http://x/api'
 */
function joinUrl(base, path) {
  const b = String(base == null ? '' : base).replace(/\/+$/, '');
  const p = String(path == null ? '' : path).replace(/^\/+/, '');
  return p ? b + '/' + p : b;
}

/**
 * Promise-based delay helper.
 */
function sleep(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Exponential backoff with full jitter, clamped to `[0, max]`.
 *
 * @param {number} base     base delay in ms
 * @param {number} attempt  zero-based retry attempt
 * @param {number} max      hard upper bound in ms
 */
function backoffDelay(base, attempt, max) {
  const b = base == null ? DEFAULT_BACKOFF : Number(base) || 0;
  const a = Math.max(0, Number(attempt) || 0);
  const m = max == null ? DEFAULT_MAX_BACKOFF : Number(max) || 0;
  const raw = b * Math.pow(2, a);
  const jitter = Math.random() * b;
  return Math.max(0, Math.min(raw + jitter, m));
}

/**
 * Recursively merge plain objects (source wins). Returns a new object.
 */
function deepMerge(target, source) {
  const out = Object.assign({}, isPlainObject(target) ? target : {});
  if (!isPlainObject(source)) return out;
  for (const key of Object.keys(source)) {
    if (isPlainObject(out[key]) && isPlainObject(source[key])) {
      out[key] = deepMerge(out[key], source[key]);
    } else if (source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}

/**
 * Read a header from a `fetch` Response-like object.
 */
function readHeader(response, name) {
  if (!response || !response.headers) return '';
  const headers = response.headers;
  if (typeof headers.get === 'function') {
    return headers.get(name) || '';
  }
  return headers[name] || headers[String(name).toLowerCase()] || '';
}

/**
 * Resolve a fetch implementation that works in Node.js and browsers.
 */
function resolveFetch(provided) {
  if (typeof provided === 'function') return provided;
  if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  throw new ValidationError(
    'No fetch implementation available. Pass one via options.fetch.'
  );
}

/* ------------------------------------------------------------------ */
/* Event emitter                                                      */
/* ------------------------------------------------------------------ */

/**
 * Minimal synchronous event emitter used for lifecycle hooks.
 */
class Emitter {
  constructor() {
    this._listeners = Object.create(null);
  }

  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new ValidationError('handler must be a function');
    }
    (this._listeners[event] || (this._listeners[event] = [])).push(handler);
    return this;
  }

  once(event, handler) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  off(event, handler) {
    const list = this._listeners[event];
    if (!list) return this;
    this._listeners[event] = list.filter((h) => h !== handler);
    return this;
  }

  emit(event, ...args) {
    const list = this._listeners[event];
    if (!list || list.length === 0) return false;
    for (const handler of list.slice()) {
      try {
        handler(...args);
      } catch (err) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[sdk_js] listener error for "' + event + '"', err);
        }
      }
    }
    return true;
  }

  listenerCount(event) {
    const list = this._listeners[event];
    return list ? list.length : 0;
  }
}

/* ------------------------------------------------------------------ */
/* Rate limiter                                                       */
/* ------------------------------------------------------------------ */

/**
 * Token-bucket rate limiter.
 *
 * Accepts either a number (`intervalMs`, simple fixed spacing) or an options
 * object `{ capacity, refillPerSec, intervalMs }`.
 */
class RateLimiter {
  constructor(options) {
    if (typeof options === 'number') {
      options = { intervalMs: options };
    }
    options = options || {};
    this.capacity = options.capacity === undefined ? Infinity : Number(options.capacity);
    this.refillPerSec = options.refillPerSec === undefined ? 0 : Number(options.refillPerSec);
    this.intervalMs = options.intervalMs === undefined ? 0 : Number(options.intervalMs);
    this.tokens = this.capacity;
    this.last = Date.now();
    this.lastAcquire = 0;
    this._chain = Promise.resolve();
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    if (this.refillPerSec > 0 && this.capacity !== Infinity) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    }
  }

  _tryAcquire() {
    this._refill();
    if (this.capacity === Infinity && this.intervalMs === 0) return true;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Resolve once a token is available. Returns a Promise. */
  acquire() {
    this._chain = this._chain.then(() => this._acquireOne());
    return this._chain.then(() => undefined);
  }

  async _acquireOne() {
    if (this.intervalMs > 0) {
      const now = Date.now();
      const wait = this.lastAcquire + this.intervalMs - now;
      if (wait > 0) await sleep(wait);
      this.lastAcquire = Date.now();
    }
    while (!this._tryAcquire()) {
      const needed = Math.max(1 - this.tokens, 0);
      const rate = this.refillPerSec > 0 ? this.refillPerSec : 1;
      const waitMs = Math.max(1, (needed / rate) * 1000);
      await sleep(Math.min(waitMs, 1000));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Transport                                                          */
/* ------------------------------------------------------------------ */

/**
 * Low-level HTTP transport: URL building, headers, timeout, retries,
 * rate limiting and lifecycle events.
 */
class Transport extends Emitter {
  constructor(options = {}) {
    super();
    if (!isPlainObject(options)) throw new ValidationError('transport options must be an object');
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = options.timeout == null ? DEFAULT_TIMEOUT : Number(options.timeout);
    this.retries = options.retries == null ? DEFAULT_RETRIES : Number(options.retries);
    this.backoff = options.backoff == null ? DEFAULT_BACKOFF : Number(options.backoff);
    this.maxBackoff = options.maxBackoff == null ? DEFAULT_MAX_BACKOFF : Number(options.maxBackoff);
    this.headers = isPlainObject(options.headers) ? Object.assign({}, options.headers) : {};
    this.apiKey = options.apiKey || null;
    this.fetchImpl = options.fetch || null;
    this.rateLimiter = options.rateLimiter || null;
  }

  _fetch() {
    return resolveFetch(this.fetchImpl);
  }

  _buildUrl(path, query) {
    return joinUrl(this.baseUrl, path) + encodeQuery(query);
  }

  _headers(extra) {
    const headers = Object.assign({ Accept: 'application/json' }, this.headers);
    if (this.apiKey && !headers['Authorization']) {
      headers['Authorization'] = 'Bearer ' + this.apiKey;
    }
    if (isPlainObject(extra)) Object.assign(headers, extra);
    return headers;
  }

  /** Perform a single fetch call, applying the timeout guard. */
  async _once(method, url, body, options) {
    const fetchImpl = this._fetch();
    const headers = this._headers(options.headers);
    const init = { method, headers };

    let controller = null;
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      init.signal = controller.signal;
    }

    if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
      const isRaw =
        typeof body === 'string' ||
        (typeof FormData !== 'undefined' && body instanceof FormData) ||
        (typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function' && Buffer.isBuffer(body));
      if (isRaw) {
        init.body = body;
      } else {
        init.body = JSON.stringify(body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    const timeout = options.timeout == null ? this.timeout : Number(options.timeout);
    let timer = null;
    const timeoutPromise = new Promise((_resolve, reject) => {
      if (!timeout || timeout <= 0) return;
      timer = setTimeout(() => {
        if (controller) {
          try { controller.abort(); } catch (_e) { /* ignore */ }
        }
        reject(new TimeoutError(url, timeout));
      }, timeout);
    });

    try {
      return await Promise.race([fetchImpl(url, init), timeoutPromise]);
    } catch (err) {
      if (err instanceof SDKError) throw err;
      throw new NetworkError(
        'Network error for ' + url + ': ' + (err && err.message ? err.message : String(err)),
        { url, cause: err }
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Parse a Response into JSON/text and raise HTTPError on non-2xx. */
  async _parse(response, url) {
    const status = response && typeof response.status === 'number' ? response.status : 0;
    const contentType = readHeader(response, 'content-type') || '';
    let data = null;

    if (response && typeof response.text === 'function') {
      const text = await response.text();
      if (text) {
        const looksJson =
          contentType.indexOf('json') !== -1 ||
          text.charAt(0) === '{' ||
          text.charAt(0) === '[';
        if (looksJson) {
          try {
            data = JSON.parse(text);
          } catch (_e) {
            data = text;
          }
        } else {
          data = text;
        }
      }
    }

    const okFlag = response && response.ok;
    const httpOk = status >= 200 && status < 300;
    if (okFlag === false || !httpOk) {
      throw new HTTPError(status, data, url);
    }
    return data;
  }

  /**
   * Execute a request with retries.
   *
   * @param {string} method  HTTP verb
   * @param {string} path    path relative to baseUrl
   * @param {object} options `{ query, body, headers, timeout, retries }`
   */
  async request(method, path, options = {}) {
    const url = this._buildUrl(path, options.query);
    const body = options.body;
    const configured =
      options.retries == null ? this.retries : Number(options.retries);
    const maxAttempts = Math.max(1, configured + 1);

    let attempt = 0;
    let lastError = null;

    while (attempt < maxAttempts) {
      attempt += 1;

      if (this.rateLimiter && typeof this.rateLimiter.acquire === 'function') {
        await this.rateLimiter.acquire();
      }

      this.emit('request', { method, url, attempt });
      try {
        const response = await this._once(method, url, body, options);
        this.emit('response', { method, url, status: response && response.status, attempt });
        return await this._parse(response, url);
      } catch (err) {
        lastError = err;
        this.emit('error', { method, url, error: err, attempt });

        const retryable =
          err instanceof HTTPError
            ? RETRYABLE_STATUS.has(err.status)
            : err instanceof NetworkError || err instanceof TimeoutError;

        if (attempt >= maxAttempts || !retryable) throw err;

        const delay = backoffDelay(this.backoff, attempt - 1, this.maxBackoff);
        this.emit('retry', { method, url, attempt, delay });
        await sleep(delay);
      }
    }

    throw lastError || new SDKError('Request failed');
  }

  get(path, query, options) {
    return this.request('GET', path, Object.assign({ query }, options));
  }

  post(path, body, options) {
    return this.request('POST', path, Object.assign({ body }, options));
  }

  put(path, body, options) {
    return this.request('PUT', path, Object.assign({ body }, options));
  }

  patch(path, body, options) {
    return this.request('PATCH', path, Object.assign({ body }, options));
  }

  delete(path, options) {
    return this.request('DELETE', path, options || {});
  }
}

/* ------------------------------------------------------------------ */
/* Resources                                                          */
/* ------------------------------------------------------------------ */

/** `/api/memories` resource. */
class MemoriesResource {
  constructor(transport) {
    this.transport = transport;
  }

  list(query) {
    return this.transport.request('GET', '/api/memories', { query });
  }

  get(id) {
    return this.transport.request('GET', '/api/memories/' + encodeURIComponent(id));
  }

  create(input) {
    return this.transport.request('POST', '/api/memories', { body: input });
  }

  update(id, patch) {
    return this.transport.request('PATCH', '/api/memories/' + encodeURIComponent(id), { body: patch });
  }

  remove(id) {
    return this.transport.request('DELETE', '/api/memories/' + encodeURIComponent(id));
  }

  search(query, options) {
    return this.transport.request('POST', '/api/memories/search',
      Object.assign({ body: { query } }, options));
  }
}

/** `/api/tasks` resource. */
class TasksResource {
  constructor(transport) {
    this.transport = transport;
  }

  list(query) {
    return this.transport.request('GET', '/api/tasks', { query });
  }

  get(id) {
    return this.transport.request('GET', '/api/tasks/' + encodeURIComponent(id));
  }

  create(input) {
    return this.transport.request('POST', '/api/tasks', { body: input });
  }

  cancel(id) {
    return this.transport.request('POST', '/api/tasks/' + encodeURIComponent(id) + '/cancel');
  }

  result(id) {
    return this.transport.request('GET', '/api/tasks/' + encodeURIComponent(id) + '/result');
  }
}

/** `/health` and readiness probes. */
class HealthResource {
  constructor(transport) {
    this.transport = transport;
  }

  check() {
    return this.transport.request('GET', '/health');
  }

  ready() {
    return this.transport.request('GET', '/ready');
  }

  version() {
    return this.transport.request('GET', '/version');
  }
}

/** `/api/agents` resource. */
class AgentsResource {
  constructor(transport) {
    this.transport = transport;
  }

  list(query) {
    return this.transport.request('GET', '/api/agents', { query });
  }

  get(id) {
    return this.transport.request('GET', '/api/agents/' + encodeURIComponent(id));
  }

  run(id, input) {
    return this.transport.request('POST', '/api/agents/' + encodeURIComponent(id) + '/run', { body: input });
  }
}

/** `/api/events` resource. */
class EventsResource {
  constructor(transport) {
    this.transport = transport;
  }

  list(query) {
    return this.transport.request('GET', '/api/events', { query });
  }

  emit(event) {
    return this.transport.request('POST', '/api/events', { body: event });
  }
}

/* ------------------------------------------------------------------ */
/* Client                                                             */
/* ------------------------------------------------------------------ */

/**
 * Main SDK entry point. Wraps a {@link Transport} and exposes resource
 * namespaces plus convenience request helpers.
 */
class Client extends Emitter {
  constructor(options = {}) {
    super();
    if (!isPlainObject(options)) {
      throw new ValidationError('client options must be an object');
    }
    this.options = Object.assign({}, options);
    this.transport =
      options.transport instanceof Transport ? options.transport : new Transport(options);
    this.baseUrl = this.transport.baseUrl;

    this.memories = new MemoriesResource(this.transport);
    this.tasks = new TasksResource(this.transport);
    this.health = new HealthResource(this.transport);
    this.agents = new AgentsResource(this.transport);
    this.events = new EventsResource(this.transport);
  }

  /**
   * Merge new options into the live client and return `this` for chaining.
   */
  configure(options = {}) {
    if (!isPlainObject(options)) {
      throw new ValidationError('configure options must be an object');
    }
    Object.assign(this.options, options);
    if (options.baseUrl != null) {
      this.transport.baseUrl = String(options.baseUrl).replace(/\/+$/, '');
    }
    if (options.timeout != null) this.transport.timeout = Number(options.timeout);
    if (options.retries != null) this.transport.retries = Number(options.retries);
    if (options.apiKey != null) this.transport.apiKey = options.apiKey;
    if (isPlainObject(options.headers)) {
      Object.assign(this.transport.headers, options.headers);
    }
    this.baseUrl = this.transport.baseUrl;
    return this;
  }

  /** Forward a raw request. */
  request(method, path, options) {
    return this.transport.request(method, path, options);
  }

  get(path, query, options) {
    return this.transport.request('GET', path, Object.assign({ query }, options));
  }

  post(path, body, options) {
    return this.transport.request('POST', path, Object.assign({ body }, options));
  }

  put(path, body, options) {
    return this.transport.request('PUT', path, Object.assign({ body }, options));
  }

  patch(path, body, options) {
    return this.transport.request('PATCH', path, Object.assign({ body }, options));
  }

  delete(path, options) {
    return this.transport.request('DELETE', path, options || {});
  }

  /**
   * Poll `tasks.get(id)` until the task reaches a terminal state or the
   * optional timeout elapses.
   */
  async waitForTask(id, options = {}) {
    const interval = options.intervalMs == null ? DEFAULT_POLL_INTERVAL : Number(options.intervalMs);
    const deadline =
      options.timeout && options.timeout > 0 ? Date.now() + Number(options.timeout) : 0;
    const terminal = new Set(['succeeded', 'success', 'completed', 'done', 'failed', 'cancelled', 'error']);

    for (;;) {
      const task = await this.tasks.get(id);
      const status = task && task.status;
      if (terminal.has(status)) return task;
      if (deadline && Date.now() >= deadline) {
        throw new TimeoutError('tasks/' + id, options.timeout);
      }
      await sleep(interval);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Factory + exports                                                  */
/* ------------------------------------------------------------------ */

/**
 * Convenience factory mirroring the constructor.
 */
function createClient(options = {}) {
  return new Client(options);
}

const utils = {
  isPlainObject,
  encodeQuery,
  joinUrl,
  sleep,
  backoffDelay,
  deepMerge,
  readHeader,
  resolveFetch,
};

const _exports = {
  Client,
  createClient,
  Transport,
  Emitter,
  RateLimiter,
  MemoriesResource,
  TasksResource,
  HealthResource,
  AgentsResource,
  EventsResource,
  SDKError,
  HTTPError,
  TimeoutError,
  NetworkError,
  ValidationError,
  isPlainObject,
  encodeQuery,
  joinUrl,
  sleep,
  backoffDelay,
  deepMerge,
  readHeader,
  resolveFetch,
  utils,
  version: VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT,
  DEFAULT_RETRIES,
  RETRYABLE_STATUS,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = _exports;
}
if (typeof window !== 'undefined') {
  window.EverosSDK = _exports;
}
