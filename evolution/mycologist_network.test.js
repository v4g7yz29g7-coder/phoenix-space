'use strict';

/**
 * evolution/mycologist_network.test.js
 *
 * Smoke + contract tests for the mycelium network mapper.
 * Run with:  node evolution/mycologist_network.test.js
 *
 * No external test runner: keeps CI dependency-free.
 */

var assert = require('assert');
var myc = require('./mycologist_network.js');

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL ' + name);
    console.log('       ' + (err && err.message ? err.message : err));
  }
}

console.log('mycologist_network: API contract');

/* ------------------------------------------------------------------ *
 * Surface
 * ------------------------------------------------------------------ */

test('exports network()', function () {
  assert.strictEqual(typeof myc.network, 'function');
});

test('exports createMycologist()', function () {
  assert.strictEqual(typeof myc.createMycologist, 'function');
});

test('exports Mycologist constructor callable without new', function () {
  var inst = myc.Mycologist([{ id: 'a' }], []);
  assert(inst instanceof myc.Mycologist);
});

/* ------------------------------------------------------------------ *
 * Headline verb: network() with explicit graph
 * ------------------------------------------------------------------ */

var records = [
  { id: 'root', species: 'spore', mass: 3 },
  { id: 'trunk', species: 'hypha' },
  { id: 'tip-a', species: 'tip' },
  { id: 'tip-b', species: 'tip' },
  { id: 'spore-x', species: 'spore' }
];

var links = [
  { from: 'root', to: 'trunk', weight: 2 },
  { from: 'trunk', to: 'tip-a', weight: 1.5 },
  { from: 'trunk', to: 'tip-b', weight: 1.25 },
  { a: 'tip-a', b: 'tip-b', weight: 0.5, type: 'anastomosis' }
];

var map = myc.network(records, links);

test('network() returns the documented shape', function () {
  ['nodes', 'edges', 'adjacency', 'components', 'isolated', 'hubs', 'stats']
    .forEach(function (key) {
      assert(key in map, 'missing key: ' + key);
    });
});

test('network() preserves node count and edge count', function () {
  assert.strictEqual(map.nodes.length, 5);
  assert.strictEqual(map.edges.length, 4);
});

test('network() adjacency is symmetric for undirected hyphae', function () {
  assert(map.adjacency.root.indexOf('trunk') !== -1);
  assert(map.adjacency.trunk.indexOf('root') !== -1);
});

test('network() flags the isolated spore', function () {
  assert.deepStrictEqual(map.isolated, ['spore-x']);
});

test('network() computes 2 components (mesh + lone spore)', function () {
  assert.strictEqual(map.stats.components, 2);
  assert.strictEqual(map.stats.largestComponent, 4);
  assert.strictEqual(map.stats.connected, false);
});

test('network() hubs are ranked by degree', function () {
  assert.strictEqual(map.hubs[0].id, 'trunk');
  assert.strictEqual(map.hubs[0].degree, 3);
});

/* ------------------------------------------------------------------ *
 * Network helpers exposed on the map (non-enumerable)
 * ------------------------------------------------------------------ */

test('map.path() finds a multi-hop route', function () {
  var route = map.path('root', 'tip-a');
  assert(route, 'expected a route');
  assert.deepStrictEqual(route.nodes, ['root', 'trunk', 'tip-a']);
  assert.strictEqual(route.length, 2);
});

test('map.shortestPath() is an alias of path()', function () {
  var a = map.path('tip-a', 'tip-b');
  var b = map.shortestPath('tip-a', 'tip-b');
  assert.deepStrictEqual(a.nodes, b.nodes);
});

test('map.neighbors() lists direct contacts', function () {
  assert.deepStrictEqual(map.neighbors('trunk').sort(), ['root', 'tip-a', 'tip-b']);
});

test('helpers are non-enumerable so the map stays JSON-clean', function () {
  var json = JSON.stringify(map);
  assert(json.indexOf('"neighbors"') === -1);
});

/* ------------------------------------------------------------------ *
 * Instance verbs
 * ------------------------------------------------------------------ */

var inst = myc.createMycologist(records, links);

test('instance.stats() reports density and degrees', function () {
  var s = inst.stats();
  assert.strictEqual(s.nodes, 5);
  assert.strictEqual(s.hyphae, 4);
  assert.strictEqual(s.maxDegree, 3);
  assert(s.density > 0 && s.density <= 1, 'density out of range: ' + s.density);
});

test('instance.hubs(limit) honours the limit', function () {
  assert.strictEqual(inst.hubs(1).length, 1);
});

test('instance.describe() renders a human summary', function () {
  var text = inst.describe();
  assert(text.indexOf('mycelium: 5 nodes') !== -1);
  assert(text.indexOf('fragmented') !== -1);
});

test('instance.render() degrades gracefully without coordinates', function () {
  assert.strictEqual(inst.render(), '(no coordinates)');
});

/* ------------------------------------------------------------------ *
 * Wrapped + growing invocations
 * ------------------------------------------------------------------ */

test('network({nodes, links}) accepts a wrapped graph', function () {
  var wrapped = myc.network({ nodes: records, links: links });
  assert.strictEqual(wrapped.stats.nodes, 5);
});

test('network() with no args grows a connected mesh', function () {
  var grown = myc.network();
  assert(grown.stats.nodes > 1, 'expected grown nodes');
  assert.strictEqual(grown.stats.connected, true);
  assert.strictEqual(grown.stats.isolated, 0);
});

test('growMycelium() is deterministic for a fixed seed', function () {
  var a = myc.growMycelium({ width: 16, height: 12, steps: 80, seed: 42 });
  var b = myc.growMycelium({ width: 16, height: 12, steps: 80, seed: 42 });
  assert.strictEqual(a.nodes.length, b.nodes.length);
  assert.strictEqual(a.links.length, b.links.length);
  assert.deepStrictEqual(
    a.nodes.map(function (n) { return n.id + '@' + n.meta.x + ',' + n.meta.y; }),
    b.nodes.map(function (n) { return n.id + '@' + n.meta.x + ',' + n.meta.y; })
  );
});

test('grown mesh gives every pair a hyphal path', function () {
  var grown = myc.growNetwork({ width: 24, height: 14, steps: 200, seed: 7 });
  var first = grown.nodes[0].id;
  var last = grown.nodes[grown.nodes.length - 1].id;
  var route = grown.shortestPath(first, last);
  assert(route, 'expected a route across the grown mesh');
  assert(route.nodes[0] === first);
  assert(route.nodes[route.nodes.length - 1] === last);
  assert(grown.render().indexOf('(no coordinates)') === -1);
});

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

test('normalizeHypha() rejects an endpoint-less link', function () {
  assert.throws(function () { myc.normalizeHypha({ weight: 1 }, 0); });
});

test('normalizeNode() rejects a record without an id', function () {
  assert.throws(function () { myc.normalizeNode({ species: 'x' }); });
});

/* ------------------------------------------------------------------ */

console.log('');
console.log('passed: ' + passed + ', failed: ' + failed);
if (failed > 0) {
  process.exitCode = 1;
}
