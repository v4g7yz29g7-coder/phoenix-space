'use strict';

/**
 * trajectory/tick_logger.js
 * ============================================================================
 * Журнал телеметрии гонки AI-агентов (race tick logger).
 *
 * Модуль слушает серверное событие `race:tick` (socket.io) и дописывает
 * каждую запись отдельной строкой в JSONL-файл траектории гонки:
 *
 *     memory/patterns/race_<id>_ticks.jsonl
 *
 * Формат одной строки файла (ровно эти поля):
 *
 *     {"ts":1700000000000,"positions":[
 *        {"agent":"agent_1","lap":3,"progress":0.42},
 *        {"agent":"agent_2","lap":3,"progress":0.40}
 *     ]}
 *
 * Публичный API
 * -------------
 *   const tickLogger = require('./trajectory/tick_logger');
 *
 *   tickLogger.connect();               // подключиться к socket.io серверу
 *   tickLogger.attach(socket);          // привязать уже готовый socket-like объект
 *   tickLogger.disconnect();            // отписаться и закрыть сокет
 *   tickLogger.onTick(payload);         // обработать тик вручную (без сети)
 *   tickLogger.pathFor(raceId);         // абсолютный путь к JSONL-файлу гонки
 *   tickLogger.flush();                 // дождаться сброса очереди на диск
 *   tickLogger.getStats();              // счётчики/телеметрия
 *   tickLogger.on('tick', fn);          // подписка на нормализованный тик
 *   tickLogger.on('write', fn);         // запись подтверждена диском
 *   tickLogger.on('error', fn);         // ошибки записи/подключения
 *
 *   tickLogger.create(opts);            // отдельный экземпляр (не singleton)
 *   tickLogger.TickLogger;              // сам класс
 *   tickLogger.buildRecord;             // чистая функция нормализации записи
 *   tickLogger.normalizePositions;      // чистая функция нормализации позиций
 *
 * Гарантии
 * --------
 *   - Модуль требует только `fs`, `path`, `events`; `socket.io-client`
 *     подключается лениво, поэтому `node --check` и офлайн-запуск не падают.
 *   - Записи сериализуются через внутреннюю очередь; `appendFile` для одного
 *     файла не перемежает строки и не теряет данные при бурном потоке тиков.
 *   - Каталог `memory/patterns` создаётся автоматически (recursive).
 *   - Ошибки записи не роняют процесс: они попадают в телеметрию.
 *   - Имя файла санитизируется, ограничено по длине и не может выйти за
 *     пределы каталога назначения.
 *
 * Самопроверка
 * ------------
 *   node trajectory/tick_logger.js --self-test
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/* ---------------------------------------------------------------------------
 * 0. Ленивое подключение socket.io-client (модуль остаётся импортируемым без
 *    установленной зависимости и проходит `node --check` в голом окружении).
 * ------------------------------------------------------------------------- */

function loadIoFactory() {
  const candidates = ['socket.io-client', 'socket.io'];
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      // eslint-disable-next-line global-require
      const mod = require(candidates[i]);
      const factory = mod && (mod.io || mod.default || mod);
      if (typeof factory === 'function') return factory;
    } catch (err) {
      // переходим к следующему кандидату
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 1. Конфигурация по умолчанию.
 * ------------------------------------------------------------------------- */

const EVENT_NAME = 'race:tick';

const DEFAULTS = {
  url: process.env.TICK_LOGGER_URL || process.env.RADIO_URL || 'http://127.0.0.1:3020',
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
  timeout: 10000,

  outDir: path.join(__dirname, '..', 'memory', 'patterns'),
  prefix: 'race_',
  suffix: '_ticks.jsonl',

  flushIntervalMs: 250,
  maxQueue: 20000,
  maxIdLength: 80,
  totalLaps: 0,
};

/* ---------------------------------------------------------------------------
 * 2. Чистые утилиты нормализации.
 * ------------------------------------------------------------------------- */

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstDefined(candidates, fallback) {
  for (let i = 0; i < candidates.length; i += 1) {
    const value = candidates[i];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function clampLap(x) {
  if (!Number.isFinite(x) || x < 0) return 0;
  return Math.floor(x);
}

function round4(x) {
  return Math.round(clamp01(x) * 10000) / 10000;
}

/** Допускает `race_id`, `raceId`, `race`, `id`. */
function resolveRaceId(payload) {
  if (!isObject(payload)) return null;
  const value = firstDefined(
    [payload.race_id, payload.raceId, payload.race, payload.id],
    null
  );
  return value === null ? null : String(value);
}

/** Безопасное (filesystem-safe) имя гонки. */
function sanitizeId(raceId, maxLength) {
  if (raceId === null || raceId === undefined || raceId === '') return 'unknown';
  let id = String(raceId).trim();
  id = id.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
  if (!id || id === '.' || id === '..') return 'unknown';
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : 80;
  if (id.length > limit) id = id.slice(0, limit);
  return id;
}

/**
 * Приводит список позиций из payload к массиву `{agent, lap, progress}`,
 * сохраняя входной порядок. Понимает как массив, так и объект-словарь
 * `{ agentId: {...} }`, а также синонимы полей.
 *
 * @param {*} payload
 * @param {object} [options]
 * @returns {Array<{agent:string, lap:number, progress:number}>}
 */
function normalizePositions(payload, options) {
  if (!isObject(payload)) return [];

  let raw = firstDefined(
    [payload.positions, payload.pos, payload.agents, payload.cars,
     payload.field, payload.standings, payload.results, payload.racers],
    []
  );

  if (isObject(raw)) {
    raw = Object.keys(raw).map((key) => {
      const value = raw[key];
      return isObject(value) ? Object.assign({ agent: key }, value) : { agent: key };
    });
  }
  if (!Array.isArray(raw)) return [];

  const opts = isObject(options) ? options : {};
  const totalLaps = toNumber(opts.totalLaps) || 0;
  const payloadLap = toNumber(payload.lap);

  return raw.filter(Boolean).map((driver, index) => {
    const d = isObject(driver) ? driver : {};

    const agent = String(firstDefined(
      [d.agent, d.id, d.driverId, d.driver_id, d.name, d.driver, d.code],
      'car_' + index
    ));

    const rawProgress = firstDefined(
      [toNumber(d.progress), toNumber(d.pct), toNumber(d.distance)],
      0
    );
    const progress = round4(rawProgress > 1 ? rawProgress / 100 : rawProgress);

    let lap = toNumber(firstDefined([d.lap, d.lapCount, d.lap_no], null));
    if (lap === null) {
      if (payloadLap !== null && raw.length === 1) lap = payloadLap;
      else if (totalLaps > 0) lap = progress * totalLaps;
      else lap = progress;
    }

    return { agent, lap: clampLap(lap), progress };
  });
}

/** Собирает запись строго в формате `{ ts, positions }`. */
function buildRecord(payload, options) {
  return {
    ts: Date.now(),
    positions: normalizePositions(payload, options),
  };
}

/* ---------------------------------------------------------------------------
 * 3. Асинхронный append (без блокировки event loop).
 * ------------------------------------------------------------------------- */

function appendFileAsync(file, data) {
  return new Promise((resolve, reject) => {
    fs.appendFile(file, data, (err) => (err ? reject(err) : resolve()));
  });
}

/* ---------------------------------------------------------------------------
 * 4. Основной класс TickLogger.
 * ------------------------------------------------------------------------- */

class TickLogger extends EventEmitter {
  constructor(options) {
    super();
    this.setMaxListeners(0);
    this.options = Object.assign({}, DEFAULTS, options || {});
    this.socket = null;
    this.queue = [];
    this.timer = null;
    this.flushing = false;
    this.closed = false;
    this.stats = {
      received: 0,
      enqueued: 0,
      written: 0,
      dropped: 0,
      errors: 0,
      files: new Map(),
    };
    this.__boundTick = this.__onTick.bind(this);
    this.__ensureOutDir();
  }

  /* --- файловая система -------------------------------------------------- */

  __ensureOutDir() {
    try {
      fs.mkdirSync(this.options.outDir, { recursive: true });
      return true;
    } catch (err) {
      this.stats.errors += 1;
      this.__safeEmit('error', err);
      return false;
    }
  }

  /** Абсолютный путь JSONL-файла для конкретной гонки. */
  pathFor(raceId) {
    const file = this.options.prefix
      + sanitizeId(raceId, this.options.maxIdLength)
      + this.options.suffix;
    return path.join(this.options.outDir, file);
  }

  /* --- подписка на события ---------------------------------------------- */

  /** Ленивое подключение к socket.io серверу. */
  connect() {
    if (this.socket) return this;
    const ioFactory = loadIoFactory();
    if (!ioFactory) {
      this.__safeEmit('warn', new Error('socket.io-client недоступен: офлайн-режим'));
      return this;
    }
    try {
      this.socket = ioFactory(this.options.url, {
        transports: this.options.transports,
        reconnection: this.options.reconnection,
        reconnectionAttempts: this.options.reconnectionAttempts,
        reconnectionDelay: this.options.reconnectionDelay,
        reconnectionDelayMax: this.options.reconnectionDelayMax,
        timeout: this.options.timeout,
      });
      return this.attach(this.socket);
    } catch (err) {
      this.stats.errors += 1;
      this.__safeEmit('error', err);
      return this;
    }
  }

  /** Привязывает произвольный socket-like объект к событию `race:tick`. */
  attach(socket) {
    if (!socket || typeof socket.on !== 'function') return this;
    this.socket = socket;
    socket.on(EVENT_NAME, this.__boundTick);
    socket.on('connect', () => this.__safeEmit('connected'));
    socket.on('disconnect', () => this.__safeEmit('disconnected'));
    return this;
  }

  /** Отписывается от сокета и закрывает соединение. */
  disconnect() {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.socket && typeof this.socket.off === 'function') {
      this.socket.off(EVENT_NAME, this.__boundTick);
    }
    if (this.socket && typeof this.socket.close === 'function') {
      try { this.socket.close(); } catch (err) { /* игнорируем */ }
    }
    this.socket = null;
    return this;
  }

  /* --- обработка тика ---------------------------------------------------- */

  __onTick(payload) {
    if (this.closed) return null;
    this.stats.received += 1;

    const record = buildRecord(payload, this.options);
    const file = this.pathFor(resolveRaceId(payload));
    const line = JSON.stringify(record) + '\n';

    this.queue.push({ file, line, record });
    this.stats.enqueued += 1;

    while (this.queue.length > this.options.maxQueue) {
      this.queue.shift();
      this.stats.dropped += 1;
    }

    this.__safeEmit('tick', record, file);
    this.__scheduleFlush();
    return record;
  }

  /** Ручная обработка тика (удобно для тестов и офлайн-режима). */
  onTick(payload) {
    return this.__onTick(payload);
  }

  /* --- сброс на диск ----------------------------------------------------- */

  __scheduleFlush() {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.__flush();
    }, this.options.flushIntervalMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  __flush() {
    if (this.flushing) return this.__flushPromise || Promise.resolve();
    this.flushing = true;
    this.__flushPromise = (async () => {
      try {
        while (this.queue.length) {
          const item = this.queue.shift();
          try {
            await appendFileAsync(item.file, item.line);
            this.stats.written += 1;
            this.stats.files.set(item.file, (this.stats.files.get(item.file) || 0) + 1);
            this.__safeEmit('write', item.record, item.file);
          } catch (err) {
            this.stats.errors += 1;
            this.__safeEmit('error', err);
          }
        }
      } finally {
        this.flushing = false;
      }
    })();
    return this.__flushPromise;
  }

  /** Публичный flush: дожидается записи всей очереди на диск. */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.__flush();
  }

  /* --- телеметрия -------------------------------------------------------- */

  getStats() {
    const files = {};
    this.stats.files.forEach((count, file) => { files[file] = count; });
    return {
      received: this.stats.received,
      enqueued: this.stats.enqueued,
      written: this.stats.written,
      dropped: this.stats.dropped,
      errors: this.stats.errors,
      pending: this.queue.length,
      connected: Boolean(this.socket),
      files,
    };
  }

  __safeEmit(event, ...args) {
    if (event === 'error' && this.listenerCount('error') === 0) return false;
    return this.emit(event, ...args);
  }
}

/* ---------------------------------------------------------------------------
 * 5. Синглтон + экспорт.
 * ------------------------------------------------------------------------- */

const tickLogger = new TickLogger();

module.exports = tickLogger;
module.exports.TickLogger = TickLogger;
module.exports.create = function create(options) { return new TickLogger(options); };
module.exports.EVENT_NAME = EVENT_NAME;
module.exports.DEFAULTS = DEFAULTS;
module.exports.buildRecord = buildRecord;
module.exports.normalizePositions = normalizePositions;
module.exports.sanitizeId = sanitizeId;
module.exports.resolveRaceId = resolveRaceId;

/* ---------------------------------------------------------------------------
 * 6. Самопроверка: `node trajectory/tick_logger.js --self-test`
 * ------------------------------------------------------------------------- */

if (require.main === module && process.argv.indexOf('--self-test') !== -1) {
  const self = new TickLogger({ outDir: path.join(__dirname, '..', 'memory', 'patterns') });

  self.on('write', (record, file) => {
    console.log('[tick_logger] записано в', file, JSON.stringify(record));
  });

  const raceId = 'selftest_' + Date.now();
  const demoTicks = [1, 2, 3].map((n) => ({
    race_id: raceId,
    lap: n,
    positions: [
      { agent: 'agent_1', lap: n, progress: 0.1 * n },
      { agent: 'agent_2', lap: n, progress: 0.1 * n - 0.02 },
      { agent: 'agent_3', progress: 0.05 * n, status: 'running' },
    ],
  }));

  demoTicks.forEach((tick) => self.onTick(tick));
  self.flush().then(() => {
    console.log('[tick_logger] файл:', self.pathFor(raceId));
    console.log('[tick_logger] stats:', JSON.stringify(self.getStats()));
    const back = readTicks(raceId);
    console.log('[tick_logger] прочитано обратно строк:', back.length);
  });
}

/* ---------------------------------------------------------------------------
 * 7. Утилита чтения: разобрать JSONL-файл гонки в массив записей
 *    формата `{ ts, positions: [{ agent, lap, progress }] }`.
 * ------------------------------------------------------------------------- */

function readTicks(raceId, options) {
  const opts = isObject(options) ? options : {};
  const dir = opts.outDir || DEFAULTS.outDir;
  const fileName = (opts.prefix || DEFAULTS.prefix)
    + sanitizeId(raceId, opts.maxIdLength || DEFAULTS.maxIdLength)
    + (opts.suffix || DEFAULTS.suffix);
  const file = path.join(dir, fileName);

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }

  const records = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (isObject(rec) && Array.isArray(rec.positions)) records.push(rec);
    } catch (err) {
      // Повреждённую строку пропускаем, не роняя чтение всего файла.
    }
  }
  return records;
}

module.exports.readTicks = readTicks;
module.exports.parseTicksFile = readTicks;
