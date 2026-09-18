'use strict';

/**
 * log_aggregator.js
 * ---------------------------------------------------------------------------
 * Агрегатор логов. Собирает записи логов (в памяти через `ingest()` и/или из
 * файлов, перечисленных в `sources`) и строит сводный отчёт за скользящее
 * временное окно.
 *
 * Публичный API:
 *   aggregate(hours[, opts]) -> {
 *     window, totals, byLevel, bySource, topMessages, timeline, errors
 *   }
 *
 * Вспомогательные функции:
 *   configure(overrides)  — настройка параметров модуля
 *   reset()               — очистка накопленных записей
 *   ingest(input, origin) — добавить запись/массив записей
 *   loadFile(path)        — загрузить лог-файл (JSONL или текстовый)
 *   loadSources()         — загрузить все источники из options.sources
 *   formatReport(report)  — человекочитаемый отчёт
 *
 * Пример:
 *   const la = require('./log_aggregator.js');
 *   la.configure({ sources: ['/var/log/app.log'], windowHours: 6 });
 *   await la.loadSources();
 *   console.log(la.formatReport(la.aggregate(6)));
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

/* ------------------------------------------------------------------------- *
 * Константы и значения по умолчанию
 * ------------------------------------------------------------------------- */

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

const LEVEL_WEIGHT = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const DEFAULT_OPTIONS = {
  windowHours: 24, // окно по умолчанию
  bucketMinutes: 60, // размер бакета для timeline
  maxMessages: 10, // сколько верхних сообщений возвращать
  maxErrors: 50, // сколько последних ошибок отдавать
  sources: [], // список файлов-источников
  clock: () => Date.now(), // источник времени (для тестов)
};

let options = Object.assign({}, DEFAULT_OPTIONS);
let entries = [];

/* ------------------------------------------------------------------------- *
 * Конфигурация и состояние
 * ------------------------------------------------------------------------- */

function configure(overrides) {
  if (overrides && typeof overrides === 'object') {
    options = Object.assign({}, options, overrides);
  }
  return Object.assign({}, options);
}

function reset() {
  entries = [];
}

function count() {
  return entries.length;
}

/* ------------------------------------------------------------------------- *
 * Нормализация записей
 * ------------------------------------------------------------------------- */

function normalizeLevel(level) {
  if (typeof level !== 'string') return 'info';
  const lower = level.trim().toLowerCase();
  if (lower === 'warning') return 'warn';
  if (lower === 'err') return 'error';
  if (lower === 'critical' || lower === 'crit') return 'fatal';
  return LEVELS.indexOf(lower) >= 0 ? lower : 'info';
}

function toTimestamp(value) {
  if (value == null) return options.clock();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') {
    // Эвристика: секунды (< 1e12) против миллисекунд.
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? options.clock() : parsed;
}

function normalizeEntry(raw, origin) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    return {
      timestamp: options.clock(),
      level: 'info',
      source: origin || 'unknown',
      message: raw,
      meta: {},
    };
  }
  return {
    timestamp: toTimestamp(raw.timestamp || raw.time || raw.ts),
    level: normalizeLevel(raw.level || raw.severity),
    source: raw.source || raw.service || raw.app || origin || 'unknown',
    message: String(raw.message || raw.msg || raw.text || ''),
    meta: raw.meta || raw.fields || {},
  };
}

function ingest(input, origin) {
  const list = Array.isArray(input) ? input : [input];
  let added = 0;
  for (const item of list) {
    const normalized = normalizeEntry(item, origin);
    if (normalized) {
      entries.push(normalized);
      added += 1;
    }
  }
  return added;
}

/* ------------------------------------------------------------------------- *
 * Загрузка из файлов
 * ------------------------------------------------------------------------- */

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return normalizeEntry(parsed, 'file');
  } catch (err) {
    // Фолбэк: "timestamp LEVEL source - message"
    const match = trimmed.match(
      /^(?<ts>\S+)\s+(?<level>\w+)\s+(?<source>[\w.-]+)\s*[:-]?\s*(?<msg>.*)$/
    );
    if (match && match.groups) {
      return normalizeEntry(
        {
          timestamp: match.groups.ts,
          level: match.groups.level,
          source: match.groups.source,
          message: match.groups.msg,
        },
        'file'
      );
    }
    return normalizeEntry({ message: trimmed }, 'file');
  }
}

async function loadFile(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return 0;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let loaded = 0;
  for await (const line of rl) {
    const parsed = parseLine(line);
    if (parsed) {
      entries.push(parsed);
      loaded += 1;
    }
  }
  return loaded;
}

async function loadSources() {
  const configured = options.sources || [];
  let total = 0;
  for (const raw of configured) {
    const resolved = path.isAbsolute(raw)
      ? raw
      : path.resolve(process.cwd(), raw);
    total += await loadFile(resolved);
  }
  return total;
}

/* ------------------------------------------------------------------------- *
 * Агрегация
 * ------------------------------------------------------------------------- */

function withinWindow(entry, since, until) {
  return entry.timestamp >= since && entry.timestamp <= until;
}

function bucketKey(timestamp, bucketMs) {
  return Math.floor(timestamp / bucketMs) * bucketMs;
}

/**
 * Построить сводный отчёт за окно `hours` часов.
 * @param {number} [hours] размер окна в часах
 * @param {object} [opts]  локальные переопределения (now, sources, ...)
 * @returns {object}
 */
function aggregate(hours, opts) {
  const local = Object.assign({}, options, opts || {});
  const hoursNum =
    typeof hours === 'number' && hours > 0 ? hours : local.windowHours;
  const until = typeof local.now === 'number' ? local.now : local.clock();
  const since = until - hoursNum * 3600 * 1000;
  const bucketMs = Math.max(1, local.bucketMinutes) * 60 * 1000;

  const scoped = entries.filter((e) => withinWindow(e, since, until));

  const byLevel = {};
  for (const level of LEVELS) byLevel[level] = 0;

  const bySource = {};
  const messageCounts = new Map();
  const timelineMap = new Map();
  const errors = [];

  for (const entry of scoped) {
    byLevel[entry.level] = (byLevel[entry.level] || 0) + 1;

    if (!bySource[entry.source]) {
      bySource[entry.source] = { total: 0, byLevel: {} };
    }
    bySource[entry.source].total += 1;
    bySource[entry.source].byLevel[entry.level] =
      (bySource[entry.source].byLevel[entry.level] || 0) + 1;

    const key = entry.message || '(empty)';
    messageCounts.set(key, (messageCounts.get(key) || 0) + 1);

    const bucket = bucketKey(entry.timestamp, bucketMs);
    if (!timelineMap.has(bucket)) {
      timelineMap.set(bucket, { count: 0, errors: 0 });
    }
    const slot = timelineMap.get(bucket);
    slot.count += 1;
    if (LEVEL_WEIGHT[entry.level] >= LEVEL_WEIGHT.warn) slot.errors += 1;

    if (LEVEL_WEIGHT[entry.level] >= LEVEL_WEIGHT.error) {
      errors.push(entry);
    }
  }

  const topMessages = Array.from(messageCounts.entries())
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, local.maxMessages);

  const timeline = Array.from(timelineMap.entries())
    .map(([ts, slot]) => ({ timestamp: ts, ...slot }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const errorCount = byLevel.error + byLevel.fatal;
  const total = scoped.length;

  return {
    window: { hours: hoursNum, since, until },
    totals: {
      count: total,
      returned: entries.length,
      sources: Object.keys(bySource).length,
      errorRate: total ? errorCount / total : 0,
    },
    byLevel,
    bySource,
    topMessages,
    timeline,
    errors: errors
      .slice(-local.maxErrors)
      .map((e) => ({
        timestamp: e.timestamp,
        level: e.level,
        source: e.source,
        message: e.message,
      })),
  };
}

/* ------------------------------------------------------------------------- *
 * Отчёт
 * ------------------------------------------------------------------------- */

function formatReport(report) {
  if (!report) return '';
  const lines = [];
  const { window: win, totals } = report;
  lines.push(`Log report for last ${win.hours}h`);
  lines.push(`  entries:   ${totals.count}`);
  lines.push(`  sources:   ${totals.sources}`);
  lines.push(`  errorRate: ${(totals.errorRate * 100).toFixed(2)}%`);
  lines.push('  by level:');
  for (const level of LEVELS) {
    lines.push(`    ${level.padEnd(6)} ${report.byLevel[level]}`);
  }
  if (report.topMessages.length) {
    lines.push('  top messages:');
    for (const item of report.topMessages) {
      lines.push(`    ${item.count}x ${item.message}`);
    }
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------------- *
 * P5-OBS-6 — хвостовой агрегатор логов
 * ------------------------------------------------------------------------- *
 * Читает последние N строк из `arena/*.log` + `evolution/*.log`, парсит
 * timestamp + level (INFO/WARN/ERROR/OK), группирует по source.
 *
 * Публичный API:
 *   tail(n = 200[, opts])       -> [{ ts, level, source, msg }]
 *   filterByLevel(level[, n])   -> [{ ts, level, source, msg }]
 *   topErrors(k = 5[, opts])    -> [{ msg, count, source, ts }]
 *   groupBySource([records])    -> { [source]: { source, count, byLevel } }
 *   summary([opts])             -> { total, byLevel, bySource, files }
 *   collectLogRecords(opts)     -> [{ ts, level, source, msg }] (без среза)
 *   selfTest(opts)              -> { ok, count, records, dirs, files }
 *
 * Устойчивость: несуществующие каталоги/файлы молча пропускаются, на пустом
 * каталоге возвращается [] (без throw).
 */

const TAIL_LEVELS = ['INFO', 'WARN', 'ERROR', 'OK'];

const TAIL_LEVEL_ALIASES = {
  WARNING: 'WARN',
  ERR: 'ERROR',
  CRIT: 'ERROR',
  CRITICAL: 'ERROR',
  FATAL: 'ERROR',
  SEVERE: 'ERROR',
  FAIL: 'ERROR',
  FAILED: 'ERROR',
  OKAY: 'OK',
  SUCCESS: 'OK',
  DEBUG: 'INFO',
  TRACE: 'INFO',
  NOTICE: 'INFO',
  LOG: 'INFO',
  VERBOSE: 'INFO',
};

const CWD_DIR = process.cwd();
const ROOT_DIR = path.resolve(__dirname, '..');
const MAX_READ_BYTES = 4 * 1024 * 1024;

// --- Лог-сканер (boxes/<agent>/ + phoenix/logs/) ---------------------------------

/** Файлы больше 50MB считаются ротированными и пропускаются с warning. */
const MAX_SCAN_FILE_BYTES = 50 * 1024 * 1024;
/** Окно дедупликации одинаковых сообщений — 5 минут. */
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

/** Каталоги-источники по умолчанию: boxes/ и phoenix/logs/. */
const DEFAULT_SCAN_SUBDIRS = [
  ['boxes'],
  ['phoenix', 'logs'],
  ['logs'],
];

/** Привести уровень к одному из TAIL_LEVELS (или null). */
function normalizeLogLevel(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!upper) return null;
  if (TAIL_LEVELS.indexOf(upper) >= 0) return upper;
  if (TAIL_LEVEL_ALIASES[upper]) return TAIL_LEVEL_ALIASES[upper];
  return null;
}

/** Уровень по эмодзи-маркеру (✅ OK, ❌ ERROR, ⚠ WARN). */
function detectEmojiLevel(text) {
  if (!text) return null;
  if (/\u2705/.test(text)) return 'OK'; // ✅
  if (/\u274C/.test(text)) return 'ERROR'; // ❌
  if (/\u26A0/.test(text)) return 'WARN'; // ⚠
  return null;
}

/** Нормализовать timestamp → ISO-строку (или null). */
function normalizeLogTs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const str = String(value).trim();
  if (!str) return null;
  const direct = new Date(str);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  // Время без даты: "21:29:06" → сегодняшняя дата.
  const t = str.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (t) {
    const now = new Date();
    const d = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Number(t[1]),
      Number(t[2]),
      Number(t[3])
    );
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function tsValue(record) {
  if (!record || !record.ts) return 0;
  const parsed = Date.parse(record.ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Разобрать одну строку лога в запись { ts, level, source, msg }.
 * Всегда пытается вернуть запись (даже без timestamp).
 */
function parseLogLine(line, defaultSource, fallbackTs) {
  if (line == null) return null;
  const raw = String(line).replace(/\r?\n?$/, '');
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // --- JSON-строка -----------------------------------------------------
  if (trimmed[0] === '{') {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const level =
          normalizeLogLevel(obj.level || obj.severity || obj.lvl) ||
          detectEmojiLevel(trimmed);
        const ts = normalizeLogTs(
          obj.ts != null ? obj.ts :
          obj.timestamp != null ? obj.timestamp :
          obj.time != null ? obj.time :
          obj.date != null ? obj.date : obj.datetime
        );
        const source = String(
          obj.source || obj.service || obj.module || obj.logger || obj.app ||
          defaultSource || 'unknown'
        );
        const msg = String(
          obj.msg != null ? obj.msg :
          obj.message != null ? obj.message :
          obj.text != null ? obj.text : ''
        ).trim();
        if (!msg && !level && !ts) return null;
        return {
          ts: ts || fallbackTs || null,
          level: level || 'INFO',
          source,
          msg,
        };
      }
    } catch (_) {
      /* не JSON — парсим как текст ниже */
    }
  }

  let rest = trimmed;
  let ts = null;
  let level = null;
  let source = null;

  // --- Ведущие [ ... ] токены (timestamp / level / source) -------------
  let guard = 0;
  while (guard < 8) {
    guard += 1;
    const m = rest.match(/^\[([^\]]+)\]\s*/);
    if (!m) break;
    const inner = m[1].trim();

    const maybeLevel = normalizeLogLevel(inner);
    if (maybeLevel && !level) {
      level = maybeLevel;
      rest = rest.slice(m[0].length);
      continue;
    }

    // "[ORCH 21:29:06]" → source + time
    const sm = inner.match(/^([A-Za-z_][\w.-]*)\s+(\d{1,2}:\d{2}:\d{2})$/);
    if (sm && !source) {
      source = sm[1];
      if (!ts) ts = normalizeLogTs(sm[2]);
      rest = rest.slice(m[0].length);
      continue;
    }

    const maybeTs = normalizeLogTs(inner);
    if (maybeTs && !ts) {
      ts = maybeTs;
      rest = rest.slice(m[0].length);
      continue;
    }

    if (!source) {
      source = inner;
      rest = rest.slice(m[0].length);
      continue;
    }
    break;
  }

  // --- ISO timestamp без скобок ----------------------------------------
  if (!ts) {
    const im = rest.match(
      /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s*/
    );
    if (im) {
      ts = normalizeLogTs(im[1]);
      rest = rest.slice(im[0].length);
    }
  }

  // --- "LEVEL сообщение" в начале остатка ------------------------------
  if (!level) {
    const lm = rest.match(
      /^(INFO|WARN|WARNING|ERROR|ERR|OK|DEBUG|TRACE|FATAL|CRIT|CRITICAL|NOTICE)[\s:;-]+/i
    );
    if (lm) {
      level = normalizeLogLevel(lm[1]);
      rest = rest.slice(lm[0].length);
    }
  }

  // --- level где угодно в строке / эмодзи ------------------------------
  if (!level) {
    level = detectEmojiLevel(trimmed);
    if (!level) {
      const any = trimmed.match(
        /\b(INFO|WARN|WARNING|ERROR|ERR|OK|DEBUG|FATAL|CRITICAL)\b/i
      );
      if (any) level = normalizeLogLevel(any[1]);
    }
  }

  const msg = rest.trim();
  if (!source) source = defaultSource || 'unknown';
  if (!ts) ts = fallbackTs || null;
  return { ts, level: level || 'INFO', source, msg };
}

/* ---- Файловые утилиты ------------------------------------------------- */

/** Список *.log в переданных каталогах (несуществующие пропускаются). */
function listLogFiles(dirs) {
  const files = [];
  const seen = Object.create(null);
  for (const dir of dirs || []) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (_) {
      continue; // каталога нет / нет доступа — skip без throw
    }
    for (const name of entries) {
      if (!/\.log$/i.test(name)) continue;
      const full = path.join(dir, name);
      if (seen[full]) continue;
      try {
        const st = fs.statSync(full);
        if (st.isFile()) {
          seen[full] = true;
          files.push(full);
        }
      } catch (_) {
        /* skip */
      }
    }
  }
  return files.sort();
}

/** Прочитать последние `limit` строк файла (устойчиво к ошибкам). */
function readLastLines(filePath, limit) {
  const maxLines = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
  let content;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return [];
    if (st.size <= MAX_READ_BYTES) {
      content = fs.readFileSync(filePath, 'utf8');
    } else {
      const start = st.size - MAX_READ_BYTES;
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES);
        const read = fs.readSync(fd, buf, 0, MAX_READ_BYTES, start);
        content = buf.slice(0, read).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      const nl = content.indexOf('\n');
      if (nl >= 0) content = content.slice(nl + 1);
    }
  } catch (_) {
    return [];
  }
  const lines = content.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-maxLines);
}

/** Каталоги-источники по умолчанию: arena + evolution (cwd и корень пакета). */
function resolveDefaultDirs() {
  const envDirs = (process.env.PHOENIX_LOG_DIRS || process.env.LOG_DIRS || '')
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const dirs = envDirs.length
    ? envDirs
    : [
        path.join(CWD_DIR, 'arena'),
        path.join(CWD_DIR, 'evolution'),
        path.join(ROOT_DIR, 'arena'),
        path.join(ROOT_DIR, 'evolution'),
      ];
  return Array.from(new Set(dirs));
}

function resolveDirs(opts) {
  // Явно переданный массив (даже пустой) имеет приоритет над дефолтами.
  if (opts && Array.isArray(opts.dirs)) {
    return opts.dirs.map((d) => String(d));
  }
  return resolveDefaultDirs();
}

/**
 * Собрать записи из arena/*.log + evolution/*.log.
 * @param {object} [opts] dirs, perFile (сколько последних строк читать)
 */
function collectLogRecords(opts) {
  const options = opts || {};
  const dirs = resolveDirs(options);
  const perFile =
    Number.isFinite(options.perFile) && options.perFile > 0
      ? Math.floor(options.perFile)
      : 500;
  const files = listLogFiles(dirs);
  const records = [];
  for (const file of files) {
    let fallbackTs = null;
    try {
      fallbackTs = new Date(fs.statSync(file).mtimeMs).toISOString();
    } catch (_) {
      fallbackTs = null;
    }
    const defaultSource = path.basename(file, path.extname(file));
    const lines = readLastLines(file, perFile);
    for (const line of lines) {
      const rec = parseLogLine(line, defaultSource, fallbackTs);
      if (rec) records.push(rec);
    }
  }
  return records;
}

/**
 * Последние `n` записей по всем источникам (отсортированы по времени).
 * @param {number} [n=200]
 * @param {object} [opts] dirs, perFile
 * @returns {Array<{ts,level,source,msg}>}
 */
function tail(n, opts) {
  const limit =
    Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
  const options = Object.assign({}, opts || {});
  const records = getScannedRecords(options);
  const sorted = records.slice().sort((a, b) => tsValue(a) - tsValue(b));
  return sorted.slice(-limit);
}

/**
 * Отфильтровать записи по уровню (INFO/WARN/ERROR/OK).
 * @param {string} level
 * @param {number} [n=200] сколько последних записей рассматривать
 * @param {object} [opts]
 */
function filterByLevel(level, n, opts) {
  const normalized = normalizeLogLevel(level);
  const records = tail(n, opts);
  if (!normalized) return records;
  return records.filter((r) => r.level === normalized);
}

/**
 * Топ-K сообщений уровня ERROR (по частоте).
 * @param {number} [k=5]
 * @param {object} [opts]
 * @returns {Array<{msg:string,count:number,source:string,ts:string}>}
 */
function topErrors(k, opts) {
  const limit = Number.isFinite(k) && k > 0 ? Math.floor(k) : 5;
  const options = Object.assign({}, opts || {});
  const records = getScannedRecords(options);
  const counts = new Map();
  for (const rec of records) {
    if (String(rec.level || '').toUpperCase() !== 'ERROR') continue;
    const key = rec.msg || '(empty)';
    if (!counts.has(key)) {
      counts.set(key, { msg: key, count: 0, source: rec.source, ts: rec.ts });
    }
    const item = counts.get(key);
    item.count += rec.count || 1;
    if (rec.ts) item.ts = rec.ts;
  }
  // ВАЖНО: сортировка по count DESC (критерий topErrors(10)).
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count || String(a.msg).localeCompare(String(b.msg)))
    .slice(0, limit);
}

/* ---- Сканер: boxes/<agent>/ + phoenix/logs/ ---------------------------------- */

/** Кеш последнего scan(): переиспользуется byLevel/topErrors/tail. */
let scanCache = { dirs: [], files: [], records: [], skipped: 0 };

/** Развернуть аргумент scan() в список каталогов (устойчиво к мусору). */
function resolveScanDirs(dir) {
  if (Array.isArray(dir)) {
    return dir.map((d) => String(d)).filter(Boolean);
  }
  if (typeof dir === 'string' && dir.trim()) {
    return [dir.trim()];
  }
  const dirs = [];
  for (const rel of DEFAULT_SCAN_SUBDIRS) {
    dirs.push(path.join(CWD_DIR, ...rel));
    dirs.push(path.join(ROOT_DIR, ...rel));
  }
  // Дополнительно — старые источники (arena/evolution) для совместимости.
  for (const rel of [['arena'], ['evolution']]) {
    dirs.push(path.join(CWD_DIR, ...rel));
    dirs.push(path.join(ROOT_DIR, ...rel));
  }
  return Array.from(new Set(dirs));
}

/**
 * Рекурсивно собрать *.log (boxes/<agent>/…, phoenix/logs/…).
 * Несуществующие каталоги/симлинки молча пропускаются — никогда не бросает.
 */
function walkLogFiles(root, acc, visited) {
  const results = acc || [];
  const seen = visited || new Set();
  let real;
  try {
    real = fs.realpathSync(root);
  } catch (_) {
    return results; // каталога нет / нет доступа
  }
  if (seen.has(real)) return results;
  seen.add(real);

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return results; // пустая / недоступная директория — не падаем
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(root, name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink && entry.isSymbolicLink()) {
      try {
        const st = fs.statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch (_) {
        continue; // битый симлинк
      }
    }
    if (isDir) {
      walkLogFiles(full, results, seen);
    } else if (isFile && /\.log$/i.test(name)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Прочитать файл с учётом ротации. Файлы > 50MB пропускаются с warning.
 * @returns {{lines: string[], skipped: boolean, size: number}}
 */
function readLogFileSafe(filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch (_) {
    return { lines: [], skipped: false, size: 0 };
  }
  if (!st.isFile()) return { lines: [], skipped: false, size: 0 };

  if (st.size > MAX_SCAN_FILE_BYTES) {
    // РОТАЦИЯ: слишком большой файл — skip с warning (не читаем целиком).
    console.warn(
      '[log_aggregator] WARN: skip ' +
        filePath +
        ' — ' +
        st.size +
        ' bytes > ' +
        MAX_SCAN_FILE_BYTES +
        ' (50MB rotation threshold)'
    );
    return { lines: [], skipped: true, size: st.size };
  }

  let content;
  try {
    if (st.size <= MAX_READ_BYTES) {
      content = fs.readFileSync(filePath, 'utf8');
    } else {
      const start = Math.max(0, st.size - MAX_READ_BYTES);
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(st.size - start);
        const read = fs.readSync(fd, buf, 0, buf.length, start);
        content = buf.slice(0, read).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      const nl = content.indexOf('\n');
      if (nl >= 0) content = content.slice(nl + 1);
    }
  } catch (_) {
    return { lines: [], skipped: false, size: st.size };
  }
  return { lines: content.split(/\r?\n/), skipped: false, size: st.size };
}

/**
 * Дедуп одинаковых сообщений в окне `windowMs` (по умолчанию 5 мин).
 * Дубликат увеличивает count записи, а не создаёт новую строку.
 */
function dedupeRecords(records, windowMs) {
  const win =
    Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : DEDUP_WINDOW_MS;
  const sorted = records
    .slice()
    .sort((a, b) => tsValue(a) - tsValue(b));
  const out = [];
  const index = new Map(); // key -> позиция в out
  for (const rec of sorted) {
    const key = String(rec.level || 'INFO') + '\u0000' + String(rec.msg || '');
    const t = tsValue(rec) || 0;
    const pos = index.get(key);
    if (pos !== undefined) {
      const last = out[pos];
      if (t >= last._lastTs && t - last._lastTs <= win) {
        last.count += rec.count || 1;
        last.duplicates += 1;
        last._lastTs = t;
        continue;
      }
    }
    out.push(
      Object.assign({}, rec, {
        count: rec.count || 1,
        duplicates: 0,
        _lastTs: t,
      })
    );
    index.set(key, out.length - 1);
  }
  for (const rec of out) delete rec._lastTs;
  return out;
}

/**
 * Собрать и распарсить .log из каталога(ов).
 *
 * @param {string|string[]} [dir] каталог или список каталогов.
 *   По умолчанию — boxes/ и phoenix/logs/ (сначала относительно cwd, затем
 *   относительно корня пакета). Пустые/несуществующие каталоги безопасны.
 * @param {object} [opts] perFile, dedupWindowMs
 * @returns {Array<{ts,level,source,msg,count,duplicates}>} — всегда массив.
 */
function scan(dir, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const dirArg =
    dir === undefined || dir === null
      ? options.dir !== undefined
        ? options.dir
        : options.dirs
      : dir;
  const dirs = resolveScanDirs(dirArg);

  const files = [];
  const seen = new Set();
  for (const d of dirs) {
    for (const f of walkLogFiles(d)) {
      if (!seen.has(f)) {
        seen.add(f);
        files.push(f);
      }
    }
  }
  files.sort();

  const perFile =
    Number.isFinite(options.perFile) && options.perFile > 0
      ? Math.floor(options.perFile)
      : 0;

  const raw = [];
  let skipped = 0;
  for (const file of files) {
    const res = readLogFileSafe(file);
    if (res.skipped) {
      skipped += 1;
      continue;
    }
    let fallbackTs = null;
    try {
      fallbackTs = new Date(fs.statSync(file).mtimeMs).toISOString();
    } catch (_) {
      fallbackTs = null;
    }
    const defaultSource = path.basename(file, path.extname(file));
    const lines = perFile > 0 ? res.lines.slice(-perFile) : res.lines;
    for (const line of lines) {
      const rec = parseLogLine(line, defaultSource, fallbackTs);
      if (rec) raw.push(rec);
    }
  }

  const records = dedupeRecords(raw, options.dedupWindowMs);
  scanCache = { dirs, files, records, skipped };
  return records;
}

/** Достать записи: из opts.records, свежего scan() или кеша. */
function getScannedRecords(opts) {
  const options = opts || {};
  if (Array.isArray(options.records)) return options.records;
  if (options.dir !== undefined || options.dirs !== undefined || options.fresh) {
    return scan(
      options.dir !== undefined ? options.dir : options.dirs,
      options
    );
  }
  if (Array.isArray(scanCache.records) && scanCache.records.length) {
    return scanCache.records;
  }
  return scan(options.dir, options);
}

/**
 * Записи указанного уровня.
 * @param {string} level 'info' | 'warn' | 'error' (регистр/алиасы — ок)
 * @returns {Array<{ts,level,source,msg,count,duplicates}>} — всегда массив.
 */
function byLevel(level, opts) {
  const records = getScannedRecords(opts);
  const norm =
    normalizeLogLevel(level) ||
    (level == null ? '' : String(level).trim().toUpperCase());
  if (!norm) return records.slice();
  return records.filter((r) => String(r.level || '').toUpperCase() === norm);
}

/**
 * Сгруппировать записи по source.
 * @param {Array} [records] по умолчанию — tail()
 */
function groupBySource(records) {
  const list = Array.isArray(records) ? records : tail();
  const groups = {};
  for (const rec of list) {
    const key = rec.source || 'unknown';
    if (!groups[key]) {
      groups[key] = { source: key, count: 0, byLevel: {}, records: [] };
    }
    const g = groups[key];
    g.count += 1;
    g.byLevel[rec.level] = (g.byLevel[rec.level] || 0) + 1;
    g.records.push(rec);
  }
  return groups;
}

/** Сводка по прочитанным записям. */
function summary(opts) {
  const options = Object.assign({}, opts || {});
  const records = collectLogRecords(options);
  const byLevel = {};
  for (const lvl of TAIL_LEVELS) byLevel[lvl] = 0;
  for (const rec of records) {
    byLevel[rec.level] = (byLevel[rec.level] || 0) + 1;
  }
  const groups = groupBySource(records);
  const bySource = {};
  for (const key of Object.keys(groups)) {
    bySource[key] = { count: groups[key].count, byLevel: groups[key].byLevel };
  }
  return {
    total: records.length,
    byLevel,
    bySource,
    files: listLogFiles(resolveDirs(options)),
  };
}

/**
 * Self-test: читает реальные arena/evolution логи. Успех — непустой массив
 * при наличии хотя бы одного *.log.
 */
function selfTest(opts) {
  const options = Object.assign({}, opts || {});
  const dirs = resolveDirs(options);
  const files = listLogFiles(dirs);
  const records = tail(200, options);
  return {
    ok: Array.isArray(records) && records.length > 0,
    count: records.length,
    files,
    dirs,
    emptyDirsOk: tail(200, { dirs: [] }).length === 0,
    missingDirOk: tail(200, {
      dirs: [path.join(CWD_DIR, '__no_such_dir_' + process.pid)],
    }).length === 0,
    records: records.slice(-10),
  };
}

function formatTail(records) {
  const list = Array.isArray(records) ? records : tail();
  return list
    .map((r) => `${r.ts || '-'} [${r.level}] ${r.source}: ${r.msg}`)
    .join('\n');
}

/* ------------------------------------------------------------------------- *
 * Экспорт
 * ------------------------------------------------------------------------- */

module.exports = {
  // сканер boxes/<agent>/ + phoenix/logs/ (P5-OBS новое ТЗ)
  scan,
  byLevel,
  dedupeRecords,
  walkLogFiles,
  readLogFileSafe,
  // tail-агрегатор (P5-OBS-6)
  tail,
  filterByLevel,
  topErrors,
  groupBySource,
  summary,
  collectLogRecords,
  selfTest,
  formatTail,
  parseLogLine,
  normalizeLogLevel,
  normalizeLogTs,
  listLogFiles,
  readLastLines,
  TAIL_LEVELS,
  MAX_SCAN_FILE_BYTES,
  DEDUP_WINDOW_MS,
  // окно-агрегатор (обратная совместимость)
  aggregate,
  configure,
  reset,
  count,
  ingest,
  loadFile,
  loadSources,
  formatReport,
  normalizeEntry,
  normalizeLevel,
  toTimestamp,
  parseLine,
  bucketKey,
  LEVELS,
};

module.exports.default = module.exports.aggregate;

/* ------------------------------------------------------------------------- *
 * Контракт scan(dir)/byLevel(level) (P5-OBS-7)
 * Делегируют к каноническому сканеру: обход boxes/ + phoenix/logs/,
 * пропуск файлов > 50MB (ротация) и дедуп одинаковых сообщений за 5 минут.
 * ------------------------------------------------------------------------- */

/**
 * scan(dir[, opts]) — собрать записи из каталога (или каталогов).
 * dir == null → набор по умолчанию (boxes + phoenix/logs + logs).
 * @returns {Array<{ts,level,source,msg,count,duplicates}>} всегда массив.
 */
module.exports.scan = function scanContract(dir, opts) {
  return scan(dir, opts);
};

/**
 * byLevel(level[, opts]) — записи заданного уровня (массив).
 * @returns {Array<{ts,level,source,msg,count,duplicates}>} всегда массив.
 */
module.exports.byLevel = function byLevelContract(level, opts) {
  return byLevel(level, opts);
};

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */

function parseCliArgs(argv) {
  const args = argv.slice(2);
  const opts = { dirs: [] };
  const flags = { selftest: false, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--selftest') flags.selftest = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--n' || arg === '--tail') {
      opts.n = Number(args[i + 1]);
      i += 1;
    } else if (arg.startsWith('--n=')) opts.n = Number(arg.slice(4));
    else if (arg === '--k') {
      opts.k = Number(args[i + 1]);
      i += 1;
    } else if (arg.startsWith('--k=')) opts.k = Number(arg.slice(4));
    else if (arg === '--level') {
      opts.level = args[i + 1];
      i += 1;
    } else if (arg.startsWith('--level=')) opts.level = arg.slice(8);
    else if (arg === '--dir' || arg === '--dirs') {
      opts.dirs.push(args[i + 1]);
      i += 1;
    } else if (arg.startsWith('--dir=')) opts.dirs.push(arg.slice(6));
  }
  return { flags, opts };
}

function main(argv) {
  const { flags, opts } = parseCliArgs(argv || process.argv);

  if (flags.selftest) {
    // Машиночитаемый вывод: JSON-массив записей tail(200).
    const report = selfTest(opts);
    const records = tail(
      Number.isFinite(opts.n) && opts.n > 0 ? opts.n : 200,
      opts
    );
    process.stdout.write(
      `LOG_AGGREGATOR_SELFTEST count=${report.count} files=${report.files.length} ` +
        `emptyDirsOk=${report.emptyDirsOk} missingDirOk=${report.missingDirOk}\n`
    );
    process.stdout.write(JSON.stringify(records, null, 2) + '\n');
    process.stdout.write((report.ok ? 'SELFTEST_OK' : 'SELFTEST_EMPTY') + '\n');
    // Пустой набор — не ошибка (нет логов), скрипт завершается успешно.
    return report;
  }

  if (opts.level) {
    const recs = filterByLevel(
      opts.level,
      Number.isFinite(opts.n) && opts.n > 0 ? opts.n : 200,
      opts
    );
    process.stdout.write(JSON.stringify(recs, null, 2) + '\n');
    return recs;
  }

  if (Number.isFinite(opts.k)) {
    const recs = topErrors(opts.k, opts);
    process.stdout.write(JSON.stringify(recs, null, 2) + '\n');
    return recs;
  }

  if (flags.json) {
    const recs = tail(
      Number.isFinite(opts.n) && opts.n > 0 ? opts.n : 200,
      opts
    );
    process.stdout.write(JSON.stringify(recs, null, 2) + '\n');
    return recs;
  }

  // По умолчанию — человекочитаемый хвост.
  const recs = tail(Number.isFinite(opts.n) && opts.n > 0 ? opts.n : 200, opts);
  process.stdout.write(formatTail(recs) + '\n');
  return recs;
}

if (require.main === module) {
  main(process.argv);
}
