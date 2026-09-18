'use strict';

/**
 * tests/coverage.js
 * ---------------------------------------------------------------------------
 * Dependency-free, in-process code-coverage collector for Node.js.
 *
 * Public API (primary entry point):
 *
 *   report()  -> {
 *                  summary: { files, statements, covered, rate, percent,
 *                             lines, branches, functions, durationMs },
 *                  files:   [ { file, statements, covered, rate, percent,
 *                               lines, branches, functions } ],
 *                  thresholds: { required, pass },
 *                  failing:  [file, ...],
 *                  uncovered: [lineRef, ...],
 *                  ok:       boolean,
 *                  generatedAt: ISO-string
 *                }
 *
 *   report(options) -> same shape, tuned by:
 *                  {
 *                    threshold: number,   // required coverage 0..1 (default 0.8)
 *                    cwd:       string,   // root dir to scan
 *                    exclude:   string[], // substrings or *.suffix patterns
 *                    maxFiles:  number,   // hard cap on scanned files
 *                    include:   string[]  // required substrings for files
 *                  }
 *
 *   report.asText(result) -> human readable multi-line string
 *   report.asJSON(options) -> pretty JSON string
 *   report.validate(result) -> { ok, errors }
 *   report.assert(result)  -> true (throws on contract violation)
 *
 * Supporting API:
 *   collect(file, source)     -> register a source unit (denominator)
 *   track(file, line)         -> record an executed line (numerator)
 *   trackBranch(file, id)     -> record an executed branch
 *   trackFunction(file, id)   -> record an executed function
 *   hitCount(file)            -> distinct executed lines for a file
 *   countStatements(source)  -> naive, robust statement counter
 *   shouldExclude(file, pats) -> exclusion predicate
 *   walk(dir, opts, acc)      -> recursive .js collector
 *   discover(opts)            -> walk + collect in one call
 *   reset()                   -> clears all recorded data
 *   DEFAULTS                  -> frozen default configuration
 *
 * The module is side-effect free at import time and never throws on
 * malformed input, so it is safe to require() from any runner.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

/* =========================================================================
 * Configuration
 * ========================================================================= */

const DEFAULTS = Object.freeze({
  threshold: 0.8,
  cwd: process.cwd(),
  include: ['*.js'],
  exclude: ['node_modules', '.git', 'coverage', 'dist', 'build', '.bak'],
  maxFiles: 500,
});

/* =========================================================================
 * Internal state
 * ========================================================================= */

/** Map<absolute-file, Set<line-number>> of executed lines. */
const hits = new Map();

/** Map<absolute-file, Set<string>> of executed branch ids. */
const branchHits = new Map();

/** Map<absolute-file, Set<string>> of executed function ids. */
const functionHits = new Map();

/** Map<absolute-file, meta> of known / instrumented files. */
const registry = new Map();

/** Insertion order of registered files (stable report ordering). */
const order = [];

let startedAt = Date.now();
let finishedAt = null;

/* =========================================================================
 * Small utilities
 * ========================================================================= */

/** Stable string key for arbitrary values. */
function keyOf(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return String(value);
}

/** Absolute, normalised path used as the canonical key. */
function canonical(file) {
  try {
    return path.resolve(keyOf(file));
  } catch (err) {
    return keyOf(file);
  }
}

/** Round to a fixed number of decimals, guarding against NaN. */
function round(value, decimals) {
  const d = decimals == null ? 4 : decimals;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(d));
}

/** Safe division returning 0 when the denominator is falsy. */
function ratio(covered, total) {
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return round(Number(covered) / t, 4);
}

/* =========================================================================
 * Recording API
 * ========================================================================= */

/** Clear every recorded hit and registration. */
function reset() {
  hits.clear();
  branchHits.clear();
  functionHits.clear();
  registry.clear();
  order.length = 0;
  startedAt = Date.now();
  finishedAt = null;
  return true;
}

/** Mark the collector as started. */
function start() {
  startedAt = Date.now();
  finishedAt = null;
}

/** Mark the collector as finished. */
function stop() {
  finishedAt = Date.now();
}

/** Record that `line` of `file` executed; returns new distinct count. */
function track(file, line) {
  const abs = canonical(file);
  const n = Number(line);
  if (!Number.isFinite(n) || n <= 0) return 0;

  let set = hits.get(abs);
  if (!set) {
    set = new Set();
    hits.set(abs, set);
  }
  set.add(Math.floor(n));
  return set.size;
}

/** Record an executed branch id for `file`. */
function trackBranch(file, id) {
  const abs = canonical(file);
  let set = branchHits.get(abs);
  if (!set) {
    set = new Set();
    branchHits.set(abs, set);
  }
  set.add(keyOf(id));
  return set.size;
}

/** Record an executed function id for `file`. */
function trackFunction(file, id) {
  const abs = canonical(file);
  let set = functionHits.get(abs);
  if (!set) {
    set = new Set();
    functionHits.set(abs, set);
  }
  set.add(keyOf(id));
  return set.size;
}

/** Number of distinct executed lines for `file` (0 if unknown). */
function hitCount(file) {
  const set = hits.get(canonical(file));
  return set ? set.size : 0;
}

/** Is `file` excluded by any of the given patterns? */
function shouldExclude(file, patterns) {
  const list = Array.isArray(patterns) ? patterns : DEFAULTS.exclude;
  const normalized = String(file).split(path.sep).join('/');
  return list.some(function matches(p) {
    if (typeof p !== 'string' || p === '') return false;
    if (p.startsWith('*')) return normalized.endsWith(p.slice(1));
    return normalized.includes(p);
  });
}

/** Does `file` satisfy the include list (empty list means "all")? */
function shouldInclude(file, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  const normalized = String(file).split(path.sep).join('/');
  return patterns.some(function matches(p) {
    if (typeof p !== 'string' || p === '') return false;
    if (p.startsWith('*')) return normalized.endsWith(p.slice(1));
    return normalized.includes(p);
  });
}

/* =========================================================================
 * Source scanning
 * ========================================================================= */

/**
 * Recursively collect `.js` files below `dir`, honouring `opts.exclude`
 * and `opts.maxFiles`. Never throws: unreadable directories are skipped.
 */
function walk(dir, opts, acc) {
  const o = opts || DEFAULTS;
  const out = acc || [];
  const cap = Number.isFinite(o.maxFiles) ? o.maxFiles : DEFAULTS.maxFiles;

  if (out.length >= cap) return out;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const full = path.join(dir, entry.name);

    if (shouldExclude(full, o.exclude)) continue;

    if (entry.isDirectory()) {
      walk(full, o, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      if (shouldInclude(full, o.include)) out.push(full);
    }

    if (out.length >= cap) return out;
  }

  return out;
}

/**
 * Naive but robust statement counter: counts non-empty, non-comment lines
 * that look executable. Sufficient as a coverage denominator without a
 * full parser, and tolerant of CRLF line endings and block comments.
 */
function countStatements(source) {
  const src = typeof source === 'string' ? source : '';
  const lines = src.split(/\r?\n/);
  let inBlockComment = false;
  let count = 0;

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].trim();

    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2).trim();
      inBlockComment = false;
    }

    if (line === '' || line.startsWith('//')) continue;

    if (line.startsWith('/*')) {
      const end = line.indexOf('*/');
      if (end === -1) {
        inBlockComment = true;
        continue;
      }
      line = line.slice(end + 2).trim();
      if (line === '') continue;
    }

    if (line === '{' || line === '}' || line === '};') continue;
    count += 1;
  }

  return count;
}

/** Cheap estimate of branch points contained in a source blob. */
function countBranches(source) {
  const src = typeof source === 'string' ? source : '';
  const matches = src.match(/\bif\b|\belse\b|\bcase\b|\?|&&|\|\|/g);
  return matches ? matches.length : 0;
}

/** Cheap estimate of function declarations contained in a source blob. */
function countFunctions(source) {
  const src = typeof source === 'string' ? source : '';
  const matches = src.match(/\bfunction\b|=>/g);
  return matches ? matches.length : 0;
}

/**
 * Register a source unit. Idempotent-ish: re-registering updates metadata.
 * If `source` is omitted it is read from disk.
 */
function collect(file, source) {
  const abs = canonical(file);
  let src = source;

  if (src == null) {
    src = fs.readFileSync(abs, 'utf8');
  }

  const meta = {
    file: abs,
    statements: countStatements(src),
    lines: String(src).split(/\r?\n/).length,
    branches: countBranches(src),
    functions: countFunctions(src),
    bytes: Buffer.byteLength(String(src), 'utf8'),
  };

  if (!registry.has(abs)) order.push(abs);
  registry.set(abs, meta);
  return meta;
}

/** Discover and register every eligible file below `opts.cwd`. */
function discover(opts) {
  const o = opts || DEFAULTS;
  const root = o.cwd || DEFAULTS.cwd;
  const found = walk(root, o, []);
  const metas = [];
  for (let i = 0; i < found.length; i += 1) {
    try {
      metas.push(collect(found[i]));
    } catch (err) {
      // ignore unreadable files
    }
  }
  return metas;
}

/* =========================================================================
 * Reporting API
 * ========================================================================= */

/** Build a per-file report row from a registry entry. */
function buildRow(meta) {
  const abs = meta.file;
  const total = meta.statements;
  const covered = Math.min(hitCount(abs), total);
  const rate = ratio(covered, total);

  return {
    file: abs,
    statements: total,
    covered: covered,
    rate: rate,
    percent: round(rate * 100, 2),
    lines: meta.lines,
    branches: meta.branches,
    functions: meta.functions,
  };
}

/**
 * Compute a full coverage report.
 *
 * @param {object} [options] optional configuration overrides.
 * @returns {object} aggregated report (see module header).
 */
function report(options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const rows = [];
  let statements = 0;
  let covered = 0;

  for (let i = 0; i < order.length; i += 1) {
    const meta = registry.get(order[i]);
    if (!meta) continue;
    const row = buildRow(meta);
    rows.push(row);
    statements += row.statements;
    covered += row.covered;
  }

  const rate = ratio(covered, statements);
  const threshold = Number.isFinite(o.threshold) ? o.threshold : DEFAULTS.threshold;
  const failing = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].rate < threshold) failing.push(rows[i].file);
  }

  const uncovered = [];
  for (let i = 0; i < order.length; i += 1) {
    const abs = order[i];
    const set = hits.get(abs);
    if (set) continue;
    uncovered.push(path.relative(o.cwd, abs));
  }

  return {
    summary: {
      files: rows.length,
      statements: statements,
      covered: covered,
      rate: rate,
      percent: round(rate * 100, 2),
      lines: statements,
      branches: rows.reduce(function sum(acc, r) { return acc + r.branches; }, 0),
      functions: rows.reduce(function sum(acc, r) { return acc + r.functions; }, 0),
      durationMs: (finishedAt || Date.now()) - startedAt,
    },
    files: rows,
    thresholds: { required: threshold, pass: rate >= threshold },
    failing: failing,
    uncovered: uncovered,
    ok: failing.length === 0 && rate >= threshold,
    generatedAt: new Date().toISOString(),
  };
}

/** Human-readable text rendering of a report object. */
report.asText = function asText(result) {
  const r = result || report();
  const out = [];
  out.push('Coverage report');
  out.push('---------------');
  out.push('files      : ' + r.summary.files);
  out.push('statements : ' + r.summary.statements);
  out.push('covered    : ' + r.summary.covered);
  out.push('rate       : ' + r.summary.percent + '%');
  out.push('threshold  : ' + round(r.thresholds.required * 100, 2) + '%');
  out.push('status     : ' + (r.ok ? 'PASS' : 'FAIL'));
  out.push('');
  out.push('Per file:');
  for (let i = 0; i < r.files.length; i += 1) {
    const f = r.files[i];
    const rel = path.relative(process.cwd(), f.file);
    const filled = Math.max(0, Math.min(20, Math.round(f.rate * 20)));
    const bar = '#'.repeat(filled).padEnd(20, '.');
    out.push('[' + bar + '] ' + String(f.percent).padStart(6) + '%  ' + rel);
  }
  if (r.failing.length) {
    out.push('');
    out.push('Failing files (' + r.failing.length + '):');
    for (let i = 0; i < r.failing.length; i += 1) {
      out.push('  - ' + path.relative(process.cwd(), r.failing[i]));
    }
  }
  return out.join('\n');
};

/** Convenience: report() rendered as pretty JSON. */
report.asJSON = function asJSON(options) {
  return JSON.stringify(report(options), null, 2);
};

/** Shape validator for a report object. */
report.validate = function validate(result) {
  const errors = [];
  const r = result || {};
  if (typeof r !== 'object' || r === null) {
    return { ok: false, errors: ['report is not an object'] };
  }
  if (!r.summary || typeof r.summary !== 'object') {
    errors.push('missing summary');
  } else if (typeof r.summary.rate !== 'number') {
    errors.push('summary.rate must be a number');
  }
  if (!Array.isArray(r.files)) errors.push('files must be an array');
  if (!r.thresholds || typeof r.thresholds !== 'object') {
    errors.push('missing thresholds');
  }
  if (!Array.isArray(r.failing)) errors.push('failing must be an array');
  if (typeof r.ok !== 'boolean') errors.push('ok must be a boolean');
  if (typeof r.generatedAt !== 'string') errors.push('generatedAt must be a string');
  return { ok: errors.length === 0, errors: errors };
};

/** Assert-style helper: throws when the report violates the contract. */
report.assert = function assert(result) {
  const check = report.validate(result);
  if (!check.ok) {
    throw new Error('invalid coverage report: ' + check.errors.join('; '));
  }
  return true;
};

/* =========================================================================
 * Exports
 * ========================================================================= */

module.exports = {
  report: report,
  collect: collect,
  discover: discover,
  reset: reset,
  start: start,
  stop: stop,
  track: track,
  trackBranch: trackBranch,
  trackFunction: trackFunction,
  hitCount: hitCount,
  countStatements: countStatements,
  countBranches: countBranches,
  countFunctions: countFunctions,
  shouldExclude: shouldExclude,
  shouldInclude: shouldInclude,
  walk: walk,
  DEFAULTS: DEFAULTS,
};

/* =========================================================================
 * Self-test when executed directly:  node tests/coverage.js
 * ========================================================================= */

if (require.main === module) {
  const self = __filename;
  try {
    reset();
    const meta = collect(self);
    track(self, 1);
    track(self, 2);
    track(self, 3);
    track(self, 4);
    trackBranch(self, 'if:1');
    trackFunction(self, 'report');
    const result = report({ threshold: 0.0 });
    report.assert(result);

    // --- extra contract checks (asText / asJSON / validate negative case) ---
    const text = report.asText(result);
    if (typeof text !== 'string' || text.indexOf('Coverage report') === -1) {
      throw new Error('asText() did not render a coverage report');
    }

    const json = report.asJSON({ threshold: 0.0 });
    if (typeof json !== 'string' || JSON.parse(json).summary == null) {
      throw new Error('asJSON() did not produce a parsable report');
    }

    const negative = report.validate({ summary: null });
    if (negative.ok !== false || negative.errors.length === 0) {
      throw new Error('validate() failed to reject a malformed report');
    }

    if (hitCount(self) < 4) {
      throw new Error('hitCount() did not record tracked lines');
    }

    process.stdout.write(
      'Instrumented ' + path.basename(self) + ': ' + meta.statements + ' statements\n'
    );
    process.stdout.write(report.asText(result) + '\n');
    process.stdout.write('coverage self-test: OK\n');
  } catch (err) {
    process.stderr.write('coverage self-test failed: ' + err.message + '\n');
    process.exitCode = 1;
  }
}
