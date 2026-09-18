'use strict';

/**
 * distributed_traces.js — распределённые трейсы (span tree + critical path)
 * ===========================================================================
 * Минималистичный, детерминированный и O(n) модуль для построения дерева
 * трейсов и поиска критического пути (цепочки span'ов с максимальной суммой
 * длительностей — классическая интерпретация critical path в трейсинге).
 *
 * Публичный API
 * ---------------------------------------------------------------------------
 *   startSpan(name, parentId[, opts]) -> id
 *   endSpan(id[, opts])               -> span
 *   buildTree(rootId)                 -> Node
 *   criticalPath(rootId)              -> Array<Node>   // самый долгий путь
 *
 *   // вспомогательное (для тестов / отладки)
 *   getSpan(id) -> span | null
 *   spans()     -> Array<span>
 *   reset()     -> void
 *
 * Span = { id, name, parentId, start, end, }
 * Node = { id, name, parentId, start, end, duration, children: Node[] }
 *
 * Гарантии
 * ---------------------------------------------------------------------------
 *   • startSpan с неизвестным parentId — бросает Error (не молчит).
 *   • endSpan с неизвестным id — бросает Error.
 *   • endSpan(id, { end }) допускает детерминированное время в тестах.
 *   • startSpan(name, parentId, { start }) фиксирует начало явно.
 *   • buildTree(rootId) строит ТОЛЬКО достижимое из root поддерево, O(n).
 *   • criticalPath — детерминирован: при равной сумме выбирается цепочка
 *     длиннее, затем лексикографически меньшая по именам (устойчивый tie-break).
 *   • Дети сортируются по start ASC (при равенстве — по id ASC).
 *
 * CLI / self-check
 * ---------------------------------------------------------------------------
 *   node distributed_traces.js --selftest
 *
 * export { startSpan, endSpan, buildTree, criticalPath };
 * (в CommonJS это module.exports = { ... } — см. конец файла)
 */

/* ------------------------------------------------------------------------- *
 * Хранилище
 * ------------------------------------------------------------------------- */

/** @type {Map<string, {id:string,name:string,parentId:string|null,start:number,end:number|null}>} */
const spans = new Map();

let counter = 0;

/** Текущее время (мс). Переопределяемо через opts.start / opts.end. */
function now() {
  return Date.now();
}

/** Генерация уникального id (детерминированный префикс + случайный хвост). */
function nextId() {
  counter += 1;
  return (
    'span_' +
    counter.toString(36) +
    '_' +
    Math.random().toString(36).slice(2, 8)
  );
}

/* ------------------------------------------------------------------------- *
 * Публичный API
 * ------------------------------------------------------------------------- */

/**
 * Начать новый span.
 *
 * @param {string} name       Непустое имя span'а.
 * @param {string|null} parentId  id родителя либо null/undefined для корня.
 * @param {{start?:number, id?:string}} [opts]
 * @returns {string} id созданного span'а.
 */
function startSpan(name, parentId, opts) {
  opts = opts || {};
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('startSpan: name must be a non-empty string');
  }
  if (parentId !== undefined && parentId !== null) {
    if (typeof parentId !== 'string' || !spans.has(parentId)) {
      throw new Error('startSpan: unknown parentId: ' + String(parentId));
    }
  }
  const id = opts.id !== undefined ? opts.id : nextId();
  if (spans.has(id)) {
    throw new Error('startSpan: duplicate id: ' + id);
  }
  const start = opts.start !== undefined ? opts.start : now();
  spans.set(id, {
    id,
    name,
    parentId: parentId === undefined || parentId === null ? null : parentId,
    start,
    end: null,
  });
  return id;
}

/**
 * Завершить span.
 *
 * @param {string} id
 * @param {{end?:number}} [opts]
 * @returns {object} сам span
 */
function endSpan(id, opts) {
  opts = opts || {};
  const span = spans.get(id);
  if (!span) {
    throw new Error('endSpan: unknown id: ' + String(id));
  }
  const end = opts.end !== undefined ? opts.end : now();
  if (end < span.start) {
    throw new Error('endSpan: end (' + end + ') < start (' + span.start + ')');
  }
  span.end = end;
  return span;
}

/** Длительность span'а (для незакрытого — до refNow). */
function durationOf(span, refNow) {
  const end = span.end !== null ? span.end : refNow;
  return end - span.start;
}

/**
 * Построить дерево трейсов от корня rootId.
 *
 * @param {string} rootId
 * @returns {{id:string,name:string,parentId:string|null,start:number,end:number|null,duration:number,children:Array}}
 */
function buildTree(rootId) {
  const root = spans.get(rootId);
  if (!root) {
    throw new Error('buildTree: unknown rootId: ' + String(rootId));
  }

  // adjacency: parentId -> children[]
  const childrenOf = new Map();
  for (const s of spans.values()) {
    if (s.parentId === null) continue;
    let arr = childrenOf.get(s.parentId);
    if (!arr) {
      arr = [];
      childrenOf.set(s.parentId, arr);
    }
    arr.push(s);
  }

  const refNow = now();
  const visiting = new Set();

  function make(span) {
    if (visiting.has(span.id)) {
      throw new Error('buildTree: cycle detected at ' + span.id);
    }
    visiting.add(span.id);
    const kids = (childrenOf.get(span.id) || [])
      .slice()
      .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const node = {
      id: span.id,
      name: span.name,
      parentId: span.parentId,
      start: span.start,
      end: span.end,
      duration: durationOf(span, refNow),
      children: kids.map(make),
    };
    visiting.delete(span.id);
    return node;
  }

  return make(root);
}

/** Сумма длительностей цепочки узлов. */
function chainDuration(chain) {
  let sum = 0;
  for (const n of chain) sum += n.duration;
  return sum;
}

/**
 * Упорядочивание цепочек: длиннее сумма — лучше; при равенстве — больше
 * узлов; затем лексикографически меньше имена.
 */
function chainBetter(a, b) {
  const da = chainDuration(a);
  const db = chainDuration(b);
  if (da !== db) return da > db;
  if (a.length !== b.length) return a.length > b.length;
  const ka = a.map((n) => n.name).join('/');
  const kb = b.map((n) => n.name).join('/');
  return ka < kb;
}

/**
 * Критический путь — цепочка от корня к листу с максимальной суммой
 * длительностей span'ов. Возвращает массив узлов (Node[]).
 *
 * @param {string} rootId
 * @returns {Array<object>}
 */
function criticalPath(rootId) {
  const tree = buildTree(rootId);

  function walk(node, path) {
    const cur = path.concat(node);
    if (node.children.length === 0) return cur;
    let best = null;
    for (const child of node.children) {
      const cand = walk(child, cur);
      if (best === null || chainBetter(cand, best)) best = cand;
    }
    return best;
  }

  return walk(tree, []);
}

/* ------------------------------------------------------------------------- *
 * Помощники / отладка
 * ------------------------------------------------------------------------- */

function getSpan(id) {
  return spans.get(id) || null;
}

function spansList() {
  return Array.from(spans.values());
}

function reset() {
  spans.clear();
  counter = 0;
}

/* ------------------------------------------------------------------------- *
 * Self-test (быстрый smoke без тест-раннера)
 * ------------------------------------------------------------------------- */

function selfTest() {
  reset();
  const root = startSpan('root', null, { start: 0 });
  const a = startSpan('a', root, { start: 0 });
  endSpan(a, { end: 10 });
  const b = startSpan('b', root, { start: 10 });
  endSpan(b, { end: 50 });
  const c = startSpan('c', b, { start: 10 });
  endSpan(c, { end: 45 });
  const cp = criticalPath(root);
  const names = cp.map((n) => n.name).join('>');
  if (names !== 'root>b>c') {
    throw new Error('selfTest failed: got ' + names);
  }
  const tree = buildTree(root);
  if (tree.children.length !== 2) {
    throw new Error('selfTest failed: children=' + tree.children.length);
  }
  return true;
}

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */

if (require.main === module) {
  try {
    if (process.argv.includes('--selftest')) {
      selfTest();
      process.stdout.write('[distributed_traces] selftest OK\n');
    } else {
      process.stdout.write('[distributed_traces] usage: node distributed_traces.js --selftest\n');
    }
  } catch (err) {
    process.stderr.write('[distributed_traces] error: ' + (err && err.message) + '\n');
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------------- *
 * Экспорт
 * ------------------------------------------------------------------------- */

module.exports = {
  startSpan,
  endSpan,
  buildTree,
  criticalPath,
  // вспомогательное
  getSpan,
  spans: spansList,
  reset,
  selfTest,
  durationOf,
};

module.exports.default = module.exports;
