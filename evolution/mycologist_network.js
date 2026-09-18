#!/usr/bin/env node
/**
 * evolution/mycologist_network.js — Карта мицелия (Mycelium Network Map)
 * ============================================================================
 * Назначение:
 *   Строит и анализирует карту мицелиальной сети — граф, в котором узлы
 *   (nodes) представляют колонии/агентов, а гифы (hyphae) — связи между ними.
 *   Мицелий — природная распределённая сеть: он связывает колонии, переносит
 *   питательные вещества и споры, образует хабы и мосты.
 *
 *   Модуль моделирует:
 *     1. Построение сети из записей колоний и списка гиф (network / build).
 *     2. Связность: компоненты, изолированные споры, диаметр, средний путь.
 *     3. Топологию: степени узлов, хабы, мосты, точки сочленения.
 *     4. Транспорт: поток питательных веществ от источника (nutrientFlow).
 *     5. Рост: наращивание гиф и распространение спор (growMycelium, sporulate).
 *     6. Поиск маршрутов между узлами (path / shortestPath).
 *     7. Визуализацию карты в ASCII (render).
 *
 * Публичный API (модуль):
 *   - network(records, links) -> Map      Главная функция: строит карту.
 *   - network({ nodes, links }) -> Map    Обёрнутая форма входа.
 *   - network() -> Map                    Выращивает связную сеть по умолчанию.
 *   - build(records, links) -> Map        Синоним network().
 *   - map() -> Map                        Синоним network() без аргументов.
 *   - growMycelium(options) -> {nodes, links}
 *   - growNetwork(options) -> Map
 *   - createMycologist(records, links) -> instance
 *   - Mycologist(records, links)          Конструктор (можно без new).
 *   - normalizeNode(record) -> node       Валидация/нормализация узла.
 *   - normalizeHypha(link, i) -> link     Валидация/нормализация гифы.
 *   - analyze(records, links) -> graph    Чистый граф без helper-замыканий.
 *   - configure(options), stats(), reset()
 *
 * Форма карты (Map):
 *   {
 *     nodes: [{ id, species, mass, meta, degree }],
 *     edges: [{ id, a, b, weight, type, conductivity }],
 *     adjacency: { id: [neighbourId, ...] },
 *     components: [[id, ...], ...],
 *     isolated: [id, ...],
 *     hubs: [{ id, degree }, ...],          // отсортированы по степени
 *     stats: { nodes, hyphae, components, largestComponent, connected,
 *              isolated, maxDegree, density },
 *   }
 *   Плюс НЕ-перечисляемые helper-методы: neighbors(), path(), shortestPath(),
 *   render(), transport(), sporulate(), describe(). Не-перечисляемость
 *   сохраняет карту «чистой» для JSON.stringify.
 *
 * Детерминизм: rng инъектируется через configure({ rng }) либо seed в
 * options для growMycelium/growNetwork.
 * ----------------------------------------------------------------------------
 */

'use strict';

/* -------------------------------------------------------------------------- */
/* Константы                                                                   */
/* -------------------------------------------------------------------------- */

const LINK_TYPES = Object.freeze({
  HYPHAL: 'hyphal',   // обычная гифа между двумя колониями
  FUSION: 'fusion',   // анастомоз (слияние) двух гиф
  SPORE: 'spore',     // связь, выросшая из споры
  ANASTOMOSIS: 'anastomosis',
});

const DEFAULTS = Object.freeze({
  width: 20,           // ширина колонии при выращивании
  height: 14,          // высота при выращивании
  steps: 24,           // сколько гиф нарастить при выращивании
  seed: null,          // сид детерминированного ГПСЧ
  hubThreshold: 1,     // степень, начиная с которой узел считается хабом
  transportLoss: 0.12, // потери при транспорте по одной гифе
  clusterChance: 0.12, // шанс анастомоза в выращенной сети
  minWeight: 0.1,
  maxWeight: 1.0,
});

/* -------------------------------------------------------------------------- */
/* Внутреннее состояние модуля                                                 */
/* -------------------------------------------------------------------------- */

let _cfg = { ...DEFAULTS };
const _counters = { maps: 0, nodes: 0, hyphae: 0, spores: 0, flow: 0, grown: 0 };
const _history = [];
let _rng = Math.random;

/* -------------------------------------------------------------------------- */
/* Утилиты                                                                     */
/* -------------------------------------------------------------------------- */

/** Псевдослучайный ГПСЧ mulberry32 — детерминирован для заданного сида. */
function mulberry32Rng(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ограничить значение диапазоном [lo, hi]. */
function clamp(value, lo, hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/** Случайное целое в [lo, hi] на базе переданного ГПСЧ. */
function randInt(rnd, lo, hi) {
  return Math.floor(rnd() * (hi - lo + 1)) + lo;
}

/** Случайный элемент массива. */
function pick(arr) {
  if (!arr || !arr.length) return undefined;
  return arr[Math.floor(_rng() * arr.length)];
}

/** Округлить число до n знаков (без артефактов плавающей точки). */
function round(value, digits) {
  const d = digits === undefined ? 4 : digits;
  const p = Math.pow(10, d);
  return Math.round(value * p) / p;
}

/** Число из значения, либо fallback. */
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Стабильное сравнение идентификаторов (для детерминированной сортировки). */
function compareIds(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Нормализация входа                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Нормализовать запись колонии в узел карты.
 * @param {object} record запись { id, species?, mass?, x?, y?, ... }
 * @returns {{id:string, species:string, mass:number, meta:object}} узел
 * @throws {Error} если у записи нет идентификатора
 */
function normalizeNode(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('normalizeNode: запись должна быть объектом');
  }
  const rawId = record.id !== undefined ? record.id
    : record.key !== undefined ? record.key
      : record.name;
  if (rawId === undefined || rawId === null || rawId === '') {
    throw new Error('normalizeNode: у записи отсутствует id');
  }
  const meta = { ...(record.meta || {}) };
  if (typeof record.x === 'number') meta.x = record.x;
  if (typeof record.y === 'number') meta.y = record.y;
  if (record.generation !== undefined && meta.generation === undefined) {
    meta.generation = record.generation;
  }
  if (record.spore === true) meta.spore = true;
  if (record.origin !== undefined) meta.origin = record.origin;
  return {
    id: String(rawId),
    species: record.species || record.kind || record.type || 'hypha',
    mass: num(record.mass, 1),
    meta,
    degree: 0,
  };
}

/**
 * Нормализовать описание гифы (ребра).
 * Поддерживаются формы: {a,b}, {from,to}, {source,target}, [a, b], 'a->b'.
 * @param {object|Array|string} link описание связи
 * @param {number} [index] позиция (для сообщения об ошибке)
 * @returns {{a:string, b:string, weight:number, type:string}}
 * @throws {Error} если не удалось определить оба конца
 */
function normalizeHypha(link, index) {
  const where = index === undefined ? '' : ' #' + index;
  if (link === null || link === undefined) {
    throw new Error('normalizeHypha' + where + ': пустая связь');
  }
  if (typeof link === 'string') {
    const parts = link.split(/->|--|:/);
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      throw new Error('normalizeHypha' + where + ': некорректная строка связи');
    }
    return {
      a: parts[0].trim(),
      b: parts[1].trim(),
      weight: 0.5,
      type: LINK_TYPES.HYPHAL,
    };
  }
  if (Array.isArray(link)) {
    if (link.length < 2) throw new Error('normalizeHypha' + where + ': нет конца связи');
    return {
      a: String(link[0]),
      b: String(link[1]),
      weight: num(link[2], 0.5),
      type: LINK_TYPES.HYPHAL,
    };
  }
  if (typeof link !== 'object') {
    throw new Error('normalizeHypha' + where + ': связь должна быть объектом');
  }
  const a = link.a !== undefined ? link.a
    : link.from !== undefined ? link.from
      : link.source !== undefined ? link.source
        : link[0];
  const b = link.b !== undefined ? link.b
    : link.to !== undefined ? link.to
      : link.target !== undefined ? link.target
        : link[1];
  if (a === undefined || a === null || a === '' || b === undefined || b === null || b === '') {
    throw new Error('normalizeHypha' + where + ': у связи отсутствует один из концов');
  }
  let weight = num(link.weight, num(link.conductivity, 0.5));
  weight = clamp(weight, DEFAULTS.minWeight, DEFAULTS.maxWeight);
  return {
    a: String(a),
    b: String(b),
    weight: round(weight),
    type: link.type || LINK_TYPES.HYPHAL,
  };
}

/* -------------------------------------------------------------------------- */
/* Построение графа                                                            */
/* -------------------------------------------------------------------------- */

/** Создать пустую структуру графа. */
function emptyGraph() {
  return {
    nodes: [],
    edges: [],
    adjacency: {},
    index: new Map(),
    rejected: [],
    components: [],
    isolated: [],
    hubs: [],
    stats: null,
  };
}

/**
 * Построить чистый граф из записей и связей.
 * @param {Array|object} records записи либо { nodes, links }
 * @param {Array} [links]
 * @returns {object} граф { nodes, edges, adjacency, index, components, ... }
 */
function analyze(records, links) {
  let nodeRecords = records;
  let linkRecords = links;
  if (records && !Array.isArray(records) && typeof records === 'object') {
    nodeRecords = records.nodes || records.records || records.agents || [];
    linkRecords = records.links || records.edges || [];
  }
  const graph = emptyGraph();

  // 1. Узлы.
  (Array.isArray(nodeRecords) ? nodeRecords : []).forEach((record, i) => {
    try {
      const node = normalizeNode(record);
      if (!graph.index.has(node.id)) {
        graph.index.set(node.id, node);
        graph.nodes.push(node);
        _counters.nodes += 1;
      }
    } catch (err) {
      graph.rejected.push({ kind: 'node', index: i, error: err.message });
    }
  });

  // 2. Рёбра (только между известными узлами).
  (Array.isArray(linkRecords) ? linkRecords : []).forEach((raw, i) => {
    let link;
    try {
      link = normalizeHypha(raw, i);
    } catch (err) {
      graph.rejected.push({ kind: 'edge', index: i, error: err.message });
      return;
    }
    if (link.a === link.b) {
      graph.rejected.push({ kind: 'edge', index: i, error: 'петля' });
      return;
    }
    if (!graph.index.has(link.a) || !graph.index.has(link.b)) {
      graph.rejected.push({ kind: 'edge', index: i, error: 'неизвестный конец' });
      return;
    }
    const dup = graph.edges.find(
      (e) => (e.a === link.a && e.b === link.b) || (e.a === link.b && e.b === link.a),
    );
    if (dup) return;
    graph.edges.push({
      id: 'hypha-' + (graph.edges.length + 1),
      a: link.a,
      b: link.b,
      weight: link.weight,
      type: link.type,
      conductivity: round(link.weight * (1 - _cfg.transportLoss)),
    });
    _counters.hyphae += 1;
  });

  // 3. Смежность + степени.
  graph.nodes.forEach((n) => { graph.adjacency[n.id] = []; });
  graph.edges.forEach((e) => {
    if (graph.adjacency[e.a].indexOf(e.b) === -1) graph.adjacency[e.a].push(e.b);
    if (graph.adjacency[e.b].indexOf(e.a) === -1) graph.adjacency[e.b].push(e.a);
  });
  Object.keys(graph.adjacency).forEach((id) => {
    graph.adjacency[id].sort(compareIds);
  });
  graph.nodes.forEach((n) => { n.degree = graph.adjacency[n.id].length; });

  // 4. Компоненты / изолированные / хабы / метрики.
  graph.components = componentsOf(graph.adjacency, graph.nodes.map((n) => n.id));
  graph.isolated = graph.nodes
    .filter((n) => n.degree === 0)
    .map((n) => n.id)
    .sort(compareIds);
  graph.hubs = hubNodesOf(graph, _cfg.hubThreshold);
  graph.stats = statsOf(graph);
  return graph;
}

/* -------------------------------------------------------------------------- */
/* Алгоритмы над графом                                                        */
/* -------------------------------------------------------------------------- */

/** Компоненты связности (BFS). Массив массивов id (отсортирован). */
function componentsOf(adjacency, ids) {
  const seen = new Set();
  const comps = [];
  const order = Array.isArray(ids) ? ids.slice().sort(compareIds) : Object.keys(adjacency).sort(compareIds);
  order.forEach((start) => {
    if (seen.has(start)) return;
    const queue = [start];
    const comp = [];
    seen.add(start);
    while (queue.length) {
      const cur = queue.shift();
      comp.push(cur);
      const nbrs = adjacency[cur] || [];
      for (let i = 0; i < nbrs.length; i += 1) {
        const nid = nbrs[i];
        if (!seen.has(nid)) {
          seen.add(nid);
          queue.push(nid);
        }
      }
    }
    comp.sort(compareIds);
    comps.push(comp);
  });
  return comps;
}

/** Карта расстояний (в рёбрах) от узла — BFS. */
function bfsDistances(adjacency, start) {
  const dist = new Map([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    const nbrs = adjacency[cur] || [];
    for (let i = 0; i < nbrs.length; i += 1) {
      const nid = nbrs[i];
      if (!dist.has(nid)) {
        dist.set(nid, dist.get(cur) + 1);
        queue.push(nid);
      }
    }
  }
  return dist;
}

/** Кратчайший путь (в рёбрах) между двумя узлами. */
function shortestPathIn(adjacency, a, b) {
  const empty = { path: [], nodes: [], length: Infinity, distance: Infinity, found: false };
  if (!adjacency[a] && !adjacency[b]) return empty;
  if (a === b) return { path: [a], nodes: [a], length: 0, distance: 0, found: true };
  const prev = new Map([[a, null]]);
  const queue = [a];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === b) break;
    const nbrs = adjacency[cur] || [];
    for (let i = 0; i < nbrs.length; i += 1) {
      const nid = nbrs[i];
      if (!prev.has(nid)) {
        prev.set(nid, cur);
        queue.push(nid);
      }
    }
  }
  if (!prev.has(b)) return empty;
  const path = [];
  let cur = b;
  while (cur !== null && cur !== undefined) {
    path.unshift(cur);
    cur = prev.get(cur);
  }
  return { path, nodes: path, length: path.length - 1, distance: path.length - 1, found: true };
}

/** Узлы-хабы: степень не меньше порога, отсортированы по убыванию степени. */
function hubNodesOf(graph, threshold) {
  const t = typeof threshold === 'number' ? threshold : _cfg.hubThreshold;
  return graph.nodes
    .filter((n) => n.degree >= t)
    .map((n) => ({ id: n.id, degree: n.degree, species: n.species }))
    .sort((x, y) => (y.degree - x.degree) || compareIds(x.id, y.id));
}

/** Плотность сети: 2E / (N*(N-1)). */
function densityOf(graph) {
  const n = graph.nodes.length;
  if (n < 2) return 0;
  return round(Math.min(1, (2 * graph.edges.length) / (n * (n - 1))), 6);
}

/** Диаметр сети — максимальное кратчайшее расстояние. */
function diameterOf(graph) {
  let max = 0;
  graph.nodes.forEach((n) => {
    bfsDistances(graph.adjacency, n.id).forEach((d) => { if (d > max) max = d; });
  });
  return max;
}

/** Средняя длина кратчайшего пути по всем парам узлов. */
function averagePathLengthOf(graph) {
  const ids = graph.nodes.map((n) => n.id);
  if (ids.length < 2) return 0;
  let sum = 0;
  let count = 0;
  ids.forEach((id) => {
    bfsDistances(graph.adjacency, id).forEach((d) => {
      if (d > 0) { sum += d; count += 1; }
    });
  });
  return count ? round(sum / count, 6) : 0;
}

/** Мосты: рёбра, удаление которых увеличивает число компонент. */
function bridgesOf(graph) {
  const base = graph.components.length;
  const ids = graph.nodes.map((n) => n.id);
  const result = [];
  graph.edges.forEach((e) => {
    const adj = {};
    ids.forEach((id) => { adj[id] = (graph.adjacency[id] || []).filter((x) => {
      if (id === e.a && x === e.b) return false;
      if (id === e.b && x === e.a) return false;
      return true;
    }); });
    if (componentsOf(adj, ids).length > base) result.push(e);
  });
  return result;
}

/** Точки сочленения: узлы, удаление которых увеличивает число компонент. */
function articulationPointsOf(graph) {
  const base = graph.components.length;
  const ids = graph.nodes.map((n) => n.id);
  const result = [];
  ids.forEach((victim) => {
    const remaining = ids.filter((id) => id !== victim);
    const adj = {};
    remaining.forEach((id) => {
      adj[id] = (graph.adjacency[id] || []).filter((x) => x !== victim);
    });
    if (componentsOf(adj, remaining).length > base) result.push(victim);
  });
  return result;
}

/**
 * Поток питательных веществ от источника (диффузия с потерями).
 * @returns {{source:string, received:object, totalDelivered:number}}
 */
function nutrientFlowIn(graph, source, budget) {
  const b = typeof budget === 'number' ? budget : 100;
  if (!graph.adjacency[source]) return { source, received: {}, totalDelivered: 0 };
  const received = {};
  received[source] = round(b);
  const queue = [{ id: source, amount: b }];
  const visited = new Set([source]);
  let delivered = 0;
  while (queue.length) {
    const { id, amount } = queue.shift();
    const nbrs = graph.adjacency[id] || [];
    const share = amount / Math.max(1, nbrs.length);
    for (let i = 0; i < nbrs.length; i += 1) {
      const nid = nbrs[i];
      const edge = graph.edges.find(
        (e) => (e.a === id && e.b === nid) || (e.a === nid && e.b === id),
      );
      const w = edge ? edge.weight : 0.5;
      const passed = share * w * (1 - _cfg.transportLoss);
      if (passed <= 0.0001) continue;
      received[nid] = round((received[nid] || 0) + passed);
      delivered += passed;
      if (!visited.has(nid)) {
        visited.add(nid);
        queue.push({ id: nid, amount: passed });
      }
    }
  }
  _counters.flow += 1;
  return { source, received, totalDelivered: round(delivered) };
}

/* -------------------------------------------------------------------------- */
/* Метрики и описание                                                          */
/* -------------------------------------------------------------------------- */

/** Сводные метрики графа. */
function statsOf(graph) {
  const degrees = graph.nodes.map((n) => n.degree);
  const comps = graph.components || [];
  return {
    nodes: graph.nodes.length,
    hyphae: graph.edges.length,
    edgeCount: graph.edges.length,
    components: comps.length,
    largestComponent: comps.reduce((m, c) => Math.max(m, c.length), 0),
    connected: comps.length <= 1,
    isolated: (graph.isolated || []).length,
    isolatedIds: (graph.isolated || []).slice(),
    maxDegree: degrees.length ? Math.max.apply(null, degrees) : 0,
    meanDegree: degrees.length ? round(degrees.reduce((a, b) => a + b, 0) / degrees.length) : 0,
    density: densityOf(graph),
    diameter: diameterOf(graph),
    averagePathLength: averagePathLengthOf(graph),
    hubCount: (graph.hubs || []).length,
    rejected: (graph.rejected || []).length,
  };
}

/** Человекочитаемое описание карты мицелия. */
function describeGraph(graph) {
  const s = graph.stats || statsOf(graph);
  const lines = [];
  lines.push('mycelium: ' + s.nodes + ' nodes, ' + s.hyphae + ' hyphae.');
  if (s.connected) {
    lines.push('connected; diameter ' + s.diameter + ', mean path ' + s.averagePathLength + '.');
  } else {
    lines.push('fragmented (' + s.components + ' components), largest ' + s.largestComponent + '.');
  }
  if (s.isolated) {
    lines.push('isolated spores: ' + s.isolated + '.');
  }
  if (graph.hubs && graph.hubs.length) {
    lines.push('hubs: ' + graph.hubs.slice(0, 5).map((h) => h.id + '(' + h.degree + ')').join(', ') + '.');
  }
  lines.push('density ' + s.density + '.');
  return lines.join(' ');
}

/* -------------------------------------------------------------------------- */
/* Визуализация (ASCII)                                                        */
/* -------------------------------------------------------------------------- */

/** Отрисовать карту в ASCII по координатам col/row (meta.x / meta.y). */
function renderGraph(graph, options) {
  const pts = graph.nodes.filter(
    (n) => n.meta && typeof n.meta.x === 'number' && typeof n.meta.y === 'number',
  );
  if (!pts.length) return '(no coordinates)';
  const opts = options || {};
  const mark = opts.mark || '*';
  const xs = pts.map((n) => n.meta.x);
  const ys = pts.map((n) => n.meta.y);
  const minX = Math.min.apply(null, xs);
  const maxX = Math.max.apply(null, xs);
  const minY = Math.min.apply(null, ys);
  const maxY = Math.max.apply(null, ys);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const grid = [];
  for (let r = 0; r < height; r += 1) {
    grid.push(new Array(width).fill(' '));
  }
  pts.forEach((n) => {
    grid[n.meta.y - minY][n.meta.x - minX] = n.degree > 2 ? '#' : mark;
  });
  const header = 'mycelium map ' + width + 'x' + height;
  return header + '\n' + grid.map((row) => row.join('')).join('\n');
}

/* -------------------------------------------------------------------------- */
/* Выращивание мицелия                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Вырастить мицелиальную сеть (дерево гиф + анастомозы).
 * @param {object} [options] { width, height, steps, seed, clusterChance }
 * @returns {{nodes: object[], links: object[], seed: number|null}}
 */
function growMycelium(options) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  const rnd = opts.seed !== null && opts.seed !== undefined
    ? mulberry32Rng(opts.seed)
    : Math.random;
  const width = Math.max(2, num(opts.width, DEFAULTS.width));
  const height = Math.max(2, num(opts.height, DEFAULTS.height));
  const steps = Math.max(1, num(opts.steps, DEFAULTS.steps));

  const nodes = [];
  const links = [];
  const has = new Set();

  const startX = randInt(rnd, 0, width - 1);
  const startY = randInt(rnd, 0, height - 1);
  const rootId = 'hypha-1';
  nodes.push({ id: rootId, species: 'hypha', mass: 1, meta: { x: startX, y: startY, generation: 0 } });
  has.add(rootId);

  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let i = 1; i <= steps; i += 1) {
    const parent = nodes[Math.floor(rnd() * nodes.length)];
    const dir = dirs[Math.floor(rnd() * dirs.length)];
    const x = clamp(parent.meta.x + dir[0], 0, width - 1);
    const y = clamp(parent.meta.y + dir[1], 0, height - 1);
    const id = 'hypha-' + (i + 1);
    if (has.has(id)) continue;
    nodes.push({
      id,
      species: 'hypha',
      mass: round(0.4 + rnd() * 0.6, 3),
      meta: { x, y, generation: parent.meta.generation + 1 },
    });
    has.add(id);
    links.push({
      id: 'hypha-link-' + links.length,
      a: parent.id,
      b: id,
      weight: round(0.2 + rnd() * 0.8),
      type: LINK_TYPES.HYPHAL,
    });
  }

  // Анастомозы между соседними по сетке узлами (детерминированно).
  const clusterChance = num(opts.clusterChance, DEFAULTS.clusterChance);
  const edgeKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const edgeSet = new Set(links.map((l) => edgeKey(l.a, l.b)));
  for (let i = 0; i < nodes.length; i += 1) {
    if (rnd() >= clusterChance) continue;
    const a = nodes[i];
    const b = nodes[Math.floor(rnd() * nodes.length)];
    if (a.id === b.id) continue;
    const manhattan = Math.abs(a.meta.x - b.meta.x) + Math.abs(a.meta.y - b.meta.y);
    if (manhattan !== 1) continue;
    const key = edgeKey(a.id, b.id);
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    links.push({
      id: 'hypha-link-' + links.length,
      a: a.id,
      b: b.id,
      weight: round(0.2 + rnd() * 0.8),
      type: LINK_TYPES.ANASTOMOSIS,
    });
  }

  _counters.grown += 1;
  return { nodes, links, seed: opts.seed === undefined ? null : opts.seed };
}

/* -------------------------------------------------------------------------- */
/* Карта: сборка + helper-методы                                               */
/* -------------------------------------------------------------------------- */

/**
 * Собрать объект-карту из готового графа. Helper-методы добавляются
 * НЕ-перечисляемыми, чтобы JSON.stringify(map) не засорялся функциями.
 * @param {object} graph граф из analyze()
 * @param {object} [options]
 * @returns {object} карта мицелия
 */
function buildMap(graph, options) {
  const opts = options || {};
  const comps = graph.components || componentsOf(graph.adjacency, graph.nodes.map((n) => n.id));
  const mapObject = {
    nodes: graph.nodes,
    edges: graph.edges,
    adjacency: graph.adjacency,
    components: comps,
    isolated: graph.isolated,
    hubs: graph.hubs,
    stats: graph.stats || statsOf(graph),
    rejected: graph.rejected,
    ts: Date.now(),
  };

  const define = (name, fn) => {
    Object.defineProperty(mapObject, name, {
      value: fn,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  };

  define('neighbors', (id) => (graph.adjacency[id] || []).slice());
  define('path', (a, b) => shortestPathIn(graph.adjacency, a, b));
  define('shortestPath', (a, b) => shortestPathIn(graph.adjacency, a, b));
  define('render', (renderOptions) => renderGraph(graph, renderOptions));
  define('describe', () => describeGraph(graph));
  define('transport', (source, budget) => nutrientFlowIn(graph, source, budget));
  define('metrics', () => statsOf(graph));
  define('sporulate', (count) => sporulateOn(graph, count, opts));
  define('graph', () => graph);

  _counters.maps += 1;
  _history.push({ ts: mapObject.ts, nodes: mapObject.stats.nodes, hyphae: mapObject.stats.hyphae });
  if (_history.length > 50) _history.shift();
  return mapObject;
}

/** Главная функция модуля: построить карту мицелия. */
function network(input, second) {
  let records = null;
  let links = null;
  let options = {};

  if (input === undefined || input === null) {
    const grown = growMycelium(options);
    records = grown.nodes;
    links = grown.links;
  } else if (Array.isArray(input)) {
    records = input;
    if (Array.isArray(second)) {
      links = second;
    } else if (second && typeof second === 'object') {
      options = second;
      links = options.links || options.edges || [];
    } else {
      links = [];
    }
  } else if (typeof input === 'number') {
    const grown = growMycelium({ ...options, steps: Math.max(1, input - 1) });
    records = grown.nodes;
    links = grown.links;
  } else if (typeof input === 'object') {
    options = input;
    records = input.nodes || input.records || input.agents || [];
    links = input.links || input.edges || [];
  }

  const graph = analyze(records, links);
  return buildMap(graph, options);
}

/** Синоним network(). */
function build(records, links) {
  return network(records, links);
}

/** Синоним network() без аргументов — вырастить связную сеть. */
function map() {
  return network();
}

/** Вырастить сеть и сразу вернуть её карту. */
function growNetwork(options) {
  const grown = growMycelium(options);
  return network(grown.nodes, grown.links);
}

/** Распространить споры: каждая спора основывает колонию рядом с хабом. */
function sporulateOn(graph, count, options) {
  const c = typeof count === 'number' ? count : 1;
  const targets = graph.hubs && graph.hubs.length
    ? graph.hubs.map((h) => h.id)
    : graph.nodes.map((n) => n.id);
  const spores = [];
  for (let i = 0; i < c; i += 1) {
    const target = pick(targets);
    if (!target) break;
    const sporeId = 'spore-' + (_counters.spores + 1);
    _counters.spores += 1;
    spores.push({ spore: sporeId, target, weight: round(0.4 + _rng() * 0.6) });
  }
  return spores;
}

/* -------------------------------------------------------------------------- */
/* Объектная обёртка: Mycologist                                               */
/* -------------------------------------------------------------------------- */

/**
 * Инстанс-обёртка над картой мицелия. Вызывается и без new.
 * @constructor
 * @param {Array|object} [records] записи колоний либо { nodes, links }
 * @param {Array} [links] связи
 */
function Mycologist(records, links) {
  if (!(this instanceof Mycologist)) {
    return new Mycologist(records, links);
  }
  this._records = Array.isArray(records) ? records : [];
  this._links = Array.isArray(links) ? links : [];
  this._graph = analyze(this._records, this._links);
  this._map = buildMap(this._graph, {});
  this.roots = this._graph.nodes.filter((n) => n.meta && n.meta.root).map((n) => n.id);
  this.lastMap = this._map;
}

/** Пересобрать карту из сохранённых либо новых данных. */
Mycologist.prototype.network = function networkMethod(records) {
  if (records !== undefined) {
    this._records = Array.isArray(records) ? records : this._records;
    this._links = Array.isArray(records) ? [] : this._links;
  }
  this._graph = analyze(this._records, this._links);
  this._map = buildMap(this._graph, {});
  this.lastMap = this._map;
  return this._map;
};

/** Синоним network(). */
Mycologist.prototype.map = function mapMethod(records) {
  return this.network(records);
};

/** Полная карта мицелия. */
Mycologist.prototype.card = function cardMethod() {
  return this._map;
};

/** Сводная статистика инстанса. */
Mycologist.prototype.stats = function statsMethod() {
  return this._graph.stats;
};

/** Хабы (при необходимости — первые limit). */
Mycologist.prototype.hubs = function hubsMethod(limit) {
  const list = this._graph.hubs;
  return typeof limit === 'number' ? list.slice(0, limit) : list.slice();
};

/** Соседи узла. */
Mycologist.prototype.neighbors = function neighborsMethod(id) {
  return (this._graph.adjacency[id] || []).slice();
};

/** Кратчайший путь между узлами. */
Mycologist.prototype.path = function pathMethod(a, b) {
  return shortestPathIn(this._graph.adjacency, a, b);
};

/** Синоним path(). */
Mycologist.prototype.shortestPath = function shortestPathMethod(a, b) {
  return this.path(a, b);
};

/** Компоненты связности. */
Mycologist.prototype.components = function componentsMethod() {
  return this._graph.components.map((c) => c.slice());
};

/** Изолированные узлы. */
Mycologist.prototype.isolated = function isolatedMethod() {
  return this._graph.isolated.slice();
};

/** Поток питательных веществ от источника. */
Mycologist.prototype.transport = function transportMethod(source, budget) {
  return nutrientFlowIn(this._graph, source, budget);
};

/** Синоним transport(). */
Mycologist.prototype.signal = function signalMethod(source, budget) {
  return this.transport(source, budget);
};

/** Отрисовать карту в ASCII. */
Mycologist.prototype.render = function renderMethod(options) {
  return renderGraph(this._graph, options);
};

/** Человекочитаемое описание. */
Mycologist.prototype.describe = function describeMethod() {
  return describeGraph(this._graph);
};

/** Снимок состояния инстанса. */
Mycologist.prototype.snapshot = function snapshotMethod() {
  return {
    stats: this.stats(),
    hubs: this.hubs(),
    components: this.components(),
    isolated: this.isolated(),
    roots: this.roots.slice(),
  };
};

/**
 * Создать инстанс-обёртку над картой мицелия.
 * @returns {Mycologist}
 */
function createMycologist(records, links) {
  return new Mycologist(records, links);
}

/* -------------------------------------------------------------------------- */
/* Конфигурация/счётчики модуля                                                */
/* -------------------------------------------------------------------------- */

/** Настроить модуль ({ rng, seed, hubThreshold, transportLoss, ... }). */
function configure(options) {
  const opts = options || {};
  if (typeof opts.seed === 'number') _rng = mulberry32Rng(opts.seed);
  if (typeof opts.rng === 'function') _rng = opts.rng;
  _cfg = { ..._cfg, ...opts };
  return { ..._cfg };
}

/** Сбросить счётчики/историю модуля (конфигурацию не трогает). */
function reset() {
  _counters.maps = 0;
  _counters.nodes = 0;
  _counters.hyphae = 0;
  _counters.spores = 0;
  _counters.flow = 0;
  _counters.grown = 0;
  _history.length = 0;
  return module.exports;
}

/** Счётчики и история модуля. */
function stats() {
  return {
    config: { ..._cfg },
    counters: { ..._counters },
    history: _history.slice(),
  };
}

/* -------------------------------------------------------------------------- */
/* Экспорт                                                                     */
/* -------------------------------------------------------------------------- */

module.exports = {
  // главные функции
  network,
  build,
  map,
  analyze,
  // выращивание
  growMycelium,
  growNetwork,
  sporulate: (count, options) => sporulateOn(analyze(options || {}), count, options),
  nutrientFlow: (records, links, source, budget) => {
    const graph = analyze(records, links);
    return nutrientFlowIn(graph, source, budget);
  },
  // обёртки
  Mycologist,
  createMycologist,
  // нормализация
  normalizeNode,
  normalizeHypha,
  // анализ
  componentsOf,
  bfsDistances,
  shortestPathIn,
  hubNodesOf,
  densityOf,
  diameterOf,
  averagePathLengthOf,
  bridgesOf,
  articulationPointsOf,
  renderGraph,
  describeGraph,
  statsOf,
  // служебное
  configure,
  reset,
  stats,
  LINK_TYPES,
  DEFAULTS,
  _internals: {
    mulberry32Rng,
    clamp,
    round,
    compareIds,
    buildMap,
    emptyGraph,
  },
};

/* -------------------------------------------------------------------------- */
/* CLI: демонстрационный прогон                                                */
/* -------------------------------------------------------------------------- */

if (require.main === module) {
  const demoRecords = [
    { id: 'root', species: 'spore', mass: 3 },
    { id: 'trunk', species: 'hypha' },
    { id: 'tip-a', species: 'tip' },
    { id: 'tip-b', species: 'tip' },
    { id: 'spore-x', species: 'spore' },
  ];
  const demoLinks = [
    { from: 'root', to: 'trunk', weight: 2 },
    { from: 'trunk', to: 'tip-a', weight: 1.5 },
    { from: 'trunk', to: 'tip-b', weight: 1.25 },
    { a: 'tip-a', b: 'tip-b', weight: 0.5, type: 'anastomosis' },
  ];
  const card = network(demoRecords, demoLinks);
  console.log(describeGraph(card.graph()));
  console.log('hubs:', card.hubs.map((h) => h.id + '(' + h.degree + ')').join(', ') || '—');
  console.log('isolated:', card.isolated.join(', ') || '—');
  const grown = growNetwork({ width: 24, height: 14, steps: 60, seed: 7 });
  console.log(describeGraph(grown.graph()));
  console.log(grown.render());
  console.log('module stats:', JSON.stringify(stats()));
}
