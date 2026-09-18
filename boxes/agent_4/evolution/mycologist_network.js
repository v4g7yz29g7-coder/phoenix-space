#!/usr/bin/env node
/**
 * evolution/mycologist_network.js — Карта мицелия (Mycelium Network Map)
 * ============================================================================
 * Назначение:
 *   Строит и анализирует сеть мицелия — граф, узлами которого являются
 *   мицелиальные агенты/точки роста (hyphal tips, spores, hubs, sclerotia),
 *   а рёбрами — гифальные связи (hyphae) между ними. Модуль «миколога»:
 *   он умеет не только рисовать карту, но и оценивать связность, находить
 *   плодовые тела (компоненты), кратчайшие пути проводимости и уязвимые
 *   узлы (мосты/точки сочленения), потеря которых разрывает сеть.
 *
 * Публичный API (модуль):
 *   - network(spec, options) -> {
 *       ok: true,
 *       nodes: [...],          // нормализованные узлы с метриками
 *       edges: [...],          // нормализованные рёбра с проводимостью
 *       adjacency: {...},       // список смежности id -> [{to, edgeId, weight}]
 *       components: [...],      // связные компоненты (плодовые тела)
 *       metrics: { ... },       // сводные метрики сети
 *       meta: { ... }           // параметры построения
 *     }
 *     Основная функция. spec — описание сети (узлы/рёбра) либо массив узлов.
 *
 * Вспомогательные функции:
 *   - build(spec)             -> внутренний нормализованный граф
 *   - neighbors(graph, id)    -> прямые соседи узла
 *   - path(graph, from, to)   -> кратчайший путь (BFS) как массив id
 *   - conductivity(edge)      -> нормированная проводимость ребра 0..1
 *   - components(graph)       -> связные компоненты (массивы id)
 *   - bridges(graph)          -> рёбра-мосты, разрывающие сеть
 *   - articulationPoints(g)   -> точки сочленения (критические узлы)
 *   - degrees(graph)          -> степени узлов
 *   - explain(result)         -> человекочитаемая сводка
 *
 * Модель:
 *   Узел:   { id, kind, biomass, activity, vitality, x, y, ... }
 *   Ребро:  { id, from, to, length, diameter, flow }
 *   Проводимость ребра объединяет длину и диаметр:
 *       conductivity = clamp( diameter^2 / (length + 1), 0, 1 )
 *   Вес для поиска пути — обратная проводимость (сильная гифа = короткий путь).
 *
 * Гарантии:
 *   - функции чистые: входные объекты НЕ мутируются;
 *   - толерантность к неполным данным (отсутствующие поля = дефолты);
 *   - детерминированный порядок (сортировка по id);
 *   - наружу всегда возвращается { ok:true|false, ... };
 *   - без внешних зависимостей.
 * ============================================================================
 */

'use strict';

// ---------------------------------------------------------------------------
//  Константы
// ---------------------------------------------------------------------------

const NODE_KINDS = Object.freeze({
  TIP: 'tip',           // точка роста гифы
  HUB: 'hub',           // узел-концентратор
  SPORE: 'spore',       // спора (потенциальный изолят)
  SCLEROTIUM: 'sclerotium', // склероций (покоящаяся структура)
  FRUIT: 'fruit',       // плодовое тело
  UNKNOWN: 'unknown'
});

const DEFAULTS = Object.freeze({
  biomass: 1,           // условная масса узла
  activity: 1,          // активность метаболизма 0..1+
  length: 1,            // длина гифы
  diameter: 1,          // диаметр гифы (толщина)
  flow: 0               // зарегистрированный поток
});

// ---------------------------------------------------------------------------
//  Утилиты нормализации
// ---------------------------------------------------------------------------

/** Безопасный идентификатор узла. */
function idOf(value, fallback) {
  if (value == null) return fallback;
  const s = String(value).trim();
  return s.length ? s : fallback;
}

/** Число из строки/числа с дефолтом. */
function num(value, fallback) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Ограничение диапазоном. */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Уникализация массива с сохранением порядка. */
function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Нормализация узлов и рёбер
// ---------------------------------------------------------------------------

function normalizeNode(raw, index) {
  const n = raw && typeof raw === 'object' ? raw : {};
  const id = idOf(n.id != null ? n.id : n.name, `node_${index}`);
  return {
    id,
    label: String(n.label || n.name || id),
    kind: NODE_KINDS[String(n.kind || '').toUpperCase()] || String(n.kind || NODE_KINDS.UNKNOWN).toLowerCase(),
    biomass: Math.max(0, num(n.biomass, DEFAULTS.biomass)),
    activity: clamp(num(n.activity, DEFAULTS.activity), 0, 1),
    vitality: clamp(num(n.vitality, num(n.health, 1)), 0, 1),
    x: num(n.x, 0),
    y: num(n.y, 0),
    extra: n.extra && typeof n.extra === 'object' ? { ...n.extra } : {}
  };
}

function normalizeEdge(raw, index) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const from = idOf(e.from != null ? e.from : e.source, null);
  const to = idOf(e.to != null ? e.to : e.target, null);
  return {
    id: idOf(e.id, `edge_${index}`),
    from,
    to,
    length: Math.max(0, num(e.length, DEFAULTS.length)),
    diameter: Math.max(0, num(e.diameter, DEFAULTS.diameter)),
    flow: num(e.flow, DEFAULTS.flow),
    type: String(e.type || 'hypha').toLowerCase()
  };
}

// ---------------------------------------------------------------------------
//  Проводимость и вес ребра
// ---------------------------------------------------------------------------

/**
 * Проводимость гифы: толще и короче — проводит лучше.
 * Нормируем в 0..1, чтобы метрики были сопоставимы.
 */
function conductivity(edge) {
  if (!edge) return 0;
  const diameter = Math.max(0, num(edge.diameter, DEFAULTS.diameter));
  const length = Math.max(0, num(edge.length, DEFAULTS.length));
  const raw = (diameter * diameter) / (length + 1);
  return clamp(raw / (1 + raw), 0, 1);
}

/** Вес ребра для поиска пути: обратная проводимость (сильная гифа = 1). */
function edgeWeight(edge) {
  const c = conductivity(edge);
  return c <= 0 ? Number.POSITIVE_INFINITY : 1 / c;
}

// ---------------------------------------------------------------------------
//  Построение графа
// ---------------------------------------------------------------------------

/**
 * Приводит произвольный spec к внутренней структуре графа.
 * spec может быть:
 *   - { nodes:[...], edges:[...] }
 *   - массивом узлов (рёбра будут пусты)
 *   - объектом с вложенными species/links (мягкая совместимость)
 */
function build(spec) {
  let nodeList = [];
  let edgeList = [];

  if (Array.isArray(spec)) {
    nodeList = spec;
  } else if (spec && typeof spec === 'object') {
    nodeList = Array.isArray(spec.nodes) ? spec.nodes
      : Array.isArray(spec.vertices) ? spec.vertices : [];
    edgeList = Array.isArray(spec.edges) ? spec.edges
      : Array.isArray(spec.links) ? spec.links : [];
  }

  const nodes = nodeList.map((raw, i) => normalizeNode(raw, i));
  const index = new Map(nodes.map((n) => [n.id, n]));

  // Нормализуем рёбра, отбрасывая те, что ссылаются на неизвестные узлы
  // или являются петлями (петли не несут смысла в карте проводимости).
  const edges = [];
  const rejected = [];
  edgeList.forEach((raw, i) => {
    const e = normalizeEdge(raw, i);
    if (!e.from || !e.to) {
      rejected.push({ edge: e, reason: 'missing_endpoint' });
      return;
    }
    if (!index.has(e.from) || !index.has(e.to)) {
      rejected.push({ edge: e, reason: 'unknown_endpoint' });
      return;
    }
    if (e.from === e.to) {
      rejected.push({ edge: e, reason: 'self_loop' });
      return;
    }
    edges.push(e);
  });

  return { nodes, edges, index, rejected };
}

// ---------------------------------------------------------------------------
//  Смежность и степени
// ---------------------------------------------------------------------------

function adjacency(graph) {
  const adj = {};
  for (const node of graph.nodes) adj[node.id] = [];
  const seen = new Set();
  for (const edge of graph.edges) {
    const key = [edge.from, edge.to].sort().join('\u0000');
    if (seen.has(key)) continue; // не учитываем дубли рёбер
    seen.add(key);
    const weight = edgeWeight(edge);
    adj[edge.from].push({ to: edge.to, edgeId: edge.id, weight, conductivity: conductivity(edge) });
    adj[edge.to].push({ to: edge.from, edgeId: edge.id, weight, conductivity: conductivity(edge) });
  }
  for (const id of Object.keys(adj)) {
    adj[id].sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  }
  return adj;
}

function neighbors(graph, id) {
  const adj = adjacency(graph);
  return adj[id] ? adj[id].map((x) => x.to) : [];
}

function degrees(graph) {
  const adj = adjacency(graph);
  const out = {};
  for (const id of Object.keys(adj)) out[id] = adj[id].length;
  return out;
}

// ---------------------------------------------------------------------------
//  Обход в ширину: путь и достижимость
// ---------------------------------------------------------------------------

/** Кратчайший путь по числу рёбер (BFS). Возвращает массив id или []. */
function path(graph, from, to) {
  if (!graph.index.has(from) || !graph.index.has(to)) return [];
  if (from === to) return [from];
  const adj = adjacency(graph);
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const current = queue.shift();
    for (const link of adj[current] || []) {
      if (prev.has(link.to)) continue;
      prev.set(link.to, current);
      if (link.to === to) {
        const chain = [to];
        let step = current;
        while (step != null) {
          chain.unshift(step);
          step = prev.get(step);
        }
        return chain;
      }
      queue.push(link.to);
    }
  }
  return [];
}

/** Достижимые узлы из заданного. */
function reachable(graph, from) {
  const adj = adjacency(graph);
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const current = queue.shift();
    for (const link of adj[current] || []) {
      if (!seen.has(link.to)) {
        seen.add(link.to);
        queue.push(link.to);
      }
    }
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
//  Связные компоненты (плодовые тела)
// ---------------------------------------------------------------------------

function components(graph) {
  const adj = adjacency(graph);
  const visited = new Set();
  const comps = [];
  for (const node of graph.nodes) {
    if (visited.has(node.id)) continue;
    const stack = [node.id];
    const members = [];
    visited.add(node.id);
    while (stack.length) {
      const current = stack.pop();
      members.push(current);
      for (const link of adj[current] || []) {
        if (!visited.has(link.to)) {
          visited.add(link.to);
          stack.push(link.to);
        }
      }
    }
    members.sort();
    comps.push(members);
  }
  comps.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
  return comps;
}

// ---------------------------------------------------------------------------
//  Мосты и точки сочленения (уязвимость сети)
// ---------------------------------------------------------------------------

/** Рёбра-мосты: удаление разрывает сеть. */
function bridges(graph) {
  const adj = adjacency(graph);
  const disc = new Map();
  const low = new Map();
  const found = [];
  let timer = 0;

  function dfs(u, parentEdgeId) {
    disc.set(u, timer);
    low.set(u, timer);
    timer += 1;
    for (const link of adj[u] || []) {
      if (link.edgeId === parentEdgeId) continue;
      if (!disc.has(link.to)) {
        dfs(link.to, link.edgeId);
        low.set(u, Math.min(low.get(u), low.get(link.to)));
        if (low.get(link.to) > disc.get(u)) {
          found.push({ edgeId: link.edgeId, from: u, to: link.to });
        }
      } else {
        low.set(u, Math.min(low.get(u), disc.get(link.to)));
      }
    }
  }

  for (const node of graph.nodes) {
    if (!disc.has(node.id)) dfs(node.id, null);
  }
  found.sort((a, b) => (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0));
  return found;
}

/** Точки сочленения: критические узлы, разрыв которых дробит сеть. */
function articulationPoints(graph) {
  const adj = adjacency(graph);
  const disc = new Map();
  const low = new Map();
  const isCut = new Set();
  let timer = 0;

  function dfs(u, parent) {
    disc.set(u, timer);
    low.set(u, timer);
    timer += 1;
    let children = 0;
    for (const link of adj[u] || []) {
      if (link.to === parent) continue;
      if (!disc.has(link.to)) {
        children += 1;
        dfs(link.to, u);
        low.set(u, Math.min(low.get(u), low.get(link.to)));
        if (parent !== null && low.get(link.to) >= disc.get(u)) isCut.add(u);
      } else {
        low.set(u, Math.min(low.get(u), disc.get(link.to)));
      }
    }
    if (parent === null && children > 1) isCut.add(u);
  }

  for (const node of graph.nodes) {
    if (!disc.has(node.id)) dfs(node.id, null);
  }
  return [...isCut].sort();
}

// ---------------------------------------------------------------------------
//  Центральности (простая оценка важности узла)
// ---------------------------------------------------------------------------

/** Степень-центральность: доля соседей от максимума. */
function degreeCentrality(graph) {
  const deg = degrees(graph);
  const max = Math.max(1, ...Object.values(deg));
  const out = {};
  for (const id of Object.keys(deg)) out[id] = clamp(deg[id] / max, 0, 1);
  return out;
}

// ---------------------------------------------------------------------------
//  Основная функция network()
// ---------------------------------------------------------------------------

function network(spec, options) {
  try {
    const opts = options && typeof options === 'object' ? options : {};
    const graph = build(spec);
    const adj = adjacency(graph);
    const deg = degrees(graph);
    const comps = components(graph);
    const central = degreeCentrality(graph);
    const cutPoints = articulationPoints(graph);
    const bridgeList = bridges(graph);

    const totalConductivity = graph.edges.reduce((sum, e) => sum + conductivity(e), 0);
    const avgConductivity = graph.edges.length ? totalConductivity / graph.edges.length : 0;

    const density = graph.nodes.length > 1
      ? (2 * graph.edges.length) / (graph.nodes.length * (graph.nodes.length - 1))
      : 0;

    const decoratedNodes = graph.nodes.map((node) => ({
      ...node,
      degree: deg[node.id] || 0,
      centrality: central[node.id] || 0,
      isArticulation: cutPoints.includes(node.id),
      component: comps.findIndex((c) => c.includes(node.id))
    }));

    const metrics = {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      componentCount: comps.length,
      largestComponent: comps.length ? comps[0].length : 0,
      avgConductivity: Number(avgConductivity.toFixed(4)),
      density: Number(density.toFixed(4)),
      avgDegree: graph.nodes.length
        ? Number((graph.edges.length * 2 / graph.nodes.length).toFixed(4))
        : 0,
      bridgeCount: bridgeList.length,
      articulationCount: cutPoints.length,
      isConnected: comps.length <= 1,
      isTree: comps.length === 1 && graph.edges.length === graph.nodes.length - 1
    };

    return {
      ok: true,
      nodes: decoratedNodes,
      edges: graph.edges.map((e) => ({ ...e, conductivity: Number(conductivity(e).toFixed(4)) })),
      adjacency: adj,
      components: comps,
      bridges: bridgeList,
      articulationPoints: cutPoints,
      metrics,
      meta: {
        requested: opts.label || null,
        rejectedEdges: graph.rejected,
        generatedFor: opts.for || 'mycologist_network'
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error && error.message ? error.message : error),
      nodes: [],
      edges: [],
      adjacency: {},
      components: [],
      metrics: {},
      meta: {}
    };
  }
}

// ---------------------------------------------------------------------------
//  Человекочитаемая сводка
// ---------------------------------------------------------------------------

function explain(result) {
  if (!result || !result.ok) return 'Сеть мицелия не построена.';
  const m = result.metrics;
  const lines = [
    `Сеть мицелия: узлов=${m.nodeCount}, гиф=${m.edgeCount}.`,
    `Плодовых тел (компонент): ${m.componentCount}, крупнейшее: ${m.largestComponent}.`,
    `Плотность=${m.density}, средняя проводимость=${m.avgConductivity}.`,
    `Мостов: ${m.bridgeCount}, критических узлов: ${m.articulationCount}.`,
    m.isConnected ? 'Сеть связна.' : 'Сеть распадается на изолированные кластеры.'
  ];
  return lines.join('\n');
}

module.exports = {
  network,
  build,
  neighbors,
  path,
  reachable,
  conductivity,
  edgeWeight,
  components,
  bridges,
  articulationPoints,
  degrees,
  degreeCentrality,
  explain,
  NODE_KINDS,
  DEFAULTS
};

// ---------------------------------------------------------------------------
//  Самопроверка при прямом запуске
// ---------------------------------------------------------------------------
if (typeof require !== 'undefined' && require.main === module) {
  const demo = {
    nodes: [
      { id: 'a', kind: 'hub', x: 0, y: 0 },
      { id: 'b', kind: 'tip', x: 1, y: 0 },
      { id: 'c', kind: 'tip', x: 2, y: 0 },
      { id: 'd', kind: 'spore', x: 5, y: 5 }
    ],
    edges: [
      { from: 'a', to: 'b', length: 1, diameter: 2 },
      { from: 'b', to: 'c', length: 2, diameter: 1 },
      { from: 'b', to: 'd', length: 3, diameter: 1 }
    ]
  };
  const result = network(demo, { label: 'demo' });
  console.log(explain(result));
}
