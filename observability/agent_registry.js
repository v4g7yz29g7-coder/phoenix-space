'use strict';

/**
 * observability/agent_registry.js
 * ---------------------------------------------------------------------------
 * Heartbeat-мониторинг агентов (реестр живых боксов).
 *
 * Модель:
 *   - каждый бокс/агент регистрируется в реестре (registerAgent);
 *   - агент шлёт heartbeats (heartbeat) — обновляется lastHeartbeat;
 *   - при проверке (check) возраст последнего heartbeat сравнивается с TTL:
 *
 *        age <  TTL            -> OK     (жив,   alive)
 *        TTL <= age < 2*TTL    -> STALE  (просрочен, но ещё в окне)
 *        age >= 2*TTL          -> DEAD   (мёртв)
 *        нет heartbeat          -> DEAD
 *
 *   TTL по умолчанию 30_000 мс (30 секунд).
 *
 * Публичный API:
 *   registerAgent({id, ttlMs?, lastHeartbeat?, ...}) -> agent
 *   heartbeat(id, {at?})                             -> agent|null
 *   unregisterAgent(id)                              -> boolean
 *   getAgent(id)                                     -> agent|null
 *   listAgents()                                     -> agent[]
 *   statusOf(id, now?)                               -> 'OK'|'STALE'|'DEAD'|null
 *   check(now?)                                      -> { alive, stale, dead, ... }
 *   checkAll(now?)                                   -> подробный отчёт (совместимость)
 *
 * Зависимостей нет (только Node built-ins).
 *
 * @module observability/agent_registry
 */

const os = require('os');

/* ------------------------------------------------------------------------- *
 * Константы
 * ------------------------------------------------------------------------- */

/** Значение TTL по умолчанию — 30 секунд. */
const DEFAULT_TTL_MS = 30 * 1000;

/** Статусы heartbeat. Порядок = возрастание серьёзности. */
const STATUS = Object.freeze({
  OK: 'OK',
  STALE: 'STALE',
  DEAD: 'DEAD',
});

const STATUSES = Object.freeze([STATUS.OK, STATUS.STALE, STATUS.DEAD]);

const SEVERITY = Object.freeze({
  [STATUS.OK]: 0,
  [STATUS.STALE]: 1,
  [STATUS.DEAD]: 2,
});

/* ------------------------------------------------------------------------- *
 * Утилиты
 * ------------------------------------------------------------------------- */

function toMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Числа < 1e11 трактуем как секунды.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return null;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
    }
    const p = Date.parse(s);
    return Number.isFinite(p) ? p : null;
  }
  return null;
}

function nowMs() {
  return Date.now();
}

/* ------------------------------------------------------------------------- *
 * Реестр
 * ------------------------------------------------------------------------- */

/** id -> agent */
const registry = new Map();

/**
 * Зарегистрировать (или перезаписать) агента.
 *
 * @param {object} agent
 * @param {string} agent.id            обязательный идентификатор бокса
 * @param {number} [agent.ttlMs]       TTL heartbeat (default 30000)
 * @param {number|string|Date} [agent.lastHeartbeat] начальный heartbeat
 * @param {object} [agent.meta]
 * @returns {object} нормализованная запись
 */
function registerAgent(agent) {
  if (!agent || agent.id === undefined || agent.id === null || agent.id === '') {
    throw new Error('registerAgent: agent.id обязателен');
  }
  const id = String(agent.id);
  const existing = registry.get(id);
  const ttlRaw = agent.ttlMs !== undefined ? agent.ttlMs : agent.heartbeatTtlMs;
  const ttlMs = Number(ttlRaw) > 0 ? Number(ttlRaw) : (existing ? existing.ttlMs : DEFAULT_TTL_MS);
  const hb = toMs(agent.lastHeartbeat);

  const record = {
    id,
    name: agent.name || (existing ? existing.name : id),
    ttlMs,
    lastHeartbeat: hb !== null ? hb : (existing ? existing.lastHeartbeat : nowMs()),
    meta: agent.meta && typeof agent.meta === 'object' ? agent.meta : (existing ? existing.meta : {}),
    registeredAt: existing ? existing.registeredAt : nowMs(),
  };
  registry.set(id, record);
  return record;
}

/** Обновить heartbeat агента (lastHeartbeat = at || now). */
function heartbeat(id, opts = {}) {
  const agent = registry.get(String(id));
  if (!agent) return null;
  const at = toMs(opts.at);
  agent.lastHeartbeat = at !== null ? at : nowMs();
  return agent;
}

/** Удалить агента из реестра. */
function unregisterAgent(id) {
  return registry.delete(String(id));
}

/** Получить запись агента. */
function getAgent(id) {
  return registry.get(String(id)) || null;
}

/** Список зарегистрированных агентов. */
function listAgents() {
  return Array.from(registry.values());
}

/** Очистить реестр (для тестов). */
function clearRegistry() {
  registry.clear();
}

/* ------------------------------------------------------------------------- *
 * Классификация
 * ------------------------------------------------------------------------- */

/**
 * Классифицировать агента по возрасту heartbeat.
 * @param {object} agent
 * @param {number} now epoch ms
 * @returns {'OK'|'STALE'|'DEAD'}
 */
function classify(agent, now) {
  const last = agent.lastHeartbeat;
  if (!Number.isFinite(last)) return STATUS.DEAD;
  const ttl = Number(agent.ttlMs) > 0 ? Number(agent.ttlMs) : DEFAULT_TTL_MS;
  const age = now - last;
  if (age < 0) return STATUS.OK; // будущий heartbeat — считаем живым
  if (age < ttl) return STATUS.OK;
  if (age < ttl * 2) return STATUS.STALE;
  return STATUS.DEAD;
}

/**
 * Статус одного агента (или null, если не зарегистрирован).
 * @returns {'OK'|'STALE'|'DEAD'|null}
 */
function statusOf(id, now) {
  const agent = registry.get(String(id));
  if (!agent) return null;
  return classify(agent, Number.isFinite(now) ? now : nowMs());
}

/* ------------------------------------------------------------------------- *
 * Публичная проверка
 * ------------------------------------------------------------------------- */

/**
 * check() — посчитать живых / просроченных / мёртвых агентов.
 *
 * @param {number} [now] epoch ms (для детерминированных тестов)
 * @returns {{alive:number, stale:number, dead:number, total:number,
 *            byStatus:object, generatedAt:string}}
 */
function check(now) {
  const at = Number.isFinite(now) ? now : nowMs();
  const byStatus = { [STATUS.OK]: 0, [STATUS.STALE]: 0, [STATUS.DEAD]: 0 };
  const agents = listAgents();

  for (const agent of agents) {
    byStatus[classify(agent, at)] += 1;
  }

  return {
    alive: byStatus[STATUS.OK],
    stale: byStatus[STATUS.STALE],
    dead: byStatus[STATUS.DEAD],
    total: agents.length,
    byStatus,
    generatedAt: new Date(at).toISOString(),
  };
}

/**
 * checkAll() — подробный отчёт (совместимость со smoke-тестом).
 * Возвращает агрегат + по каждому агенту его статус и возраст heartbeat.
 *
 * @param {{now?:number}|number} [options]
 */
function checkAll(options = {}) {
  const opts = typeof options === 'number' ? { now: options } : (options || {});
  const at = Number.isFinite(opts.now) ? opts.now : nowMs();
  const agents = listAgents();

  const reports = agents.map((agent) => {
    const status = classify(agent, at);
    const age = Number.isFinite(agent.lastHeartbeat) ? Math.max(0, at - agent.lastHeartbeat) : Infinity;
    return {
      id: agent.id,
      name: agent.name,
      status,
      ttlMs: agent.ttlMs,
      heartbeatAgeMs: Number.isFinite(age) ? age : null,
      lastHeartbeat: Number.isFinite(agent.lastHeartbeat)
        ? new Date(agent.lastHeartbeat).toISOString()
        : null,
      checks: [{ name: 'heartbeat', status, detail: `age=${Number.isFinite(age) ? age : 'inf'}ms ttl=${agent.ttlMs}ms` }],
    };
  });

  const byStatus = { [STATUS.OK]: 0, [STATUS.STALE]: 0, [STATUS.DEAD]: 0 };
  for (const r of reports) byStatus[r.status] += 1;

  let overall = STATUS.OK;
  for (const r of reports) {
    if (SEVERITY[r.status] > SEVERITY[overall]) overall = r.status;
  }
  if (agents.length === 0) overall = STATUS.DEAD;

  return {
    generatedAt: new Date(at).toISOString(),
    total: agents.length,
    healthy: byStatus[STATUS.OK],
    alive: byStatus[STATUS.OK],
    stale: byStatus[STATUS.STALE],
    dead: byStatus[STATUS.DEAD],
    byStatus,
    overall,
    agents: reports,
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      pid: process.pid,
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Экспорт
 * ------------------------------------------------------------------------- */

module.exports = {
  STATUS,
  STATUSES,
  SEVERITY,
  DEFAULT_TTL_MS,
  registerAgent,
  heartbeat,
  unregisterAgent,
  getAgent,
  listAgents,
  clearRegistry,
  statusOf,
  classify,
  check,
  checkAll,
  toMs,
};

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */

function main(argv) {
  const args = (argv || process.argv).slice(2);
  if (args.includes('--selftest')) {
    const t = nowMs();
    clearRegistry();
    registerAgent({ id: 'selftest-ok', lastHeartbeat: t - 1000 });
    registerAgent({ id: 'selftest-stale', lastHeartbeat: t - 45000 });
    registerAgent({ id: 'selftest-dead', lastHeartbeat: t - 120000 });
    const res = check(t);
    process.stdout.write('AGENT_REGISTRY_SELFTEST\n');
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    process.stdout.write(
      res.alive === 1 && res.stale === 1 && res.dead === 1 ? 'SELFTEST_OK\n' : 'SELFTEST_FAIL\n',
    );
    if (!(res.alive === 1 && res.stale === 1 && res.dead === 1)) process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(check(), null, 2) + '\n');
}

if (require.main === module) {
  main(process.argv);
}
