'use strict';

/**
 * radio/race_commentator_v2.js
 * ============================================================================
 * Живой радиокомментатор гонки AI-агентов (v2).
 *
 * Модуль подписывается на события гонки:
 *   - `race:tick`      ->  { race_id, lap?, positions:[{agent, progress, status}] }
 *   - `race:overtake`  ->  { race_id, by, on, lap?, gap? }
 *
 * Для каждого значимого события он генерирует короткую фразу через
 * `radio/radio_writer` (GigaChat, с шаблонным fallback при офлайне) и
 * публикует её в канал `race:radio`.
 *
 * Публичный API
 * -------------
 *   const commentator = require('./radio/race_commentator_v2');
 *
 *   commentator.connect();               // подключиться к 127.0.0.1:3020
 *   commentator.disconnect();            // закрыть соединение
 *   commentator.onTick(payload);         // обработать тик вручную
 *   commentator.onOvertake(payload);     // обработать обгон вручную
 *   commentator.on('race:radio', fn);    // локальная подписка на фразы
 *   commentator.setEnabled(false);       // временно выключить озвучку
 *   commentator.getStats();              // счётчики/телеметрия
 *
 * Гарантии
 * --------
 *   - Модуль требует только `events`; `socket.io-client` и `radio_writer`
 *     подключаются лениво, поэтому `node --check` и запуск без зависимостей
 *     не падают.
 *   - Генерация никогда не отклоняет промис: при ошибке используется
 *     шаблонная фраза.
 *   - Очередь сериализует асинхронные обращения к модели и не даёт потоку
 *     тиков заспамить GigaChat.
 * ============================================================================
 */

const { EventEmitter } = require('events');

/* ---------------------------------------------------------------------------
 * 1. Ленивые зависимости
 * ------------------------------------------------------------------------- */

let ioClient = null;
try {
  // eslint-disable-next-line global-require
  const mod = require('socket.io-client');
  ioClient = mod && mod.io ? mod.io : mod;
} catch (err) {
  ioClient = null;
}

let radioWriter = null;
try {
  // eslint-disable-next-line global-require
  radioWriter = require('./radio_writer');
} catch (err) {
  radioWriter = null;
}

/* ---------------------------------------------------------------------------
 * 2. Конфигурация
 * ------------------------------------------------------------------------- */

const DEFAULTS = {
  url: process.env.RADIO_URL || 'http://127.0.0.1:3020',
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
  timeout: 10000,

  // Канал, в который публикуются готовые фразы.
  channel: 'race:radio',

  // Экономия запросов к модели для частых `race:tick`.
  tickCooldownMs: 1500,     // не чаще одной фразы по тикам раз в N мс
  minProgressDelta: 0.05,   // минимальный прирост прогресса лидера
  overtakeCooldownMs: 800,  // антидребезг для серий обгонов
  dedupeMs: 2500,           // окно дедупликации одинаковых обгонов
  maxQueue: 40,             // максимум отложенных заданий

  commentTicks: true,       // озвучивать ли значимые тики
  commentOvertakes: true,   // озвучивать ли обгоны
  offline: false,           // true -> только шаблоны, без сети
};

/* Шаблонные фразы — страховка, если модель/сеть недоступны. */
const TEMPLATES = {
  tick: [
    'Пелотон наматывает круги, борьба продолжается!',
    'Лидер держит темп, соперники ищут ошибку.',
    'Плотная борьба на трассе, отрыв минимален.',
  ],
  'leader-change': [
    'Смена лидера! Борьба на пределе.',
    'Новый лидер выходит вперёд, трибуны ликуют!',
  ],
  lap: [
    'Новый круг! Гонка набирает обороты.',
    'Круг пройден, темп соперников растёт.',
  ],
  status: [
    'Инцидент на трассе, механики уже наготове.',
    'Машина с трудом держит темп, борьба за позицию!',
  ],
  overtake: [
    'Обгон! Смелый манёвр на торможении.',
    'Позиция сменилась, атака увенчалась успехом!',
  ],
  finish: [
    'Финиш! Победитель пересекает линию первым.',
  ],
  generic: [
    'Гонка продолжается, события развиваются быстро.',
  ],
};

/* ---------------------------------------------------------------------------
 * 3. Небольшие утилиты
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

/** Допускает `race_id`, `raceId`, `race`, `id`. */
function resolveRaceId(payload) {
  if (!isObject(payload)) return null;
  const value = firstDefined(
    [payload.race_id, payload.raceId, payload.race, payload.id],
    null
  );
  return value === null ? null : String(value);
}

/** Приводит число/строку к конечному number или null. */
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

function pickTemplate(kind) {
  const pool = TEMPLATES[kind] || TEMPLATES.generic;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Идентификатор гонщика, устойчивый к разным соглашениям об именах. */
function driverId(driver, index) {
  if (!isObject(driver)) return 'car_' + index;
  const id = firstDefined(
    [driver.agent, driver.id, driver.driverId, driver.driver_id,
     driver.code, driver.name, driver.driver],
    'car_' + index
  );
  return String(id);
}

/**
 * Нормализует список позиций из payload в массив
 * { id, progress, status } отсортированный по убыванию прогресса.
 */
function normalizePositions(payload) {
  if (!isObject(payload)) return [];
  let raw = firstDefined(
    [payload.positions, payload.pos, payload.agents, payload.cars, payload.field],
    []
  );
  if (isObject(raw)) {
    raw = Object.keys(raw).map((key) => {
      const value = raw[key];
      return isObject(value) ? Object.assign({ agent: key }, value) : { agent: key };
    });
  }
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(Boolean)
    .map((driver, index) => {
      const progress = firstDefined(
        [toNumber(driver.progress), toNumber(driver.lap), toNumber(driver.distance)],
        0
      );
      const status = firstDefined(
        [driver.status, driver.state, driver.ok],
        'running'
      );
      return {
        id: driverId(driver, index),
        progress: clamp01(progress > 1 ? progress / 100 : progress),
        rawProgress: progress,
        status: String(status),
      };
    })
    .sort((a, b) => b.progress - a.progress);
}

/* ---------------------------------------------------------------------------
 * 4. Описание событий для радио-райтера
 * ------------------------------------------------------------------------- */

/** Готовит { event, context, meta } для тика. */
function describeTick(payload, ordered, reason) {
  const raceId = resolveRaceId(payload);
  const leader = ordered[0] || null;
  const second = ordered[1] || null;
  const lap = firstDefined(
    [toNumber(payload && payload.lap), toNumber(payload && payload.lap_no)],
    null
  );

  let gap = null;
  if (leader && second) gap = Math.max(0, leader.progress - second.progress);

  const context = {
    gонка: raceId || 'без идентификатора',
    круг: lap === null ? 'н/д' : lap,
    лидер: leader ? leader.id : 'н/д',
    прогресс_лидера: leader ? leader.progress.toFixed(3) : 'н/д',
    отрыв_до_второго: gap === null ? 'н/д' : gap.toFixed(3),
    соперники: ordered.slice(0, 3).map((d) => d.id).join(', ') || 'н/д',
    причина: reason || 'регулярный тик',
  };

  const eventText =
    reason === 'leader-change'
      ? 'смена лидера в гонке'
      : reason === 'lap'
        ? 'пройден новый круг'
        : reason === 'status'
          ? 'изменение состояния гонщика'
          : 'очередной тик гонки';

  return {
    event: eventText,
    context,
    meta: { race_id: raceId, lap, leader: leader ? leader.id : null, reason },
  };
}

/** Готовит { event, context, meta } для обгона. */
function describeOvertake(payload) {
  const raceId = resolveRaceId(payload);
  const by = firstDefined(
    [payload && payload.by, payload && payload.agent, payload && payload.overtaker],
    'неизвестный гонщик'
  );
  const on = firstDefined(
    [payload && payload.on, payload && payload.victim, payload && payload.defender],
    'соперник'
  );
  const lap = firstDefined(
    [toNumber(payload && payload.lap), toNumber(payload && payload.lap_no)],
    null
  );
  const gap = toNumber(payload && payload.gap);

  const context = {
    гонка: raceId || 'без идентификатора',
    обгоняющий: String(by),
    соперник: String(on),
    круг: lap === null ? 'н/д' : lap,
    интервал: gap === null ? 'н/д' : gap,
    причина: 'обгон на трассе',
  };

  return {
    event: 'обгон',
    context,
    meta: {
      race_id: raceId,
      lap,
      by: String(by),
      on: String(on),
      gap,
    },
  };
}

/* ---------------------------------------------------------------------------
 * 5. Комментатор
 * ------------------------------------------------------------------------- */

class RaceCommentator extends EventEmitter {
  constructor(options) {
    super();
    this.options = Object.assign({}, DEFAULTS, options || {});
    this.url = this.options.url;
    this.channel = this.options.channel;

    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.enabled = true;

    /** Состояние по каждой гонке: raceId -> snapshot. */
    this.tickState = new Map();
    /** Дедупликация обгонов: key -> ts. */
    this.recentOvertakes = new Map();

    /** Очередь заданий озвучки (сериализует обращения к модели). */
    this.queue = [];
    this.busy = false;

    this.stats = {
      ticksSeen: 0,
      ticksCommented: 0,
      overtakesSeen: 0,
      overtakesCommented: 0,
      phrases: 0,
      errors: 0,
      dropped: 0,
    };

    this.lastPhrase = null;

    // Сохранённые ссылки для корректного снятия обработчиков.
    this.__boundTick = this.__onSocketTick.bind(this);
    this.__boundOvertake = this.__onSocketOvertake.bind(this);
  }

  /* ----------------------------- соединение ----------------------------- */

  /** Открывает socket-соединение (идемпотентно). */
  connect() {
    if (this.socket && this.connected) return this;
    if (this.connecting) return this;
    if (!ioClient) {
      this.emit('error', new Error('socket.io-client не установлен'));
      return this;
    }

    this.connecting = true;
    this.socket = ioClient(this.url, {
      transports: this.options.transports,
      reconnection: this.options.reconnection,
      reconnectionAttempts: this.options.reconnectionAttempts,
      reconnectionDelay: this.options.reconnectionDelay,
      reconnectionDelayMax: this.options.reconnectionDelayMax,
      timeout: this.options.timeout,
    });

    this.socket.on('connect', () => {
      this.connected = true;
      this.connecting = false;
      this.emit('connect', this.socket && this.socket.id);
    });

    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      this.emit('disconnect', reason);
    });

    this.socket.on('connect_error', (err) => {
      this.connecting = false;
      this.emit('error', err);
    });

    this.socket.on('race:tick', this.__boundTick);
    this.socket.on('race:overtake', this.__boundOvertake);
    return this;
  }

  /** Закрывает соединение и снимает обработчики. */
  disconnect() {
    if (this.socket) {
      try {
        if (typeof this.socket.off === 'function') {
          this.socket.off('race:tick', this.__boundTick);
          this.socket.off('race:overtake', this.__boundOvertake);
        }
        this.socket.removeAllListeners();
        this.socket.disconnect();
      } catch (err) {
        this.emit('error', err);
      }
      this.socket = null;
    }
    this.connected = false;
    this.connecting = false;
    return this;
  }

  isConnected() {
    return this.connected;
  }

  /* --------------------------- обработчики ------------------------------ */

  __onSocketTick(payload) {
    try {
      this.onTick(payload);
    } catch (err) {
      this.stats.errors += 1;
      this.emit('error', err);
    }
  }

  __onSocketOvertake(payload) {
    try {
      this.onOvertake(payload);
    } catch (err) {
      this.stats.errors += 1;
      this.emit('error', err);
    }
  }

  /**
   * Обработка `race:tick`.
   *
   * Мы не комментируем каждый тик: фраза генерируется только когда тик
   * значим (смена лидера, новый круг, изменение состояния) либо когда
   * прошёл кулдаун и лидер заметно продвинулся.
   */
  onTick(payload) {
    this.stats.ticksSeen += 1;
    const raceId = resolveRaceId(payload) || 'unknown';
    const ordered = normalizePositions(payload);
    const snapshot = this.__snapshot(ordered);
    const previous = this.tickState.get(raceId) || null;

    const decision = this.__significance(previous, snapshot);
    this.tickState.set(raceId, snapshot);

    if (!this.enabled || !this.options.commentTicks) return null;
    if (!decision.ok) return null;

    this.stats.ticksCommented += 1;
    const described = describeTick(payload, ordered, decision.reason);
    return this.say(described.event, described.context, described.meta);
  }

  /** Обработка `race:overtake`. */
  onOvertake(payload) {
    this.stats.overtakesSeen += 1;
    const meta = describeOvertake(payload).meta;

    if (this.__isDuplicateOvertake(meta)) {
      this.stats.dropped += 1;
      return null;
    }

    if (!this.enabled || !this.options.commentOvertakes) return null;

    this.stats.overtakesCommented += 1;
    const described = describeOvertake(payload);
    return this.say(described.event, described.context, described.meta);
  }

  /* --------------------------- генерация -------------------------------- */

  /**
   * Генерирует фразу через radio_writer и публикует её в `race:radio`.
   * @returns {Promise<object|null>} опубликованный пакет или null.
   */
  say(event, context, meta) {
    return this.__enqueue(() => this.__generateAndEmit(event, context, meta));
  }

  __generateAndEmit(event, context, meta) {
    return Promise.resolve()
      .then(() => {
        if (this.options.offline || !radioWriter) {
          return pickTemplate(this.__kindOf(meta));
        }
        if (typeof radioWriter.comment === 'function') {
          return radioWriter.comment(event, context);
        }
        if (typeof radioWriter.commentSync === 'function') {
          return radioWriter.commentSync(event);
        }
        return pickTemplate(this.__kindOf(meta));
      })
      .catch((err) => {
        this.stats.errors += 1;
        this.emit('error', err);
        return pickTemplate(this.__kindOf(meta));
      })
      .then((text) => {
        const phrase = String(text == null ? '' : text).trim() ||
          pickTemplate(this.__kindOf(meta));
        const packet = this.__buildPacket(phrase, event, context, meta);
        this.__publish(packet);
        return packet;
      });
  }

  __kindOf(meta) {
    if (!meta) return 'generic';
    if (meta.reason === 'leader-change') return 'leader-change';
    if (meta.reason === 'lap') return 'lap';
    if (meta.reason === 'status') return 'status';
    if (meta.by) return 'overtake';
    if (meta.finish) return 'finish';
    return 'tick';
  }

  __buildPacket(text, event, context, meta) {
    return {
      type: 'comment',
      channel: this.channel,
      event: event || 'гонка',
      text,
      context: context || {},
      race_id: meta && meta.race_id ? meta.race_id : null,
      lap: meta && meta.lap !== undefined ? meta.lap : null,
      reason: meta && meta.reason ? meta.reason : (meta && meta.by ? 'overtake' : 'tick'),
      ts: Date.now(),
    };
  }

  /** Рассылает пакет локально и (при соединении) на сервер. */
  __publish(packet) {
    this.stats.phrases += 1;
    this.lastPhrase = packet;
    this.emit(this.channel, packet);
    this.emit('phrase', packet);
    if (this.socket && this.connected) {
      try {
        this.socket.emit(this.channel, packet);
      } catch (err) {
        this.stats.errors += 1;
        this.emit('error', err);
      }
    }
    return packet;
  }

  /* ---------------------------- очередь ------------------------------- */

  /** Сериализует асинхронные задания, ограничивая длину очереди. */
  __enqueue(job) {
    if (this.queue.length >= this.options.maxQueue) {
      this.queue.shift();
      this.stats.dropped += 1;
    }
    return new Promise((resolve) => {
      this.queue.push({ job, resolve });
      this.__drain();
    });
  }

  __drain() {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) return;
    this.busy = true;
    Promise.resolve()
      .then(() => next.job())
      .then((value) => next.resolve(value))
      .catch((err) => {
        this.stats.errors += 1;
        this.emit('error', err);
        next.resolve(null);
      })
      .then(() => {
        this.busy = false;
        if (this.queue.length) this.__drain();
      });
  }

  /* ------------------------- вспомогательное -------------------------- */

  __snapshot(ordered) {
    const statuses = {};
    ordered.forEach((d) => { statuses[d.id] = d.status; });
    return {
      leader: ordered.length ? ordered[0].id : null,
      leaderProgress: ordered.length ? ordered[0].progress : 0,
      lap: null,
      statuses,
      ts: Date.now(),
    };
  }

  /**
   * Решает, достоин ли тик озвучки.
   * @returns {{ok:boolean, reason:string}}
   */
  __significance(previous, snapshot) {
    const opts = this.options;
    const now = Date.now();

    if (previous) {
      if (previous.leader !== snapshot.leader) {
        return { ok: now - (previous.commentTs || 0) >= opts.tickCooldownMs,
          reason: 'leader-change' };
      }
      const prevStatuses = previous.statuses || {};
      const changed = Object.keys(snapshot.statuses).some(
        (id) => prevStatuses[id] !== undefined && prevStatuses[id] !== snapshot.statuses[id]
      );
      if (changed) {
        return { ok: now - (previous.commentTs || 0) >= opts.tickCooldownMs,
          reason: 'status' };
      }
    }

    const lastTs = (previous && previous.commentTs) || 0;
    if (now - lastTs < opts.tickCooldownMs) {
      return { ok: false, reason: 'cooldown' };
    }
    const prevProgress = previous ? previous.leaderProgress : 0;
    const delta = Math.abs(snapshot.leaderProgress - prevProgress);
    if (delta >= opts.minProgressDelta) {
      return { ok: true, reason: 'progress' };
    }
    // Первый тик гонки — всегда повод начать трансляцию.
    if (!previous) return { ok: true, reason: 'progress' };
    return { ok: false, reason: 'insignificant' };
  }

  __isDuplicateOvertake(meta) {
    if (!meta || !meta.race_id) return false;
    const key = meta.race_id + '|' + meta.by + '|' + meta.on;
    const now = Date.now();
    const seen = this.recentOvertakes.get(key);
    this.recentOvertakes.set(key, now);
    // Чистим старые записи, чтобы карта не росла бесконечно.
    if (this.recentOvertakes.size > 500) {
      this.recentOvertakes.forEach((ts2, k) => {
        if (now - ts2 > this.options.dedupeMs) this.recentOvertakes.delete(k);
      });
    }
    return seen !== undefined && now - seen < this.options.dedupeMs;
  }

  /* ----------------------------- управление --------------------------- */

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    return this;
  }

  clear() {
    this.tickState.clear();
    this.recentOvertakes.clear();
    this.queue.length = 0;
    return this;
  }

  getStats() {
    return Object.assign({}, this.stats, {
      connected: this.connected,
      enabled: this.enabled,
      queued: this.queue.length,
      races: this.tickState.size,
      lastPhrase: this.lastPhrase ? this.lastPhrase.text : null,
    });
  }
}

/* ---------------------------------------------------------------------------
 * 6. Синглтон + экспорт
 * ------------------------------------------------------------------------- */

const raceCommentator = new RaceCommentator();

module.exports = raceCommentator;
module.exports.RaceCommentator = RaceCommentator;
module.exports._internal = {
  resolveRaceId,
  normalizePositions,
  describeTick,
  describeOvertake,
  pickTemplate,
  TEMPLATES,
};

/* ---------------------------------------------------------------------------
 * 7. Демо-режим: `node radio/race_commentator_v2.js`
 * ------------------------------------------------------------------------- */

if (require.main === module) {
  const demo = new RaceCommentator({ offline: true });

  demo.on('race:radio', (packet) => {
    // eslint-disable-next-line no-console
    console.log('[race:radio]', packet.reason, '|', packet.text);
  });

  const raceId = 'race_demo_' + Date.now();

  demo.onTick({
    race_id: raceId,
    lap: 1,
    positions: [
      { agent: 'agent_1', progress: 0.10, status: 'running' },
      { agent: 'agent_3', progress: 0.08, status: 'running' },
    ],
  });

  demo.onOvertake({
    race_id: raceId,
    by: 'agent_3',
    on: 'agent_1',
    lap: 1,
    gap: 1,
  });

  setTimeout(() => {
    // eslint-disable-next-line no-console
    console.log('stats:', JSON.stringify(demo.getStats()));
    process.exit(0);
  }, 150);
}
