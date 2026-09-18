'use strict';

/**
 * memory/biofield.js — Биоэлектрическое поле (Michael Levin).
 *
 * Идея: клетки обмениваются ионными «сигналами» через межклеточные щели
 * (gap junctions). В модели это in-memory шина событий: агент/клетка
 * ИСПУСКАЕТ сигнал через emit(signal, data), а соседи ПОДПИСЫВАЮТСЯ
 * через on(signal, cb) (постоянная связь) или once(signal, cb)
 * (одноразовая — «первое касание» мембраны).
 *
 * Реализация построена на Node.js EventEmitter, поэтому наследует
 * весь контракт: синхронная доставка, порядок подписчиков, off/removeListener,
 * событие 'error' и т.д. Поверх добавлено полевое состояние: история
 * потенциалов (history) и реестр активных сигналов.
 *
 * API:
 *   emit(signal, data) -> boolean   — испустить сигнал в поле
 *   on(signal, cb)     -> this      — постоянная подписка
 *   once(signal, cb)   -> this      — одноразовая подписка
 *   off(signal, cb)    -> this      — отписаться
 *
 * КРИТЕРИЙ: node --check OK, emit+on работает.
 */

const { EventEmitter } = require('events');

/** Максимум хранимых «потенциалов» в истории поля. */
const DEFAULT_HISTORY_LIMIT = 1000;

class BioelectricField extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.historyLimit=1000] глубина истории сигналов
   * @param {number} [options.maxListeners=100]  порог предупреждения EE
   */
  constructor(options = {}) {
    super();
    this.setMaxListeners(options.maxListeners || 100);
    this.historyLimit =
      Number.isFinite(options.historyLimit) && options.historyLimit > 0
        ? options.historyLimit
        : DEFAULT_HISTORY_LIMIT;
    /** @type {Array<{seq:number, signal:string, data:*, ts:number}>} */
    this.history = [];
    this._seq = 0;
  }

  /**
   * Испускает сигнал в поле. Записывает кадр в историю потенциалов
   * и синхронно доставляет его всем подписчикам сигнала.
   *
   * @param {string} signal — имя сигнала (напр. 'Na+/K+', 'morphogen').
   * @param {*} [data] — полезная нагрузка (произвольное значение).
   * @returns {boolean} true, если был хотя бы один слушатель.
   */
  emit(signal, data) {
    if (typeof signal !== 'string' || signal.length === 0) {
      throw new TypeError('biofield.emit: signal must be a non-empty string');
    }
    const frame = {
      seq: ++this._seq,
      signal,
      data,
      ts: Date.now(),
    };
    this.history.push(frame);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    // Последним аргументом передаём кадр — удобно для диагностики.
    return super.emit(signal, data, frame);
  }

  /**
   * Постоянная подписка на сигнал.
   * @param {string} signal
   * @param {Function} cb
   * @returns {this}
   */
  on(signal, cb) {
    super.on(signal, cb);
    return this;
  }

  /**
   * Одноразовая подписка: сработает ровно один раз.
   * @param {string} signal
   * @param {Function} cb
   * @returns {this}
   */
  once(signal, cb) {
    super.once(signal, cb);
    return this;
  }

  /**
   * Отписаться от сигнала.
   * @param {string} signal
   * @param {Function} cb
   * @returns {this}
   */
  off(signal, cb) {
    super.off(signal, cb);
    return this;
  }

  /**
   * История потенциалов. Без аргумента — вся, с аргументом — по сигналу.
   * @param {string} [signal]
   * @returns {Array<{seq:number, signal:string, data:*, ts:number}>}
   */
  getHistory(signal) {
    const src = signal ? this.history.filter((f) => f.signal === signal) : this.history;
    return src.map((f) => ({ ...f }));
  }

  /**
   * Список сигналов, которые когда-либо возникали в поле.
   * @returns {string[]}
   */
  getSignals() {
    return [...new Set(this.history.map((f) => f.signal))];
  }

  /**
   * Очистить историю поля (подписки сохраняются).
   * @returns {this}
   */
  reset() {
    this.history = [];
    this._seq = 0;
    return this;
  }
}

/** Глобальное (синглтон) поле процесса. */
const field = new BioelectricField();

/** Императивный фасад над глобальным полем. */
function emit(signal, data) {
  return field.emit(signal, data);
}
function on(signal, cb) {
  return field.on(signal, cb);
}
function once(signal, cb) {
  return field.once(signal, cb);
}

module.exports = {
  BioelectricField,
  field,
  emit,
  on,
  once,
};

// --- Самопроверка: node memory/biofield.js -------------------------------
if (require.main === module) {
  const bus = new BioelectricField();
  const seen = [];

  bus.on('Na+/K+', (data) => seen.push(['on', data]));
  bus.once('Na+/K+', (data) => seen.push(['once', data]));

  const hit1 = bus.emit('Na+/K+', { mv: -70 });
  const hit2 = bus.emit('Na+/K+', { mv: -55 });

  console.log('emit#1 listeners:', hit1);
  console.log('emit#2 listeners:', hit2);
  console.log('received:', JSON.stringify(seen));
  console.log('signals:', bus.getSignals().join(','));
  console.log('history:', bus.getHistory().length);

  const ok = hit1 === true && hit2 === true && seen.length === 3;
  console.log(ok ? 'BIOFIELD OK' : 'BIOFIELD FAIL');
  process.exit(ok ? 0 : 1);
}
