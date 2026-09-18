'use strict';

/**
 * observability/daily_report.js
 * ------------------------------------------------------------------
 * Ежедневный отчёт (Daily Report) для observability-контура Everos.
 *
 * Публичный API:
 *   generate(options?) -> Report
 *
 * Дополнительно на функции generate и на самом модуле доступны:
 *   generate.format / format   — рендер отчёта в Markdown;
 *   generate.toJson / toJson   — сериализация отчёта в JSON;
 *   generate.write  / write    — сохранение отчёта на диск.
 *
 * generate() принимает список событий (events) и строит агрегированный
 * отчёт: сводку, распределение уровней, разбивку по endpoint'ам,
 * топ ошибок, проверки SLO и интегральную оценку здоровья (health).
 *
 * Модуль не имеет внешних зависимостей и корректно работает как
 * самостоятельный CLI, так и при подключении через require().
 * ------------------------------------------------------------------
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

/* ------------------------------------------------------------------ *
 * Константы модуля
 * ------------------------------------------------------------------ */

const SCHEMA = 'everos.observability.daily_report';
const VERSION = '2.0.0';
const FILE_PREFIX = 'daily_report_';

const LEVEL_INFO = 'info';
const LEVEL_WARN = 'warn';
const LEVEL_ERROR = 'error';
const LEVEL_DEBUG = 'debug';

const UNKNOWN_ENDPOINT = 'unknown';
const UNKNOWN_ERROR = 'unknown error';

/** Пороговые значения SLO по умолчанию. */
const DEFAULT_SLO = Object.freeze({
  availability: 0.99,
  latencyP95Ms: 1000,
  errorRate: 0.05,
});

/** Опции генерации по умолчанию. */
const DEFAULT_OPTIONS = Object.freeze({
  date: null,
  timezone: 'UTC',
  locale: 'ru-RU',
  limitTopErrors: 10,
});

/* ------------------------------------------------------------------ *
 * Вспомогательные утилиты
 * ------------------------------------------------------------------ */

/**
 * Привести значение к числу с запасным значением.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function toNumber(value, fallback) {
  const fb = fallback === undefined ? 0 : fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fb;
}

/**
 * Округлить число до заданного количества знаков.
 * @param {number} value
 * @param {number} [digits]
 * @returns {number}
 */
function round(value, digits) {
  const d = digits === undefined ? 2 : digits;
  const factor = Math.pow(10, d);
  return Math.round(toNumber(value, 0) * factor) / factor;
}

/**
 * Ограничить значение диапазоном.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, toNumber(value, min)));
}

/**
 * Безопасное деление с запасным значением.
 * @param {number} a
 * @param {number} b
 * @param {number} [fallback]
 * @returns {number}
 */
function safeDiv(a, b, fallback) {
  const fb = fallback === undefined ? 0 : fallback;
  if (!b) return fb;
  return a / b;
}

/**
 * Среднее арифметическое массива.
 * @param {number[]} values
 * @returns {number}
 */
function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const total = values.reduce((acc, v) => acc + toNumber(v, 0), 0);
  return total / values.length;
}

/**
 * Перцентиль по массиву значений (метод ближайшего ранга).
 * @param {number[]} values
 * @param {number} p — перцентиль (0..100)
 * @returns {number}
 */
function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil((toNumber(p, 0) / 100) * sorted.length) - 1;
  const idx = clamp(rank, 0, sorted.length - 1);
  return sorted[idx];
}

/**
 * Уникальные значения массива.
 * @param {Array} values
 * @returns {Array}
 */
function unique(values) {
  return Array.from(new Set(Array.isArray(values) ? values : []));
}

/**
 * Проверка, что значение — простой объект.
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Глубокое слияние простых объектов (массивы заменяются).
 * @param {object} base
 * @param {object} override
 * @returns {object}
 */
function deepMerge(base, override) {
  const out = {};
  Object.keys(base || {}).forEach((key) => {
    out[key] = base[key];
  });
  if (!isPlainObject(override)) return out;
  Object.keys(override).forEach((key) => {
    if (isPlainObject(out[key]) && isPlainObject(override[key])) {
      out[key] = deepMerge(out[key], override[key]);
    } else if (override[key] !== undefined) {
      out[key] = override[key];
    }
  });
  return out;
}

/**
 * Формат даты YYYY-MM-DD (UTC).
 * @param {Date|string|number} d
 * @returns {string}
 */
function formatDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
}

/**
 * Формат таймстампа ISO без миллисекунд.
 * @param {Date|string|number} d
 * @returns {string}
 */
function formatTimestamp(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return formatDate(dt) + 'T' + String(dt.getUTCHours()).padStart(2, '0') + ':' +
    String(dt.getUTCMinutes()).padStart(2, '0') + ':' +
    String(dt.getUTCSeconds()).padStart(2, '0') + 'Z';
}

/* ------------------------------------------------------------------ *
 * Нормализация событий
 * ------------------------------------------------------------------ */

/**
 * Привести сырое событие к каноническому виду.
 * @param {object} raw
 * @param {number} index
 * @returns {object}
 */
function normalizeEvent(raw, index) {
  const e = isPlainObject(raw) ? raw : {};
  const level = typeof e.level === 'string' ? e.level.toLowerCase() : LEVEL_INFO;
  return {
    id: e.id === undefined ? index : e.id,
    timestamp: e.timestamp || e.ts || null,
    level: level,
    endpoint: typeof e.endpoint === 'string' && e.endpoint ? e.endpoint : UNKNOWN_ENDPOINT,
    latencyMs: Math.max(0, toNumber(e.latencyMs, toNumber(e.latency, 0))),
    count: Math.max(0, toNumber(e.count, 1)),
    message: typeof e.message === 'string' && e.message ? e.message : null,
    source: typeof e.source === 'string' ? e.source : null,
  };
}

/**
 * Нормализовать список событий.
 * @param {Array} list
 * @returns {object[]}
 */
function normalizeEvents(list) {
  if (!Array.isArray(list)) return [];
  return list.map((raw, index) => normalizeEvent(raw, index));
}

/* ------------------------------------------------------------------ *
 * Агрегаторы
 * ------------------------------------------------------------------ */

/**
 * Сводные счётчики по событиям.
 * @param {object[]} events
 * @returns {object}
 */
function aggregateTotals(events) {
  const totals = {
    events: events.length,
    requests: 0,
    errors: 0,
    warnings: 0,
    infos: 0,
    debug: 0,
    errorEvents: 0,
  };
  events.forEach((e) => {
    totals.requests += e.count;
    if (e.level === LEVEL_ERROR) {
      totals.errors += 1;
      totals.errorEvents += 1;
    } else if (e.level === LEVEL_WARN) {
      totals.warnings += 1;
    } else if (e.level === LEVEL_DEBUG) {
      totals.debug += 1;
    } else {
      totals.infos += 1;
    }
  });
  return totals;
}

/**
 * Распределение событий по уровням.
 * @param {object[]} events
 * @returns {object}
 */
function aggregateLevels(events) {
  const levels = {};
  events.forEach((e) => {
    levels[e.level] = (levels[e.level] || 0) + 1;
  });
  return levels;
}

/**
 * Статистика задержек.
 * @param {object[]} events
 * @returns {object}
 */
function aggregateLatency(events) {
  const values = events
    .map((e) => e.latencyMs)
    .filter((v) => Number.isFinite(v) && v >= 0);
  return {
    count: values.length,
    min: values.length ? Math.min.apply(null, values) : 0,
    max: values.length ? Math.max.apply(null, values) : 0,
    avg: round(average(values), 2),
    p50: round(percentile(values, 50), 2),
    p90: round(percentile(values, 90), 2),
    p95: round(percentile(values, 95), 2),
    p99: round(percentile(values, 99), 2),
  };
}

/**
 * Разбивка по endpoint'ам.
 * @param {object[]} events
 * @returns {object[]}
 */
function aggregateEndpoints(events) {
  const map = new Map();
  events.forEach((e) => {
    if (!map.has(e.endpoint)) {
      map.set(e.endpoint, {
        endpoint: e.endpoint,
        requests: 0,
        errors: 0,
        warnings: 0,
        latencySum: 0,
        latencyMax: 0,
        samples: 0,
      });
    }
    const entry = map.get(e.endpoint);
    entry.requests += e.count;
    entry.samples += 1;
    entry.latencySum += e.latencyMs;
    entry.latencyMax = Math.max(entry.latencyMax, e.latencyMs);
    if (e.level === LEVEL_ERROR) entry.errors += 1;
    if (e.level === LEVEL_WARN) entry.warnings += 1;
  });

  return Array.from(map.values())
    .map((entry) => ({
      endpoint: entry.endpoint,
      requests: entry.requests,
      errors: entry.errors,
      warnings: entry.warnings,
      avgLatencyMs: round(safeDiv(entry.latencySum, entry.samples, 0), 2),
      maxLatencyMs: round(entry.latencyMax, 2),
      errorRate: round(safeDiv(entry.errors, entry.samples, 0), 4),
    }))
    .sort((a, b) => b.requests - a.requests);
}

/**
 * Топ ошибок, отсортированный по убыванию частоты.
 * @param {object[]} events
 * @param {number} [limit]
 * @returns {object[]}
 */
function aggregateTopErrors(events, limit) {
  const max = limit === undefined ? 10 : limit;
  const map = new Map();
  events.forEach((e) => {
    if (e.level !== LEVEL_ERROR) return;
    const message = e.message || UNKNOWN_ERROR;
    if (!map.has(message)) {
      map.set(message, { message: message, count: 0, endpoints: new Set() });
    }
    const entry = map.get(message);
    entry.count += 1;
    entry.endpoints.add(e.endpoint);
  });

  return Array.from(map.values())
    .map((entry) => ({
      message: entry.message,
      count: entry.count,
      endpoints: Array.from(entry.endpoints),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, max);
}

/* ------------------------------------------------------------------ *
 * SLO и интегральная оценка здоровья
 * ------------------------------------------------------------------ */

/**
 * Проверить выполнение SLO.
 * @param {object} summary
 * @param {object} sloConfig
 * @returns {object}
 */
function evaluateSlo(summary, sloConfig) {
  const cfg = deepMerge(DEFAULT_SLO, sloConfig || {});
  const checks = [
    {
      name: 'availability',
      unit: 'ratio',
      target: cfg.availability,
      actual: summary.availability,
      passed: summary.availability >= cfg.availability,
    },
    {
      name: 'latency_p95',
      unit: 'ms',
      target: cfg.latencyP95Ms,
      actual: summary.latency.p95,
      passed: summary.latency.p95 <= cfg.latencyP95Ms,
    },
    {
      name: 'error_rate',
      unit: 'ratio',
      target: cfg.errorRate,
      actual: summary.errorRate,
      passed: summary.errorRate <= cfg.errorRate,
    },
  ];
  const failed = checks.filter((c) => !c.passed);
  return {
    passed: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    checks: checks,
  };
}

/**
 * Интегральная оценка здоровья (0..100).
 * @param {object} summary
 * @param {object} sloResult
 * @returns {object}
 */
function computeHealth(summary, sloResult) {
  let score = 100;
  score -= clamp(summary.errorRate * 200, 0, 45);
  score -= clamp(summary.latency.p95 / 40, 0, 25);
  score -= clamp((1 - summary.availability) * 100, 0, 30);
  if (sloResult && sloResult.failed) score -= sloResult.failed * 2;

  const finalScore = round(clamp(score, 0, 100), 1);
  let grade = 'A';
  if (finalScore < 90) grade = 'B';
  if (finalScore < 75) grade = 'C';
  if (finalScore < 60) grade = 'D';
  if (finalScore < 40) grade = 'F';

  return {
    score: finalScore,
    grade: grade,
    status: finalScore >= 75 ? 'healthy' : finalScore >= 50 ? 'degraded' : 'critical',
  };
}

/* ------------------------------------------------------------------ *
 * Рендеринг отчёта
 * ------------------------------------------------------------------ */

/**
 * Сформировать markdown-таблицу.
 * @param {string} title
 * @param {Array<{label:string,value:*}>} rows
 * @returns {string[]}
 */
function renderTable(title, rows) {
  const lines = ['## ' + title, '', '| metric | value |', '| --- | --- |'];
  rows.forEach((row) => {
    lines.push('| ' + row.label + ' | ' + row.value + ' |');
  });
  lines.push('');
  return lines;
}

/**
 * Отрендерить отчёт в Markdown.
 * @param {object} report
 * @returns {string}
 */
function format(report) {
  const r = isPlainObject(report) ? report : {};
  const s = isPlainObject(r.summary) ? r.summary : {};
  const t = isPlainObject(s.totals) ? s.totals : {};
  const lat = isPlainObject(s.latency) ? s.latency : {};
  const lines = [];

  lines.push('# Ежедневный отчёт observability — ' + (r.date || '—'));
  lines.push('');
  lines.push('> Схема: ' + (r.schema || SCHEMA) +
    ' · Версия: ' + (r.version || VERSION) +
    ' · Сгенерировано: ' + (r.generatedAt || '—'));
  lines.push('');

  renderTable('Сводка', [
    { label: 'События', value: t.events || 0 },
    { label: 'Запросы (weighted)', value: t.requests || 0 },
    { label: 'Ошибки', value: t.errors || 0 },
    { label: 'Предупреждения', value: t.warnings || 0 },
    { label: 'Availability', value: round(s.availability, 4) },
    { label: 'Error rate', value: round(s.errorRate, 4) },
    { label: 'Health score', value: (r.health && r.health.score) || 0 },
    { label: 'Health grade', value: (r.health && r.health.grade) || '—' },
  ]).forEach((line) => lines.push(line));

  renderTable('Latency (ms)', [
    { label: 'avg', value: lat.avg || 0 },
    { label: 'p50', value: lat.p50 || 0 },
    { label: 'p90', value: lat.p90 || 0 },
    { label: 'p95', value: lat.p95 || 0 },
    { label: 'p99', value: lat.p99 || 0 },
    { label: 'max', value: lat.max || 0 },
  ]).forEach((line) => lines.push(line));

  lines.push('## Уровни');
  lines.push('');
  const levels = isPlainObject(s.levels) ? s.levels : {};
  const levelKeys = Object.keys(levels);
  if (levelKeys.length === 0) {
    lines.push('- нет данных');
  } else {
    levelKeys.sort((a, b) => levels[b] - levels[a]).forEach((key) => {
      lines.push('- ' + key + ': ' + levels[key]);
    });
  }
  lines.push('');

  lines.push('## Endpoints');
  lines.push('');
  const endpoints = Array.isArray(s.endpoints) ? s.endpoints : [];
  if (endpoints.length === 0) {
    lines.push('- нет данных');
  } else {
    lines.push('| endpoint | requests | errors | avg ms | p95 target |');
    lines.push('| --- | --- | --- | --- | --- |');
    endpoints.forEach((e) => {
      lines.push('| ' + e.endpoint + ' | ' + e.requests + ' | ' + e.errors +
        ' | ' + e.avgLatencyMs + ' | ' + lat.p95 + ' |');
    });
  }
  lines.push('');

  lines.push('## Топ ошибок');
  lines.push('');
  const topErrors = Array.isArray(s.topErrors) ? s.topErrors : [];
  if (topErrors.length === 0) {
    lines.push('- ошибок не зафиксировано');
  } else {
    topErrors.forEach((e) => {
      lines.push('- ' + e.message + ' × ' + e.count);
    });
  }
  lines.push('');

  lines.push('## SLO');
  lines.push('');
  const checks = r.slo && Array.isArray(r.slo.checks) ? r.slo.checks : [];
  if (checks.length === 0) {
    lines.push('- проверки не настроены');
  } else {
    checks.forEach((c) => {
      lines.push('- [' + (c.passed ? 'OK' : 'FAIL') + '] ' + c.name +
        ': ' + c.actual + ' / target ' + c.target + ' ' + (c.unit || ''));
    });
  }
  lines.push('');
  lines.push('_Отчёт сформирован автоматически: observability/daily_report.js_');

  return lines.join('\n');
}

/**
 * Сериализовать отчёт в JSON.
 * @param {object} report
 * @returns {string}
 */
function toJson(report) {
  const payload = isPlainObject(report) ? report : { value: report };
  return JSON.stringify(payload, null, 2);
}

/**
 * Сохранить отчёт на диск. Поддерживает вызовы write(dir, report)
 * и write(report, dir).
 * @param {string|object} target
 * @param {object|string} [report]
 * @returns {string|null} путь к файлу
 */
function write(target, report) {
  let dir;
  let data;
  if (typeof target === 'string') {
    dir = target;
    data = report;
  } else {
    data = target;
    dir = typeof report === 'string' ? report : undefined;
  }

  const outDir = dir || path.join(__dirname, 'reports');
  const date = (isPlainObject(data) && data.date) || formatDate(new Date());
  try {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, FILE_PREFIX + date + '.json');
    fs.writeFileSync(file, toJson(data), 'utf8');
    return file;
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Публичный API
 * ------------------------------------------------------------------ */

/**
 * Сгенерировать ежедневный отчёт.
 * @param {object} [options]
 * @param {Array} [options.events] — список событий.
 * @param {string} [options.date] — дата отчёта (YYYY-MM-DD).
 * @param {object} [options.slo] — пороги SLO.
 * @returns {object} report
 */
function generate(options) {
  const input = isPlainObject(options) ? options : {};
  const opts = deepMerge(DEFAULT_OPTIONS, input);
  const sloConfig = deepMerge(DEFAULT_SLO, input.slo || {});

  const events = normalizeEvents(input.events);
  const now = new Date();
  const date = input.date || formatDate(now);
  const generatedAt = formatTimestamp(now);

  const totals = aggregateTotals(events);
  const latency = aggregateLatency(events);
  const endpoints = aggregateEndpoints(events);
  const topErrors = aggregateTopErrors(events, opts.limitTopErrors);
  const levels = aggregateLevels(events);

  const availability = totals.requests > 0
    ? clamp(1 - safeDiv(totals.errors, totals.requests, 0), 0, 1)
    : 1;
  const errorRate = totals.requests > 0
    ? safeDiv(totals.errors, totals.requests, 0)
    : 0;

  const summary = {
    date: date,
    totals: totals,
    availability: round(availability, 4),
    errorRate: round(errorRate, 4),
    latency: latency,
    endpoints: endpoints,
    topErrors: topErrors,
    levels: levels,
  };

  const slo = evaluateSlo(summary, sloConfig);
  const health = computeHealth(summary, slo);

  const report = {
    schema: SCHEMA,
    version: VERSION,
    date: date,
    generatedAt: generatedAt,
    summary: summary,
    slo: slo,
    health: health,
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      loadAvg: os.loadavg().map((x) => round(x, 2)),
      totalMemMB: round(os.totalmem() / 1048576, 1),
      freeMemMB: round(os.freemem() / 1048576, 1),
    },
    generatedBy: 'observability/daily_report.js',
    markdown: '',
  };

  report.markdown = format(report);
  return report;
}

generate.format = format;
generate.toJson = toJson;
generate.write = write;
generate.DEFAULT_SLO = DEFAULT_SLO;

module.exports = {
  generate,
  format,
  toJson,
  write,
  normalizeEvent,
  normalizeEvents,
  aggregateTotals,
  aggregateLevels,
  aggregateLatency,
  aggregateEndpoints,
  aggregateTopErrors,
  evaluateSlo,
  computeHealth,
  unique,
  SCHEMA,
  VERSION,
  DEFAULT_SLO,
};

/* ------------------------------------------------------------------ *
 * CLI-режим: node observability/daily_report.js
 * ------------------------------------------------------------------ */

if (require.main === module) {
  const report = generate();
  process.stdout.write(report.markdown + '\n');
}
