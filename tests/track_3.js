'use strict';

/**
 * tests/track_3.js
 * ---------------------------------------------------------------------------
 * Dependency-free event tracker / metrics aggregator for Phoenix.
 *
 * Primary API:
 *
 *   track(name, value?, tags?)  -> Record   record a metric sample
 *   timer(name, tags?)          -> Function returns a stop() that records ms
 *   counter(name, tags?)        -> { inc(n=1), value(), reset() }
 *   gauge(name, value, tags?)   -> number   set an absolute value
 *   snapshot()                  -> { ... }   deep-ish copy of raw state
 *   report(options?)            -> aggregated report
 *   reset()                     -> void      clear all recorded data
 *
 * Helpers:
 *   percentile(sortedOrArray, p) -> number
 *   summarize(values)            -> { count, sum, min, max, mean, p50, p90, p95, p99 }
 *   setClock(fn)                 -> void   override the clock (testing)
 *   setMaxSamples(n)             -> void   cap retained raw events
 *
 * report(options) shape:
 *   {
 *     ok: boolean,
 *     events: number,
 *     names: string[],
 *     metrics: {
 *       [name]: {
 *         count, sum, min, max, mean, last,
 *         p50, p90, p95, p99,
 *         tags: { [tagKey]: count }
 *       }
 *     },
 *     gauges:   { [key]: { value, at } },
 *     counters: { [key]: { value } },
 *     timers:   { [name]: { count, sum, min, max, mean, p95 } },
 *     slowest:  Array<{ name, value, at }>,
 *     window:   { from, to }
 *   }
 */

/* -------------------------------------------------------------------------- */
/* internal state                                                             */
/* -------------------------------------------------------------------------- */

const state = {
  events: [],          // { name, value, tags, at, kind }
  gauges: Object.create(null),
  counters: Object.create(null),
  timers: Object.create(null),
};

let _now = () => Date.now();
let _maxSamples = 100000;

/* -------------------------------------------------------------------------- */
/* small utilities                                                            */
/* -------------------------------------------------------------------------- */

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function toFiniteNumber(n, fallback) {
  if (n === undefined || n === null || n === '') return fallback;
  const x = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function normalizeTags(tags) {
  if (!tags || typeof tags !== 'object') return Object.create(null);
  const out = Object.create(null);
  for (const key of Object.keys(tags)) {
    const val = tags[key];
    out[String(key)] = val === undefined || val === null ? '' : String(val);
  }
  return out;
}

function tagKey(tags) {
  const keys = Object.keys(tags).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${tags[k]}`).join(',');
}

function compositeKey(name, tags) {
  const tk = tagKey(tags);
  return tk ? `${name}|${tk}` : name;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_e) {
    return String(value);
  }
}

/* -------------------------------------------------------------------------- */
/* percentile / summarize                                                     */
/* -------------------------------------------------------------------------- */

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const nums = values.filter(isFiniteNumber).slice().sort((a, b) => a - b);
  if (nums.length === 0) return 0;
  let rank = toFiniteNumber(p, 0);
  if (rank > 1) rank = rank / 100;
  if (rank <= 0) return nums[0];
  if (rank >= 1) return nums[nums.length - 1];
  const idx = Math.min(nums.length - 1, Math.ceil(rank * nums.length) - 1);
  return nums[idx < 0 ? 0 : idx];
}

function summarize(values) {
  const nums = (Array.isArray(values) ? values : []).filter(isFiniteNumber);
  if (nums.length === 0) {
    return { count: 0, sum: 0, min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
  }
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const n of nums) {
    sum += n;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return {
    count: nums.length,
    sum,
    min,
    max,
    mean: sum / nums.length,
    p50: percentile(nums, 50),
    p90: percentile(nums, 90),
    p95: percentile(nums, 95),
    p99: percentile(nums, 99),
  };
}

/* -------------------------------------------------------------------------- */
/* core recording primitives                                                  */
/* -------------------------------------------------------------------------- */

function pushEvent(evt) {
  state.events.push(evt);
  if (state.events.length > _maxSamples) {
    state.events.splice(0, state.events.length - _maxSamples);
  }
  return evt;
}

/**
 * Record a metric sample. `value` defaults to 1 (useful as a plain counter).
 */
function track(name, value, tags) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('track(name, value?, tags?) expects a non-empty string name');
  }
  const val = toFiniteNumber(value, 1);
  const normTags = normalizeTags(tags);
  return pushEvent({
    kind: 'metric',
    name,
    value: val,
    tags: normTags,
    at: _now(),
  });
}

/**
 * Time an operation. Returns a stop() function that records elapsed ms.
 * Never records twice per stop().
 */
function timer(name, tags) {
  const normTags = normalizeTags(tags);
  const started = _now();
  let stopped = false;
  return function stop() {
    if (stopped) return 0;
    stopped = true;
    const elapsed = Math.max(0, _now() - started);
    const bucket = name in state.timers
      ? state.timers[name]
      : (state.timers[name] = { count: 0, sum: 0, min: Infinity, max: -Infinity, samples: [] });
    bucket.count += 1;
    bucket.sum += elapsed;
    if (elapsed < bucket.min) bucket.min = elapsed;
    if (elapsed > bucket.max) bucket.max = elapsed;
    bucket.samples.push(elapsed);
    if (bucket.samples.length > 1000) bucket.samples.shift();

    pushEvent({ kind: 'timer', name, value: elapsed, tags: normTags, at: _now() });
    return elapsed;
  };
}

/**
 * Monotonic counter, optionally tagged. Value is stored under a composite key.
 */
function counter(name, tags) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('counter(name, tags?) expects a non-empty string name');
  }
  const normTags = normalizeTags(tags);
  const key = compositeKey(name, normTags);
  if (!(key in state.counters)) {
    state.counters[key] = { name, tags: normTags, value: 0 };
  }
  const entry = state.counters[key];
  return {
    inc(n) {
      const delta = toFiniteNumber(n, 1);
      entry.value += delta;
      pushEvent({ kind: 'counter', name, value: entry.value, tags: normTags, at: _now() });
      return entry.value;
    },
    value() {
      return entry.value;
    },
    reset() {
      entry.value = 0;
      return 0;
    },
  };
}

/**
 * Set an absolute gauge value (last write wins).
 */
function gauge(name, value, tags) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('gauge(name, value, tags?) expects a non-empty string name');
  }
  const normTags = normalizeTags(tags);
  const key = compositeKey(name, normTags);
  const val = toFiniteNumber(value, 0);
  state.gauges[key] = { name, value: val, tags: normTags, at: _now() };
  pushEvent({ kind: 'gauge', name, value: val, tags: normTags, at: _now() });
  return val;
}

/* -------------------------------------------------------------------------- */
/* reporting                                                                  */
/* -------------------------------------------------------------------------- */

function report(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const topN = toFiniteNumber(opts.slowest, 0);

  const metrics = Object.create(null);
  const byName = Object.create(null);
  let from = Infinity;
  let to = -Infinity;

  for (const evt of state.events) {
    if (evt.at < from) from = evt.at;
    if (evt.at > to) to = evt.at;
    if (evt.kind !== 'metric') continue;
    if (!byName[evt.name]) byName[evt.name] = { values: [], tags: Object.create(null) };
    byName[evt.name].values.push(evt.value);
    const tk = tagKey(evt.tags);
    if (tk) {
      byName[evt.name].tags[tk] = (byName[evt.name].tags[tk] || 0) + 1;
    }
  }

  for (const name of Object.keys(byName)) {
    const s = summarize(byName[name].values);
    const vals = byName[name].values;
    metrics[name] = {
      count: s.count,
      sum: s.sum,
      min: s.min,
      max: s.max,
      mean: s.mean,
      last: vals.length ? vals[vals.length - 1] : 0,
      p50: s.p50,
      p90: s.p90,
      p95: s.p95,
      p99: s.p99,
      tags: byName[name].tags,
    };
  }

  const gauges = Object.create(null);
  for (const key of Object.keys(state.gauges)) {
    const g = state.gauges[key];
    gauges[key] = { value: g.value, at: g.at };
  }

  const counters = Object.create(null);
  for (const key of Object.keys(state.counters)) {
    counters[key] = { value: state.counters[key].value };
  }

  const timers = Object.create(null);
  for (const key of Object.keys(state.timers)) {
    const t = state.timers[key];
    timers[key] = {
      count: t.count,
      sum: t.sum,
      min: t.min === Infinity ? 0 : t.min,
      max: t.max === -Infinity ? 0 : t.max,
      mean: t.count ? t.sum / t.count : 0,
      p95: percentile(t.samples, 95),
    };
  }

  let slowest = [];
  if (topN > 0) {
    slowest = state.events
      .filter((e) => e.kind === 'metric')
      .slice()
      .sort((a, b) => b.value - a.value)
      .slice(0, Math.floor(topN))
      .map((e) => ({ name: e.name, value: e.value, at: e.at }));
  }

  const names = Object.keys(metrics).sort();

  return {
    ok: true,
    events: state.events.length,
    names,
    metrics,
    gauges,
    counters,
    timers,
    slowest,
    window: {
      from: from === Infinity ? 0 : from,
      to: to === -Infinity ? 0 : to,
    },
  };
}

function snapshot() {
  return {
    events: state.events.map((e) => ({
      kind: e.kind,
      name: e.name,
      value: e.value,
      tags: Object.assign({}, e.tags),
      at: e.at,
    })),
    gauges: JSON.parse(safeJson(state.gauges)),
    counters: JSON.parse(safeJson(state.counters)),
    timers: semanticTimers(),
  };

  function semanticTimers() {
    const out = Object.create(null);
    for (const key of Object.keys(state.timers)) {
      const t = state.timers[key];
      out[key] = { count: t.count, sum: t.sum };
    }
    return out;
  }
}

function reset() {
  state.events.length = 0;
  state.gauges = Object.create(null);
  state.counters = Object.create(null);
  state.timers = Object.create(null);
}

/* -------------------------------------------------------------------------- */
/* configuration hooks                                                        */
/* -------------------------------------------------------------------------- */

function setClock(fn) {
  if (typeof fn !== 'function') throw new TypeError('setClock(fn) expects a function');
  _now = fn;
}

function setMaxSamples(n) {
  if (!isFiniteNumber(n) || n <= 0) throw new TypeError('setMaxSamples(n) expects a positive number');
  _maxSamples = Math.floor(n);
  if (state.events.length > _maxSamples) {
    state.events.splice(0, state.events.length - _maxSamples);
  }
}

/* -------------------------------------------------------------------------- */
/* exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  track,
  timer,
  counter,
  gauge,
  report,
  snapshot,
  reset,
  setClock,
  setMaxSamples,
  percentile,
  summarize,
};

/* -------------------------------------------------------------------------- */
/* smoke test (runs only when invoked directly: `node tests/track_3.js`)      */
/* -------------------------------------------------------------------------- */

if (require.main === module) {
  reset();

  // deterministic clock
  let clock = 1000;
  setClock(() => clock);

  track('requests', 12, { route: '/a' });
  clock += 5;
  track('requests', 7, { route: '/b' });
  clock += 5;
  track('requests', 30, { route: '/a' });

  gauge('memory', 128);

  const c = counter('hits', { src: 'cli' });
  c.inc(3);

  const stop = timer('work');
  clock += 42;
  stop();

  const r = report({ slowest: 5 });

  const checks = [
    r.ok === true,
    r.events === 4,
    r.metrics.requests.count === 3,
    r.metrics.requests.max === 30,
    r.metrics.requests.min === 7,
    r.gauges.memory.value === 128,
    r.counters['hits|src=cli'].value === 3,
    r.timers.work.count === 1,
    r.timers.work.sum === 42,
    r.slowest.length === 3,
    r.slowest[0].value === 30,
    typeof snapshot().events.length === 'number',
  ];

  const ok = checks.every(Boolean);

  if (!ok) {
    console.error('track_3 smoke test FAILED', JSON.stringify({ checks, report: r }, null, 2));
    process.exitCode = 1;
  } else {
    console.log('track_3 smoke test OK');
  }
}
