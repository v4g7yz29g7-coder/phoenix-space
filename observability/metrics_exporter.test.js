'use strict';
const assert = require('assert');
const MetricsExporter = require('./metrics_exporter.js');

// ---------------------------------------------------------------------------
// 1. Empty exporter renders a valid empty payload
// ---------------------------------------------------------------------------
const empty = new MetricsExporter();
assert.strictEqual(typeof empty.render, 'function', 'render must be a function');
assert.strictEqual(empty.render(), '', 'empty exporter renders empty string');
assert.strictEqual(String(empty), '', 'toString alias matches render');
assert.strictEqual(MetricsExporter.CONTENT_TYPE, 'text/plain; version=0.0.4; charset=utf-8');
console.log('empty render OK');

// ---------------------------------------------------------------------------
// 2. Class + method surface
// ---------------------------------------------------------------------------
assert.strictEqual(typeof MetricsExporter, 'function', 'class exported');
for (const m of ['counter', 'gauge', 'set', 'render', 'inc', 'clear', 'remove', 'has', 'get']) {
  assert.strictEqual(typeof MetricsExporter.prototype[m], 'function', `${m} must be a function`);
}
console.log('method surface OK');

// ---------------------------------------------------------------------------
// 3. HELP / TYPE headers + basic sample rendering
// ---------------------------------------------------------------------------
const exp = new MetricsExporter();
exp.counter('http_requests_total', 'Total number of HTTP requests');
exp.gauge('queue_depth', 'Current queue depth');
exp.set('http_requests_total', 5);
exp.set('queue_depth', 42);

const out = exp.render();
assert.ok(out.endsWith('\n'), 'output ends with newline');
assert.ok(
  out.includes('# HELP http_requests_total Total number of HTTP requests'),
  'HELP line present'
);
assert.ok(out.includes('# TYPE http_requests_total counter'), 'counter TYPE line present');
assert.ok(out.includes('# HELP queue_depth Current queue depth'), 'gauge HELP present');
assert.ok(out.includes('# TYPE queue_depth gauge'), 'gauge TYPE line present');
assert.ok(out.includes('http_requests_total 5'), 'counter sample rendered');
assert.ok(out.includes('queue_depth 42'), 'gauge sample rendered');
console.log('HELP/TYPE headers OK');

// ---------------------------------------------------------------------------
// 4. Counter monotonicity: -1 (and any decrease) is a no-op
// ---------------------------------------------------------------------------
exp.set('http_requests_total', -1);
assert.strictEqual(exp.get('http_requests_total'), 5, 'negative set on counter is a no-op');
exp.set('http_requests_total', 3);
assert.strictEqual(exp.get('http_requests_total'), 5, 'decreasing counter is a no-op');
exp.set('http_requests_total', 7);
assert.strictEqual(exp.get('http_requests_total'), 7, 'increasing counter applies');
exp.inc('http_requests_total', -5);
assert.strictEqual(exp.get('http_requests_total'), 7, 'negative inc is a no-op');
exp.inc('http_requests_total', 2);
assert.strictEqual(exp.get('http_requests_total'), 9, 'positive inc applies');
assert.ok(exp.render().includes('http_requests_total 9'), 'monotonic value rendered');

// fresh counter starts at 0, so -1 must not make it negative
const c2 = new MetricsExporter();
c2.counter('c_total', 'counter');
c2.set('c_total', -1);
assert.strictEqual(c2.get('c_total'), 0, 'fresh counter cannot go negative');
console.log('counter monotonicity OK');

// ---------------------------------------------------------------------------
// 5. Gauges may decrease / be negative / float
// ---------------------------------------------------------------------------
const g = new MetricsExporter();
g.gauge('temperature', 'Temperature');
g.set('temperature', -3.5);
assert.strictEqual(g.get('temperature'), -3.5, 'gauge accepts negative floats');
g.set('temperature', 10);
assert.strictEqual(g.get('temperature'), 10, 'gauge decreases freely');
console.log('gauge semantics OK');

// ---------------------------------------------------------------------------
// 6. Label value escaping (\\, ", \n) and label ordering
// ---------------------------------------------------------------------------
const lab = new MetricsExporter();
lab.counter('req_total', 'requests');
lab.set('req_total', 1, { path: '/a"b', method: 'GET' });
lab.set('req_total', 2, { path: 'x\\y', method: 'POST' });
lab.set('req_total', 3, { note: 'line1\nline2' });

const lout = lab.render();
assert.ok(lout.includes('req_total{method="GET",path="/a\\"b"} 1'), 'quote escaped');
assert.ok(lout.includes('req_total{method="POST",path="x\\\\y"} 2'), 'backslash escaped');
assert.ok(lout.includes('note="line1\\nline2"'), 'newline escaped');
assert.strictEqual(
  MetricsExporter.escapeLabelValue('a"b\\c\nd'),
  'a\\"b\\\\c\\nd',
  'escapeLabelValue helper'
);
assert.strictEqual(MetricsExporter.escapeHelp('a\\b\nc'), 'a\\\\b\\nc', 'escapeHelp helper');
console.log('label escaping OK');

// ---------------------------------------------------------------------------
// 7. Special numeric values
// ---------------------------------------------------------------------------
const sp = new MetricsExporter();
sp.gauge('inf_g', 'inf');
sp.gauge('nan_g', 'nan');
sp.set('inf_g', Infinity);
sp.set('nan_g', NaN);
const sout = sp.render();
assert.ok(sout.includes('inf_g +Inf'), '+Inf rendered per spec');
assert.ok(sout.includes('nan_g NaN'), 'NaN rendered per spec');
console.log('special values OK');

// ---------------------------------------------------------------------------
// 8. Deterministic ordering + newline-terminated non-empty payload
// ---------------------------------------------------------------------------
const a = new MetricsExporter();
a.gauge('b_metric', 'b');
a.gauge('a_metric', 'a');
const r = a.render();
assert.ok(r.indexOf('# HELP a_metric') < r.indexOf('# HELP b_metric'), 'metrics sorted by name');
assert.ok(r.trim().length > 0, 'non-empty render has content');
console.log('ordering OK');

// ---------------------------------------------------------------------------
// 9. Immutability of the rendered payload
// ---------------------------------------------------------------------------
const imm = new MetricsExporter();
imm.counter('x_total', 'x');
imm.set('x_total', 1);
const before = imm.render();
assert.ok(before.includes('# TYPE x_total counter'));
imm.set('x_total', -1);
assert.strictEqual(imm.render(), before, 'no-op write leaves payload unchanged');
console.log('immutability OK');

console.log('\nAll metrics_exporter tests passed.');
