'use strict';

/**
 * Биоэлектрическое поле (Levin) — in-memory шина сигналов.
 *
 * Биологическая метафора (Michael Levin): клетки общаются не только через
 * гены, но и через трансмембранные потенциалы (Vm) и gap-junction-каналы.
 * Здесь «клетки» — это подписчики, «потенциал» — сигнал, передаваемый по
 * общей in-memory шине без сети и без брокеров.
 *
 * Публичный API:
 *   emit(signal, data)  — излучить сигнал во поле, вернуть boolean (был ли слушатель)
 *   on(signal, cb)      — постоянная подписка (gap-junction)
 *   once(signal, cb)    — одноразовая подписка (транзиентный импульс)
 *   off(signal, cb)     — снять подписку
 *   offAll(signal?)     — снять все подписки (по сигналу или вообще)
 *   listeners(signal)   — сколько рецепторов сейчас слушают сигнал
 *   replay(signal?)     — история сигналов поля
 *
 * Расширяет EventEmitter, поэтому совместим со всем, что ждёт `.on/.once/.emit`.
 */

const { EventEmitter } = require('events');

/** Разрешённые имена сигналов: латиница, цифры, . _ : - */
const SIGNAL_RE = /^[A-Za-z0-9._:-]+$/;

/**
 * Нормализует и валидирует имя сигнала.
 * @param {string} signal
 * @returns {string}
 */
function normalizeSignal(signal) {
  if (typeof signal !== 'string' || signal.length === 0) {
    throw new TypeError('bioelectric: signal должен быть непустой строкой');
  }
  if (!SIGNAL_RE.test(signal)) {
    throw new TypeError(
      `bioelectric: некорректное имя сигнала "${signal}" (допустимо [A-Za-z0-9._:-])`
    );
  }
  return signal;
}

/**
 * Проверяет, что слушатель — функция.
 * @param {*} cb
 * @returns {Function}
 */
function normalizeListener(cb) {
  if (typeof cb !== 'function') {
    throw new TypeError('bioelectric: listener должен быть функцией');
  }
  return cb;
}

/**
 * Класс in-memory шины биоэлектрического поля.
 */
class BioelectricBus extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.maxListeners=1000] лимит рецепторов на сигнал
   * @param {number} [options.historyLimit=200]  размер кольцевого буфера истории
   * @param {string} [options.channel='default'] имя «ткани» для логов
   */
  constructor(options = {}) {
    super();

    const maxListeners = Number.isFinite(options.maxListeners)
      ? options.maxListeners
      : 1000;
    this.setMaxListeners(maxListeners);

    this.channel = typeof options.channel === 'string' ? options.channel : 'default';
    this.historyLimit = Number.isFinite(options.historyLimit)
      ? Math.max(0, Math.floor(options.historyLimit))
      : 200;

    this._history = [];
  }

  /**
   * Излучает сигнал во поле.
   * @param {string} signal имя сигнала
   * @param {*} [data] полезная нагрузка
   * @returns {boolean} true, если сигнал был кем-то принят
   */
  emit(signal, data) {
    normalizeSignal(signal);
    this._remember(signal, data);
    return super.emit(signal, data);
  }

  /**
   * Постоянная подписка на сигнал (gap-junction).
   * Возвращает сам шину для чейнинга.
   * @param {string} signal
   * @param {Function} cb
   * @returns {BioelectricBus}
   */
  on(signal, cb) {
    normalizeSignal(signal);
    normalizeListener(cb);
    super.on(signal, cb);
    return this;
  }

  /**
   * Одноразовая подписка — срабатывает на первый же импульс.
   * @param {string} signal
   * @param {Function} cb
   * @returns {BioelectricBus}
   */
  once(signal, cb) {
    normalizeSignal(signal);
    normalizeListener(cb);
    super.once(signal, cb);
    return this;
  }

  /**
   * Снимает конкретную подписку.
   * @param {string} signal
   * @param {Function} cb
   * @returns {BioelectricBus}
   */
  off(signal, cb) {
    normalizeSignal(signal);
    normalizeListener(cb);
    super.off(signal, cb);
    return this;
  }

  /**
   * Снимает все подписки: по одному сигналу, либо по всему полю.
   * @param {string} [signal]
   * @returns {BioelectricBus}
   */
  offAll(signal) {
    if (signal === undefined) {
      this.removeAllListeners();
    } else {
      this.removeAllListeners(normalizeSignal(signal));
    }
    return this;
  }

  /**
   * Число рецепторов, слушающих сигнал.
   * @param {string} signal
   * @returns {number}
   */
  listeners(signal) {
    return super.listenerCount(normalizeSignal(signal));
  }

  /**
   * История сигналов поля (глубокая копия — вызывающий не меняет буфер).
   * @param {string} [signal]
   * @returns {Array<{signal:string, data:*, at:number}>}
   */
  replay(signal) {
    const name = signal === undefined ? undefined : normalizeSignal(signal);
    const src = name === undefined ? this._history : this._history.filter((e) => e.signal === name);
    return src.map((e) => ({ signal: e.signal, data: e.data, at: e.at }));
  }

  /** @private */
  _remember(signal, data) {
    if (this.historyLimit === 0) return;
    this._history.push({ signal, data, at: Date.now() });
    if (this._history.length > this.historyLimit) {
      this._history.splice(0, this._history.length - this.historyLimit);
    }
  }
}

/**
 * Фабрика шины.
 * @param {object} [options]
 * @returns {BioelectricBus}
 */
function createBus(options) {
  return new BioelectricBus(options);
}

module.exports = {
  BioelectricBus,
  createBus,
  normalizeSignal
};
