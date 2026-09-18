'use strict';

/**
 * tests/distributed_traces.test.js
 * ---------------------------------------------------------------------------
 * Тесты модуля `distributed_traces.js` (корень репозитория).
 *
 * Покрываемый публичный API:
 *   startSpan(name, parentId[, opts]) -> id
 *   endSpan(id[, opts])               -> span
 *   buildTree(rootId)                 -> Node (вложенное дерево, O(n))
 *   criticalPath(rootId)              -> Node[] (самый долгий путь)
 *
 * Проверяемые гарантии:
 *   • id уникальны, parentId связывает span'ы, неизвестный parentId/id — Error;
 *   • длительности считаются как end - start (детерминированно через opts);
 *   • buildTree строит корректное вложенное дерево из 10 узлов < 5 мс;
 *   • дети отсортированы по start ASC;
 *   • критический путь = цепочка с максимальной СУММОЙ длительностей
 *     и совпадает с ручным расчётом (175/195/115/170/110 -> 195);
 *   • детерминированный tie-break при равной сумме;
 *   • экспортируются ровно {startSpan, endSpan, buildTree, criticalPath}.
 *
 * Запуск:
 *   node tests/runner.js tests/distributed_traces.test.js
 */

const { describe, it, beforeEach, assert } = require('./runner.js');

// ВАЖНО: тестируем именно корневой distributed_traces.js.
const dt = require('../distributed_traces.js');

/* ------------------------------------------------------------------------- *
 * Фикстура: дерево из 10 узлов с детерминированными временами (мс)
 * ------------------------------------------------------------------------- *
 *
 *  root            0 ──────────── 100   (dur 100)
 *   ├─ http        0 ── 40               (dur 40)
 *   │   └─ db.query 0 ── 30              (dur 30)
 *   │       ├─ db.connect 0 ─ 5          (dur 5)
 *   │       └─ db.exec    5 ─ 30         (dur 25)
 *   ├─ cache.get  40 ─ 45                (dur 5)
 *   │   └─ redis   40 ── 50              (dur 10)
 *   ├─ render     50 ──────── 90         (dur 40)
 *   │   └─ template 55 ── 85             (dur 30)
 *   └─ flush      90 ─── 100             (dur 10)
 *
 * Ручной расчёт суммы по цепочкам:
 *   root>http>db.query>db.connect = 100+40+30+5  = 175
 *   root>http>db.query>db.exec    = 100+40+30+25 = 195  <-- КРИТИЧЕСКИЙ
 *   root>cache.get>redis          = 100+5+10     = 115
 *   root>render>template          = 100+40+30    = 170
 *   root>flush                    = 100+10       = 110
 */

function buildFixture() {
  dt.reset();
  const s = (name, parent, start, end) => {
    const id = dt.startSpan(name, parent, { start });
    dt.endSpan(id, { end });
    return id;
  };

  const root = s('root', null, 0, 100);
  const http = s('http', root, 0, 40);
  const dbq = s('db.query', http, 0, 30);
  const dbc = s('db.connect', dbq, 0, 5);
  const dbe = s('db.exec', dbq, 5, 30);
  const cache = s('cache.get', root, 40, 45);
  const redis = s('redis', cache, 40, 50);
  const render = s('render', root, 50, 90);
  const template = s('template', render, 55, 85);
  const flush = s('flush', root, 90, 100);

  return { root, http, dbq, dbc, dbe, cache, redis, render, template, flush };
}

const names = (nodes) => nodes.map((n) => n.name).join('>');
const isSortedByStart = (kids) =>
  kids.every((k, i) => i === 0 || kids[i - 1].start <= k.start);

/* ------------------------------------------------------------------------- *
 * Экспорт
 * ------------------------------------------------------------------------- */

describe('distributed_traces: экспорт API', () => {
  it('экспортирует функции startSpan/endSpan/buildTree/criticalPath', () => {
    assert.strictEqual(typeof dt.startSpan, 'function');
    assert.strictEqual(typeof dt.endSpan, 'function');
    assert.strictEqual(typeof dt.buildTree, 'function');
    assert.strictEqual(typeof dt.criticalPath, 'function');
  });
});

/* ------------------------------------------------------------------------- *
 * startSpan / endSpan
 * ------------------------------------------------------------------------- */

describe('distributed_traces: startSpan/endSpan', () => {
  beforeEach(() => dt.reset());

  it('startSpan возвращает уникальный непустой id', () => {
    const a = dt.startSpan('a', null, { start: 0 });
    const b = dt.startSpan('b', null, { start: 0 });
    assert.strictEqual(typeof a, 'string');
    assert.ok(a.length > 0);
    assert.notEqual(a, b);
  });

  it('endSpan проставляет end и duration = end - start', () => {
    const id = dt.startSpan('x', null, { start: 100 });
    const span = dt.endSpan(id, { end: 175 });
    assert.strictEqual(span.id, id);
    assert.strictEqual(span.start, 100);
    assert.strictEqual(span.end, 175);
    assert.strictEqual(dt.durationOf(span, 0), 75);
  });

  it('startSpan с неизвестным parentId бросает Error', () => {
    assert.throws(() => dt.startSpan('orphan', 'nope', { start: 0 }));
  });

  it('startSpan с пустым именем бросает Error', () => {
    assert.throws(() => dt.startSpan('', null, { start: 0 }));
  });

  it('endSpan с неизвестным id бросает Error', () => {
    assert.throws(() => dt.endSpan('nope', { end: 1 }));
  });

  it('endSpan(end < start) бросает Error', () => {
    const id = dt.startSpan('back', null, { start: 50 });
    assert.throws(() => dt.endSpan(id, { end: 10 }));
  });

  it('getSpan возвращает сохранённый span', () => {
    const id = dt.startSpan('g', null, { start: 5 });
    assert.ok(dt.getSpan(id));
    assert.strictEqual(dt.getSpan(id).name, 'g');
    assert.strictEqual(dt.getSpan('missing'), null);
  });
});

/* ------------------------------------------------------------------------- *
 * buildTree
 * ------------------------------------------------------------------------- */

describe('distributed_traces: buildTree', () => {
  let f;
  beforeEach(() => {
    f = buildFixture();
  });

  it('корень найден, а неизвестный rootId бросает Error', () => {
    assert.strictEqual(dt.buildTree(f.root).name, 'root');
    assert.throws(() => dt.buildTree('nope'));
  });

  it('корень имеет ровно 4 прямых ребёнка', () => {
    const t = dt.buildTree(f.root);
    assert.strictEqual(t.children.length, 4);
  });

  it('дети корня отсортированы по start ASC (http,cache.get,render,flush)', () => {
    const t = dt.buildTree(f.root);
    assert.deepStrictEqual(
      t.children.map((c) => c.name),
      ['http', 'cache.get', 'render', 'flush']
    );
    assert.ok(isSortedByStart(t.children));
  });

  it('глубина вложенности: root>http>db.query>db.exec', () => {
    const t = dt.buildTree(f.root);
    const http = t.children.find((c) => c.name === 'http');
    const dbq = http.children.find((c) => c.name === 'db.query');
    const exec = dbq.children.find((c) => c.name === 'db.exec');
    assert.ok(http && dbq && exec);
    assert.strictEqual(exec.name, 'db.exec');
    assert.strictEqual(exec.parentId, f.dbq);
  });

  it('db.query имеет двух детей, отсортированных по start (connect,exec)', () => {
    const t = dt.buildTree(f.root);
    const dbq = t.children.find((c) => c.name === 'http').children
      .find((c) => c.name === 'db.query');
    assert.strictEqual(dbq.children.length, 2);
    assert.deepStrictEqual(dbq.children.map((c) => c.name), ['db.connect', 'db.exec']);
  });

  it('duration каждого узла совпадает с ручным расчётом', () => {
    const t = dt.buildTree(f.root);
    assert.strictEqual(t.duration, 100);
    const http = t.children.find((c) => c.name === 'http');
    assert.strictEqual(http.duration, 40);
    const render = t.children.find((c) => c.name === 'render');
    assert.strictEqual(render.duration, 40);
    assert.strictEqual(render.children[0].duration, 30);
  });

  it('buildTree строит дерево из 10 узлов < 5 мс', () => {
    const countNodes = (n) => 1 + n.children.reduce((acc, c) => acc + countNodes(c), 0);
    assert.strictEqual(countNodes(dt.buildTree(f.root)), 10);

    const t0 = process.hrtime.bigint();
    const tree = dt.buildTree(f.root);
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    assert.ok(ms < 5, `buildTree из 10 узлов занял ${ms.toFixed(3)} мс (лимит 5)`);
    assert.strictEqual(tree.children.length, 4);
  });
});

/* ------------------------------------------------------------------------- *
 * criticalPath
 * ------------------------------------------------------------------------- */

describe('distributed_traces: criticalPath', () => {
  let f;
  beforeEach(() => {
    f = buildFixture();
  });

  it('критический путь совпадает с ручным расчётом (root>http>db.query>db.exec)', () => {
    const cp = dt.criticalPath(f.root);
    assert.deepStrictEqual(
      cp.map((n) => n.name),
      ['root', 'http', 'db.query', 'db.exec']
    );
    assert.strictEqual(names(cp), 'root>http>db.query>db.exec');
  });

  it('сумма длительностей критического пути = 195', () => {
    const cp = dt.criticalPath(f.root);
    const sum = cp.reduce((acc, n) => acc + n.duration, 0);
    assert.strictEqual(sum, 195);
  });

  it('критический путь длиннее каждой альтернативы', () => {
    const cp = dt.criticalPath(f.root);
    const sum = cp.reduce((acc, n) => acc + n.duration, 0);
    const t = dt.buildTree(f.root);
    const render = t.children.find((c) => c.name === 'render');
    const renderSum = 100 + render.duration + render.children[0].duration; // 170
    const redis = t.children.find((c) => c.name === 'cache.get');
    const redisSum = 100 + redis.duration + redis.children[0].duration; // 115
    assert.ok(sum > renderSum);
    assert.ok(sum > redisSum);
    assert.strictEqual(renderSum, 170);
    assert.strictEqual(redisSum, 115);
  });

  it('путь начинается в корне и заканчивается листом', () => {
    const cp = dt.criticalPath(f.root);
    assert.strictEqual(cp[0].id, f.root);
    assert.strictEqual(cp[cp.length - 1].children.length, 0);
  });

  it('неизвестный rootId бросает Error', () => {
    assert.throws(() => dt.criticalPath('nope'));
  });

  it('дерево из одного узла: путь = [root]', () => {
    dt.reset();
    const r = dt.startSpan('solo', null, { start: 0 });
    dt.endSpan(r, { end: 7 });
    const cp = dt.criticalPath(r);
    assert.strictEqual(cp.length, 1);
    assert.strictEqual(cp[0].name, 'solo');
    assert.strictEqual(cp[0].duration, 7);
  });

  it('tie-break при равной сумме детерминирован (короче имена)', () => {
    dt.reset();
    const root = dt.startSpan('root', null, { start: 0 });
    dt.endSpan(root, { end: 100 });
    // aa и bb — одинаковая длительность (10). Ожидаем 'aa' (лексикографически меньше).
    const aa = dt.startSpan('aa', root, { start: 0 });
    dt.endSpan(aa, { end: 10 });
    const bb = dt.startSpan('bb', root, { start: 10 });
    dt.endSpan(bb, { end: 20 });
    const cp = dt.criticalPath(root);
    assert.deepStrictEqual(cp.map((n) => n.name), ['root', 'aa']);
    // повторный вызов даёт тот же результат (детерминизм)
    assert.deepStrictEqual(
      dt.criticalPath(root).map((n) => n.name),
      ['root', 'aa']
    );
  });

  it('при равной сумме выбирается более длинная цепочка', () => {
    dt.reset();
    const root = dt.startSpan('root', null, { start: 0 });
    dt.endSpan(root, { end: 100 });
    // Мелкая ветка: один span длиной 20.
    const short = dt.startSpan('short', root, { start: 0 });
    dt.endSpan(short, { end: 20 });
    // Глубокая ветка: два span'а по 10 -> сумма 20, но узлов больше.
    const deep = dt.startSpan('deep', root, { start: 20 });
    dt.endSpan(deep, { end: 30 });
    const leaf = dt.startSpan('leaf', deep, { start: 20 });
    dt.endSpan(leaf, { end: 30 });
    const cp = dt.criticalPath(root);
    assert.deepStrictEqual(cp.map((n) => n.name), ['root', 'deep', 'leaf']);
    assert.strictEqual(cp.length, 3);
  });
});
