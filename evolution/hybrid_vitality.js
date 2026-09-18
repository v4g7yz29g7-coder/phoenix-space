#!/usr/bin/env node
/**
 * evolution/hybrid_vitality.js — Гибридная сила (Hybrid Vitality / Heterosis)
 * ============================================================================
 * Назначение:
 *   Измеряет «гибридную силу» (гетерозис) агента и его потомков. Модуль
 *   объединяет два взгляда на жизнеспособность:
 *
 *   1. АНСАМБЛЬ ПОТОКОВ. Жизнеспособность агента раскладывается на пять
 *      независимых «потоков» (streams):
 *        energy, resilience, coherence, adaptability, symbiosis.
 *      Каждый поток нормируется в [0,1], взвешивается и сводится в базовый
 *      уровень (base). Затем поверх считается СИНЕРГИЯ — эффект того, что
 *      согласованный ансамбль потоков даёт больше, чем сумма частей
 *      (synergy всегда >= 1).
 *
 *          vitality = clamp(base * synergy, 0, 1)
 *
 *   2. ГИБРИДИЗАЦИЯ ГЕНОМОВ. Два набора признаков (родители) скрещиваются
 *      в гибридный геном с доминированием и «гетерозисным импульсом»
 *      (hybrid vigor). Гетерозис измеряется превышением гибрида над средним
 *      родителем (MPH) и над лучшим родителем (BPH), а также коэффициентом
 *      гетерозиготности.
 *
 * Публичный API (модуль):
 *   - analyze(ctx, options)              -> VitalityReport     (основная функция)
 *   - hybridize(parentA, parentB, opts)  -> Hybrid
 *   - heterosis(parentA, parentB, opts)  -> HeterosisReport
 *   - createDefault(options)             -> VitalityEngine
 *   - VitalityEngine, Hybrid             классы
 *   - configure(options)                 -> config
 *   - stats()                            -> object
 *   - reset()                            -> this
 *
 * Модель VitalityReport:
 *   {
 *     vitality, base, synergy, harmony, spread,
 *     grade, gradeLabel, streamCount,
 *     dominantStream, weakestStream, streams[], ts
 *   }
 *
 * Всё детерминировано: время и ГПСЧ инъектируются через configure().
 * ----------------------------------------------------------------------------
 */

'use strict';

/* -------------------------------------------------------------------------- */
/* Константы                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Пять потоков жизнеспособности. Порядок фиксирован и определяет streamCount.
 * scale: 'percent' — сырое значение 0..100 приводится к 0..1;
 *        'unit'    — значение уже в диапазоне 0..1.
 */
const STREAMS = Object.freeze([
  Object.freeze({ key: 'energy',       label: 'энергия',       weight: 1.00, scale: 'percent' }),
  Object.freeze({ key: 'resilience',   label: 'устойчивость',  weight: 0.90, scale: 'unit'    }),
  Object.freeze({ key: 'coherence',    label: 'когерентность', weight: 0.80, scale: 'unit'    }),
  Object.freeze({ key: 'adaptability', label: 'адаптивность',  weight: 0.70, scale: 'unit'    }),
  Object.freeze({ key: 'symbiosis',    label: 'симбиоз',       weight: 0.60, scale: 'unit'    }),
]);

/** Классы жизнеспособности (по убыванию порога). */
const GRADES = Object.freeze([
  Object.freeze({ key: 'elite',    min: 0.90, label: 'элитный гибрид' }),
  Object.freeze({ key: 'vigorous', min: 0.75, label: 'мощный'         }),
  Object.freeze({ key: 'healthy',  min: 0.55, label: 'здоровый'       }),
  Object.freeze({ key: 'fragile',  min: 0.35, label: 'хрупкий'        }),
  Object.freeze({ key: 'weak',     min: 0.15, label: 'слабый'         }),
  Object.freeze({ key: 'lethal',   min: 0.00, label: 'летальный'      }),
]);

/** Виды гетерозиса. */
const HETEROSIS_KIND = Object.freeze({
  NEGATIVE: 'negative',      // инбредная депрессия
  NONE: 'none',              // нейтрально
  MID: 'mid-parent',         // превосходит среднего родителя
  BEST: 'best-parent',       // превосходит лучшего родителя
});

const DEFAULTS = Object.freeze({
  synergyGain: 0.40,         // сила синергии ансамбля потоков
  dominance: 0.60,           // базовое доминирование родителя A
  hybridVigor: 0.15,         // гетерозисный импульс при скрещивании
  heteroEpsilon: 0.05,       // порог различия аллелей для гетерозиготности
  historyLimit: 100,         // максимум записей в модульной истории
  weights: null,             // переопределение весов потоков { key: weight }
});

/* -------------------------------------------------------------------------- */
/* Внутреннее состояние модуля                                                 */
/* -------------------------------------------------------------------------- */

let _config = Object.assign({}, DEFAULTS);
let _now = () => Date.now();
let _rng = Math.random;
let _seq = 0;
const _history = [];
const _counters = { analyzes: 0, hybrids: 0 };

/* -------------------------------------------------------------------------- */
/* Утилиты                                                                     */
/* -------------------------------------------------------------------------- */

/** Безопасное число. */
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Ограничение диапазоном [min, max]. */
function clamp(value, min = 0, max = 1) {
  const n = num(value, min);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Среднее арифметическое. */
function mean(list) {
  if (!Array.isArray(list) || list.length === 0) return 0;
  return list.reduce((acc, v) => acc + num(v), 0) / list.length;
}

/** Стандартное отклонение. */
function stdDev(list) {
  if (!Array.isArray(list) || list.length === 0) return 0;
  const m = mean(list);
  return Math.sqrt(mean(list.map((v) => (num(v) - m) ** 2)));
}

/** Округление до 6 знаков. */
function round6(x) {
  return Math.round(num(x) * 1e6) / 1e6;
}

/**
 * Приводит сырое значение потока к [0,1].
 * 'percent': большие единицы трактуются как проценты (0..100).
 */
function toUnit(value, scale = 'unit') {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (scale === 'percent' && n > 1) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
}

/** Эвристика: ключ признака, который логично воспринимать как проценты. */
function isPercentKey(key) {
  return /^(energy|power|health|hp|mass|scale|strength)/i.test(String(key));
}

/** Короткий уникальный идентификатор. */
function shortId(prefix = 'hv') {
  _seq += 1;
  const t = Math.floor(num(_now(), 0) % 100000).toString(36);
  return `${prefix}${_seq.toString(36)}${t}`;
}

/** Класс жизнеспособности по значению. */
function gradeFor(value) {
  const x = clamp(value, 0, 1);
  for (const g of GRADES) {
    if (x >= g.min) return g.key;
  }
  return GRADES[GRADES.length - 1].key;
}

/** Человекочитаемая метка класса. */
function gradeLabel(key) {
  const g = GRADES.find((x) => x.key === key);
  return g ? g.label : String(key);
}

/* -------------------------------------------------------------------------- */
/* Поток 1: ансамбль потоков жизнеспособности                                  */
/* -------------------------------------------------------------------------- */

/**
 * Основная функция. Оценивает гибридную силу агента/контекста.
 *
 * @param {object} ctx      { energy, resilience, coherence, adaptability, symbiosis }
 * @param {object} options  { synergyGain, weights }
 * @returns {object} VitalityReport
 */
function analyze(ctx = {}, options = {}) {
  const context = (ctx && typeof ctx === 'object') ? ctx : {};
  const opts = (options && typeof options === 'object') ? options : {};
  const weights = opts.weights || _config.weights || {};

  const rows = STREAMS.map((s) => {
    const raw = context[s.key];
    const value = toUnit(raw, s.scale);
    const weight = Math.abs(num(weights[s.key], s.weight)) || s.weight;
    return {
      key: s.key,
      label: s.label,
      raw: Number.isFinite(Number(raw)) ? Number(raw) : null,
      value,
      weight,
      contribution: value * weight,
    };
  });

  const totalWeight = rows.reduce((acc, r) => acc + r.weight, 0) || 1;
  const base = rows.reduce((acc, r) => acc + r.contribution, 0) / totalWeight;
  const values = rows.map((r) => r.value);
  const spread = stdDev(values);
  const harmony = clamp(1 - spread, 0, 1);

  // Синергия: согласованный ансамбль даёт прирост. Всегда >= 1.
  const gain = Math.max(0, num(opts.synergyGain, _config.synergyGain));
  const synergy = 1 + gain * harmony * clamp(base * 1.5, 0, 1);
  const vitality = clamp(base * synergy, 0, 1);
  const grade = gradeFor(vitality);

  const dominant = rows.reduce((b, r) => (r.contribution > b.contribution ? r : b), rows[0]);
  const weakest = rows.reduce((b, r) => (r.value < b.value ? r : b), rows[0]);

  const report = {
    vitality: round6(vitality),
    base: round6(base),
    synergy: round6(synergy),
    harmony: round6(harmony),
    spread: round6(spread),
    grade,
    gradeLabel: gradeLabel(grade),
    streamCount: rows.length,
    dominantStream: dominant.key,
    weakestStream: weakest.key,
    streams: rows.map((r) => ({
      key: r.key,
      label: r.label,
      raw: r.raw,
      value: round6(r.value),
      weight: r.weight,
      contribution: round6(r.contribution),
    })),
    ts: num(_now(), 0),
  };

  _counters.analyzes += 1;
  _history.push(report);
  if (_history.length > _config.historyLimit) _history.shift();
  return report;
}

/* -------------------------------------------------------------------------- */
/* Поток 2: гибридизация геномов                                               */
/* -------------------------------------------------------------------------- */

/** Нормирует карту признаков в [0,1]. */
function normGenes(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    out[k] = toUnit(v, isPercentKey(k) ? 'percent' : 'unit');
  }
  return out;
}

/** Гибридный геном, полученный от двух родителей. */
class Hybrid {
  constructor(parentA = {}, parentB = {}, options = {}) {
    const opts = (options && typeof options === 'object') ? options : {};
    this.id = opts.id || shortId('hy');
    this.dominance = clamp(num(opts.dominance, _config.dominance), 0, 1);
    this.a = normGenes(parentA);
    this.b = normGenes(parentB);
    this.weights = opts.weights || {};
    this.genes = {};

    const keys = Array.from(
      new Set([...Object.keys(this.a), ...Object.keys(this.b)]),
    ).sort();

    for (const key of keys) {
      const hasA = Object.prototype.hasOwnProperty.call(this.a, key);
      const hasB = Object.prototype.hasOwnProperty.call(this.b, key);
      const va = hasA ? this.a[key] : this.b[key];
      const vb = hasB ? this.b[key] : this.a[key];
      const dom = clamp(num(this.weights[key], this.dominance), 0, 1);
      const mid = dom * va + (1 - dom) * vb;
      const diff = Math.abs(va - vb);
      const boost = (hasA && hasB)
        ? Math.max(0, num(opts.hybridVigor, _config.hybridVigor)) * diff * Math.max(va, vb)
        : 0;
      this.genes[key] = clamp(mid + boost, 0, 1);
    }
    this.createdAt = num(_now(), 0);
    _counters.hybrids += 1;
  }

  /** Список признаков гибрида. */
  outline() {
    return Object.keys(this.genes);
  }

  /** Фенотип гибрида, нормированный в [0,1]. */
  express() {
    const out = {};
    for (const k of Object.keys(this.genes)) out[k] = clamp(this.genes[k], 0, 1);
    return out;
  }

  /** Значение одного признака либо null. */
  gene(key) {
    return Object.prototype.hasOwnProperty.call(this.genes, key)
      ? this.genes[key]
      : null;
  }

  /** Доля гетерозиготных (различающихся) локусов. */
  heterozygosity(eps = _config.heteroEpsilon) {
    const keys = this.outline();
    if (keys.length === 0) return 0;
    let h = 0;
    for (const k of keys) {
      const hasA = Object.prototype.hasOwnProperty.call(this.a, k);
      const hasB = Object.prototype.hasOwnProperty.call(this.b, k);
      if (hasA && hasB) {
        if (Math.abs(this.a[k] - this.b[k]) > eps) h += 1;
      } else if (hasA !== hasB) {
        h += 1;
      }
    }
    return round6(h / keys.length);
  }

  /** Копии родительских геномов. */
  parents() {
    return { a: Object.assign({}, this.a), b: Object.assign({}, this.b) };
  }

  /** Краткий отчёт о гибриде. */
  report() {
    const genes = this.express();
    const values = Object.keys(genes).map((k) => genes[k]);
    return {
      id: this.id,
      dominance: this.dominance,
      genes,
      geneCount: values.length,
      meanGene: round6(mean(values)),
      heterozygosity: this.heterozygosity(),
      ts: this.createdAt,
    };
  }
}

/** Скрещивает двух родителей в гибрид. */
function hybridize(parentA = {}, parentB = {}, options = {}) {
  return new Hybrid(parentA, parentB, options);
}

/**
 * Гетерозис между двумя картами признаков.
 * MPH — превышение над средним родителем, BPH — над лучшим родителем.
 */
function heterosis(parentA = {}, parentB = {}, options = {}) {
  const child = hybridize(parentA, parentB, options);
  const ga = child.a;
  const gb = child.b;
  const gc = child.genes;
  const keys = child.outline();

  const midList = [];
  const bestList = [];
  const hybridList = [];
  for (const k of keys) {
    const hasA = Object.prototype.hasOwnProperty.call(ga, k);
    const hasB = Object.prototype.hasOwnProperty.call(gb, k);
    const va = hasA ? ga[k] : (hasB ? gb[k] : 0);
    const vb = hasB ? gb[k] : (hasA ? ga[k] : 0);
    midList.push((va + vb) / 2);
    bestList.push(Math.max(va, vb));
    hybridList.push(gc[k]);
  }

  const hybridMean = mean(hybridList);
  const midParent = mean(midList);
  const bestParent = mean(bestList);
  const mph = hybridMean - midParent;
  const bph = hybridMean - bestParent;

  let kind = HETEROSIS_KIND.NONE;
  if (mph > 1e-6 && bph > 1e-6) kind = HETEROSIS_KIND.BEST;
  else if (mph > 1e-6) kind = HETEROSIS_KIND.MID;
  else if (mph < -1e-6) kind = HETEROSIS_KIND.NEGATIVE;

  return {
    id: child.id,
    hybridMean: round6(hybridMean),
    midParent: round6(midParent),
    bestParent: round6(bestParent),
    midParentHeterosis: round6(mph),
    bestParentHeterosis: round6(bph),
    heterozygosity: child.heterozygosity(),
    kind,
    genes: child.express(),
  };
}

/* -------------------------------------------------------------------------- */
/* Движок с историей и трендом                                                 */
/* -------------------------------------------------------------------------- */

class VitalityEngine {
  constructor(options = {}) {
    const opts = (options && typeof options === 'object') ? options : {};
    this.label = String(opts.label || 'engine');
    this.maxHistory = Math.max(1, Math.floor(num(opts.maxHistory, 50)));
    this.options = opts;
    this.history = [];
    this.hybrids = 0;
    this._seq = 0;
  }

  /** Анализирует контекст и складывает отчёт в ограниченную историю. */
  analyze(ctx = {}) {
    const report = analyze(ctx, this.options);
    this._seq += 1;
    report.engine = this.label;
    report.run = this._seq;
    this.history.push(report);
    while (this.history.length > this.maxHistory) this.history.shift();
    return report;
  }

  /** Последний отчёт либо null. */
  latest() {
    return this.history.length ? this.history[this.history.length - 1] : null;
  }

  /** Средняя жизнеспособность по истории. */
  meanVitality() {
    return mean(this.history.map((r) => r.vitality));
  }

  /** Лучший результат. */
  best() {
    return this.history.reduce((m, r) => Math.max(m, num(r.vitality)), 0);
  }

  /** Худший результат. */
  worst() {
    return this.history.length
      ? this.history.reduce((m, r) => Math.min(m, num(r.vitality)), 1)
      : 0;
  }

  /** Наклон линейного тренда жизнеспособности (метод наименьших квадратов). */
  trend() {
    const n = this.history.length;
    if (n < 2) return 0;
    const ys = this.history.map((r) => num(r.vitality));
    const xs = ys.map((_, i) => i);
    const mx = mean(xs);
    const my = mean(ys);
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i += 1) {
      numerator += (xs[i] - mx) * (ys[i] - my);
      denominator += (xs[i] - mx) ** 2;
    }
    return denominator === 0 ? 0 : round6(numerator / denominator);
  }

  /** Гибридизация в контексте движка. */
  analyzeHybrid(parentA = {}, parentB = {}, options = {}) {
    this.hybrids += 1;
    const h = heterosis(parentA, parentB, options);
    return {
      hybrid: true,
      id: h.id,
      genes: h.genes,
      heterosis: h,
      engine: this.label,
      run: this.hybrids,
      ts: num(_now(), 0),
    };
  }

  /** Сводная статистика движка. */
  stats() {
    return {
      label: this.label,
      runs: this.history.length,
      historySize: this.history.length,
      maxHistory: this.maxHistory,
      meanVitality: round6(this.meanVitality()),
      bestVitality: round6(this.best()),
      worstVitality: round6(this.worst()),
      trend: this.trend(),
      hybrids: this.hybrids,
    };
  }

  reset() {
    this.history.length = 0;
    this.hybrids = 0;
    this._seq = 0;
    return this;
  }
}

/** Фабрика движка по умолчанию. */
function createDefault(options = {}) {
  return new VitalityEngine(options);
}

/* -------------------------------------------------------------------------- */
/* Конфигурация и модульная статистика                                         */
/* -------------------------------------------------------------------------- */

/** Инъекция зависимостей и переопределение параметров. */
function configure(options = {}) {
  if (options && typeof options === 'object') {
    if (typeof options.now === 'function') _now = options.now;
    if (typeof options.rng === 'function') _rng = options.rng;
    _config = Object.assign({}, _config, options);
    _config.weights = options.weights || _config.weights || null;
  }
  return Object.assign({}, _config);
}

/** Модульная статистика. */
function stats() {
  return {
    analyzes: _counters.analyzes,
    hybrids: _counters.hybrids,
    historySize: _history.length,
    lastVitality: _history.length ? _history[_history.length - 1].vitality : 0,
    config: Object.assign({}, _config),
  };
}

/** Полный сброс состояния модуля. */
function reset() {
  _config = Object.assign({}, DEFAULTS);
  _now = () => Date.now();
  _rng = Math.random;
  _seq = 0;
  _history.length = 0;
  _counters.analyzes = 0;
  _counters.hybrids = 0;
  return module.exports;
}

/* -------------------------------------------------------------------------- */
/* Экспорт                                                                     */
/* -------------------------------------------------------------------------- */

module.exports = {
  analyze,
  hybridize,
  heterosis,
  Hybrid,
  VitalityEngine,
  createDefault,
  configure,
  stats,
  reset,
  STREAMS,
  GRADES,
  HETEROSIS_KIND,
  DEFAULTS,
  _internals: { toUnit, stdDev, gradeFor, normGenes, clamp, mean },
};

/* -------------------------------------------------------------------------- */
/* CLI: демонстрационный прогон                                                */
/* -------------------------------------------------------------------------- */

if (require.main === module) {
  const report = analyze({
    energy: 82,
    resilience: 0.91,
    coherence: 0.73,
    adaptability: 0.64,
    symbiosis: 0.55,
  });
  console.log('[hybrid_vitality] report:', JSON.stringify(report, null, 2));

  const child = hybridize(
    { speed: 0.9, power: 0.8 },
    { speed: 0.3, power: 0.4, agility: 0.7 },
  );
  console.log('[hybrid_vitality] hybrid:', JSON.stringify(child.report(), null, 2));
  console.log('[hybrid_vitality] heterosis:', JSON.stringify(
    heterosis({ speed: 0.9, power: 0.8 }, { speed: 0.3, power: 0.4, agility: 0.7 }),
    null,
    2,
  ));

  const engine = createDefault({ label: 'demo', maxHistory: 3 });
  for (let i = 0; i < 5; i += 1) {
    engine.analyze({ energy: i * 20, resilience: i / 5, coherence: 0.5 });
  }
  console.log('[hybrid_vitality] engine:', JSON.stringify(engine.stats(), null, 2));
}
