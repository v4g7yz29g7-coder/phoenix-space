'use strict';

/**
 * observability/distributed_tracing.js
 * ---------------------------------------------------------------------------
 * Минимальный модуль распределённых трейсов (distributed tracing).
 *
 * Модель:
 *   - трейс — это лес span'ов; каждый span имеет id, name, parentId,
 *     startTime, endTime и duration (endTime - startTime);
 *   - startSpan(name, parentId?, at?)    -> id   создаёт span;
 *   - endSpan(id, at?)                   -> span завершает span;
 *   - buildTree(rootId)                  -> {id,name,...,children[]}
 *                                            рекурсивное дерево span'ов;
 *   - criticalPath(rootId?)              -> [id, id, ...]
 *                                            КРИТИЧЕСКИЙ ПУТЬ — путь
 *                                            root -> ... -> leaf с максимальной
 *                                            суммой duration (самый "долгий").
 *
 * Правило критического пути:
 *   cost(path) = Σ duration(span) для всех span вдоль пути от корня до листа.
 *   Выбирается путь с максимальным cost. При равенстве — более длинный путь,
 *   затем путь с более ранним стартовым временем (детерминизм).
 *
 * Примечание: продолжительности задаются логически (через `at`), поэтому
 * сумму duration вдоль пути можно посчитать вручную — это и проверяется тестом.
 *
 * Публичный API (именованные экспорты):
 *   startSpan(name, parentId = null, at = Date.now()) -> string
 *   endSpan(id, at = Date.now())                      -> span
 *   buildTree(rootId)                                 -> tree node
 *   criticalPath(rootId?)                             -> string[]
 *
 * Дополнительно:
 *   getSpan(id)  -> span|null
 *   clear()      -> void  (сброс состояния, удобно для тестов)
 *
 * Зависимостей нет (только Node built-ins).
 *
 * @module observability/distributed_tracing
 */

/* ------------------------------------------------------------------------- *
 * Внутреннее состояние
 * ------------------------------------------------------------------------- */

/** @type {Map<string, object>} */
const _spans = new Map();
let _counter = 0;

const _now = () => Date.now();

function _genId() {
  _counter += 1;
  return 'sp-' + _counter.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function _durationOf(span) {
  return span.duration == null ? 0 : span.duration;
}

/* ------------------------------------------------------------------------- *
 * startSpan / endSpan
 * ------------------------------------------------------------------------- */

/**
 * Создать новый span.
 * @param {string} name        имя операции (не пустая строка)
 * @param {string|null} [parentId] id родителя (должен существовать)
 * @param {number} [at]        стартовое время (по умолчанию Date.now())
 * @returns {string} id созданного span'а
 */
function startSpan(name, parentId = null, at = _now()) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('startSpan: name must be a non-empty string');
  }
  if (parentId != null && !_spans.has(parentId)) {
    throw new Error('startSpan: unknown parentId "' + parentId + '"');
  }
  if (typeof at !== 'number' || Number.isNaN(at)) {
    throw new TypeError('startSpan: `at` must be a number');
  }

  const id = _genId();
  const span = {
    id,
    name,
    parentId: parentId == null ? null : parentId,
    startTime: at,
    endTime: null,
    duration: null,
    children: [],
  };
  _spans.set(id, span);
  if (parentId != null) _spans.get(parentId).children.push(id);
  return id;
}

/**
 * Завершить span: выставить endTime и duration.
 * @param {string} id
 * @param {number} [at] время завершения (по умолчанию Date.now())
 * @returns {object} завершённый span
 */
function endSpan(id, at = _now()) {
  const span = _spans.get(id);
  if (!span) throw new Error('endSpan: unknown span id "' + id + '"');
  if (span.endTime != null) throw new Error('endSpan: span "' + id + '" already ended');
  if (typeof at !== 'number' || Number.isNaN(at)) {
    throw new TypeError('endSpan: `at` must be a number');
  }
  if (at < span.startTime) {
    throw new Error('endSpan: end time before start time for span "' + id + '"');
  }
  span.endTime = at;
  span.duration = at - span.startTime;
  return span;
}

/* ------------------------------------------------------------------------- *
 * buildTree
 * ------------------------------------------------------------------------- */

function _sortedChildren(span) {
  return span.children
    .map((cid) => _spans.get(cid))
    .sort((a, b) => a.startTime - b.startTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Построить рекурсивное дерево span'ов от rootId.
 * Дети сортируются по startTime.
 * @param {string} rootId
 * @returns {object} узел дерева
 */
function buildTree(rootId) {
  if (!_spans.has(rootId)) {
    throw new Error('buildTree: unknown span id "' + rootId + '"');
  }
  const build = (id) => {
    const s = _spans.get(id);
    return {
      id: s.id,
      name: s.name,
      parentId: s.parentId,
      startTime: s.startTime,
      endTime: s.endTime,
      duration: s.duration,
      children: _sortedChildren(s).map((c) => build(c.id)),
    };
  };
  return build(rootId);
}

/* ------------------------------------------------------------------------- *
 * criticalPath
 * ------------------------------------------------------------------------- */

function _cmpPath(a, b) {
  // больше сумма -> лучше
  if (a.total !== b.total) return a.total - b.total;
  // при равенстве — более длинный путь
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  // затем более ранний старт первого span'а
  return _spans.get(a.path[0]).startTime - _spans.get(b.path[0]).startTime;
}

function _longestPath(id) {
  const s = _spans.get(id);
  const self = _durationOf(s);
  let bestChild = null;
  for (const cid of s.children) {
    const cp = _longestPath(cid);
    if (bestChild == null || _cmpPath(cp, bestChild) > 0) bestChild = cp;
  }
  if (bestChild == null) return { path: [id], total: self };
  return { path: [id].concat(bestChild.path), total: self + bestChild.total };
}

/**
 * Критический путь — самый долгий путь root -> leaf по сумме duration.
 * @param {string} [rootId] если не задан — берётся корень леса (parentId === null)
 * @returns {string[]} массив id span'ов вдоль критического пути
 */
function criticalPath(rootId) {
  let roots;
  if (rootId != null) {
    if (!_spans.has(rootId)) {
      throw new Error('criticalPath: unknown span id "' + rootId + '"');
    }
    roots = [rootId];
  } else {
    roots = [..._spans.values()]
      .filter((s) => s.parentId == null)
      .map((s) => s.id);
    if (roots.length === 0) {
      if (_spans.size === 0) throw new Error('criticalPath: no spans');
      roots = [_spans.keys().next().value];
    }
  }

  let best = null;
  for (const r of roots) {
    const p = _longestPath(r);
    if (best == null || _cmpPath(p, best) > 0) best = p;
  }
  return best.path;
}

/* ------------------------------------------------------------------------- *
 * Утилиты
 * ------------------------------------------------------------------------- */

/** @returns {object|null} */
function getSpan(id) {
  return _spans.get(id) || null;
}

/** Полный сброс состояния. */
function clear() {
  _spans.clear();
  _counter = 0;
}

module.exports = {
  startSpan,
  endSpan,
  buildTree,
  criticalPath,
  getSpan,
  clear,
};
