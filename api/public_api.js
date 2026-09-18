'use strict';

/**
 * api/public_api.js
 * ---------------------------------------------------------------------------
 * Dependency-free REST API server for the FORMULA I1 / Phoenix arena.
 *
 * Built only on Node's core modules (`http`, `url`, `crypto`) so it can boot
 * inside a bare container without any `npm install` step.
 *
 * Public interface:
 *
 *   const api = require('./api/public_api');
 *
 *   const info = await api.start(3000);          // number shorthand
 *   const info = await api.start({ port, host }); // options object
 *   await api.stop();                            // graceful shutdown
 *   api.isRunning();                             // -> boolean
 *   api.reset();                                 // wipe the in-memory store
 *
 * Response envelope (identical for every endpoint):
 *
 *   success -> { ok: true,  data: <any>, meta: { requestId, ts, ... } }
 *   failure -> { ok: false, error: { code, message, details }, meta: {...} }
 *
 * Endpoints:
 *
 *   GET    /                       service descriptor / index
 *   GET    /health                 liveness probe
 *   GET    /ready                  readiness probe
 *   GET    /metrics                raw request counters
 *   GET    /stats                  aggregate statistics (+metrics)
 *   GET    /api/records            list records (?tag=&limit=&offset=)
 *   POST   /api/records            create a record
 *   GET    /api/records/search     search (?tag=&q=&limit=)
 *   DELETE /api/records            delete every record (dangerous)
 *   GET    /api/records/:id        fetch a single record
 *   PUT    /api/records/:id        replace a record
 *   PATCH  /api/records/:id        partial update
 *   DELETE /api/records/:id        delete a record
 *
 *   The whole `/api/v1/items` tree is exposed as an alias for
 *   `/api/records` (backwards compatibility with older clients).
 * ---------------------------------------------------------------------------
 */

const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------- */

const API_VERSION = '1.1.0';
const SERVICE_NAME = 'phoenix-public-api';
const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const STARTED_AT = Date.now();

/* ---------------------------------------------------------------------------
 * Internal state
 * ------------------------------------------------------------------------- */

const store = new Map(); // id (string) -> record
let sequence = 0;

const metrics = {
  startedAt: STARTED_AT,
  requests: 0,
  responses: Object.create(null),
  errors: 0,
  lastRequestAt: null,
  totalLatencyMs: 0,
};

let server = null;
let boundPort = null;
let boundHost = null;

/* ---------------------------------------------------------------------------
 * Small generic helpers
 * ------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function uptimeMs() {
  return Date.now() - STARTED_AT;
}

function nextId() {
  sequence += 1;
  return String(sequence);
}

function requestId() {
  return 'req_' + crypto.randomBytes(6).toString('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

/* ---------------------------------------------------------------------------
 * HTTP helpers
 * ------------------------------------------------------------------------- */

function baseHeaders(bodyLength) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bodyLength,
    'Cache-Control': 'no-store',
    'X-Service': SERVICE_NAME,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, baseHeaders(Buffer.byteLength(body)));
  res.end(body);
}

function sendOk(res, data, status) {
  sendJson(res, status || 200, {
    ok: true,
    data,
    meta: {
      service: SERVICE_NAME,
      version: API_VERSION,
      requestId: res.__requestId || null,
      ts: nowIso(),
    },
  });
}

function sendError(res, status, code, message, details) {
  sendJson(res, status, {
    ok: false,
    error: {
      code,
      message,
      details: details === undefined ? null : details,
      at: nowIso(),
    },
    meta: {
      service: SERVICE_NAME,
      version: API_VERSION,
      requestId: res.__requestId || null,
      ts: nowIso(),
    },
  });
}

/**
 * Read and JSON-parse the request body.
 * @param {http.IncomingMessage} req
 * @returns {Promise<object|null>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/* ---------------------------------------------------------------------------
 * Store operations
 * ------------------------------------------------------------------------- */

/**
 * Normalise an incoming payload into the stored record shape.
 * @param {object} payload
 */
function normalisePayload(payload) {
  const src = isPlainObject(payload) ? payload : {};
  return {
    name: typeof src.name === 'string' ? src.name.trim() : '',
    value:
      typeof src.value === 'number' && !Number.isNaN(src.value) ? src.value : 0,
    tags: Array.isArray(src.tags)
      ? src.tags.filter((t) => typeof t === 'string' && t.length > 0).slice(0, 64)
      : [],
    meta: isPlainObject(src.meta) ? clone(src.meta) : undefined,
  };
}

function createRecord(payload) {
  const data = normalisePayload(payload);
  const record = {
    id: nextId(),
    name: data.name,
    value: data.value,
    tags: data.tags,
    meta: data.meta,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.set(record.id, record);
  return clone(record);
}

function listRecords(options) {
  const opts = options || {};
  let items = Array.from(store.values());

  if (opts.tag) {
    items = items.filter((i) => i.tags.includes(opts.tag));
  }

  const total = items.length;
  const offset = Number.isFinite(opts.offset) && opts.offset > 0 ? opts.offset : 0;
  items = items.slice(offset);

  let limit = null;
  if (Number.isFinite(opts.limit) && opts.limit > 0) {
    limit = opts.limit;
    items = items.slice(0, limit);
  }

  return {
    items: items.map(clone),
    total,
    count: items.length,
    limit,
    offset,
  };
}

function searchRecords(options) {
  const opts = options || {};
  const q = typeof opts.q === 'string' ? opts.q.trim().toLowerCase() : '';
  let items = Array.from(store.values());

  if (opts.tag) {
    items = items.filter((i) => i.tags.includes(opts.tag));
  }
  if (q) {
    items = items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        String(i.id).toLowerCase().includes(q) ||
        i.tags.some((t) => t.toLowerCase().includes(q))
    );
  }
  if (Number.isFinite(opts.limit) && opts.limit > 0) {
    items = items.slice(0, opts.limit);
  }

  return { items: items.map(clone), count: items.length };
}

function getRecord(id) {
  const item = store.get(String(id));
  return item ? clone(item) : undefined;
}

function replaceRecord(id, payload) {
  const existing = store.get(String(id));
  if (!existing) return null;
  const data = normalisePayload(payload);
  const record = {
    id: existing.id,
    name: data.name,
    value: data.value,
    tags: data.tags,
    meta: data.meta,
    createdAt: existing.createdAt,
    updatedAt: nowIso(),
  };
  store.set(record.id, record);
  return clone(record);
}

function patchRecord(id, payload) {
  const existing = store.get(String(id));
  if (!existing) return null;
  const record = clone(existing);
  const src = isPlainObject(payload) ? payload : {};

  if (typeof src.name === 'string') record.name = src.name.trim();
  if (typeof src.value === 'number' && !Number.isNaN(src.value)) record.value = src.value;
  if (Array.isArray(src.tags)) {
    record.tags = src.tags.filter((t) => typeof t === 'string' && t.length > 0);
  }
  if (isPlainObject(src.meta)) record.meta = clone(src.meta);

  record.updatedAt = nowIso();
  store.set(record.id, record);
  return clone(record);
}

function deleteRecord(id) {
  const key = String(id);
  if (!store.has(key)) return false;
  store.delete(key);
  return true;
}

function reset() {
  store.clear();
  sequence = 0;
}

/* ---------------------------------------------------------------------------
 * Route handlers
 * ------------------------------------------------------------------------- */

const handlers = {
  index: () => ({
    name: SERVICE_NAME,
    version: API_VERSION,
    uptime: uptimeMs(),
    endpoints: ROUTES.map((r) => `${r.method} ${r.path}`),
  }),

  health: () => ({
    status: 'ok',
    service: SERVICE_NAME,
    version: API_VERSION,
    uptime: uptimeMs(),
    now: nowIso(),
  }),

  ready: () => ({
    ready: true,
    records: store.size,
  }),

  metrics: () => ({
    requests: metrics.requests,
    errors: metrics.errors,
    responses: metrics.responses,
    lastRequestAt: metrics.lastRequestAt,
    avgLatencyMs: metrics.requests
      ? Math.round(metrics.totalLatencyMs / metrics.requests)
      : 0,
    uptime: uptimeMs(),
  }),

  stats: () => ({
    requests: metrics.requests,
    errors: metrics.errors,
    records: store.size,
    sequence,
    uptime: uptimeMs(),
    memory: process.memoryUsage(),
    responses: metrics.responses,
  }),

  listRecords: (ctx) => {
    const q = ctx.url.searchParams;
    const options = {
      tag: q.get('tag') || undefined,
      limit: q.get('limit') ? clamp(toInt(q.get('limit'), 50), 1, 500) : undefined,
      offset: q.get('offset') ? Math.max(toInt(q.get('offset'), 0), 0) : undefined,
    };
    return listRecords(options);
  },

  createRecord: (ctx) => {
    const payload = ctx.body;
    if (!isPlainObject(payload)) {
      const err = new Error('Body must be a JSON object');
      err.statusCode = 400;
      throw err;
    }
    return { status: 201, value: createRecord(payload) };
  },

  searchRecords: (ctx) => {
    const q = ctx.url.searchParams;
    return searchRecords({
      q: q.get('q') || undefined,
      tag: q.get('tag') || undefined,
      limit: q.get('limit') ? clamp(toInt(q.get('limit'), 50), 1, 500) : undefined,
    });
  },

  getRecord: (ctx) => {
    const item = getRecord(ctx.params.id);
    if (!item) {
      const err = new Error(`Record ${ctx.params.id} not found`);
      err.statusCode = 404;
      throw err;
    }
    return item;
  },

  putRecord: (ctx) => {
    const item = replaceRecord(ctx.params.id, ctx.body);
    if (!item) {
      const err = new Error(`Record ${ctx.params.id} not found`);
      err.statusCode = 404;
      throw err;
    }
    return item;
  },

  patchRecord: (ctx) => {
    const item = patchRecord(ctx.params.id, ctx.body);
    if (!item) {
      const err = new Error(`Record ${ctx.params.id} not found`);
      err.statusCode = 404;
      throw err;
    }
    return item;
  },

  deleteRecord: (ctx) => {
    const removed = deleteRecord(ctx.params.id);
    if (!removed) {
      const err = new Error(`Record ${ctx.params.id} not found`);
      err.statusCode = 404;
      throw err;
    }
    return { deleted: true, id: ctx.params.id };
  },

  deleteAll: () => {
    const removed = store.size;
    reset();
    return { deleted: true, removed };
  },
};

/* ---------------------------------------------------------------------------
 * Route table
 * ------------------------------------------------------------------------- */

const ROUTES = [];

function register(method, path, handler) {
  ROUTES.push({
    method: method.toUpperCase(),
    path,
    parts: path.split('/').filter(Boolean),
    handler,
  });
}

// Generic / monitoring routes.
register('GET', '/', handlers.index);
register('GET', '/health', handlers.health);
register('GET', '/ready', handlers.ready);
register('GET', '/metrics', handlers.metrics);
register('GET', '/stats', handlers.stats);

// Canonical record routes.
register('GET', '/api/records', handlers.listRecords);
register('POST', '/api/records', handlers.createRecord);
register('GET', '/api/records/search', handlers.searchRecords);
register('DELETE', '/api/records', handlers.deleteAll);
register('GET', '/api/records/:id', handlers.getRecord);
register('PUT', '/api/records/:id', handlers.putRecord);
register('PATCH', '/api/records/:id', handlers.patchRecord);
register('DELETE', '/api/records/:id', handlers.deleteRecord);

// `/api/v1/items` alias, kept for backwards compatibility.
const ALIASES = [
  ['GET', '/api/v1/items', handlers.listRecords],
  ['POST', '/api/v1/items', handlers.createRecord],
  ['GET', '/api/v1/items/search', handlers.searchRecords],
  ['DELETE', '/api/v1/items', handlers.deleteAll],
  ['GET', '/api/v1/items/:id', handlers.getRecord],
  ['PUT', '/api/v1/items/:id', handlers.putRecord],
  ['PATCH', '/api/v1/items/:id', handlers.patchRecord],
  ['DELETE', '/api/v1/items/:id', handlers.deleteRecord],
];
for (const [method, path, handler] of ALIASES) {
  register(method, path, handler);
}

/* ---------------------------------------------------------------------------
 * Router
 * ------------------------------------------------------------------------- */

function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);

  for (const r of ROUTES) {
    if (r.method !== method) continue;
    if (r.parts.length !== parts.length) continue;

    const params = Object.create(null);
    let matched = true;

    for (let i = 0; i < r.parts.length; i += 1) {
      const rp = r.parts[i];
      const ap = parts[i];
      if (rp.startsWith(':')) {
        params[rp.slice(1)] = decodeURIComponent(ap);
      } else if (rp !== ap) {
        matched = false;
        break;
      }
    }

    if (matched) return { route: r, params };
  }

  return null;
}

/* ---------------------------------------------------------------------------
 * Main request handler
 * ------------------------------------------------------------------------- */

async function handleRequest(req, res) {
  const started = process.hrtime.bigint();
  metrics.requests += 1;
  metrics.lastRequestAt = nowIso();
  res.__requestId = requestId();

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (err) {
    metrics.errors += 1;
    return sendError(res, 400, 'BAD_REQUEST', 'Malformed URL');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, baseHeaders(0));
    return res.end();
  }

  const found = matchRoute(req.method, parsedUrl.pathname);
  if (!found) {
    metrics.errors += 1;
    metrics.responses['404'] = (metrics.responses['404'] || 0) + 1;
    return sendError(
      res,
      404,
      'ROUTE_NOT_FOUND',
      `No route for ${req.method} ${parsedUrl.pathname}`
    );
  }

  const ctx = {
    req,
    res,
    url: parsedUrl,
    params: found.params,
    body: null,
  };

  try {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      ctx.body = await readBody(req);
    }

    const result = await found.route.handler(ctx);
    const value = result && result.value !== undefined ? result.value : result;
    const status = result && result.status ? result.status : 200;

    metrics.responses[status] = (metrics.responses[status] || 0) + 1;
    sendOk(res, value, status);
  } catch (err) {
    metrics.errors += 1;
    const status = err && err.statusCode ? err.statusCode : 500;
    metrics.responses[status] = (metrics.responses[status] || 0) + 1;

    const code =
      status === 404
        ? 'NOT_FOUND'
        : status === 400
          ? 'BAD_REQUEST'
          : status === 413
            ? 'PAYLOAD_TOO_LARGE'
            : 'INTERNAL_ERROR';

    if (status === 500) {
      // eslint-disable-next-line no-console
      console.error('[public_api] request failed:', err);
    }
    sendError(res, status, code, err.message || 'Internal server error');
  } finally {
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    metrics.totalLatencyMs += elapsed;
  }
}

/* ---------------------------------------------------------------------------
 * Public interface: start / stop
 * ------------------------------------------------------------------------- */

function resolveOptions(arg) {
  if (typeof arg === 'number') {
    return { port: arg, host: DEFAULT_HOST };
  }
  if (isPlainObject(arg)) {
    return {
      port: Number.isFinite(Number(arg.port)) && arg.port !== undefined
        ? Number(arg.port)
        : DEFAULT_PORT,
      host: typeof arg.host === 'string' && arg.host ? arg.host : DEFAULT_HOST,
    };
  }
  return { port: DEFAULT_PORT, host: DEFAULT_HOST };
}

/**
 * Start the REST API server.
 * @param {number|{port?:number,host?:string}} [options]
 * @returns {Promise<{port:number, host:string, url:string}>}
 */
function start(options) {
  const opts = resolveOptions(options);

  return new Promise((resolve, reject) => {
    if (server) {
      return resolve({
        port: boundPort,
        host: boundHost,
        url: `http://${boundHost}:${boundPort}`,
        alreadyRunning: true,
      });
    }

    const instance = http.createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        metrics.errors += 1;
        if (!res.headersSent) {
          sendError(res, 500, 'INTERNAL_ERROR', err.message || 'Internal error');
        } else {
          res.end();
        }
      });
    });

    instance.on('error', (err) => {
      server = null;
      boundPort = null;
      boundHost = null;
      reject(err);
    });

    instance.listen(opts.port, opts.host, () => {
      server = instance;
      boundPort = instance.address().port;
      boundHost = opts.host;
      resolve({
        port: boundPort,
        host: boundHost,
        url: `http://${boundHost}:${boundPort}`,
      });
    });
  });
}

/**
 * Stop the REST API server gracefully.
 * @returns {Promise<{stopped:boolean, port:number|null}>}
 */
function stop() {
  return new Promise((resolve, reject) => {
    const instance = server;
    if (!instance) {
      return resolve({ stopped: false, port: null });
    }

    instance.close((err) => {
      if (err) return reject(err);
      const port = boundPort;
      server = null;
      boundPort = null;
      boundHost = null;
      resolve({ stopped: true, port });
    });
  });
}

function isRunning() {
  return Boolean(server) && server.listening;
}

module.exports = {
  start,
  stop,
  isRunning,
  reset,
  // Introspection
  API_VERSION,
  SERVICE_NAME,
  routes: ROUTES.map((r) => `${r.method} ${r.path}`),
  // Exposed for unit tests / embedding.
  _internal: {
    store,
    metrics,
    handlers,
    matchRoute,
    createRecord,
    listRecords,
    searchRecords,
    getRecord,
    replaceRecord,
    patchRecord,
    deleteRecord,
    normalisePayload,
    readBody,
  },
};
