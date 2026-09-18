'use strict';

/**
 * evolution/dendrologist_genealogy.js
 * ───────────────────────────────────────────────────────────────────────────
 * Генеалогическое древо агентов Phoenix / Aeon.
 *
 * Дендрологическая метафора: каждый агент — узел дерева. Связи «родитель →
 * потомок» описывают эволюционные поколения (клонирование, скрещивание,
 * мутации, ветвление). Лес — множество независимых корней (геномов-основателей).
 *
 * Узел поддерживает несколько родителей (как при половом размножении), поэтому
 * формально это ориентированный ациклический граф (DAG), а «древо» — его
 * деревообразующая проекция по выбранному корню.
 *
 * Публичный API:
 *   ancestors(id, [opts])   -> Array<{ id, depth }>   предки вверх по родителям
 *   descendants(id, [opts]) -> Array<{ id, depth }>   потомки вниз по детям
 *   tree(id, [opts])        -> вложенное дерево { id, generation, children:[...] }
 *
 * Дополнительно: registerAgent, link, roots, leaves, lineage, depth,
 * generation, commonAncestor, relatedness, subtreeSize, ascii, toDot,
 * report, clear, seedGenesis, listAgents, getNode.
 *
 * Автор: evolution / aeon
 */

// ───────────────────────────────────────────────────────────────────────────
// ХРАНИЛИЩЕ УЗЛОВ
// ───────────────────────────────────────────────────────────────────────────

/** id -> узел { id, label, parents:Set, children:Set, born, fitness, traits } */
const NODES = new Map();

/** Счётчик монотонного времени рождения, чтобы seed был детерминированным. */
let CLOCK = 0;

/** Привести идентификатор к строке. */
function normalizeId(id) {
  if (id === null || id === undefined) {
    throw new TypeError('genealogy: id обязателен');
  }
  return String(id);
}

/** Получить узел или null. */
function getNode(id) {
  return NODES.get(normalizeId(id)) || null;
}

/** Создать узел, если его ещё нет. Возвращает узел. */
function ensureNode(id, spec) {
  const key = normalizeId(id);
  let node = NODES.get(key);
  if (!node) {
    node = {
      id: key,
      label: (spec && spec.label) || key,
      parents: new Set(),
      children: new Set(),
      born: ++CLOCK,
      fitness: spec && Number.isFinite(spec.fitness) ? spec.fitness : 0.5,
      traits: (spec && spec.traits) || {},
    };
    NODES.set(key, node);
  } else if (spec) {
    if (spec.label) node.label = spec.label;
    if (Number.isFinite(spec.fitness)) node.fitness = spec.fitness;
    if (spec.traits) node.traits = Object.assign({}, node.traits, spec.traits);
  }
  return node;
}

/**
 * Зарегистрировать агента.
 * @param {string} id
 * @param {{label?:string, fitness?:number, traits?:object, parents?:string[]}} [spec]
 */
function registerAgent(id, spec) {
  const node = ensureNode(id, spec);
  if (spec && Array.isArray(spec.parents)) {
    for (const p of spec.parents) link(p, node.id);
  }
  return node;
}

/** Список всех id (в порядке рождения). */
function listAgents() {
  return Array.from(NODES.values())
    .sort((a, b) => a.born - b.born)
    .map((n) => n.id);
}

// ───────────────────────────────────────────────────────────────────────────
// СВЯЗИ
// ───────────────────────────────────────────────────────────────────────────

/** Связать родителя и потомка. Циклы запрещены (DAG). */
function link(parentId, childId) {
  const p = ensureNode(parentId);
  const c = ensureNode(childId);
  if (p.id === c.id) {
    throw new Error(`genealogy: агент "${p.id}" не может быть своим родителем`);
  }
  if (p.born > c.born) {
    // Родитель должен быть старше; пере-штампуем время рождения потомка.
    c.born = ++CLOCK;
  }
  p.children.add(c.id);
  c.parents.add(p.id);
  return { parent: p.id, child: c.id };
}

/** Корни леса — узлы без родителей. */
function roots() {
  return Array.from(NODES.values())
    .filter((n) => n.parents.size === 0)
    .sort((a, b) => a.born - b.born)
    .map((n) => n.id);
}

/** Листья — узлы без детей. */
function leaves() {
  return Array.from(NODES.values())
    .filter((n) => n.children.size === 0)
    .sort((a, b) => a.born - b.born)
    .map((n) => n.id);
}

// ───────────────────────────────────────────────────────────────────────────
// ОБХОД ВВЕРХ: ПРЕДКИ
// ───────────────────────────────────────────────────────────────────────────

/**
 * Предки узла вверх по родительским связям.
 * opts: { depth?:number(Infinity), includeSelf?:boolean, order?:'bfs'|'dfs'|'gen' }
 */
function ancestors(id, opts) {
  const cfg = Object.assign({ depth: Infinity, includeSelf: false, order: 'bfs' }, opts || {});
  const start = ensureNode(id);
  const seen = new Map(); // id -> минимальная глубина
  if (cfg.includeSelf) seen.set(start.id, 0);

  let frontier = [start.id];
  let d = 0;
  while (frontier.length && d < cfg.depth) {
    d += 1;
    const next = [];
    for (const cur of frontier) {
      const node = NODES.get(cur);
      if (!node) continue;
      for (const pid of node.parents) {
        if (!seen.has(pid) || seen.get(pid) > d) seen.set(pid, d);
        next.push(pid);
      }
    }
    frontier = next;
  }

  let out = Array.from(seen.entries()).map(([nid, depth]) => ({ id: nid, depth }));
  if (cfg.order === 'gen') {
    out.sort((a, b) => b.depth - a.depth || a.id.localeCompare(b.id));
  } else if (cfg.order === 'dfs') {
    out = dfsAncestors(start.id, cfg.depth, cfg.includeSelf);
  } else {
    out.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  }
  return out;
}

/** DFS-вариант обхода предков (порядок по ветвям). */
function dfsAncestors(rootId, maxDepth, includeSelf) {
  const out = [];
  const seen = new Set();
  const stack = [{ id: rootId, depth: 0 }];
  if (includeSelf) {
    out.push({ id: rootId, depth: 0 });
    seen.add(rootId);
  }
  while (stack.length) {
    const { id, depth } = stack.pop();
    const node = NODES.get(id);
    if (!node) continue;
    if (depth >= maxDepth) continue;
    const parents = Array.from(node.parents).sort();
    for (const pid of parents) {
      if (!seen.has(pid)) {
        seen.add(pid);
        out.push({ id: pid, depth: depth + 1 });
        stack.push({ id: pid, depth: depth + 1 });
      }
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// ОБХОД ВНИЗ: ПОТОМКИ
// ───────────────────────────────────────────────────────────────────────────

/**
 * Потомки узла вниз по дочерним связям.
 * opts: { depth?:number(Infinity), includeSelf?:boolean }
 */
function descendants(id, opts) {
  const cfg = Object.assign({ depth: Infinity, includeSelf: false }, opts || {});
  const start = ensureNode(id);
  const out = [];
  const seen = new Set();
  if (cfg.includeSelf) {
    seen.add(start.id);
    out.push({ id: start.id, depth: 0 });
  }
  let frontier = [start.id];
  let d = 0;
  while (frontier.length && d < cfg.depth) {
    d += 1;
    const next = [];
    for (const cur of frontier) {
      const node = NODES.get(cur);
      if (!node) continue;
      for (const cid of node.children) {
        if (seen.has(cid)) continue;
        seen.add(cid);
        out.push({ id: cid, depth: d });
        next.push(cid);
      }
    }
    frontier = next;
  }
  return out;
}

/** Количество потомков узла (без него самого). */
function subtreeSize(id) {
  return descendants(id).length;
}

// ───────────────────────────────────────────────────────────────────────────
// ГЛУБИНА И ПОКОЛЕНИЕ
// ───────────────────────────────────────────────────────────────────────────

/** Глубина узла от ближайшего корня (корень = 0). */
function depth(id) {
  const anc = ancestors(id, { includeSelf: false });
  if (anc.length === 0) return 0;
  return Math.max.apply(null, anc.map((a) => a.depth));
}

/** Поколение = глубина + 1 (корень в 1-м поколении). */
function generation(id) {
  return depth(id) + 1;
}

// ───────────────────────────────────────────────────────────────────────────
// ПОСТРОЕНИЕ ДЕРЕВА
// ───────────────────────────────────────────────────────────────────────────

/**
 * Вложенное дерево от узла id вниз.
 * Без id — лес от всех корней.
 * opts: { maxDepth?:number, withMeta?:boolean }
 */
function tree(id, opts) {
  const cfg = Object.assign({ maxDepth: Infinity, withMeta: false }, opts || {});
  if (id === undefined || id === null) {
    const rs = roots();
    return { id: '__forest__', generation: 0, children: rs.map((r) => buildTree(r, cfg)) };
  }
  const root = ensureNode(id);
  return buildTree(root.id, cfg);
}

function buildTree(nodeId, cfg) {
  const node = NODES.get(nodeId);
  const label = cfg.withMeta
    ? { id: node.id, label: node.label, fitness: node.fitness, generation: generation(node.id) }
    : { id: node.id };
  const children = Array.from(node.children)
    .sort((a, b) => (NODES.get(a).born - NODES.get(b).born))
    .map((cid) => buildTree(cid, Object.assign({}, cfg, { maxDepth: cfg.maxDepth - 1 })));

  const out = { id: label.id };
  if (cfg.withMeta) {
    out.label = label.label;
    out.fitness = label.fitness;
    out.generation = label.generation;
  }
  if (cfg.maxDepth > 0 && children.length) out.children = children;
  else out.children = [];
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// РОДСТВО
// ───────────────────────────────────────────────────────────────────────────

/** Путь от узла до указанного корня (или ближайшего) — массив id. */
function lineage(id, upToRootId) {
  const startId = normalizeId(id);
  const path = [startId];
  let cur = NODES.get(startId);
  const guard = new Set([startId]);
  while (cur && cur.parents.size) {
    let nextId = null;
    if (upToRootId) {
      const target = normalizeId(upToRootId);
      if (cur.parents.has(target)) return path.concat([target]);
      for (const p of cur.parents) {
        if (guard.has(p)) continue;
        nextId = p;
        break;
      }
    } else {
      for (const p of cur.parents) {
        if (!guard.has(p)) { nextId = p; break; }
      }
    }
    if (!nextId) break;
    guard.add(nextId);
    path.push(nextId);
    cur = NODES.get(nextId);
  }
  return path;
}

/** Множество всех предков узла, включая сам узел. */
function ancestorSet(id) {
  const set = new Set([normalizeId(id)]);
  for (const a of ancestors(id)) set.add(a.id);
  return set;
}

/** Ближайший общий предок (по максимальной глубине от корня). */
function commonAncestor(a, b) {
  const A = ancestorSet(a);
  const B = ancestorSet(b);
  let best = null;
  let bestDepth = -1;
  for (const id of A) {
    if (!B.has(id)) continue;
    const d = depth(id);
    if (d > bestDepth) { bestDepth = d; best = id; }
  }
  return best;
}

/**
 * Коэффициент родства в [0,1]: доля общих предков относительно объёма
 * родословных. 1 — тот же узел, 0 — общих предков нет.
 */
function relatedness(a, b) {
  const ida = normalizeId(a);
  const idb = normalizeId(b);
  if (ida === idb) return 1;
  const A = ancestorSet(ida);
  const B = ancestorSet(idb);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : +(inter / union).toFixed(4);
}

// ───────────────────────────────────────────────────────────────────────────
// ВИЗУАЛИЗАЦИЯ
// ───────────────────────────────────────────────────────────────────────────

/** ASCII-представление дерева от узла. */
function ascii(id, opts) {
  const cfg = Object.assign({ maxDepth: 6 }, opts || {});
  const rootId = id === undefined || id === null ? roots()[0] : normalizeId(id);
  if (!rootId) return '(пустой лес)';
  const lines = [];
  walkAscii(rootId, '', true, 0, cfg.maxDepth, lines);
  return lines.join('\n');
}

function walkAscii(nodeId, prefix, isLast, level, maxDepth, lines) {
  const node = NODES.get(nodeId);
  if (!node) return;
  const connector = level === 0 ? '' : (isLast ? '└─ ' : '├─ ');
  lines.push(prefix + connector + node.id);
  if (level >= maxDepth) return;
  const kids = Array.from(node.children).sort();
  kids.forEach((cid, i) => {
    const last = i === kids.length - 1;
    const childPrefix = level === 0 ? '' : prefix + (isLast ? '   ' : '│  ');
    walkAscii(cid, childPrefix, last, level + 1, maxDepth, lines);
  });
}

/** Экспорт в Graphviz DOT. */
function toDot() {
  const lines = ['digraph genealogy {', '  rankdir=TB;'];
  for (const node of NODES.values()) {
    lines.push(`  "${node.id}" [label="${node.label}\\ng${generation(node.id)}"];`);
    for (const cid of node.children) {
      lines.push(`  "${node.id}" -> "${cid}";`);
    }
  }
  lines.push('}');
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// ОТЧЁТ
// ───────────────────────────────────────────────────────────────────────────

function report() {
  const ids = listAgents();
  const byGen = {};
  for (const id of ids) {
    const g = generation(id);
    byGen[g] = (byGen[g] || 0) + 1;
  }
  const maxDepth = ids.reduce((m, id) => Math.max(m, depth(id)), 0);
  const avgFit = ids.length
    ? +(ids.reduce((s, id) => s + NODES.get(id).fitness, 0) / ids.length).toFixed(3)
    : 0;
  return {
    nodes: ids.length,
    roots: roots(),
    leaves: leaves(),
    maxGeneration: maxDepth + 1,
    byGeneration: byGen,
    avgFitness: avgFit,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// СБРОС И ДЕМО-ЛЕС
// ───────────────────────────────────────────────────────────────────────────

function clear() {
  NODES.clear();
  CLOCK = 0;
}

/** Посадить базовый лес основателей для демонстрации. */
function seedGenesis() {
  clear();
  registerAgent('aeon', { label: 'Aeon', fitness: 0.7, traits: { core: true } });
  registerAgent('phoenix', { label: 'Phoenix', fitness: 0.65, traits: { core: true } });

  registerAgent('aeon_scout', { label: 'Aeon-Scout', fitness: 0.72, parents: ['aeon'] });
  registerAgent('aeon_sage', { label: 'Aeon-Sage', fitness: 0.8, parents: ['aeon'] });
  registerAgent('phoenix_ember', { label: 'Phoenix-Ember', fitness: 0.6, parents: ['phoenix'] });

  // Скрещивание двух линий — узел с двумя родителями.
  registerAgent('hybrid_a', { label: 'Hybrid-A', fitness: 0.85, parents: ['aeon_sage', 'phoenix_ember'] });
  registerAgent('hybrid_b', { label: 'Hybrid-B', fitness: 0.78, parents: ['aeon_scout', 'hybrid_a'] });
  registerAgent('mutant_x', { label: 'Mutant-X', fitness: 0.9, parents: ['hybrid_a'] });
  registerAgent('mutant_y', { label: 'Mutant-Y', fitness: 0.55, parents: ['hybrid_a'] });
  return report();
}

// ───────────────────────────────────────────────────────────────────────────
// ДЕМО
// ───────────────────────────────────────────────────────────────────────────

function main() {
  console.log('== dendrologist_genealogy demo ==');
  seedGenesis();
  console.log(JSON.stringify(report(), null, 2));
  console.log('\n-- ancestors(hybrid_b) --');
  console.log(JSON.stringify(ancestors('hybrid_b'), null, 2));
  console.log('\n-- descendants(aeon) --');
  console.log(JSON.stringify(descendants('aeon'), null, 2));
  console.log('\n-- tree(aeon) --');
  console.log(JSON.stringify(tree('aeon', { withMeta: true }), null, 2));
  console.log('\n-- ascii --');
  console.log(ascii('aeon'));
}

if (require.main === module) {
  main();
}

module.exports = {
  // публичный API
  ancestors,
  descendants,
  tree,
  // расширения
  registerAgent,
  link,
  roots,
  leaves,
  lineage,
  depth,
  generation,
  commonAncestor,
  relatedness,
  subtreeSize,
  ascii,
  toDot,
  report,
  clear,
  seedGenesis,
  listAgents,
  getNode,
  // утилиты
  ancestorSet,
  ensureNode,
  normalizeId,
};
