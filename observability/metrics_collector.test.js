'use strict';
const assert = require('assert');
const mc = require('./metrics_collector.js');

// 1. exports present
assert.strictEqual(typeof mc.collect, 'function', 'collect must be a function');
assert.strictEqual(typeof mc.query, 'function', 'query must be a function');
assert.strictEqual(typeof mc.MetricsCollector, 'function', 'class exported');
console.log('exports OK:', Object.keys(mc).join(','));

// 2. collect(name, value[, tags])
const c = new mc.MetricsCollector({ clock: () => 1000 });
c.collect('latency', 10, { route: '/a' });
c.collect('latency', 20, { route: '/a' });
c.collect('latency', 30);
assert.strictEqual(c.stats().sampleCount, 3, 'three samples');
console.log('collect(name,value,tags) OK');

// 3. collect(name) -> counter increment
c.collect('hits');
c.collect('hits');
const qh = c.query({ since: 0, until: 5000 }, { names: ['hits'] });
assert.strictEqual(qh.metrics['hits'].count, 2);
assert.strictEqual(qh.metrics['hits'].sum, 2);
console.log('collect(name) counter OK');

// 4. collect() with no args -> system snapshot
const snap = c.collect();
assert.ok(snap && typeof snap === 'object' && 'system.memory.rss' in snap, 'snapshot shape');
console.log('collect() system snapshot keys:', Object.keys(snap).length);

// 5. collect({value,timestamp})
c.collect('obj', { value: 5, timestamp: 1100, tags: { k: 'v' } });
const qo = c.query({ since: 1000, until: 5000 }, { names: ['obj'] });
assert.strictEqual(qo.metrics['obj'].max, 5);
console.log('collect(object form) OK');

// 6. query(range) shapes: number, {since,until}, {from,to}, {last}, undefined
const q1 = c.query(5000);
assert.ok(q1.from <= q1.to, 'range order');
const q2 = c.query({ since: 0, until: 2000 });
assert.ok(q2.metrics.latency, 'latency in range');
const q3 = c.query({ from: 0, to: 2000 }, { groupBy: 'tags' });
assert.ok(q3.metrics.latency, 'grouped latency');
console.log('query(range) variants OK');

// 7. tag filter
const qf = c.query({ since: 0, until: 5000 }, { names: ['latency'], tags: { route: '/a' } });
assert.strictEqual(qf.metrics.latency.count, 2);
console.log('query tag filter OK');

// 8. aggregate stats
const agg = c.query({ since: 0, until: 5000 }, { names: ['latency'] }).metrics.latency;
assert.deepStrictEqual(
  [agg.count, agg.min, agg.max, agg.avg, agg.p50],
  [3, 10, 30, 20, 20]
);
console.log('aggregate OK:', JSON.stringify(agg));

// 9. reset + prune
c.reset('hits');
assert.strictEqual(c.query({ since: 0, until: 5000 }, { names: ['hits'] }).metrics['hits'], undefined);
console.log('reset OK');

// 10. input validation
assert.throws(() => c.collect('bad', NaN), TypeError);
assert.throws(() => c.collect('', 1), TypeError);
console.log('validation OK');

// 11. module-level singleton methods
mc.reset();
mc.collect('m', 1);
const qm = mc.query(0);
assert.ok(qm.metrics.m, 'module-level query works');
console.log('module-level singleton OK');

console.log('\nALL TESTS PASSED');
