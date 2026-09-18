#!/usr/bin/env node
/**
 * evolution/mycologist_signal.js — Сигнальная сеть мицелия (Mycologist Signal Grid)
 * ============================================================================
 * Назначение:
 *   Мицелий — распределённая сеть гиф, по которой между узлами (агентами)
 *   бегут химические и электрические сигналы: питание, тревога, споры,
 *   синхронизация, приказы о росте и распаде. Модуль моделирует эту сеть и
 *   даёт простой API для испускания сигналов по «путям восхождения».
 *
 *   Модуль моделирует:
 *     1. Узлы (агенты) и гифы (каналы) между ними.
 *     2. Сигналы с типами, приоритетом, TTL и нагрузкой (payload).
 *     3. Проводимость гиф: затор растёт от нагрузки и рассасывается пульсом.
 *     4. Маршрутизацию: кратчайший путь, надёжность и задержка доставки.
 *     5. Подписки (on/off) и «подслушивание» узла (eavesdrop).
 *     6. Интроспекцию: история, статистика, снимок, экспорт (dump).
 *
 * Публичный API (модуль):
 *   - emitSignal(from, to, type, payload) -> Signal     ГЛАВНЫЙ API
 *   - pulse(from, to, type, payload)                    Синоним emitSignal
 *   - broadcast(from, type, payload) -> Signal[]
 *   - trace(from, to, type, payload) -> { signal, path, hops }
 *   - route(a, b) -> { path, distance, reliability }
 *   - noop() -> undefined                              Отсутствие сигнала
 *
 * Публичный API (класс):
 *   - new MyceliumSignalGrid(options)
 *   - grid.emitSignal(from, to, type, payload) -> Signal
 *   - grid.seed(id, meta) / grid.growHypha(a, b, opts) / grid.route(a, b)
 *   - grid.broadcast(from, type, payload) / grid.trace(from, to, type, payload)
 *   - grid.on(type, fn) -> unsubscribe / grid.off(type, fn)
 *   - grid.eavesdrop(id, limit) / grid.history(filter) / grid.stats()
 *   - grid.decay(dt) / grid.pulse() / grid.snapshot() / grid.dump() / grid.reset()
 *   - MyceliumSignalGrid.create(options), MyceliumSignalGrid.reset()
 *
 * Детерминизм: now и rng инъектируются через configure({ now, rng }).
 * ----------------------------------------------------------------------------
 */

'use strict';

/* -------------------------------------------------------------------------- */
/* Константы                                                                   */
/* -------------------------------------------------------------------------- */

const SIGNAL_TYPES = Object.freeze({
  SPORE: 'spore',         // рассеивание спор / идеи наружу
  NUTRIENT: 'nutrient',   // передача ресурсов
  WARNING: 'warning',     // тревога, патоген, ошибка
  SYNC: 'sync',           // синхронизация состояния
  GROWTH: 'growth',       // приказ о росте гифы
  DECAY: 'decay',         // сигнал распада / очистки
  PING: 'ping',           // простой такт жизни
});

const PRIORITY = Object.freeze({
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  CRITICAL: 3,
});

/** Тип сигнала -> приоритет по умолчанию. */
const TYPE_PRIORITY = Object.freeze({
  [SIGNAL_TYPES.WARNING]: PRIORITY.CRITICAL,
  [SIGNAL_TYPES.GROWTH]: PRIORITY.HIGH,
  [SIGNAL_TYPES.NUTRIENT]: PRIORITY.HIGH,
  [SIGNAL_TYPES.SYNC]: PRIORITY.NORMAL,
  [SIGNAL_TYPES.SPORE]: PRIORITY.NORMAL,
  [SIGNAL_TYPES.DECAY]: PRIORITY.LOW,
  [SIGNAL_TYPES.PING]: PRIORITY.LOW,
});

const DEFAULTS = {
  ttl: 60000,             // время жизни сигнала, мс
  maxHistory: 10000,      // предел журнала
  baseBandwidth: 1.0,     // пропускная способность новой гифы
  congestionStep: 0.1,    // насколько затор растёт за сигнал
  relaxation: 0.05,       // насколько затор спадает за такт
  lossFactor: 0.08,       // базовые потери проводимости
  latency: 1,             // базовая задержка на гифу, мс
  now: null,              // () => number
  rng: null,              // () => number in [0,1)
};

/* -------------------------------------------------------------------------- */
/* Вспомогательное                                                             */
/* -------------------------------------------------------------------------- */

let _sequence = 0;

function uid(prefix) {
  _sequence += 1;
  return `${prefix}-${_sequence.toString(36)}-${(Date.now() % 1e7).toString(36)}`;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function round(value, digits) {
  const k = Math.pow(10, digits == null ? 4 : digits);
  return Math.round(value * k) / k;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && isFinite(value);
}

function assertNonEmptyString(value, label) {
  if (!value || typeof value !== 'string') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function normalizeType(type) {
  const value = String(type || '').trim().toLowerCase();
  return value.length ? value : SIGNAL_TYPES.PING;
}

/* -------------------------------------------------------------------------- */
/* Hypha — канал (гифа) между двумя узлами                                     */
/* -------------------------------------------------------------------------- */

class Hypha {
  constructor(from, to, options) {
    const opts = options || {};
    this.from = from;
    this.to = to;
    this.bandwidth = isFiniteNumber(opts.bandwidth) ? opts.bandwidth : DEFAULTS.baseBandwidth;
    this.congestion = isFiniteNumber(opts.congestion) ? opts.congestion : 0;
    this.latency = isFiniteNumber(opts.latency) ? opts.latency : DEFAULTS.latency;
    this.transmitted = 0;
    this.dropped = 0;
    this.lastAt = null;
    this.createdAt = Date.now();
  }

  key() {
    return `${this.from}->${this.to}`;
  }

  /** Проводимость канала: падает с ростом затора и базовых потерь. */
  conductance() {
    const healthy = 1 - DEFAULTS.lossFactor;
    return clamp(this.bandwidth * healthy * (1 - this.congestion), 0, 1);
  }

  /** Сколько тактов (мс) летит сигнал по этой гифе. */
  delay() {
    return round(this.latency / Math.max(0.05, this.conductance()), 3);
  }

  /** Принять сигнал: поднять затор, учесть пропускную способность. */
  carry(signal) {
    const load = 1 - this.conductance();
    const boost = 1 + (signal.priority || 0) / 10;
    this.congestion = clamp(this.congestion + load * DEFAULTS.congestionStep * boost, 0, 1);
    this.transmitted += 1;
    this.lastAt = signal.at;
    return this;
  }

  /** Сигнал потерялся в заторе — гифа «пересохла». */
  drop() {
    this.dropped += 1;
    this.congestion = clamp(this.congestion + DEFAULTS.congestionStep, 0, 1);
    return this;
  }

  /** Естественное «дыхание»: затор медленно рассасывается. */
  relax(dt) {
    const step = DEFAULTS.relaxation * (isFiniteNumber(dt) ? dt : 1);
    this.congestion = clamp(this.congestion - step, 0, 1);
    return this;
  }

  toJSON() {
    return {
      from: this.from,
      to: this.to,
      bandwidth: this.bandwidth,
      congestion: round(this.congestion),
      conductance: round(this.conductance()),
      latency: this.latency,
      delay: this.delay(),
      transmitted: this.transmitted,
      dropped: this.dropped,
      lastAt: this.lastAt,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Signal — летящий по сети пакет данных                                       */
/* -------------------------------------------------------------------------- */

class Signal {
  constructor(fields) {
    const f = fields || {};
    this.id = f.id || uid('sig');
    this.from = f.from;
    this.to = f.to;
    this.type = f.type;
    this.payload = f.payload === undefined ? {} : f.payload;
    this.priority = isFiniteNumber(f.priority) ? f.priority : (TYPE_PRIORITY[f.type] || PRIORITY.NORMAL);
    this.path = Array.isArray(f.path) ? f.path.slice() : [f.from, f.to];
    this.at = isFiniteNumber(f.at) ? f.at : Date.now();
    this.ttl = isFiniteNumber(f.ttl) ? f.ttl : DEFAULTS.ttl;
    this.hops = isFiniteNumber(f.hops) ? f.hops : 1;
    this.delivered = f.delivered !== false;
    Object.freeze(this);
  }

  isExpired(now) {
    return (isFiniteNumber(now) ? now : Date.now()) - this.at > this.ttl;
  }

  age(now) {
    return (isFiniteNumber(now) ? now : Date.now()) - this.at;
  }

  toString() {
    return `[${this.type}] ${this.from}->${this.to} (${this.id})`;
  }

  toJSON() {
    return {
      id: this.id,
      from: this.from,
      to: this.to,
      type: this.type,
      priority: this.priority,
      payload: this.payload,
      path: this.path,
      at: this.at,
      ttl: this.ttl,
      hops: this.hops,
      delivered: this.delivered,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* MyceliumSignalGrid — ядро сети                                              */
/* -------------------------------------------------------------------------- */

class MyceliumSignalGrid {
  constructor(options) {
    const opts = options || {};
    this.nodes = new Map();       // id -> { id, joined, pulse, meta }
    this.hyphae = new Map();      // "a->b" -> Hypha
    this.history = [];            // все испущенные сигналы
    this.listeners = new Map();   // type -> [fn]
    this.undelivered = [];        // сигналы, потерянные в заторе
    this.maxHistory = isFiniteNumber(opts.maxHistory) ? opts.maxHistory : DEFAULTS.maxHistory;
    this.ttl = isFiniteNumber(opts.ttl) ? opts.ttl : DEFAULTS.ttl;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  }

  /* ------------------------------ узлы ---------------------------------- */

  /** Регистрация узла (агента) в сети. Идемпотентно. */
  seed(nodeId, meta) {
    assertNonEmptyString(nodeId, 'seed: nodeId');
    if (!this.nodes.has(nodeId)) {
      this.nodes.set(nodeId, {
        id: nodeId,
        joined: this.now(),
        pulse: 0,
        received: 0,
        meta: meta || {},
      });
    } else if (meta && typeof meta === 'object') {
      Object.assign(this.nodes.get(nodeId).meta, meta);
    }
    return this.nodes.get(nodeId);
  }

  hasNode(nodeId) {
    return this.nodes.has(nodeId);
  }

  nodeIds() {
    return [...this.nodes.keys()];
  }

  /* ------------------------------ гифы ---------------------------------- */

  /** Прорастить гифу между узлами (создаётся лениво, если её нет). */
  growHypha(from, to, options) {
    assertNonEmptyString(from, 'growHypha: from');
    assertNonEmptyString(to, 'growHypha: to');
    const key = `${from}->${to}`;
    if (!this.hyphae.has(key)) {
      this.hyphae.set(key, new Hypha(from, to, options));
    } else if (options && typeof options === 'object') {
      const hypha = this.hyphae.get(key);
      if (isFiniteNumber(options.bandwidth)) hypha.bandwidth = options.bandwidth;
      if (isFiniteNumber(options.congestion)) hypha.congestion = options.congestion;
      if (isFiniteNumber(options.latency)) hypha.latency = options.latency;
    }
    return this.hyphae.get(key);
  }

  link(from, to, options) {
    return this.growHypha(from, to, options);
  }

  /* ---------------------------- ГЛАВНЫЙ API ----------------------------- */

  /**
   * emitSignal(from, to, type, payload) — испустить сигнал по мицелию.
   *
   * @param {string} from    идентификатор отправляющего узла
   * @param {string} to      идентификатор принимающего узла
   * @param {string} type    тип сигнала (см. SIGNAL_TYPES)
   * @param {object|any} payload полезная нагрузка
   * @returns {Signal}
   */
  emitSignal(from, to, type, payload) {
    assertNonEmptyString(from, 'emitSignal: from');
    assertNonEmptyString(to, 'emitSignal: to');
    const kind = normalizeType(type);
    const body = payload === undefined || payload === null ? {} : payload;

    this.seed(from);
    this.seed(to);

    const route = this.route(from, to);
    const path = route && route.path ? route.path : [from, to];
    const hypha = this.growHypha(from, to);

    const signal = new Signal({
      id: uid('sig'),
      from,
      to,
      type: kind,
      payload: body,
      priority: isFiniteNumber(body && body.priority) ? body.priority : (TYPE_PRIORITY[kind] || PRIORITY.NORMAL),
      path,
      at: this.now(),
      ttl: isFiniteNumber(body && body.ttl) ? body.ttl : this.ttl,
      hops: Math.max(1, path.length - 1),
      delivered: true,
    });

    // Гифа могла «пересохнуть» — тогда сигнал теряется.
    if (hypha.conductance() < 0.15 && this.rng() > hypha.conductance() + 0.2) {
      hypha.drop();
      const lost = new Signal(Object.assign({}, signal, { delivered: false }));
      this._record(lost);
      this._notify(lost);
      return lost;
    }

    hypha.carry(signal);
    this.nodes.get(from).pulse += 1;
    this.nodes.get(to).received += 1;
    this._record(signal);
    this._notify(signal);
    return signal;
  }

  /** Синоним emitSignal — «пульс» по гифе. */
  pulse(from, to, type, payload) {
    if (typeof to === 'string' && typeof from === 'string' && type === undefined) {
      // pulse(from, type, payload) -> в самого себя (такт жизни).
      return this.emitSignal(from, from, to, payload);
    }
    return this.emitSignal(from, to, type, payload);
  }

  _record(signal) {
    this.history.push(signal);
    if (signal.delivered === false) this.undelivered.push(signal);
    if (this.history.length > this.maxHistory) this.history.shift();
    if (this.undelivered.length > this.maxHistory) this.undelivered.shift();
  }

  /* ----------------------------- подписки ------------------------------- */

  _notify(signal) {
    const subs = (this.listeners.get(signal.type) || []).concat(this.listeners.get('*') || []);
    for (const fn of subs) {
      try {
        fn(signal);
      } catch (err) {
        if (signal.type !== SIGNAL_TYPES.WARNING) {
          this._notify(new Signal({
            from: 'grid',
            to: signal.to,
            type: SIGNAL_TYPES.WARNING,
            payload: { error: String(err), source: signal.id },
            at: signal.at,
          }));
        }
      }
    }
    return signal;
  }

  /** Подписка на тип сигнала. Возвращает функцию отписки. */
  on(type, fn) {
    if (typeof fn !== 'function') throw new TypeError('on: fn must be a function');
    const key = type === '*' ? '*' : normalizeType(type);
    const list = this.listeners.get(key) || [];
    list.push(fn);
    this.listeners.set(key, list);
    return () => this.off(key, fn);
  }

  once(type, fn) {
    const off = this.on(type, (signal) => {
      off();
      fn(signal);
    });
    return off;
  }

  off(type, fn) {
    const key = type === '*' ? '*' : normalizeType(type);
    const list = this.listeners.get(key) || [];
    this.listeners.set(key, list.filter((item) => item !== fn));
    return this;
  }

  /* ---------------------------- маршрутизация --------------------------- */

  /** Кратчайший путь по гифам (BFS) от узла к узлу. */
  route(from, to) {
    assertNonEmptyString(from, 'route: from');
    assertNonEmptyString(to, 'route: to');
    if (from === to) {
      return { path: [from], distance: 0, reliability: 1, delay: 0 };
    }
    const adj = new Map();
    for (const hypha of this.hyphae.values()) {
      if (!adj.has(hypha.from)) adj.set(hypha.from, []);
      adj.get(hypha.from).push(hypha);
    }
    const queue = [[from]];
    const seen = new Set([from]);
    while (queue.length) {
      const path = queue.shift();
      const node = path[path.length - 1];
      for (const hypha of adj.get(node) || []) {
        if (seen.has(hypha.to)) continue;
        const nextPath = path.concat(hypha.to);
        if (hypha.to === to) {
          return this._describe(nextPath);
        }
        seen.add(hypha.to);
        queue.push(nextPath);
      }
    }
    return null;
  }

  _describe(path) {
    let reliability = 1;
    let delay = 0;
    for (let i = 0; i < path.length - 1; i += 1) {
      const hypha = this.hyphae.get(`${path[i]}->${path[i + 1]}`);
      if (!hypha) continue;
      reliability *= hypha.conductance();
      delay += hypha.delay();
    }
    return {
      path,
      distance: path.length - 1,
      reliability: round(reliability),
      delay: round(delay, 3),
    };
  }

  shortestPath(from, to) {
    const r = this.route(from, to);
    return r ? r.path : null;
  }

  /** Сигнал с трассировкой: возвращает и сам сигнал, и маршрут. */
  trace(from, to, type, payload) {
    const r = this.route(from, to);
    const signal = this.emitSignal(from, to, type, payload);
    return {
      signal,
      path: r ? r.path : [from, to],
      hops: r ? r.distance : 1,
      reliability: r ? r.reliability : 1,
    };
  }

  /* ------------------------------ рассылки ------------------------------ */

  /** Рассылка сигнала всем известным узлам, кроме источника. */
  broadcast(from, type, payload) {
    assertNonEmptyString(from, 'broadcast: from');
    const out = [];
    for (const id of this.nodes.keys()) {
      if (id === from) continue;
      out.push(this.emitSignal(from, id, type, payload));
    }
    return out;
  }

  /** Волна по соседям (гифам), исходящим из узла. */
  spread(from, type, payload) {
    assertNonEmptyString(from, 'spread: from');
    const out = [];
    for (const hypha of this.hyphae.values()) {
      if (hypha.from === from) {
        out.push(this.emitSignal(from, hypha.to, type, payload));
      }
    }
    return out;
  }

  /* ---------------------------- интроспекция ---------------------------- */

  /** Подслушать входящие сигналы узла. */
  eavesdrop(nodeId, limit) {
    assertNonEmptyString(nodeId, 'eavesdrop: nodeId');
    const found = this.history.filter((s) => s.to === nodeId);
    return isFiniteNumber(limit) ? found.slice(-limit) : found;
  }

  /** История с фильтром по типу/узлу/свежести. */
  historyOf(filter) {
    const f = filter || {};
    return this.history.filter((s) => {
      if (f.type && s.type !== normalizeType(f.type)) return false;
      if (f.from && s.from !== f.from) return false;
      if (f.to && s.to !== f.to) return false;
      if (f.since && s.at < f.since) return false;
      if (f.onlyDelivered && s.delivered === false) return false;
      return true;
    });
  }

  /** Снимок топологии: узлы + гифы + метрики. */
  snapshot() {
    return {
      nodes: [...this.nodes.values()].map((n) => ({
        id: n.id,
        pulse: n.pulse,
        received: n.received,
        joined: n.joined,
      })),
      hyphae: [...this.hyphae.values()].map((h) => h.toJSON()),
      stats: this.stats(),
    };
  }

  stats() {
    const types = {};
    for (const s of this.history) types[s.type] = (types[s.type] || 0) + 1;
    return {
      nodes: this.nodes.size,
      hyphae: this.hyphae.size,
      history: this.history.length,
      undelivered: this.undelivered.length,
      listeners: [...this.listeners.values()].reduce((n, l) => n + l.length, 0),
      averageCongestion: this._avgCongestion(),
      types,
    };
  }

  _avgCongestion() {
    const list = [...this.hyphae.values()];
    if (!list.length) return 0;
    const sum = list.reduce((acc, h) => acc + h.congestion, 0);
    return round(sum / list.length);
  }

  /** Пульс сети: релаксация гиф и очистка устаревших сигналов. */
  pulseGrid(dt) {
    const now = this.now();
    for (const h of this.hyphae.values()) h.relax(dt);
    this.history = this.history.filter((s) => !s.isExpired(now));
    this.undelivered = this.undelivered.filter((s) => !s.isExpired(now));
    return this.stats();
  }

  /** Ускорить распад затора вручную. */
  decay(dt) {
    for (const h of this.hyphae.values()) h.relax(dt);
    return this.stats();
  }

  /** Плоский массив истории для логов/аналитики. */
  dump() {
    return this.history.map((s) => s.toJSON());
  }

  reset() {
    this.nodes.clear();
    this.hyphae.clear();
    this.history.length = 0;
    this.undelivered.length = 0;
    this.listeners.clear();
    return this;
  }

  static create(options) {
    return new MyceliumSignalGrid(options);
  }

  static reset(options) {
    if (defaultGrid) defaultGrid.reset();
    if (options) configure(options);
    return defaultGrid;
  }
}

/* -------------------------------------------------------------------------- */
/* Сеть по умолчанию + модульные обёртки                                       */
/* -------------------------------------------------------------------------- */

const defaultGrid = new MyceliumSignalGrid();

/**
 * emitSignal(from, to, type, payload) — свободная функция поверх сети
 * по умолчанию. Ровно тот API, что требуется контрактом модуля.
 */
function emitSignal(from, to, type, payload) {
  return defaultGrid.emitSignal(from, to, type, payload);
}

function pulse(from, to, type, payload) {
  if (type === undefined) return defaultGrid.pulse(from, to);
  return defaultGrid.emitSignal(from, to, type, payload);
}

function broadcast(from, type, payload) {
  return defaultGrid.broadcast(from, type, payload);
}

function trace(from, to, type, payload) {
  return defaultGrid.trace(from, to, type, payload);
}

function route(from, to) {
  return defaultGrid.route(from, to);
}

function seed(nodeId, meta) {
  return defaultGrid.seed(nodeId, meta);
}

function growHypha(from, to, options) {
  return defaultGrid.growHypha(from, to, options);
}

function on(type, fn) {
  return defaultGrid.on(type, fn);
}

function stats() {
  return defaultGrid.stats();
}

function reset() {
  return defaultGrid.reset();
}

/** Инъекция детерминированных now/rng (для тестов и симуляций). */
function configure(options) {
  const opts = options || {};
  if (typeof opts.now === 'function') defaultGrid.now = opts.now;
  if (typeof opts.rng === 'function') defaultGrid.rng = opts.rng;
  if (isFiniteNumber(opts.ttl)) defaultGrid.ttl = opts.ttl;
  if (isFiniteNumber(opts.maxHistory)) defaultGrid.maxHistory = opts.maxHistory;
  return defaultGrid;
}

/** Явный «нет сигнала» — удобно в тернарниках и заглушках. */
function noop() {
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Экспорт                                                                     */
/* -------------------------------------------------------------------------- */

module.exports = {
  SIGNAL_TYPES,
  PRIORITY,
  TYPE_PRIORITY,
  DEFAULTS,
  Hypha,
  Signal,
  MyceliumSignalGrid,
  defaultGrid,
  emitSignal,
  pulse,
  broadcast,
  trace,
  route,
  seed,
  growHypha,
  on,
  stats,
  reset,
  configure,
  noop,
};
