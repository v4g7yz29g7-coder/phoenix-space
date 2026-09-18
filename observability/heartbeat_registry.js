'use strict';

/**
 * observability/heartbeat_registry.js
 * ---------------------------------------------------------------------------
 * Heartbeat-мониторинг агентов (registry живых боксов).
 *
 * Каждый агент-бокс периодически шлёт heartbeat. Реестр хранит последний
 * известный timestamp для каждого бокса и классифицирует его состояние
 * относительно TTL (по умолчанию 30 секунд):
 *
 *      age <= TTL            -> "OK"    (агент жив / alive)
 *      TTL < age <= staleTtl -> "STALE" (heartbeat пропущен, но ещё не мёртв)
 *      age >  staleTtl       -> "DEAD"  (агент мёртв)
 *
 * где staleTtl = ttl * graceFactor (по умолчанию 2 -> 60s).
 *
 * Публичный API:
 *   class HeartbeatRegistry
 *       .beat(id, ts?)      — зарегистрировать heartbeat
 *       .touch(id)          — heartbeat с текущим временем
 *       .remove(id)         — удалить бокс из реестра
 *       .clear()            — очистить реестр
 *       .status(id)         — "OK" | "STALE" | "DEAD" | undefined
 *       .get(id)            — подробная запись по боксу
 *       .list()             — массив записей
 *       .check()            — { alive, stale, dead, total, agents: [...] }
 *       .snapshot()         — алиас check()
 *
 *   check(input?, opts?)    — главный экспорт критерия.
 *                             Возвращает { alive, stale, dead } числами.
 *
 * CLI:
 *   node observability/heartbeat_registry.js --selftest
 *   node observability/heartbeat_registry.js --json
 *
 * Модуль не имеет внешних зависимостей (только Node built-ins).
 *
 * @module observability/heartbeat_registry
 */

/* ------------------------------------------------------------------------- *
 * Константы
 * ------------------------------------------------------------------------- */

/** TTL по умолчанию: 30 секунд. */
const DEFAULT_TTL_MS = 30 * 1000;

/** Во сколько раз stale-окно шире TTL. age > ttl*graceFactor -> DEAD. */
const DEFAULT_GRACE_FACTOR = 2;

/** Возможные статусы агента. */
const STATUS = Object.freeze({
  OK: 'OK',
  STALE: 'STALE',
  DEAD: 'DEAD',
});

const STATUSES = Object.freeze([STATUS.OK, STATUS.STALE, STATUS.DEAD]);

/* ------------------------------------------------------------------------- *
 * Нормализация времени
 * ------------------------------------------------------------------------- */

/**
 * Привести произвольный timestamp к epoch-миллисекундам.
 * Поддерживает: number (секунды < 1e11 или миллисекунды), ISO-8601 строку,
 * числовую строку, Date.
 *
 * @param {number|string|Date|null|undefined} value
 * @returns {number|null}
 */
function toEpochMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return null;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
    }
    const parsed = Date.parse(s);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Поля, в которых может лежать heartbeat-timestamp. */
const TIMESTAMP_FIELDS = Object.freeze([
  'timestamp',
  'ts',
  'time',
  'last_seen',
  'lastSeen',
  'lastSeenAt',
  'last_seen_at',
  'last_heartbeat',
  'lastHeartbeat',
  'heartbeat',
  'heartbeat_ts',
  'updated_at',
  'updatedAt',
]);

/**
 * Вытащить timestamp из произвольной записи агента.
 * @param {object} entry
 * @returns {number|null} epoch ms
 */
function extractTimestamp(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'number' || typeof entry === 'string' || entry instanceof Date) {
    return toEpochMs(entry);
  }
  if (typeof entry !== 'object') return null;
  for (const field of TIMESTAMP_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(entry, field)) {
      const ms = toEpochMs(entry[field]);
      if (ms !== null) return ms;
    }
  }
  return null;
}

/**
 * Классифицировать возраст heartbeat.
 * @param {number} ageMs
 * @param {number} ttlMs
 * @param {number} staleTtlMs
 * @returns {'OK'|'STALE'|'DEAD'}
 */
function classify(ageMs, ttlMs, staleTtlMs) {
  if (!Number.isFinite(ageMs)) return STATUS.DEAD;
  if (ageMs <= ttlMs) return STATUS.OK;
  if (ageMs <= staleTtlMs) return STATUS.STALE;
  return STATUS.DEAD;
}

/* ------------------------------------------------------------------------- *
 * Реестр
 * ------------------------------------------------------------------------- */

class HeartbeatRegistry {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttl]          TTL в мс (по умолчанию 30000)
   * @param {number} [opts.staleTtl]     граница DEAD в мс (по умолчанию ttl*2)
   * @param {number} [opts.graceFactor]  множитель TTL для stale-окна
   * @param {function} [opts.now]        источник времени (для тестов)
   */
  constructor(opts = {}) {
    const ttl = Number.isFinite(opts.ttl) && opts.ttl > 0 ? opts.ttl : DEFAULT_TTL_MS;
    const graceFactor =
      Number.isFinite(opts.graceFactor) && opts.graceFactor >= 1
        ? opts.graceFactor
        : DEFAULT_GRACE_FACTOR;
    const staleTtl =
      Number.isFinite(opts.staleTtl) && opts.staleTtl > ttl ? opts.staleTtl : ttl * graceFactor;

    this.ttl = ttl;
    this.staleTtl = staleTtl;
    this.graceFactor = graceFactor;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    /** @type {Map<string, {id:string, last_seen_ms:number}>} */
    this.boxes = new Map();
  }

  /** Вернуть "сейчас" в мс. */
  now() {
    const t = this._now();
    return Number.isFinite(t) ? t : Date.now();
  }

  /**
   * Зарегистрировать heartbeat агента.
   * @param {string} id
   * @param {number|string|Date} [ts] момент heartbeat (по умолчанию now)
   * @returns {{id:string,last_seen_ms:number}}
   */
  beat(id, ts) {
    const key = String(id);
    const ms = toEpochMs(ts);
    const value = ms !== null ? ms : this.now();
    const rec = { id: key, last_seen_ms: value };
    this.boxes.set(key, rec);
    return rec;
  }

  /** Heartbeat «сейчас». */
  touch(id) {
    return this.beat(id, this.now());
  }

  /** Удалить бокс из реестра. @returns {boolean} */
  remove(id) {
    return this.boxes.delete(String(id));
  }

  /** Очистить реестр. */
  clear() {
    this.boxes.clear();
  }

  /** Зарегистрировать пачку агентов: Array|Map|plain object. */
  load(input) {
    for (const rec of normalizeInput(input)) {
      const ms = extractTimestamp(rec);
      if (ms !== null) this.boxes.set(String(rec.id), { id: String(rec.id), last_seen_ms: ms });
    }
    return this;
  }

  /**
   * Подробная запись по боксу.
   * @returns {{id,status,age_ms,age_s,last_seen}|undefined}
   */
  get(id) {
    const rec = this.boxes.get(String(id));
    if (!rec) return undefined;
    return this._describe(rec, this.now());
  }

  _describe(rec, nowMs) {
    const ageMs = Math.max(0, nowMs - rec.last_seen_ms);
    return {
      id: rec.id,
      status: classify(ageMs, this.ttl, this.staleTtl),
      age_ms: ageMs,
      age_s: Math.round(ageMs / 1000),
      last_seen: new Date(rec.last_seen_ms).toISOString(),
    };
  }

  /** Статус бокса как строка. */
  status(id) {
    const rec = this.get(id);
    return rec ? rec.status : undefined;
  }

  /** Массив подробных записей по всем боксам. */
  list() {
    const nowMs = this.now();
    return Array.from(this.boxes.values())
      .map((rec) => this._describe(rec, nowMs))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Главный отчёт.
   * @returns {{alive:number, stale:number, dead:number, ok:number, total:number, agents:Array}}
   */
  check() {
    const agents = this.list();
    let alive = 0;
    let stale = 0;
    let dead = 0;
    for (const a of agents) {
      if (a.status === STATUS.OK) alive += 1;
      else if (a.status === STATUS.STALE) stale += 1;
      else dead += 1;
    }
    return { alive, stale, dead, ok: alive, total: agents.length, agents };
  }

  /** Алиас check() для совместимости. */
  snapshot() {
    return this.check();
  }
}

/* ------------------------------------------------------------------------- *
 * Нормализация входных данных для check()
 * ------------------------------------------------------------------------- */

/**
 * Привести входные данные к массиву записей вида {id, ...ts fields}.
 * Поддерживает:
 *   - Array<{id, timestamp}> или Array<[id, ts]>
 *   - Map<id, ts>
 *   - plain object {id: ts | {timestamp}}
 *   - HeartbeatRegistry
 * @returns {Array<object>}
 */
function normalizeInput(input) {
  const out = [];
  if (input === null || input === undefined) return out;
  if (input instanceof HeartbeatRegistry) {
    for (const rec of input.boxes.values()) {
      out.push({ id: rec.id, timestamp: rec.last_seen_ms });
    }
    return out;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      if (Array.isArray(item) && item.length >= 2) {
        out.push({ id: item[0], timestamp: item[1] });
      } else if (item && typeof item === 'object') {
        out.push(item);
      }
    }
    return out;
  }
  if (input instanceof Map) {
    for (const [id, ts] of input.entries()) out.push({ id, timestamp: ts });
    return out;
  }
  if (typeof input === 'object') {
    for (const [id, val] of Object.entries(input)) {
      if (val && typeof val === 'object') out.push({ id, ...val });
      else out.push({ id, timestamp: val });
    }
    return out;
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Публичная функция check()
 * ------------------------------------------------------------------------- */

/**
 * Посчитать количество живых/протухших/мёртвых агентов.
 *
 * @param {Array|Map|object|HeartbeatRegistry} [input] реестр или список heartbeat'ов
 * @param {object} [opts] { ttl, staleTtl, graceFactor, now }
 * @returns {{alive:number, stale:number, dead:number, ok:number, total:number, agents:Array}}
 */
function check(input, opts = {}) {
  const registry = new HeartbeatRegistry(opts);
  for (const rec of normalizeInput(input)) {
    const ms = extractTimestamp(rec);
    if (ms !== null) registry.beat(rec.id, ms);
  }
  return registry.check();
}

/* ------------------------------------------------------------------------- *
 * Selftest
 * ------------------------------------------------------------------------- */

/**
 * Детерминированный тест: 3 агента с разными timestamp.
 * Ожидаем ровно {alive:1, stale:1, dead:1}.
 * @returns {{pass:boolean, result:object, failures:string[]}}
 */
function selfTest() {
  const now = Date.now();
  const registry = new HeartbeatRegistry({ ttl: 30 * 1000, now: () => now });
  registry.beat('agent_ok', now - 5 * 1000); //   5s -> OK
  registry.beat('agent_stale', now - 45 * 1000); //  45s -> STALE
  registry.beat('agent_dead', now - 120 * 1000); // 120s -> DEAD

  const result = registry.check();
  const failures = [];
  if (result.alive !== 1) failures.push(`alive=${result.alive} (expected 1)`);
  if (result.stale !== 1) failures.push(`stale=${result.stale} (expected 1)`);
  if (result.dead !== 1) failures.push(`dead=${result.dead} (expected 1)`);
  if (typeof result.alive !== 'number') failures.push('alive is not a number');
  if (typeof result.stale !== 'number') failures.push('stale is not a number');
  if (typeof result.dead !== 'number') failures.push('dead is not a number');

  const statuses = registry.list().map((a) => a.status);
  if (!statuses.includes(STATUS.OK)) failures.push('no OK status');
  if (!statuses.includes(STATUS.STALE)) failures.push('no STALE status');
  if (!statuses.includes(STATUS.DEAD)) failures.push('no DEAD status');

  // Та же проверка через публичный check().
  const viaFn = check(
    [
      { id: 'agent_ok', timestamp: now - 5 * 1000 },
      { id: 'agent_stale', timestamp: now - 45 * 1000 },
      { id: 'agent_dead', timestamp: now - 120 * 1000 },
    ],
    { ttl: 30 * 1000, now: () => now }
  );
  if (viaFn.alive !== 1 || viaFn.stale !== 1 || viaFn.dead !== 1) {
    failures.push(
      `check() mismatch: ${JSON.stringify({ alive: viaFn.alive, stale: viaFn.stale, dead: viaFn.dead })}`
    );
  }

  return { pass: failures.length === 0, result, failures };
}

/* ------------------------------------------------------------------------- *
 * Экспорт / CLI
 * ------------------------------------------------------------------------- */

module.exports = {
  // Главный экспорт критерия:
  check,
  // Сопутствующее:
  HeartbeatRegistry,
  selfTest,
  classify,
  toEpochMs,
  extractTimestamp,
  STATUS,
  STATUSES,
  DEFAULT_TTL_MS,
  DEFAULT_GRACE_FACTOR,
};

if (require.main === module) {
  const arg = process.argv[2] || '--selftest';
  if (arg === '--selftest') {
    const r = selfTest();
    // eslint-disable-next-line no-console
    console.log(
      `[heartbeat_registry] selftest: ${r.pass ? 'PASS' : 'FAIL'} ` +
        `alive=${r.result.alive} stale=${r.result.stale} dead=${r.result.dead}`
    );
    if (!r.pass) {
      // eslint-disable-next-line no-console
      console.error(r.failures.join('\n'));
      process.exit(1);
    }
  } else if (arg === '--json') {
    const registry = new HeartbeatRegistry();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(registry.check(), null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error('Usage: node heartbeat_registry.js [--selftest|--json]');
    process.exit(2);
  }
}
