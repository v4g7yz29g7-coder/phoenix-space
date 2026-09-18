'use strict';

/**
 * analytics/tracker.smoke.js
 * Smoke-test for analytics/tracker.js (no external test framework).
 *
 * Run:  node analytics/tracker.smoke.js
 */

const path = require('path');
const fs = require('fs');

// Redirect the tracker to a throwaway file so the real log is untouched.
const TMP_FILE = path.join(require('os').tmpdir(), 'analytics_smoke_' + Date.now() + '.jsonl');
process.env.ANALYTICS_FILE = TMP_FILE;

const tracker = require('./tracker.js');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exitCode = 1;
  } else {
    console.log('ok  - ' + msg);
  }
}

// --- API surface ------------------------------------------------------------
assert(typeof tracker.track === 'function', 'exports track()');
assert(typeof tracker.getStats === 'function', 'exports getStats()');
assert(typeof tracker.report === 'function', 'exports report()');

// --- track() ----------------------------------------------------------------
tracker.track('page_view', { path: '/', lang: 'ru' });
tracker.track('page_view', { path: '/pricing' });
tracker.track('click', { id: 'buy', price: 42 });
tracker.track('signup', {});
assert(fs.existsSync(TMP_FILE), 'writes JSONL to disk');

const lines = fs.readFileSync(TMP_FILE, 'utf8').trim().split('\n');
assert(lines.length === 4, 'four lines persisted (' + lines.length + ')');
assert(lines.every((l) => JSON.parse(l).name), 'every line is valid JSON with name');

// --- getStats() -------------------------------------------------------------
const stats = tracker.getStats();
assert(stats.total === 4, 'total == 4 (got ' + stats.total + ')');
assert(stats.uniqueEvents === 3, 'uniqueEvents == 3 (got ' + stats.uniqueEvents + ')');
assert(stats.byName.page_view && stats.byName.page_view.count === 2, 'page_view count == 2');
assert(stats.byName.click && stats.byName.click.count === 1, 'click count == 1');
assert(stats.eventList.length === 3, 'eventList has 3 entries');

// --- validation -------------------------------------------------------------
let threw = false;
try { tracker.track(); } catch (e) { threw = true; }
assert(threw, 'track() without name throws');

let threw2 = false;
try { tracker.track(''); } catch (e) { threw2 = true; }
assert(threw2, 'track("") throws');

// --- report() ---------------------------------------------------------------
const captured = [];
const returned = tracker.report({ log: (m) => captured.push(m) });
assert(returned.total === 4, 'report() returns stats');
assert(captured.length > 0, 'report() prints lines');

// --- cleanup ----------------------------------------------------------------
try { fs.unlinkSync(TMP_FILE); } catch (e) {}
console.log(process.exitCode ? '\nSMOKE FAILED' : '\nSMOKE OK');
