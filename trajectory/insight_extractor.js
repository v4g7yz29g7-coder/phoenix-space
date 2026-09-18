'use strict';

/**
 * trajectory/insight_extractor.js
 * ================================
 *
 * Turns raw execution *paths* (the concrete ascent trajectories produced by
 * `trajectory/path_builder.js`) into reusable, generalizable insights about
 * **what worked and what did not**.
 *
 * The heavy lifting is delegated to GigaChat: we serialize the paths into a
 * compact textual digest, ask the model for a strict JSON array, then parse,
 * validate, normalise and de-duplicate the result. When the model is
 * unreachable (offline race, missing credentials, rate limit, malformed
 * answer …) we degrade gracefully to a deterministic heuristic extractor so
 * callers always receive a usable array.
 *
 * Public API
 * ----------
 *   extract(paths, options?)            -> Promise<Array<{pattern, lesson, evidence}>>
 *   extractFromRace(raceId, options?)   -> Promise<Array<...>>
 *   loadPathsFromRace(raceId)           -> Array<...>
 *
 * Every insight has exactly three string fields:
 *   pattern  — short name of the recurring behavioural pattern
 *   lesson   — actionable rule to apply next time
 *   evidence — concrete citation / observation from the analysed paths
 *
 * Design notes
 * ------------
 *   - Only Node.js built-ins are used (`https`, `fs`, `path`, `crypto`) so the
 *     module loads and passes `node --check` in a bare environment.
 *   - `path_builder` is required *lazily* — a missing sibling module must never
 *     break module loading.
 *   - Token caching mirrors `gigachat_client.js`: the OAuth token is reused
 *     until a minute before it expires, and a single 401 triggers one refresh.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const CONFIG = {
  oauthUrl:
    process.env.GIGACHAT_OAUTH_URL ||
    'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
  apiUrl:
    process.env.GIGACHAT_API_URL ||
    'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
  model: process.env.GIGACHAT_MODEL || 'GigaChat',
  scope: process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS',
  requestTimeoutMs: parseInt(process.env.INSIGHT_TIMEOUT_MS || '120000', 10),
  maxPaths: parseInt(process.env.INSIGHT_MAX_PATHS || '20', 10),
  maxSteps: parseInt(process.env.INSIGHT_MAX_STEPS || '40', 10),
  maxTokens: parseInt(process.env.INSIGHT_MAX_TOKENS || '1600', 10),
  debug: !!process.env.INSIGHT_DEBUG,
};

// GigaChat tokens live ~30 minutes; refresh 60s early.
const TOKEN_SKEW_MS = 60 * 1000;

let cachedToken = null;
let cachedTokenExpiresAt = 0;

/* -------------------------------------------------------------------------- */
/* Tiny utilities                                                             */
/* -------------------------------------------------------------------------- */

function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function truncate(value, n) {
  const s = typeof value === 'string' ? value : safeStringify(value);
  if (typeof s !== 'string') return '';
  return s.length <= n ? s : s.slice(0, n) + '\u2026';
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function log(...args) {
  if (CONFIG.debug) {
    // eslint-disable-next-line no-console
    console.error('[insight_extractor]', ...args);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* HTTP layer (https only, Russian Trusted CA -> rejectUnauthorized:false)     */
/* -------------------------------------------------------------------------- */

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function rawRequest(url, opts = {}) {
  const method = opts.method || 'POST';
  const headers = opts.headers || {};
  const body = opts.body || null;

  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      return reject(new Error(`insight_extractor: bad URL ${url}`));
    }

    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method,
        headers,
        agent: httpsAgent,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );

    req.on('error', reject);
    req.setTimeout(opts.timeout || CONFIG.requestTimeoutMs, () => {
      req.destroy(new Error('insight_extractor: request timeout'));
    });

    if (body) req.write(body);
    req.end();
  });
}

/* -------------------------------------------------------------------------- */
/* OAuth                                                                      */
/* -------------------------------------------------------------------------- */

function getAuthKey() {
  const key =
    process.env.GIGACHAT_AUTH_KEY ||
    process.env.GIGACHAT_CREDENTIALS ||
    process.env.GIGACHAT_CLIENT_SECRET;
  if (!key) {
    throw new Error(
      'GigaChat credentials missing: set GIGACHAT_AUTH_KEY (base64 client_id:client_secret).'
    );
  }
  return key;
}

async function getAccessToken(force = false) {
  const now = Date.now();
  if (!force && cachedToken && cachedTokenExpiresAt - TOKEN_SKEW_MS > now) {
    return cachedToken;
  }

  const body = 'scope=' + encodeURIComponent(CONFIG.scope);
  const res = await rawRequest(CONFIG.oauthUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      RqUID: uuid(),
      Authorization: 'Basic ' + getAuthKey(),
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });

  if (res.status !== 200) {
    throw new Error(
      `GigaChat OAuth failed ${res.status}: ${truncate(res.text, 300)}`
    );
  }

  let json;
  try {
    json = JSON.parse(res.text);
  } catch (_) {
    throw new Error('GigaChat OAuth: non-JSON response');
  }
  if (!json.access_token) {
    throw new Error('GigaChat OAuth: no access_token in response');
  }

  cachedToken = json.access_token;
  const ttl = json.expires_at ? json.expires_at - now : 25 * 60 * 1000;
  cachedTokenExpiresAt = now + Math.max(60 * 1000, ttl);
  return cachedToken;
}

/* -------------------------------------------------------------------------- */
/* Path normalisation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Accept the many shapes a "path" can arrive in and coerce it to a uniform
 * `{ label, steps: [...] }` structure.
 *
 * Supported inputs:
 *   - Array of steps                 -> one path
 *   - { steps: [...] } / { path: [...] } / { trajectory: [...] }
 *   - { agent, steps }               -> labelled path
 *   - Array of any of the above      -> many paths
 */
function normalizePaths(input) {
  if (!input) return [];

  // Object map: { agent_1: [...], agent_2: [...] } from path_builder.buildPath
  if (isPlainObject(input) && !Array.isArray(input) && !looksLikePath(input)) {
    const entries = Object.entries(input).filter(([, v]) => v !== undefined);
    if (entries.length && entries.every(([, v]) => Array.isArray(v) || isPlainObject(v))) {
      return entries.map(([agent, v]) => toPath(v, agent));
    }
  }

  const list = Array.isArray(input) ? input : [input];
  return list.map((item, i) => toPath(item, item && item.agent ? item.agent : `path_${i + 1}`));
}

function looksLikePath(obj) {
  return (
    isPlainObject(obj) &&
    (Array.isArray(obj.steps) ||
      Array.isArray(obj.path) ||
      Array.isArray(obj.trajectory) ||
      Array.isArray(obj.actions))
  );
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function stepsOf(v) {
  if (Array.isArray(v)) return v;
  if (isPlainObject(v)) {
    if (Array.isArray(v.steps)) return v.steps;
    if (Array.isArray(v.path)) return v.path;
    if (Array.isArray(v.trajectory)) return v.trajectory;
    if (Array.isArray(v.actions)) return v.actions;
  }
  return [];
}

function toPath(value, label) {
  return {
    label: typeof label === 'string' && label ? label : 'path',
    steps: stepsOf(value).slice(0, CONFIG.maxSteps),
  };
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                              */
/* -------------------------------------------------------------------------- */

function stepStatus(step) {
  if (isPlainObject(step)) {
    if (step.ok === true || step.success === true) return 'ok';
    if (step.ok === false || step.success === false) return 'fail';
    if (typeof step.score === 'number') return step.score >= 0 ? 'ok' : 'fail';
    if (step.error) return 'fail';
    if (step.status) return String(step.status);
  }
  return '?';
}

function stepLabel(step) {
  if (typeof step === 'string') return truncate(step, 200);
  if (isPlainObject(step)) {
    return truncate(
      step.action || step.tool || step.name || step.type || step.verb || 'step',
      120
    );
  }
  return truncate(step, 120);
}

function stepDetail(step) {
  if (!isPlainObject(step)) return '';
  const d =
    step.outcome ||
    step.result ||
    step.output ||
    step.detail ||
    step.error ||
    step.message ||
    '';
  return truncate(d, 220);
}

function serializePath(p, index) {
  const head = `### Path #${index + 1} [${p.label}] (${p.steps.length} steps)`;
  if (!p.steps.length) return head + '\n(empty)';
  const lines = p.steps.map((step, i) => {
    const detail = stepDetail(step);
    return `${i + 1}. [${stepStatus(step)}] ${stepLabel(step)}${detail ? ' :: ' + detail : ''}`;
  });
  return head + '\n' + lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Prompt construction                                                        */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = [
  'You are an insight extraction engine for autonomous agent trajectories.',
  'You are given execution paths (ordered steps with an ok/fail status and a short outcome).',
  'Extract reusable, generalizable lessons about what worked and what did not.',
  '',
  'Respond with ONLY a JSON array. Each element must have exactly these keys:',
  '  "pattern":  short name of the recurring behavioural pattern (<= 60 chars)',
  '  "lesson":   the actionable rule to apply next time (<= 240 chars)',
  '  "evidence": a concrete citation from the paths that supports it (<= 240 chars)',
  '',
  'Rules:',
  '- Prefer patterns that repeat across several paths.',
  '- Cover both successes (keep doing) and failures (avoid).',
  '- No markdown fences, no prose outside the JSON array.',
  '- Return [] if nothing meaningful can be extracted.',
].join('\n');

function buildMessages(paths) {
  const digest = paths
    .slice(0, CONFIG.maxPaths)
    .map((p, i) => serializePath(p, i))
    .join('\n\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        'Extract insights from the following execution paths.\n\n' +
        digest +
        '\n\nRespond with the JSON array only.',
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Model call                                                                 */
/* -------------------------------------------------------------------------- */

async function callModel(messages, attempt = 0, options = {}) {
  const token = await getAccessToken(attempt > 0);
  const body = JSON.stringify({
    model: options.model || CONFIG.model,
    temperature:
      typeof options.temperature === 'number' ? options.temperature : 0.2,
    max_tokens: CONFIG.maxTokens,
    messages,
  });

  const res = await rawRequest(CONFIG.apiUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });

  if (res.status === 401 && attempt < 1) {
    cachedToken = null;
    return callModel(messages, attempt + 1, options);
  }
  if (res.status === 429 && attempt < 2) {
    await sleep(500 * (attempt + 1));
    return callModel(messages, attempt + 1, options);
  }
  if (res.status !== 200) {
    throw new Error(
      `GigaChat completion failed ${res.status}: ${truncate(res.text, 400)}`
    );
  }

  let json;
  try {
    json = JSON.parse(res.text);
  } catch (_) {
    throw new Error('GigaChat completion: non-JSON response');
  }
  const choice = json.choices && json.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (!content) throw new Error('GigaChat completion: empty content');
  return content;
}

/* -------------------------------------------------------------------------- */
/* Parsing / normalisation                                                    */
/* -------------------------------------------------------------------------- */

function extractJsonArray(text) {
  if (!text) return [];
  let cleaned = String(text).trim();
  cleaned = cleaned
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');

  if (start !== -1 && end > start) {
    const body = stripTrailingCommas(cleaned.slice(start, end + 1));
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {
      /* fall through to single-object salvage */
    }
  }

  // Salvage: model returned a single object instead of an array.
  const oStart = cleaned.indexOf('{');
  const oEnd = cleaned.lastIndexOf('}');
  if (oStart !== -1 && oEnd > oStart) {
    const body = stripTrailingCommas(cleaned.slice(oStart, oEnd + 1));
    try {
      const parsed = JSON.parse(body);
      if (isPlainObject(parsed)) return [parsed];
    } catch (_) {
      /* ignore */
    }
  }

  return [];
}

function stripTrailingCommas(s) {
  return s.replace(/,\s*([\]}])/g, '$1');
}

function normalizeInsight(raw) {
  if (!isPlainObject(raw)) return null;
  const pattern = pickString(raw.pattern, raw.name, raw.title, raw.tag);
  const lesson = pickString(raw.lesson, raw.insight, raw.rule, raw.takeaway);
  const evidence = pickString(
    raw.evidence,
    raw.reason,
    raw.quote,
    raw.citation,
    raw.proof
  );
  if (!pattern || !lesson) return null;
  return {
    pattern: truncate(pattern, 120),
    lesson: truncate(lesson, 400),
    evidence: truncate(evidence || '(no direct evidence quoted)', 400),
  };
}

function pickString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

function dedupe(insights) {
  const seen = new Map();
  for (const item of insights) {
    const key = `${item.pattern}|${item.lesson}`
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

/* -------------------------------------------------------------------------- */
/* Heuristic fallback (no LLM)                                                */
/* -------------------------------------------------------------------------- */

function heuristicExtract(paths) {
  const ok = new Map();
  const fail = new Map();
  let totalSteps = 0;

  for (const p of paths) {
    for (const step of p.steps) {
      totalSteps += 1;
      const label = stepLabel(step).toLowerCase();
      const action = label.split(/[\s(::]/)[0] || 'step';
      const status = stepStatus(step);
      if (status === 'fail') {
        fail.set(action, (fail.get(action) || 0) + 1);
      } else if (status === 'ok') {
        ok.set(action, (ok.get(action) || 0) + 1);
      }
    }
  }

  const insights = [];
  const successes = [...ok.entries()].sort((a, b) => b[1] - a[1]);
  const failures = [...fail.entries()].sort((a, b) => b[1] - a[1]);

  if (successes.length) {
    const [action, count] = successes[0];
    insights.push({
      pattern: `reliable:${action}`,
      lesson: `Prefer the "${action}" step early — it succeeded ${count} time(s) across the analysed paths.`,
      evidence: `"${action}" reported ok ${count} time(s).`,
    });
  }

  if (failures.length) {
    const [action, count] = failures[0];
    insights.push({
      pattern: `fragile:${action}`,
      lesson: `Guard or retry the "${action}" step — it failed ${count} time(s); verify preconditions first.`,
      evidence: `"${action}" reported fail ${count} time(s).`,
    });
  }

  if (!insights.length && totalSteps > 0) {
    insights.push({
      pattern: 'unclassified-path',
      lesson: 'No ok/fail signal in the paths; instrument steps with an explicit outcome.',
      evidence: `${totalSteps} steps analysed, none carried a status.`,
    });
  }

  return dedupe(insights);
}

/* -------------------------------------------------------------------------- */
/* Race integration                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Load real paths for a race via `trajectory/path_builder.js`.
 * Never throws — returns [] when the module or data is unavailable.
 */
function loadPathsFromRace(raceId) {
  try {
    const builder = require('./path_builder');
    if (builder && typeof builder.buildPath === 'function') {
      const built = builder.buildPath(raceId);
      return normalizePaths(built);
    }
  } catch (err) {
    log('path_builder unavailable:', err.message);
  }
  return [];
}

async function extractFromRace(raceId, options = {}) {
  const paths = loadPathsFromRace(raceId);
  if (!paths.length) {
    log('no paths found for race', raceId);
    return [];
  }
  return extract(paths, options);
}

/* -------------------------------------------------------------------------- */
/* Offline path loading                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Load raw paths from a JSON or JSONL file and normalise them. Handy for
 * offline analysis of archived trajectories (e.g. memory/patterns/*.jsonl).
 *
 * Accepts either:
 *   - a JSON document containing one path / an array of paths / an agent map,
 *   - a JSONL file where every non-empty line is one path (or one step list).
 *
 * Never throws — returns [] when the file is missing or malformed.
 *
 * @param {string} file  absolute path, or relative to the project root
 * @returns {Array<{label: string, steps: Array}>}
 */
function loadPathsFromFile(file) {
  if (!file || typeof file !== 'string') return [];
  try {
    const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
    const raw = fs.readFileSync(abs, 'utf8').trim();
    if (!raw) return [];

    let data;
    if (raw.startsWith('[') || raw.startsWith('{')) {
      data = JSON.parse(raw);
    } else {
      data = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch (_) {
            return null;
          }
        })
        .filter((v) => v !== null);
    }

    return normalizePaths(data);
  } catch (err) {
    log('loadPathsFromFile failed:', err.message);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Extract insights from one or more execution paths.
 *
 * @param {*} paths  array of paths (or a single path / {agent: [steps]} map)
 * @param {Object} [options]
 * @param {boolean} [options.fallback=true]  heuristic extraction on LLM failure
 * @param {string}  [options.model]          override GigaChat model
 * @param {number}  [options.temperature]    override sampling temperature
 * @returns {Promise<Array<{pattern: string, lesson: string, evidence: string}>>}
 */
async function extract(paths, options = {}) {
  const { fallback = true } = options;
  const list = normalizePaths(paths).filter((p) => p.steps.length > 0 || Array.isArray(paths));
  const effective = list.length ? list : normalizePaths(paths);

  if (!effective.length) return [];

  let insights = [];
  try {
    const content = await callModel(buildMessages(effective), 0, options);
    insights = extractJsonArray(content).map(normalizeInsight).filter(Boolean);
  } catch (err) {
    log('LLM extraction failed:', err.message);
    if (!fallback) throw err;
  }

  if (insights.length === 0 && fallback) {
    insights = heuristicExtract(effective);
  }

  return dedupe(insights);
}

module.exports = {
  extract,
  extractFromRace,
  loadPathsFromRace,
  // Exposed for testing / reuse.
  normalizePaths,
  serializePath,
  buildMessages,
  extractJsonArray,
  normalizeInsight,
  heuristicExtract,
  dedupe,
  getAccessToken,
  CONFIG,
};

/* -------------------------------------------------------------------------- */
/* CLI: node trajectory/insight_extractor.js [raceId]                         */
/* -------------------------------------------------------------------------- */

if (require.main === module) {
  const raceId = process.argv[2];
  const sample = [
    [
      { action: 'read', ok: true, result: 'file contents' },
      { action: 'edit', ok: false, error: 'fragment not found' },
      { action: 'read', ok: true },
      { action: 'edit', ok: true, result: 'patched' },
    ],
    [
      { action: 'read', ok: true },
      { action: 'edit', ok: true, result: 'patched' },
    ],
  ];

  const job = raceId ? extractFromRace(raceId) : extract(sample);
  job
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error(e);
      process.exit(1);
    });
}
