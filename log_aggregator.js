'use strict';

/**
 * log_aggregator.js — агрегатор логов Aeon/Phoenix
 * ===========================================================================
 * Собирает `*.log` из `boxes/*​/` и `phoenix/logs/`, парсит строки, группирует
 * записи по уровню (info / warn / error) и дедуплицирует одинаковые сообщения,
 * пришедшие в пределах 5 минут друг от друга.
 *
 * Публичный API
 * ---------------------------------------------------------------------------
 *   scan(dir[, opts])          -> Array<Record>   // dir: string | string[]
 *   byLevel(level[, opts])     -> Array<Record>   // 'info' | 'warn' | 'error'
 *   topErrors(n[, opts])       -> Array<{ msg, count, source, ts, level }>
 *   tail(n[, opts])            -> Array<Record>   // последние n записей
 *
 * Record = {
 *   ts: number,            // unix ms (для сортировки / дедупа)
 *   time: string|null,     // ISO-строка (человекочитаемо)
 *   level: 'info'|'warn'|'error',
 *   source: string,        // имя файла без .log
 *   msg: string,
 *   file: string,          // абсолютный путь источника
 *   count: number,         // сколько раз сообщение встретилось в окне дедупа
 *   duplicates: number,    // count - 1
 *   firstTs: number, lastTs: number,
 * }
 *
 * Гарантии / устойчивость
 * ---------------------------------------------------------------------------
 *   • Несуществующие каталоги и пустые каталоги молча пропускаются ([]).
 *   • Симлинки не разворачиваются (защита от циклов node_modules).
 *   • Файлы размером > 50 МБ пропускаются с console.warn (ротация).
 *   • Битые строки не бросают исключений — парсятся best-effort.
 *
 * CLI
 * ---------------------------------------------------------------------------
 *   node log_aggregator.js --selftest
 *   node log_aggregator.js --level=error --n=50
 *   node log_aggregator.js --top=10
 *   node log_aggregator.js --tail=100 --dir=./boxes --dir=./logs
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------------- *
 * Константы
 * ------------------------------------------------------------------------- */

const DEDUP_WINDOW_MS = 5 * 60 * 1000; // окно дедупликации: 5 минут
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 МБ — порог ротации
const LEVELS = ['info', 'warn', 'error'];

const LEVEL_ALIASES = {
  trace: 'info',
  debug: 'info',
  verbose: 'info',
  log: 'info',
  notice: 'info',
  info: 'info',
  information: 'info',
  ok: 'info',
  okay: 'info',
  success: 'info',
  done: 'info',
  warn: 'warn',
  warning: 'warn',
  caution: 'warn',
  error: 'error',
  err: 'error',
  fatal: 'error',
  critical: 'error',
  crit: 'error',
  severe: 'error',
  fail: 'error',
  failed: 'error',
  failure: 'error',
  exception: 'error',
  panic: 'error',
};

const LEVEL_WORD_RE = /^(trace|debug|verbose|log|info|notice|information|warn|warning|caution|error|err|fatal|critical|crit|severe|fail|failed|failure|exception|panic|ok|okay|success|done)$/i;

/* ------------------------------------------------------------------------- *
 * Утилиты уровня / времени
 * ------------------------------------------------------------------------- */

/** Привести произвольный уровень к одному из info|warn|error. */
function normalizeLevel(value) {
  if (value == null) return 'info';
  if (typeof value === 'object') {
    value = value.level || value.severity || value.lvl || value.name || value.label;
  }
  const text = String(value);
  const emoji = detectEmojiLevel(text);
  if (emoji) return emoji;
  const token = text.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!token) return 'info';
  if (LEVEL_ALIASES[token]) return LEVEL_ALIASES[token];
  // Частичное совпадение: "error_rate", "warn_42" и т.п.
  if (/error|fatal|crit|severe|fail|panic/.test(token)) return 'error';
  if (/warn/.test(token)) return 'warn';
  return 'info';
}

/** Уровень по эмодзи-маркеру строки (❌ ERROR, ⚠ WARN, ✅ INFO). */
function detectEmojiLevel(text) {
  if (!text) return null;
  if (/\u274C|\u2716|\u26D4/.test(text)) return 'error'; // ❌ ✖ ⛔
  if (/\u26A0/.test(text)) return 'warn'; // ⚠
  if (/\u2705|\u2714/.test(text)) return 'info'; // ✅ ✔
  return null;
}

/** Парсинг timestamp → unix ms или null. Понимает ISO, epoch, "HH:MM:SS". */
function parseTimestamp(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // эвристика: секунды (< 1e12) против миллисекунд
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const text = String(value).trim();
  if (!text) return null;

  // Чистое epoch-число в строке
  if (/^\d{10}$|^\d{13}$/.test(text)) {
    const n = Number(text);
    return text.length === 10 ? n * 1000 : n;
  }

  // "YYYY-MM-DD HH:MM:SS(.ms)?" → ISO (пробел → 'T')
  const isoish = text.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?$/
  );
  if (isoish) {
    const suffix = isoish[3] ? isoish[3] : '';
    const ms = Date.parse(`${isoish[1]}T${isoish[2]}${suffix}`);
    if (!Number.isNaN(ms)) return ms;
  }

  const direct = Date.parse(text);
  if (!Number.isNaN(direct)) return direct;

  // Время без даты: "21:29:06(.123)?" → сегодня
  const t = text.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (t) {
    const now = new Date();
    const d = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Number(t[1]),
      Number(t[2]),
      Number(t[3]),
      t[4] ? Number(t[4].padEnd(3, '0')) : 0
    );
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  return null;
}

function toIso(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function safeMtime(file) {
  try {
    return Math.round(fs.statSync(file).mtimeMs);
  } catch (_) {
    return Date.now();
  }
}

/* ------------------------------------------------------------------------- *
 * Парсинг одной строки
 * ------------------------------------------------------------------------- */

/**
 * Разобрать строку лога в запись (best-effort, никогда не бросает).
 * @param {string} line
 * @param {string} defaultSource
 * @param {number} fallbackTs unix ms для строк без timestamp
 * @returns {{ts:number, level:string, source:string, msg:string}|null}
 */
function parseLine(line, defaultSource, fallbackTs) {
  if (line == null) return null;
  const raw = String(line).replace(/\r?\n?$/, '');
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // --- JSON ---------------------------------------------------------------
  if (trimmed[0] === '{') {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const level = normalizeLevel(
          obj.level != null ? obj.level :
          obj.severity != null ? obj.severity :
          detectEmojiLevel(trimmed)
        );
        const ts =
          parseTimestamp(
            obj.ts != null ? obj.ts :
            obj.timestamp != null ? obj.timestamp :
            obj.time != null ? obj.time :
            obj.date != null ? obj.date : obj.datetime
          ) || fallbackTs;
        const source = String(
          obj.source || obj.service || obj.module || obj.logger ||
          obj.name || obj.app || defaultSource || 'unknown'
        );
        const msg = String(
          obj.msg != null ? obj.msg :
          obj.message != null ? obj.message :
          obj.text != null ? obj.text : ''
        ).trim();
        if (!msg && !obj.level && !obj.ts && !obj.timestamp) return null;
        return { ts, level, source, msg };
      }
    } catch (_) {
      /* не JSON — парсим как текст ниже */
    }
  }

  let rest = trimmed;
  let ts = null;
  let level = null;
  let source = null;

  // --- Ведущие [ ... ] токены (timestamp / level / source) ---------------
  let guard = 0;
  while (guard < 8) {
    guard += 1;
    const m = rest.match(/^\[([^\]]+)\]\s*/);
    if (!m) break;
    const inner = m[1].trim();

    if (!level && LEVEL_WORD_RE.test(inner)) {
      level = normalizeLevel(inner);
      rest = rest.slice(m[0].length);
      continue;
    }
    // "[ORCH 21:29:06]" → source + time
    const sm = inner.match(/^([A-Za-z_][\w.-]*)\s+(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)$/);
    if (sm && !source) {
      source = sm[1];
      if (ts == null) ts = parseTimestamp(sm[2]);
      rest = rest.slice(m[0].length);
      continue;
    }
    const maybeTs = parseTimestamp(inner);
    if (maybeTs != null && ts == null) {
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

  // --- ISO timestamp без скобок ------------------------------------------
  if (ts == null) {
    const im = rest.match(
      /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s*/
    );
    if (im) {
      ts = parseTimestamp(im[1]);
      rest = rest.slice(im[0].length);
    }
  }

  // --- "LEVEL сообщение" в начале остатка --------------------------------
  if (!level) {
    const lm = rest.match(
      /^(trace|debug|verbose|info|notice|warn|warning|error|err|fatal|critical|crit|severe|fail(?:ed)?|ok|okay|success|panic)[\s:;\-|>]+/i
    );
    if (lm) {
      level = normalizeLevel(lm[1]);
      rest = rest.slice(lm[0].length);
    }
  }

  // --- Уровень где угодно в строке / эмодзи ------------------------------
  if (!level) {
    level = detectEmojiLevel(trimmed);
    if (!level) {
      const any = trimmed.match(
        /\b(trace|debug|info|notice|warn(?:ing)?|error|err|fatal|critical|crit|severe|panic)\b/i
      );
      if (any) level = normalizeLevel(any[1]);
    }
  }

  const msg = rest.replace(/^\s*[-|:>]\s*/, '').trim();
  if (!source) source = defaultSource || 'unknown';
  return { ts: ts != null ? ts : fallbackTs, level: level || 'info', source, msg };
}

/* ------------------------------------------------------------------------- *
 * Обход файлов (с учётом ротации и симлинков)
 * ------------------------------------------------------------------------- */

function defaultWarn(file, size) {
  const mb = (size / (1024 * 1024)).toFixed(1);
  // eslint-disable-next-line no-console
  console.warn(
    `[log_aggregator] skip ${file}: ${mb}MB > ${MAX_FILE_SIZE / (1024 * 1024)}MB (rotation)`
  );
}

/**
 * Собрать пути `*.log` под указанным корнем (рекурсивно).
 * Симлинки не разворачиваются; файлы > 50 МБ пропускаются с warning.
 */
function listLogFiles(root, opts) {
  const options = opts || {};
  const warn = typeof options.warn === 'function' ? options.warn : defaultWarn;
  const files = [];
  let baseStat;
  try {
    baseStat = fs.lstatSync(root);
  } catch (_) {
    return files; // нет каталога/файла — молча выход
  }
  if (baseStat.isSymbolicLink()) return files;

  // Корень — отдельный .log файл
  if (baseStat.isFile()) {
    if (/\.log$/i.test(root)) {
      if (baseStat.size > MAX_FILE_SIZE) warn(root, baseStat.size);
      else files.push(root);
    }
    return files;
  }
  if (!baseStat.isDirectory()) return files;

  const stack = [root];
  const visited = new Set();
  while (stack.length) {
    const dir = stack.pop();
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch (_) {
      real = dir;
    }
    if (visited.has(real)) continue;
    visited.add(real);

    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      continue; // нет доступа — skip
    }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch (_) {
        continue;
      }
      if (st.isSymbolicLink()) continue; // защита от циклов
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && /\.log$/i.test(name)) {
        if (st.size > MAX_FILE_SIZE) {
          warn(full, st.size);
          continue;
        }
        files.push(full);
      }
    }
  }
  return files.sort();
}

/** Прочитать и распарсить один лог-файл целиком. */
function readLogFile(file, opts) {
  const options = opts || {};
  const warn = typeof options.warn === 'function' ? options.warn : defaultWarn;
  let content;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return [];
    if (st.size > MAX_FILE_SIZE) {
      warn(file, st.size);
      return [];
    }
    content = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return [];
  }
  const fallbackTs = safeMtime(file);
  const source = path.basename(file, path.extname(file));
  const out = [];
  for (const line of content.split(/\r?\n/)) {
    const rec = parseLine(line, source, fallbackTs);
    if (rec) {
      rec.file = file;
      out.push(rec);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Дедупликация (окно 5 минут по разрыву между одинаковыми сообщениями)
 * ------------------------------------------------------------------------- */

/**
 * Свернуть одинаковые сообщения, встречающиеся подряд с разрывом <= windowMs.
 * @param {Array} records отсортированы по ts ASC
 * @param {number} windowMs
 */
function dedupe(records, windowMs) {
  const groups = [];
  const open = new Map(); // message-key -> индекс последней открытой группы
  for (const rec of records) {
    const ts = Number.isFinite(rec.ts) ? rec.ts : 0;
    const key = `${rec.level}\u0000${rec.msg}`;
    const idx = open.get(key);
    if (idx !== undefined) {
      const g = groups[idx];
      if (ts - g.lastTs <= windowMs) {
        g.count += 1;
        g.duplicates = g.count - 1;
        g.lastTs = ts;
        g.ts = ts;
        continue;
      }
    }
    groups.push({
      ts,
      time: toIso(ts),
      level: rec.level,
      source: rec.source,
      msg: rec.msg,
      file: rec.file,
      count: 1,
      duplicates: 0,
      firstTs: ts,
      lastTs: ts,
    });
    open.set(key, groups.length - 1);
  }
  return groups;
}

/* ------------------------------------------------------------------------- *
 * Каталоги по умолчанию
 * ------------------------------------------------------------------------- */

function defaultDirs() {
  const env = (process.env.PHOENIX_LOG_DIRS || process.env.LOG_DIRS || '')
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (env.length) return env;

  const cwd = process.cwd();
  const here = __dirname;
  const candidates = [
    path.join(cwd, 'boxes'),
    path.join(cwd, 'phoenix', 'logs'),
    path.join(cwd, 'logs'),
    path.join(here, 'boxes'),
    path.join(here, 'phoenix', 'logs'),
    path.join(here, 'logs'),
  ];
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      if (fs.existsSync(abs)) out.push(abs);
    } catch (_) {
      /* skip */
    }
  }
  // Даже если ничего не существует — вернём исходный набор (scan вернёт []).
  return out.length ? out : candidates;
}

/** Нормализовать аргумент `dir` в массив путей. */
function normalizeDirs(dirs) {
  if (dirs == null) return defaultDirs();
  if (Array.isArray(dirs)) return dirs.map((d) => String(d));
  return [String(dirs)];
}

/* ------------------------------------------------------------------------- *
 * Публичный API
 * ------------------------------------------------------------------------- */

/**
 * Собрать и сгруппировать записи из каталогов.
 * @param {string|string[]} [dir] каталог(и); по умолчанию boxes + logs
 * @param {object} [opts] { dedupMs, warn, fresh }
 * @returns {Array<Record>} дедуплицированные записи, отсортированы по ts ASC
 */
function scan(dir, opts) {
  const options = Object.assign({}, opts || {});
  const windowMs = Number.isFinite(options.dedupMs)
    ? options.dedupMs
    : DEDUP_WINDOW_MS;
  const targets = normalizeDirs(dir);
  const files = [];
  const seenFiles = new Set();
  for (const target of targets) {
    for (const f of listLogFiles(target, options)) {
      if (seenFiles.has(f)) continue;
      seenFiles.add(f);
      files.push(f);
    }
  }
  const records = [];
  for (const file of files) {
    for (const rec of readLogFile(file, options)) records.push(rec);
  }
  records.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return dedupe(records, windowMs);
}

/**
 * Записи указанного уровня.
 * @param {string} level 'info' | 'warn' | 'error'
 * @param {object} [opts]
 * @returns {Array<Record>} всегда массив
 */
function byLevel(level, opts) {
  const target = normalizeLevel(level);
  const records = scan(opts && opts.dir, opts);
  if (!target) return records;
  return records.filter((r) => r.level === target);
}

/**
 * Топ-N ошибок по частоте (count DESC, затем msg ASC).
 * @param {number} [n=10]
 * @param {object} [opts]
 * @returns {Array<{msg,count,source,ts,level}>}
 */
function topErrors(n, opts) {
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
  const records = scan(opts && opts.dir, opts);
  const counts = new Map();
  for (const rec of records) {
    if (rec.level !== 'error') continue;
    const key = rec.msg || '(empty)';
    if (!counts.has(key)) {
      counts.set(key, {
        msg: key,
        count: 0,
        source: rec.source,
        ts: rec.ts,
        time: toIso(rec.ts),
        level: 'error',
      });
    }
    const item = counts.get(key);
    item.count += rec.count;
    if (rec.ts >= (item.ts || 0)) {
      item.ts = rec.ts;
      item.time = toIso(rec.ts);
      item.source = rec.source;
    }
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count || String(a.msg).localeCompare(String(b.msg)))
    .slice(0, limit);
}

/**
 * Последние n записей (по времени, ASC).
 * @param {number} [n=100]
 * @param {object} [opts]
 * @returns {Array<Record>}
 */
function tail(n, opts) {
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
  const records = scan(opts && opts.dir, opts);
  records.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return records.slice(-limit);
}

/** Сводка: количество файлов/записей и разбивка по уровням. */
function summary(opts) {
  const records = scan(opts && opts.dir, opts);
  const byLevelCounts = { info: 0, warn: 0, error: 0 };
  for (const rec of records) byLevelCounts[rec.level] += 1;
  return { total: records.length, byLevel: byLevelCounts, dirs: normalizeDirs(opts && opts.dir) };
}

/* ------------------------------------------------------------------------- *
 * Самопроверка / CLI
 * ------------------------------------------------------------------------- */

function selfTest(opts) {
  const emptyDir = path.join(require('os').tmpdir(), `la_selftest_${process.pid}`);
  let emptyOk = true;
  try {
    fs.mkdirSync(emptyDir, { recursive: true });
    const r1 = scan(emptyDir);
    const r2 = scan(path.join(emptyDir, 'does_not_exist'));
    emptyOk = Array.isArray(r1) && r1.length === 0 && Array.isArray(r2) && r2.length === 0;
  } catch (_) {
    emptyOk = false;
  } finally {
    try {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  }
  const records = scan(opts && opts.dir, opts);
  return {
    ok: emptyOk,
    count: records.length,
    dirs: normalizeDirs(opts && opts.dir),
    byLevel: summary(opts).byLevel,
  };
}

function parseArgv(argv) {
  const out = { dirs: [], level: null, n: null, k: null, json: false, selftest: false };
  for (const arg of argv || []) {
    if (arg === '--selftest') out.selftest = true;
    else if (arg === '--json') out.json = true;
    else if (arg.startsWith('--dir=')) out.dirs.push(arg.slice(6));
    else if (arg.startsWith('--level=')) out.level = arg.slice(8);
    else if (arg.startsWith('--n=')) out.n = Number(arg.slice(4));
    else if (arg.startsWith('--tail=')) out.n = Number(arg.slice(7));
    else if (arg.startsWith('--top=')) out.k = Number(arg.slice(6));
  }
  return out;
}

function main(argv) {
  const args = parseArgv(argv || process.argv.slice(2));
  const dirs = args.dirs.length ? args.dirs : undefined;
  if (args.selftest) {
    const report = selfTest({ dir: dirs });
    process.stdout.write(
      `LOG_AGGREGATOR_SELFTEST count=${report.count} emptyDirsOk=${report.ok}\n`
    );
    process.stdout.write(JSON.stringify(summary({ dir: dirs })) + '\n');
    process.stdout.write((report.ok ? 'SELFTEST_OK' : 'SELFTEST_FAIL') + '\n');
    return report;
  }
  if (args.level) {
    process.stdout.write(JSON.stringify(byLevel(args.level, { dir: dirs }), null, 2) + '\n');
    return;
  }
  if (args.k) {
    process.stdout.write(JSON.stringify(topErrors(args.k, { dir: dirs }), null, 2) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(tail(args.n || 100, { dir: dirs }), null, 2) + '\n');
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`[log_aggregator] error: ${err && err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  scan,
  byLevel,
  topErrors,
  tail,
  summary,
  selfTest,
  // низкоуровневые помощники (удобно тестировать)
  parseLine,
  normalizeLevel,
  parseTimestamp,
  listLogFiles,
  readLogFile,
  dedupe,
  defaultDirs,
  LEVELS,
  DEDUP_WINDOW_MS,
  MAX_FILE_SIZE,
};

module.exports.default = module.exports.scan;
