'use strict';

/**
 * cross_domain.js
 *
 * Кросс-доменные задачи (cross-domain reasoning).
 *
 * Модуль сопоставляет два «домена» (набора наблюдений/концептов с
 * признаками) и строит между ними перенос знания: какие сущности
 * домена A соответствуют сущностям домена B, какие признаки
 * переносимы, а какие специфичны для домена, и какие общие
 * закономерности (корреляции) присутствуют в обоих доменах.
 *
 * Публичный API: crossDomain(a, b, options)
 *
 *   a, b — домены, каждый в одном из форматов:
 *     - Array<number>                          (одномерный ряд)
 *     - Array<object>                          (сущности с признаками)
 *     - { name, entities: Array<object> }      (явное имя домена)
 *
 *   options:
 *     - features     {string[]} признаковые поля       (авто-детект по умолчанию)
 *     - metric       {'euclidean'|'cosine'|'manhattan'} метрика близости
 *     - threshold    {number}   порог соответствия      (default 0.6)
 *     - invert       {boolean}  принимать 1-sim как дистанцию (default false)
 *     - detailed     {boolean}  расширенный отчёт       (default false)
 *     - topK         {number}   сколько связей вернуть  (default 5)
 */

/* ------------------------------------------------------------------ */
/* Утилиты                                                            */
/* ------------------------------------------------------------------ */

function isNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Приводит любой поддерживаемый вход к нормализованному домену:
 *   { name: string, entities: Array<{ id, vector: number[], raw }> }
 */
function normalizeDomain(input, fallbackName) {
  if (input === null || input === undefined) {
    throw new TypeError('Домен не может быть null/undefined');
  }

  let name = fallbackName;
  let rawEntities = input;

  if (isPlainObject(input)) {
    if (input.name) name = String(input.name);
    if (Array.isArray(input.entities)) {
      rawEntities = input.entities;
    } else if (Array.isArray(input.rows)) {
      rawEntities = input.rows;
    } else {
      throw new TypeError('Домен-объект должен содержать entities[]/rows[]');
    }
  }

  if (!Array.isArray(rawEntities)) {
    throw new TypeError('Домен должен быть массивом');
  }
  if (rawEntities.length === 0) {
    throw new RangeError('Домен "' + name + '" пуст');
  }

  const entities = rawEntities.map(function (item, i) {
    if (isNumber(item)) {
      return { id: 'e' + i, vector: [item], raw: item };
    }
    if (Array.isArray(item)) {
      return {
        id: 'e' + i,
        vector: item.map(function (v) {
          if (!isNumber(v)) throw new TypeError('Нечисловой признак в ' + i);
          return v;
        }),
        raw: item,
      };
    }
    if (isPlainObject(item)) {
      const id = item.id !== undefined ? String(item.id) : 'e' + i;
      return { id: id, vector: null, raw: item };
    }
    throw new TypeError('Неподдерживаемый элемент домена: ' + i);
  });

  return { name: name, entities: entities };
}

/** Определяет признаки у объектных доменов и строит векторы. */
function detectFeatures(domains, explicit) {
  if (explicit && Array.isArray(explicit) && explicit.length) {
    return explicit.slice();
  }
  const seen = [];
  const seenSet = Object.create(null);
  domains.forEach(function (d) {
    d.entities.forEach(function (e) {
      if (!isPlainObject(e.raw)) return;
      Object.keys(e.raw).forEach(function (k) {
        if (k === 'id') return;
        if (!seenSet[k]) {
          seenSet[k] = true;
          seen.push(k);
        }
      });
    });
  });
  return seen;
}

/** Заполняет вектор для каждой сущности по списку признаков. */
function materializeVectors(domain, features) {
  domain.entities.forEach(function (e) {
    if (e.vector) return; // уже числовой
    e.vector = features.map(function (f) {
      const v = e.raw[f];
      return isNumber(v) ? v : 0;
    });
  });
}

/** Нормализация значений признаков (z-score) по каждому столбцу. */
function standardize(domain) {
  const n = domain.entities.length;
  if (!n) return [];
  const dim = domain.entities[0].vector.length;
  const means = new Array(dim).fill(0);
  const stds = new Array(dim).fill(0);

  for (let j = 0; j < dim; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += domain.entities[i].vector[j];
    means[j] = s / n;
  }
  for (let j = 0; j < dim; j++) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const d = domain.entities[i].vector[j] - means[j];
      acc += d * d;
    }
    stds[j] = Math.sqrt(acc / Math.max(1, n - 1)) || 1;
  }
  domain.entities.forEach(function (e) {
    e.norm = e.vector.map(function (v, j) {
      return (v - means[j]) / stds[j];
    });
  });
  return { means: means, stds: stds };
}

/* ------------------------------------------------------------------ */
/* Метрики близости                                                   */
/* ------------------------------------------------------------------ */

function euclidean(u, v) {
  let acc = 0;
  const n = Math.min(u.length, v.length);
  for (let i = 0; i < n; i++) {
    const d = u[i] - v[i];
    acc += d * d;
  }
  return Math.sqrt(acc);
}

function manhattan(u, v) {
  let acc = 0;
  const n = Math.min(u.length, v.length);
  for (let i = 0; i < n; i++) acc += Math.abs(u[i] - v[i]);
  return acc;
}

function cosine(u, v) {
  let dot = 0;
  let nu = 0;
  let nv = 0;
  const n = Math.min(u.length, v.length);
  for (let i = 0; i < n; i++) {
    dot += u[i] * v[i];
    nu += u[i] * u[i];
    nv += v[i] * v[i];
  }
  const den = Math.sqrt(nu) * Math.sqrt(nv);
  if (den === 0) return 1;
  return 1 - dot / den; // дистанция
}

function distance(metric, u, v) {
  switch (metric) {
    case 'cosine':
      return cosine(u, v);
    case 'manhattan':
      return manhattan(u, v);
    case 'euclidean':
    default:
      return euclidean(u, v);
  }
}

/* ------------------------------------------------------------------ */
/* Матрица и сопоставление                                            */
/* ------------------------------------------------------------------ */

/** Матрица дистанций между всеми сущностями двух доменов. */
function distanceMatrix(A, B, metric) {
  return A.entities.map(function (a) {
    return B.entities.map(function (b) {
      return distance(metric, a.norm, b.norm);
    });
  });
}

/** Дистанция -> сходство в [0,1] по сигмоиде со сдвигом. */
function similarity(dist, scale) {
  const s = scale > 0 ? scale : 1;
  return 1 / (1 + Math.exp(dist / s - 1));
}

/**
 * Жадное построение паросочетания (best-match assignment):
 * итеративно выбираем наиболее похожую ещё не занятую пару.
 */
function assignPairs(sim, threshold, topK) {
  const rows = sim.length;
  const cols = rows ? sim[0].length : 0;
  const candidates = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      candidates.push({ i: i, j: j, score: sim[i][j] });
    }
  }
  candidates.sort(function (x, y) {
    return y.score - x.score;
  });

  const usedA = Object.create(null);
  const usedB = Object.create(null);
  const pairs = [];
  for (let k = 0; k < candidates.length; k++) {
    const c = candidates[k];
    if (usedA[c.i] || usedB[c.j]) continue;
    if (c.score < threshold) continue;
    usedA[c.i] = true;
    usedB[c.j] = true;
    pairs.push(c);
    if (pairs.length >= topK) break;
  }
  return pairs;
}

/** Выравнивание размерностей: общие и специфичные признаки. */
function compareFeatures(A, B, features) {
  const shared = [];
  const onlyA = [];
  const onlyB = [];
  const setA = A._featureSet;
  const setB = B._featureSet;
  features.forEach(function (f) {
    const inA = setA[f];
    const inB = setB[f];
    if (inA && inB) shared.push(f);
    else if (inA) onlyA.push(f);
    else if (inB) onlyB.push(f);
  });
  return { shared: shared, onlyA: onlyA, onlyB: onlyB };
}

/** Перенос: подобие доменов в целом (нормированное среднее лучших пар). */
function domainAffinity(sim) {
  if (!sim.length) return 0;
  let sum = 0;
  for (let i = 0; i < sim.length; i++) {
    let best = -Infinity;
    for (let j = 0; j < sim[i].length; j++) best = Math.max(best, sim[i][j]);
    sum += isFinite(best) ? best : 0;
  }
  return sum / sim.length;
}

/* ------------------------------------------------------------------ */
/* Главный API                                                        */
/* ------------------------------------------------------------------ */

function crossDomain(a, b, options) {
  const opts = Object.assign(
    {
      features: null,
      metric: 'euclidean',
      threshold: 0.6,
      detailed: false,
      topK: 5,
    },
    options || {}
  );

  const A = normalizeDomain(a, 'domainA');
  const B = normalizeDomain(b, 'domainB');

  const features = detectFeatures([A, B], opts.features);
  materializeVectors(A, features);
  materializeVectors(B, features);

  A._featureSet = indexFeatureSet(A.raws || A.entities, features);
  B._featureSet = indexFeatureSet(B.raws || B.entities, features);

  standardize(A);
  standardize(B);

  const dist = distanceMatrix(A, B, opts.metric);

  // масштаб для перевода дистанции в сходство
  let flat = [];
  for (let i = 0; i < dist.length; i++) {
    for (let j = 0; j < dist[i].length; j++) flat.push(dist[i][j]);
  }
  flat.sort(function (x, y) {
    return x - y;
  });
  const median = flat.length ? flat[Math.floor(flat.length / 2)] : 1;

  const sim = dist.map(function (row) {
    return row.map(function (d) {
      return similarity(d, median || 1);
    });
  });

  const pairs = assignPairs(sim, opts.threshold, opts.topK);

  const mappings = pairs.map(function (p) {
    return {
      from: A.entities[p.i].id,
      to: B.entities[p.j].id,
      similarity: Number(p.score.toFixed(4)),
      source: A.entities[p.i].raw,
      target: B.entities[p.j].raw,
    };
  });

  const featureReport = compareFeatures(A, B, features);

  const result = {
    domains: { a: A.name, b: B.name },
    sizes: { a: A.entities.length, b: B.entities.length },
    metric: opts.metric,
    affinity: Number(domainAffinity(sim).toFixed(4)),
    features: featureReport,
    mappings: mappings,
    transferable: featureReport.shared,
    specificity: {
      a: featureReport.onlyA,
      b: featureReport.onlyB,
    },
  };

  if (opts.detailed) {
    result.matrix = sim.map(function (row) {
      return row.map(function (v) {
        return Number(v.toFixed(4));
      });
    });
    result.rawPairs = pairs;
  }

  return result;
}

/** Индексация множества признаков, реально присутствующих у сущностей. */
function indexFeatureSet(entities, features) {
  const set = Object.create(null);
  features.forEach(function (f) {
    set[f] = false;
  });
  entities.forEach(function (e) {
    const raw = e.raw;
    if (!isPlainObject(raw)) return;
    features.forEach(function (f) {
      if (raw[f] !== undefined && raw[f] !== null) set[f] = true;
    });
  });
  return set;
}

/* ------------------------------------------------------------------ */
/* Экспорт                                                            */
/* ------------------------------------------------------------------ */

module.exports = {
  crossDomain,
  // вспомогательные функции — доступны для тестов
  _internals: {
    normalizeDomain,
    detectFeatures,
    standardize,
    distance,
    distanceMatrix,
    similarity,
    assignPairs,
    compareFeatures,
    domainAffinity,
  },
};

/* ------------------------------------------------------------------ */
/* CLI-демо                                                           */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  const domainA = {
    name: 'biology',
    entities: [
      { id: 'wolf', speed: 60, mass: 40, lifespan: 13 },
      { id: 'rabbit', speed: 45, mass: 2, lifespan: 5 },
      { id: 'tortoise', speed: 0.3, mass: 50, lifespan: 100 },
    ],
  };
  const domainB = {
    name: 'engineering',
    entities: [
      { id: 'sports_car', speed: 330, mass: 1400, lifespan: 15 },
      { id: 'bicycle', speed: 25, mass: 10, lifespan: 8 },
      { id: 'freighter', speed: 12, mass: 90000, lifespan: 40 },
    ],
  };
  const out = crossDomain(domainA, domainB, { detailed: true, topK: 3 });
  console.log(JSON.stringify(out, null, 2));
}
