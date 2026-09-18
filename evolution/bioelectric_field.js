#!/usr/bin/env node
/**
 * evolution/bioelectric_field.js — Биоэлектрическое поле (по мотивам работ Майкла Левина)
 * ========================================================================================
 * Назначение
 * ----------
 *   Клетки в развивающемся организме общаются не только химией (морфогенами), но и
 *   электричеством: разностью потенциалов на мембранах, ионными потоками и щелевыми
 *   контактами (gap junctions). Это «биоэлектрическое поле» задаёт клеткам позиционную
 *   информацию — где регенерировать, куда расти, что подавить. Левин показал, что,
 *   манипулируя картиной напряжений, можно переписать «морфологическую память».
 *
 *   Модуль моделирует такую картину как **in-memory шину сигналов**: агенты/клетки
 *   подписываются на сигналы и обмениваются данными. Реализация построена на штатном
 *   Node.js `EventEmitter` (CommonJS), дополненном журналом, wildcard-подпиской,
 *   ожиданием сигнала и интроспекцией.
 *
 * Публичный API
 * -------------
 *   Модульные функции (работают на общем поле по умолчанию):
 *     emit(signal, data)      -> boolean          Главный API: испустить сигнал
 *     on(signal, cb)          -> () => void       Подписка (возвращает отписку)
 *     once(signal, cb)        -> () => void       Одноразовая подписка
 *     off(signal, cb)         -> BioelectricField Снять подписку
 *     waitFor(signal, opts)   -> Promise<data>    Дождаться сигнала
 *     listeners(signal)       -> number           Сколько слушателей
 *     history(filter)         -> Packet[]         Журнал сигналов
 *     stats()                 -> object           Агрегированная статистика
 *     reset()                 -> BioelectricField Очистить поле
 *
 *   Класс BioelectricField (extends EventEmitter):
 *     new BioelectricField(options)
 *     field.emit(signal, data)
 *     field.on(signal, cb) / field.once(signal, cb) / field.off(signal, cb)
 *     field.waitFor(signal, opts) / field.fire(signal, data)
 *     field.listeners(signal) / field.history(filter) / field.stats()
 *     field.reset() / field.channel(name) / field.dump()
 *
 * Пример
 * ------
 *   const field = require('./evolution/bioelectric_field');
 *   field.on('voltage', (data) => console.log('потенциал', data.mV));
 *   field.emit('voltage', { mV: -70 });   // -> true, сработает слушатель
 *
 * Критерий: `node --check` без ошибок, emit + on работают.
 * ----------------------------------------------------------------------------------------
 */

'use strict';

const { EventEmitter } = require('events');

/* -------------------------------------------------------------------------- */
/* Константы                                                                   */
/* -------------------------------------------------------------------------- */

/** Канонические «сигналы» поля. Строки открыты — можно использовать свои. */
const SIGNALS = Object.freeze({
  VOLTAGE: 'voltage',              // изменение мембранного потенциала
  DEPOLARIZE: 'depolarize',        // деполяризация (рост активности)
  HYPERPOLARIZE: 'hyperpolarize',  // гиперполяризация (торможение)
  ION_FLUX: 'ion-flux',            // поток ионов (Na+, K+, Ca2+)
  MORPHOGEN: 'morphogen',          // химический градиент
  GAP_JUNCTION: 'gap-junction',    // прямой контакт клеток
  WOUND: 'wound',                  // сигнал повреждения
  MEMORY: 'memory',                // «морфологическая память»
  ANY: '*',                        // wildcard: любой сигнал
});

const DEFAULTS = Object.freeze({
  historyLimit: 1000,   // максимум записей в журнале
  maxListeners: 100,    // предел слушателей на канал (0 = без предела)
  now: null,            // () => number   (инъекция времени для тестов)
  rng: null,            // () => number   (детерминизм в тестах)
  wildcard: true,       // дублировать сигналы в канал '*'
});

/* -------------------------------------------------------------------------- */
/* Вспомогательное                                                             */
/* -------------------------------------------------------------------------- */

function isFiniteNumber(value) {
  return typeof value === 'number' && isFinite(value);
}

/** Привести имя сигнала к строке; пустое имя недопустимо. */
function normalizeSignal(signal) {
  if (typeof signal !== 'string' || !signal.trim().length) {
    throw new TypeError('signal must be a non-empty string');
  }
  return signal;
}

function assertCallback(cb, label) {
  if (typeof cb !== 'function') {
    throw new TypeError(`${label} must be a function`);
  }
}

/* -------------------------------------------------------------------------- */
/* Биоэлектрическое поле                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Распределённая in-memory шина сигналов между клетками/агентами.
 * Наследует Node.js EventEmitter: `on`, `once`, `emit` дополнены журналом,
 * wildcard-каналом, отпиской и интроспекцией.
 */
class BioelectricField extends EventEmitter {
  constructor(options) {
    const opts = options || {};
    super();

    this.setMaxListeners(isFiniteNumber(opts.maxListeners) ? opts.maxListeners : DEFAULTS.maxListeners);

    this.historyLimit = isFiniteNumber(opts.historyLimit) ? opts.historyLimit : DEFAULTS.historyLimit;
    this.wildcard = opts.wildcard === undefined ? DEFAULTS.wildcard : !!opts.wildcard;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.rng = typeof opts.rng === 'function' ? opts.rng : Math.random;

    this._history = [];
    this._counts = new Map();
    this._sequence = 0;
    this._channels = new Map();
    this._lastSignal = null;
  }

  /** Уникальный идентификатор пакета. */
  _nextId(name) {
    this._sequence += 1;
    const seq = this._sequence.toString(36);
    const t = (this.now() % 1e8).toString(36);
    return `${name}:${seq}:${t}`;
  }

  /* ------------------------------- emit ---------------------------------- */

  /**
   * Испустить сигнал в поле. Слушатели канала получают `(data, packet)`.
   * Если включён wildcard, сигнал доходит и до подписчиков '*'.
   * @returns {boolean} true, если был хотя бы один слушатель
   */
  emit(signal, data) {
    const name = normalizeSignal(signal);
    const packet = {
      id: this._nextId(name),
      signal: name,
      data: data === undefined ? null : data,
      at: this.now(),
    };

    this._record(packet);

    const handled = super.emit(name, packet.data, packet);

    if (this.wildcard && name !== SIGNALS.ANY) {
      super.emit(SIGNALS.ANY, packet.data, packet);
    }

    return handled;
  }

  /** Синоним emit — «разряд поля» (удобно для читаемости в био-модулях). */
  fire(signal, data) {
    return this.emit(signal, data);
  }

  _record(packet) {
    this._history.push(packet);
    if (this._history.length > this.historyLimit) {
      this._history.shift();
    }
    this._counts.set(packet.signal, (this._counts.get(packet.signal) || 0) + 1);
    this._lastSignal = packet;
  }

  /* ----------------------------- подписки -------------------------------- */

  /**
   * Подписаться на сигнал. Возвращает функцию отписки.
   * (Дополняет EventEmitter, поэтому `addListener` тоже доступен.)
   */
  on(signal, cb) {
    const name = normalizeSignal(signal);
    assertCallback(cb, 'on: cb');
    super.on(name, cb);
    return () => this.off(name, cb);
  }

  /** Одноразовая подписка. Возвращает функцию отписки. */
  once(signal, cb) {
    const name = normalizeSignal(signal);
    assertCallback(cb, 'once: cb');
    super.once(name, cb);
    return () => super.removeListener(name, cb);
  }

  /** Снять подписку (idempotent). */
  off(signal, cb) {
    const name = normalizeSignal(signal);
    if (cb) super.removeListener(name, cb);
    else super.removeAllListeners(name);
    return this;
  }

  /**
   * Дождаться сигнала и вернуть его data.
   * @param {string} signal
   * @param {{timeout?: number}} [opts] timeout в мс (0/undefined = ждать вечно)
   * @returns {Promise<*>}
   */
  waitFor(signal, opts) {
    const name = normalizeSignal(signal);
    const options = opts || {};
    const timeout = isFiniteNumber(options.timeout) ? options.timeout : 0;

    return new Promise((resolve, reject) => {
      let timer = null;
      const done = (data) => {
        if (timer) clearTimeout(timer);
        resolve(data);
      };
      this.once(name, done);
      if (timeout > 0) {
        timer = setTimeout(() => {
          super.removeListener(name, done);
          reject(new Error(`waitFor: timeout waiting for "${name}"`));
        }, timeout);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
    });
  }

  /* --------------------------- интроспекция ------------------------------ */

  /** Сколько слушателей у канала. */
  listeners(signal) {
    const name = normalizeSignal(signal);
    return super.listenerCount(name);
  }

  /** Есть ли подписчики (или подписчики '*'). */
  isObserved(signal) {
    return this.listeners(signal) > 0 ||
      (this.wildcard && signal !== SIGNALS.ANY && super.listenerCount(SIGNALS.ANY) > 0);
  }

  /** Последняя запись журнала. */
  last() {
    return this._lastSignal;
  }

  /** Журнал сигналов (свежие — в конце). */
  history(filter) {
    if (!filter) return this._history.slice();
    const bySignal = filter.signal ? normalizeSignal(filter.signal) : null;
    const since = isFiniteNumber(filter.since) ? filter.since : null;
    const limit = isFiniteNumber(filter.limit) && filter.limit > 0 ? filter.limit : null;
    let rows = this._history.filter((row) =>
      (!bySignal || row.signal === bySignal) && (since === null || row.at >= since));
    if (limit) rows = rows.slice(-limit);
    return rows.map((row) => ({ ...row, data: row.data }));
  }

  /** Агрегаты: сколько сигналов каких типов прошло через поле. */
  stats() {
    const bySignal = {};
    for (const [name, count] of this._counts.entries()) bySignal[name] = count;
    const total = this._history.length;
    return {
      total,
      bySignal,
      channels: Object.keys(bySignal).length,
      wildcard: this.wildcard,
      subscribers: this.eventNames().reduce(
        (acc, name) => acc + super.listenerCount(name), 0),
      lastAt: this._lastSignal ? this._lastSignal.at : null,
    };
  }

  /** Полный снимок состояния поля (для отладки/логов). */
  dump() {
    return {
      stats: this.stats(),
      history: this.history({ limit: 100 }),
      events: this.eventNames().map(String),
    };
  }

  /* ------------------------------ каналы --------------------------------- */

  /**
   * Канал — именованное подсоединение к сигналу с накоплением последнего значения
   * (аналог мембраны клетки, удерживающей потенциал).
   */
  channel(name) {
    const key = normalizeSignal(name);
    if (this._channels.has(key)) return this._channels.get(key);

    const field = this;
    const channel = {
      name: key,
      value: null,
      updatedAt: null,
      listen(cb) {
        return field.on(key, (data) => {
          channel.value = data;
          channel.updatedAt = field.now();
          if (typeof cb === 'function') cb(data);
        });
      },
      emit(data) {
        return field.emit(key, data);
      },
      snapshot() {
        return { name: channel.name, value: channel.value, updatedAt: channel.updatedAt };
      },
    };
    this._channels.set(key, channel);
    return channel;
  }

  /** Полная очистка: слушатели, журнал, счётчики, каналы. */
  reset() {
    this.removeAllListeners();
    this._history = [];
    this._counts = new Map();
    this._channels = new Map();
    this._sequence = 0;
    this._lastSignal = null;
    return this;
  }
}

/* -------------------------------------------------------------------------- */
/* Поле по умолчанию + модульные обёртки                                       */
/* -------------------------------------------------------------------------- */

const defaultField = new BioelectricField();

function emit(signal, data) {
  return defaultField.emit(signal, data);
}

function fire(signal, data) {
  return defaultField.fire(signal, data);
}

function on(signal, cb) {
  return defaultField.on(signal, cb);
}

function once(signal, cb) {
  return defaultField.once(signal, cb);
}

function off(signal, cb) {
  return defaultField.off(signal, cb);
}

function waitFor(signal, opts) {
  return defaultField.waitFor(signal, opts);
}

function listeners(signal) {
  return defaultField.listeners(signal);
}

function history(filter) {
  return defaultField.history(filter);
}

function stats() {
  return defaultField.stats();
}

function reset() {
  return defaultField.reset();
}

/** Инъекция времени/rng для детерминированных тестов. */
function configure(options) {
  const opts = options || {};
  if (typeof opts.now === 'function') defaultField.now = opts.now;
  if (typeof opts.rng === 'function') defaultField.rng = opts.rng;
  if (isFiniteNumber(opts.historyLimit)) defaultField.historyLimit = opts.historyLimit;
  if (isFiniteNumber(opts.maxListeners)) defaultField.setMaxListeners(opts.maxListeners);
  if (opts.wildcard !== undefined) defaultField.wildcard = !!opts.wildcard;
  return defaultField;
}

/** Явный «нет сигнала» — удобно в тернарниках и заглушках. */
function noop() {
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Экспорт                                                                     */
/* -------------------------------------------------------------------------- */

module.exports = {
  // Класс и константы
  BioelectricField,
  SIGNALS,
  DEFAULTS,
  defaultField,
  // Главный API (шина)
  emit,
  fire,
  on,
  once,
  off,
  waitFor,
  // Интроспекция
  listeners,
  history,
  stats,
  reset,
  configure,
  noop,
};

// Самопроверка при прямом запуске: `node evolution/bioelectric_field.js`
if (require.main === module) {
  const self = module.exports;
  const seen = [];
  const unsubscribe = self.on('voltage', (data) => seen.push(data && data.mV));
  const oneShot = self.once('wound', () => seen.push('wound!'));

  self.emit('voltage', { mV: -70 });
  self.emit('voltage', { mV: -55 });
  self.emit('wound', {});
  self.emit('wound', {}); // once уже отписан

  unsubscribe();
  oneShot();

  const ok = seen.length === 3 && seen[0] === -70 && seen[2] === 'wound!';
  console.log('[bioelectric_field] signals:', JSON.stringify(seen));
  console.log('[bioelectric_field] stats:', JSON.stringify(self.stats().bySignal));
  console.log(ok ? '[bioelectric_field] OK' : '[bioelectric_field] FAIL');
  if (!ok) process.exitCode = 1;
}
