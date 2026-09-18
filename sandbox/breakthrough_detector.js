'use strict';

/**
 * breakthrough_detector.js
 *
 * Детектор прорывов (breakout detector).
 *
 * Анализирует временной ряд цен и определяет моменты "прорыва" —
 * когда цена выходит за пределы установившегося диапазона
 * с подтверждением по объёму и волатильности.
 *
 * Публичный API: detect(input, options)
 *
 *   input:
 *     - Array<number>                                                (только цены)
 *     - { prices: number[], volumes?: number[], timestamps?: any[] } (серии)
 *
 *   options:
 *     - window      {number}  размер окна диапазона        (default 20)
 *     - sensitivity {number}  множитель сигмы для границ   (default 2)
 *     - minVolRatio {number}  мин. объём к среднему        (default 1.2)
 *     - clusterGap  {number}  макс. разрыв для кластера    (default 3)
 *     - detailed    {boolean} расширенный отчёт            (default false)
 */

/* ------------------------------------------------------------------ */
/* Утилиты                                                            */
/* ------------------------------------------------------------------ */

function isNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function assertSeries(prices) {
  if (!Array.isArray(prices)) {
    throw new TypeError('prices должен быть массивом чисел');
  }
  if (prices.length === 0) {
    throw new RangeError('prices не должен быть пустым');
  }
  for (let i = 0; i < prices.length; i++) {
    if (!isNumber(prices[i])) {
      throw new TypeError('prices[' + i + '] не является конечным числом');
    }
  }
}

function mean(arr, from, to) {
  const n = to - from;
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) sum += arr[i];
  return sum / n;
}

function stddev(arr, from, to) {
  const n = to - from;
  if (n <= 1) return 0;
  const m = mean(arr, from, to);
  let acc = 0;
  for (let i = from; i < to; i++) {
    const d = arr[i] - m;
    acc += d * d;
  }
  return Math.sqrt(acc / (n - 1));
}

function maxOf(arr, from, to) {
  let m = -Infinity;
  for (let i = from; i < to; i++) if (arr[i] > m) m = arr[i];
  return m;
}

function minOf(arr, from, to) {
  let m = Infinity;
  for (let i = from; i < to; i++) if (arr[i] < m) m = arr[i];
  return m;
}

/* ------------------------------------------------------------------ */
/* Обнаружение прорывов                                               */
/* ------------------------------------------------------------------ */

/**
 * Находит точки, где цена выходит за верхнюю границу скользящего
 * диапазона (или опускается ниже нижней) с подтверждением по объёму.
 *
 * @param {number[]} prices  ряд цен
 * @param {number[]|null} volumes ряд объёмов (может быть null)
 * @param {object} opts      параметры (window, sensitivity, minVolRatio)
 * @returns {object[]} список найденных прорывов
 */
function findBreakouts(prices, volumes, opts) {
  const window = opts.window;
  const k = opts.sensitivity;       // множитель сигмы для границ
  const minVolRatio = opts.minVolRatio;
  const results = [];

  for (let i = window; i < prices.length; i++) {
    const from = i - window;
    const to = i;

    const hi = maxOf(prices, from, to);
    const lo = minOf(prices, from, to);
    const mu = mean(prices, from, to);
    const sd = stddev(prices, from, to);

    const upper = Math.max(hi, mu + k * sd);
    const lower = Math.min(lo, mu - k * sd);
    const price = prices[i];

    let direction = null;
    if (price > upper) direction = 'up';
    else if (price < lower) direction = 'down';
    if (!direction) continue;

    // объёмное подтверждение
    let volRatio = 1;
    if (volumes) {
      const avgVol = mean(volumes, from, to);
      const cur = volumes[i] || 0;
      volRatio = avgVol > 0 ? cur / avgVol : 1;
      if (volRatio < minVolRatio) continue;
    }

    const magnitude = direction === 'up'
      ? (price - upper) / (upper || 1)
      : (lower - price) / (lower || 1);

    results.push({
      index: i,
      direction,
      price,
      upper,
      lower,
      sigma: sd,
      volumeRatio: volRatio,
      magnitude,
      strength: scoreStrength(magnitude, volRatio, sd),
    });
  }

  return results;
}

/**
 * Оценка силы прорыва от 0 до 1 по величине, объёму и волатильности.
 */
function scoreStrength(magnitude, volRatio, sigma) {
  const m = Math.min(1, Math.abs(magnitude) * 20);
  const v = Math.min(1, Math.max(0, (volRatio - 1) / 2));
  const s = Math.min(1, sigma > 0 ? Math.abs(magnitude) / sigma : 1);
  return Math.max(0, Math.min(1, 0.5 * m + 0.3 * v + 0.2 * s));
}

/**
 * Кластеризация близких прорывов в события.
 *
 * Соседние прорывы одного направления, разделённые не более чем
 * `maxGap` наблюдениями, объединяются в одно событие. В событии
 * сохраняется пиковый (самый сильный) прорыв.
 *
 * @param {object[]} events  сырые прорывы из findBreakouts()
 * @param {number}   maxGap  макс. разрыв индексов для объединения
 * @returns {object[]} список кластеров-событий
 */
function cluster(events, maxGap) {
  const gap = Number.isFinite(maxGap) && maxGap >= 0 ? maxGap : 0;
  const out = [];
  let cur = null;

  for (const e of events) {
    const sameDir = cur && e.direction === cur.direction;
    const close = cur && (e.index - cur.last) <= gap + 1;

    if (cur && sameDir && close) {
      cur.last = e.index;
      cur.count++;
      cur.totalStrength += e.strength;
      if (e.strength > cur.best) {
        cur.best = e.strength;
        cur.peak = e;
      }
    } else {
      cur = {
        direction: e.direction,
        first: e.index,
        last: e.index,
        count: 1,
        best: e.strength,
        totalStrength: e.strength,
        peak: e,
      };
      out.push(cur);
    }
  }

  // зафиксировать усреднённую силу по каждому событию
  for (const c of out) {
    c.avgStrength = c.count > 0 ? c.totalStrength / c.count : 0;
    delete c.totalStrength;
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Публичный API                                                      */
/* ------------------------------------------------------------------ */

/**
 * detect(input, options) — главная точка входа детектора прорывов.
 *
 * @param {number[]|object} input   ряд цен либо объект с сериями
 * @param {object} [options]        параметры детекции
 * @returns {object} результат детекции
 */
function detect(input, options) {
  const opts = Object.assign({
    window: 20,
    sensitivity: 2,
    minVolRatio: 1.2,
    clusterGap: 3,
    detailed: false,
  }, options || {});

  let prices;
  let volumes = null;

  if (Array.isArray(input)) {
    prices = input;
  } else if (input && typeof input === 'object') {
    prices = input.prices;
    if (Array.isArray(input.volumes)) volumes = input.volumes;
  }

  assertSeries(prices);

  if (volumes && volumes.length !== prices.length) {
    throw new RangeError('длины prices и volumes должны совпадать');
  }

  const window = Math.max(2, Math.min(opts.window, prices.length - 1));
  const effective = Object.assign({}, opts, { window });

  const raw = findBreakouts(prices, volumes, effective);
  const clusters = cluster(raw, opts.clusterGap);

  const up = clusters.filter((c) => c.direction === 'up').length;
  const down = clusters.filter((c) => c.direction === 'down').length;

  const result = {
    ok: true,
    points: raw.length,
    events: clusters.length,
    up,
    down,
    lastPrice: prices[prices.length - 1],
    lastDirection: clusters.length
      ? clusters[clusters.length - 1].direction
      : null,
    clusters,
    detectedAt: new Date().toISOString(),
  };

  if (opts.detailed) {
    result.raw = raw;
    result.options = effective;
    result.stats = {
      avgStrength: raw.length
        ? raw.reduce((a, e) => a + e.strength, 0) / raw.length
        : 0,
      maxMagnitude: raw.reduce((a, e) => Math.max(a, e.magnitude), 0),
    };
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Экспорт                                                            */
/* ------------------------------------------------------------------ */

module.exports = {
  detect,
  // вспомогательные функции — доступны для тестирования
  _internals: { findBreakouts, cluster, scoreStrength, mean, stddev },
};

/* ------------------------------------------------------------------ */
/* CLI-демо                                                           */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  const demo = [
    10, 10.2, 9.9, 10.1, 10, 10.2, 9.8, 10.1, 10.3, 10, 10.1,
    9.9, 10.2, 10, 10.1, 9.9, 10.3, 10.1, 10, 10.2, 13.5, 13.8, 14.2, 14.0,
  ];
  const out = detect(demo, { window: 10, detailed: true });
  console.log(JSON.stringify(out, null, 2));
}
