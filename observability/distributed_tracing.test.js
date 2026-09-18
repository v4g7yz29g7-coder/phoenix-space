'use strict';

/**
 * observability/distributed_tracing.test.js
 * ---------------------------------------------------------------------------
 * Тест модуля распределённых трейсов.
 *
 * Дерево из 10 узлов (логические тайминги задаются через `at`):
 *
 *   root(100) ─┬─ A(40)  ── A1(25) ── A1a(10)
 *              ├─ B(80)  ─┬─ B1(60) ── B1a(50)
 *              │          └─ B2(10)
 *              └─ C(30)  ── C1(20)
 *
 * Пути root->leaf и их суммы:
 *   root A A1 A1a = 100+40+25+10 = 175
 *   root B B1 B1a = 100+80+60+50 = 290   <-- критический (максимум)
 *   root B B2     = 100+80+10     = 190
 *   root C C1     = 100+30+20     = 150
 *
 * Run:  node observability/distributed_tracing.test.js
 */

const assert = require('assert');
const path = require('path');
const tracing = require(path.join(__dirname, 'distributed_tracing'));
const { startSpan, endSpan, buildTree, criticalPath, getSpan, clear } = tracing;

let passed = 0;
function ok(label) {
  passed += 1;
  console.log('  \u2713 ' + label);
}

clear();

/* ------------------------------------------------------------------ *
 * 1. Экспорт API
 * ------------------------------------------------------------------ */
assert.strictEqual(typeof startSpan, 'function', 'startSpan must be a function');
ok('export: startSpan');
assert.strictEqual(typeof endSpan, 'function', 'endSpan must be a function');
ok('export: endSpan');
assert.strictEqual(typeof buildTree, 'function', 'buildTree must be a function');
ok('export: buildTree');
assert.strictEqual(typeof criticalPath, 'function', 'criticalPath must be a function');
ok('export: criticalPath');

/* ------------------------------------------------------------------ *
 * 2. startSpan
 * ------------------------------------------------------------------ */
const root = startSpan('request', null, 0);
assert.strictEqual(typeof root, 'string');
assert.ok(root.length > 0);
ok('startSpan returns non-empty string id');

const root2 = startSpan('request2', null, 0);
assert.notStrictEqual(root, root2);
ok('ids are unique');

const A = startSpan('A.auth', root, 5);
const A1 = startSpan('A1.db', A, 7);
const A1a = startSpan('A1a.cache', A1, 9);

const B = startSpan('B.fetch', root, 10);
const B1 = startSpan('B1.db', B, 12);
const B1a = startSpan('B1a.query', B1, 14);
const B2 = startSpan('B2.serialize', B, 74);
const C = startSpan('C.render', root, 20);
const C1 = startSpan('C1.template', C, 22);

assert.strictEqual(getSpan(A).parentId, root);
ok('parentId stored correctly');
assert.strictEqual(getSpan(A).name, 'A.auth');
ok('span name stored correctly');
assert.strictEqual(getSpan(root).parentId, null);
ok('root span has parentId = null');

assert.throws(() => startSpan('', null, 0), /non-empty string/);
ok('startSpan rejects empty name');
assert.throws(() => startSpan('orphan', 'no-such-parent', 0), /unknown parentId/);
ok('startSpan rejects unknown parentId');

/* ------------------------------------------------------------------ *
 * 3. endSpan
 * ------------------------------------------------------------------ */
assert.throws(() => endSpan('no-such-id', 1), /unknown span id/);
ok('endSpan rejects unknown id');
assert.throws(() => endSpan(root, -1), /before start time/);
ok('endSpan rejects end time before start');

endSpan(A1a, 19);                      // 19 - 9  = 10
endSpan(A1, 32);                       // 32 - 7  = 25
endSpan(A, 45);                        // 45 - 5  = 40
endSpan(B1a, 64);                      // 64 - 14 = 50
endSpan(B1, 72);                       // 72 - 12 = 60
endSpan(B2, 84);                       // 84 - 74 = 10
endSpan(B, 90);                        // 90 - 10 = 80
endSpan(C1, 42);                       // 42 - 22 = 20
endSpan(C, 50);                        // 50 - 20 = 30
const rootEnded = endSpan(root, 100);  // 100 - 0 = 100

assert.strictEqual(rootEnded.endTime, 100);
ok('endSpan sets endTime');
assert.strictEqual(rootEnded.duration, 100);
ok('endSpan sets duration');
assert.strictEqual(getSpan(A1a).duration, 10);
ok('duration computed for nested span');

assert.throws(() => endSpan(A, 50), /already ended/);
ok('endSpan rejects double end');

/* ------------------------------------------------------------------ *
 * 4. buildTree
 * ------------------------------------------------------------------ */
assert.throws(() => buildTree('no-such-id'), /unknown span id/);
ok('buildTree rejects unknown rootId');

const tree = buildTree(root);
assert.strictEqual(tree.id, root);
ok('tree root id matches');
assert.strictEqual(tree.name, 'request');
ok('tree root name matches');
assert.strictEqual(tree.duration, 100);
ok('tree root duration matches');
assert.strictEqual(tree.children.length, 3);
ok('root has 3 children');

assert.deepStrictEqual(
  tree.children.map((c) => c.name),
  ['A.auth', 'B.fetch', 'C.render']
);
ok('children sorted by startTime');

const bNode = tree.children.find((c) => c.id === B);
assert.strictEqual(bNode.children.length, 2);
ok('B has 2 children');
assert.deepStrictEqual(
  bNode.children.map((c) => c.name),
  ['B1.db', 'B2.serialize']
);
ok('B children sorted by startTime');

const a1aNode = tree.children[0].children[0].children[0];
assert.strictEqual(a1aNode.name, 'A1a.cache');
ok('deep nesting (3 levels) resolves');
assert.strictEqual(a1aNode.children.length, 0);
ok('leaf has empty children');

function countNodes(node) {
  return 1 + node.children.reduce((acc, c) => acc + countNodes(c), 0);
}
assert.strictEqual(countNodes(tree), 10);
ok('tree contains exactly 10 nodes');

/* ------------------------------------------------------------------ *
 * 5. buildTree performance: 10 узлов < 5ms
 * ------------------------------------------------------------------ */
buildTree(root); // warm-up
const t0 = process.hrtime.bigint();
const treeTimed = buildTree(root);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
assert.strictEqual(treeTimed.id, root);
assert.ok(ms < 5, 'buildTree for 10 nodes should take < 5ms, took ' + ms.toFixed(3) + 'ms');
ok('buildTree 10 nodes took ' + ms.toFixed(3) + 'ms (< 5ms)');

/* ------------------------------------------------------------------ *
 * 6. criticalPath — совпадает с ручным расчётом
 * ------------------------------------------------------------------ */
assert.throws(() => criticalPath('no-such-id'), /unknown span id/);
ok('criticalPath rejects unknown rootId');

// Ручной расчёт длиннейшего пути.
const manual = [root, B, B1, B1a];
const manualTotal = 100 + 80 + 60 + 50; // = 290

const cp = criticalPath(root);
assert.ok(Array.isArray(cp));
ok('criticalPath returns array');
assert.strictEqual(cp[0], root);
ok('criticalPath starts at root');
assert.deepStrictEqual(cp, manual);
ok('criticalPath equals manual path [root,B,B1,B1a]');
assert.strictEqual(cp.length, 4);
ok('criticalPath has 4 spans');

const cpTotal = cp.reduce((acc, id) => acc + getSpan(id).duration, 0);
assert.strictEqual(cpTotal, manualTotal);
ok('criticalPath total duration = 290 (manual)');
assert.strictEqual(cpTotal, 290);
ok('critical path total is the maximum');

// Все остальные пути короче.
const altTotals = [175, 190, 150];
assert.ok(altTotals.every((t) => t < cpTotal));
ok('all alternative paths are shorter');

// Критический путь без явного rootId (авто-поиск корня).
const cpAuto = criticalPath();
assert.deepStrictEqual(cpAuto, manual);
ok('criticalPath() auto-detects root and matches');

// Критический путь для поддерева B.
assert.deepStrictEqual(criticalPath(B), [B, B1, B1a]);
ok('criticalPath(B) = [B,B1,B1a]');
assert.deepStrictEqual(criticalPath(C), [C, C1]);
ok('criticalPath(C) = [C,C1]');

/* ------------------------------------------------------------------ *
 * Итог
 * ------------------------------------------------------------------ */
console.log('\n\u2705 distributed_tracing: all ' + passed + ' assertions passed');
