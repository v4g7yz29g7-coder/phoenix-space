'use strict';

/**
 * observability/log_aggregator.standalone.test.js
 * ===========================================================================
 * STANDALONE-проверка сканера логов:
 *   observability/log_aggregator.js -> scan(dir) / byLevel(level) /
 *                                      topErrors(n) / tail(n)
 *
 * Жёсткие критерии приёмки, которые здесь проверяются:
 *   1. ≥ 160 assert'ов (счётчик печатается в конце).
 *   2. API: scan(dir) / byLevel(level) / topErrors(n) / tail(n) — функции,
 *      всегда возвращают массивы и НЕ бросают на пустом/несуществующем входе.
 *   3. Сканирование каталогов boxes + phoenix (корень пакета).
 *   4. ДЕДУП одинаковых сообщений в окне 5 минут — проверены ТОЧНЫЕ границы:
 *        4:59 (299000 мс) -> дубликат,
 *        5:00 (300000 мс) -> дубликат (порог включающий, <=),
 *        5:01 (301000 мс) -> НЕ дубликат (новая запись).
 *   5. РОТАЦИЯ: файлы > 50MB пропускаются; проверены 49MB / 50MB / 51MB
 *      (порог строгий: 50MB ровно — ещё читается, 51MB — уже skip).
 *   6. topErrors(n=10) СТАБИЛЕН: два подряд свежих scan() дают равный результат,
 *      сортировка по count DESC, тай-брейк по msg ASC.
 *   7. tail(n) НЕ бросает на пустом файле (0 байт) и на whitespace-файле.
 *
 * Тест самодостаточен: только `assert`, `fs`, `os`, `path` + модуль.
 * Запуск:
 *   node observability/log_aggregator.standalone.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const la = require('./log_aggregator.js');

/* ==================================================================== *
 * Счётчик ассертов — каждое утверждение идёт через хелперы, поэтому
 * итоговое число точное и проверяемое.
 * ==================================================================== */

let ASSERTIONS = 0;

function ok(cond, msg) {
  ASSERTIONS += 1;
  assert.ok(cond, msg);
}
function eq(a, b, msg) {
  ASSERTIONS += 1;
  assert.strictEqual(a, b, msg);
}
function deep(a, b, msg) {
  ASSERTIONS += 1;
  assert.deepStrictEqual(a, b, msg);
}
function gte(a, b, msg) {
  ASSERTIONS += 1;
  assert.ok(a >= b, (msg || '') + ' (>= ' + b + ', got ' + a + ')');
}
function lte(a, b, msg) {
  ASSERTIONS += 1;
  assert.ok(a <= b, (msg || '') + ' (<= ' + b + ', got ' + a + ')');
}
function noThrow(fn, msg) {
  ASSERTIONS += 1;
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.strictEqual(err, null, (msg || '') + (err ? ': ' + err.message : ''));
}
function matches(value, re, msg) {
  ASSERTIONS += 1;
  assert.ok(re.test(String(value)), (msg || '') + ' (got: ' + value + ')');
}

/* ==================================================================== *
 * Временные каталоги/фикстуры
 * ==================================================================== */

const ROOT = path.resolve(__dirname, '..'); // корень пакета = "phoenix"
const TMP_BASE = path.join(
  os.tmpdir(),
  'la_standalone_' + process.pid + '_' + Date.now()
);
const TMP_DIRS = [];

// Гарантированная уборка временных фикстур (в т.ч. при падении assert).
process.on('exit', () => {
  try {
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
});

function tmpDir(name) {
  const d = path.join(TMP_BASE, name);
  fs.mkdirSync(d, { recursive: true });
  TMP_DIRS.push(d);
  return d;
}

/** Записать текст в <dir>/<file>. */
function writeFile(dir, file, content) {
  const p = path.join(dir, file);
  fs.writeFileSync(p, content);
  return p;
}

/** Записать построчный лог в <dir>/<file>. */
function writeLines(dir, file, lines) {
  return writeFile(dir, file, lines.join('\n') + '\n');
}

const BASE_T = Date.parse('2024-06-01T00:00:00.000Z');

function iso(ms) {
  return new Date(ms).toISOString();
}

/** Компактная лог-запись {ts,level,source,msg}. */
function rec(level, msg, tsMs, source) {
  return {
    ts: iso(tsMs),
    level: level,
    source: source || 'svc',
    msg: msg,
  };
}

/** JSON-строка лога для файла. */
function jsonLine(level, msg, tsMs, source) {
  return JSON.stringify(rec(level, msg, tsMs, source));
}

/** Большой (sparse) файл точного размера с маркером в конце. */
function makeSizedFile(dir, file, sizeBytes, markerObj) {
  const p = path.join(dir, file);
  const marker =
    '\n' + JSON.stringify(markerObj || { level: 'ERROR', msg: 'marker' }) + '\n';
  const markerLen = Buffer.byteLength(marker);
  ok(sizeBytes > markerLen, 'sized fixture larger than marker');
  fs.writeFileSync(p, '');
  fs.truncateSync(p, sizeBytes - markerLen); // sparse-нули
  fs.appendFileSync(p, marker);
  const st = fs.statSync(p);
  return { path: p, size: st.size };
}

const MB = 1024 * 1024;
const DEDUP_MS = 5 * 60 * 1000; // 300000
const FIVE_MIN = 300000;
const FOUR_59 = 4 * 60 * 1000 + 59 * 1000; // 299000
const FIVE_01 = 5 * 60 * 1000 + 1000; // 301000

/* ==================================================================== *
 * A. API-поверхность и константы
 * ==================================================================== */

eq(typeof la.scan, 'function', 'scan exported as function');
eq(typeof la.byLevel, 'function', 'byLevel exported as function');
eq(typeof la.topErrors, 'function', 'topErrors exported as function');
eq(typeof la.tail, 'function', 'tail exported as function');
eq(typeof la.dedupeRecords, 'function', 'dedupeRecords exported');
eq(typeof la.readLogFileSafe, 'function', 'readLogFileSafe exported');
eq(typeof la.walkLogFiles, 'function', 'walkLogFiles exported');
eq(typeof la.parseLogLine, 'function', 'parseLogLine exported');

eq(la.DEDUP_WINDOW_MS, 5 * 60 * 1000, 'DEDUP_WINDOW_MS === 5 min');
eq(la.MAX_SCAN_FILE_BYTES, 50 * 1024 * 1024, 'MAX_SCAN_FILE_BYTES === 50MB');
eq(DEDUP_MS, la.DEDUP_WINDOW_MS, 'local DEDUP_MS mirrors module constant');
deep(
  la.TAIL_LEVELS.slice().sort(),
  ['ERROR', 'INFO', 'OK', 'WARN'],
  'TAIL_LEVELS = INFO/WARN/ERROR/OK'
);

/* ==================================================================== *
 * B. ДЕДУП — точные границы 4:59 / 5:00 / 5:01 (прямой вызов)
 * ==================================================================== */

// 4:59 -> дубликат
let d = la.dedupeRecords([
  rec('ERROR', 'same', BASE_T),
  rec('ERROR', 'same', BASE_T + FOUR_59),
]);
eq(d.length, 1, 'dedup 4:59 -> single record');
eq(d[0].count, 2, 'dedup 4:59 -> count=2');
eq(d[0].duplicates, 1, 'dedup 4:59 -> duplicates=1');

// 5:00 (ровно порог) -> дубликат (включающая граница)
d = la.dedupeRecords([
  rec('ERROR', 'same', BASE_T),
  rec('ERROR', 'same', BASE_T + FIVE_MIN),
]);
eq(d.length, 1, 'dedup 5:00 -> single record (inclusive boundary)');
eq(d[0].count, 2, 'dedup 5:00 -> count=2');
eq(d[0].duplicates, 1, 'dedup 5:00 -> duplicates=1');

// 5:01 -> НЕ дубликат
d = la.dedupeRecords([
  rec('ERROR', 'same', BASE_T),
  rec('ERROR', 'same', BASE_T + FIVE_01),
]);
eq(d.length, 2, 'dedup 5:01 -> two records (outside window)');
eq(d[0].count, 1, 'dedup 5:01 -> first count=1');
eq(d[1].count, 1, 'dedup 5:01 -> second count=1');
eq(d[0].duplicates, 0, 'dedup 5:01 -> first duplicates=0');

// Цепочка: 4:59 затем ещё 5:00 от последней -> count=3, затем 5:01 -> новая
d = la.dedupeRecords([
  rec('ERROR', 'chain', BASE_T),
  rec('ERROR', 'chain', BASE_T + FOUR_59), // +4:59 -> dup
  rec('ERROR', 'chain', BASE_T + FOUR_59 + FIVE_MIN), // ещё +5:00 -> dup
  rec('ERROR', 'chain', BASE_T + FOUR_59 + FIVE_MIN + FIVE_01), // +5:01 -> new
]);
eq(d.length, 2, 'chain 4:59/5:00/5:01 -> two records');
eq(d[0].count, 3, 'chain -> first accumulated count=3');
eq(d[0].duplicates, 2, 'chain -> first duplicates=2');
eq(d[1].count, 1, 'chain -> tail record count=1');

// Разные ключи (msg / level) не схлопываются даже на одинаковом ts
d = la.dedupeRecords([
  rec('ERROR', 'a', BASE_T),
  rec('ERROR', 'b', BASE_T),
  rec('WARN', 'a', BASE_T),
]);
eq(d.length, 3, 'distinct keys never merge on same ts');

// Кастомное окно: 1000 мс
d = la.dedupeRecords(
  [rec('INFO', 'w', BASE_T), rec('INFO', 'w', BASE_T + 1000)],
  1000
);
eq(d.length, 1, 'custom window 1000: diff 1000 -> dedup');
d = la.dedupeRecords(
  [rec('INFO', 'w', BASE_T), rec('INFO', 'w', BASE_T + 1001)],
  1000
);
eq(d.length, 2, 'custom window 1000: diff 1001 -> separate');

// Окно 0: только совпадающий ts схлопывается
d = la.dedupeRecords(
  [rec('INFO', 'z', BASE_T), rec('INFO', 'z', BASE_T)],
  0
);
eq(d.length, 1, 'window 0: identical ts -> dedup (diff 0 <= 0)');
d = la.dedupeRecords(
  [rec('INFO', 'z', BASE_T), rec('INFO', 'z', BASE_T + 1)],
  0
);
eq(d.length, 2, 'window 0: diff 1 -> separate');

// Дедуп не мутирует вход и не сортирует входной массив
const inputOrder = [
  rec('INFO', 'later', BASE_T + 10000),
  rec('INFO', 'earlier', BASE_T),
];
const inputCopy = JSON.parse(JSON.stringify(inputOrder));
la.dedupeRecords(inputOrder);
deep(inputOrder, inputCopy, 'dedupeRecords does not mutate input array');

/* ==================================================================== *
 * C. ДЕДУП — сквозной через scan(dir)
 * ==================================================================== */

const dedupDir = tmpDir('dedup');
writeLines(dedupDir, 'dedup.log', [
  jsonLine('ERROR', 'db timeout', BASE_T),
  jsonLine('ERROR', 'db timeout', BASE_T + FOUR_59), // 4:59 dup
  jsonLine('ERROR', 'db timeout', BASE_T + FOUR_59 + FIVE_MIN), // +5:00 dup
  jsonLine('ERROR', 'db timeout', BASE_T + FOUR_59 + FIVE_MIN + FIVE_01), // +5:01 new
  jsonLine('INFO', 'health ok', BASE_T + 1000),
]);

const scannedDedup = la.scan(dedupDir);
ok(Array.isArray(scannedDedup), 'scan(dir) returns array');
const dbs = scannedDedup.filter((r) => r.msg === 'db timeout');
eq(dbs.length, 2, 'scan e2e: db timeout collapsed to 2 records');
eq(dbs[0].count, 3, 'scan e2e: first db timeout count=3');
eq(dbs[0].duplicates, 2, 'scan e2e: first db timeout duplicates=2');
eq(dbs[1].count, 1, 'scan e2e: boundary record count=1');
eq(
  scannedDedup.filter((r) => r.msg === 'health ok').length,
  1,
  'scan e2e: unrelated message preserved'
);
for (const r of scannedDedup) {
  ok(typeof r.count === 'number' && r.count >= 1, 'scan record has count>=1');
  ok(typeof r.duplicates === 'number', 'scan record has duplicates field');
  ok(typeof r.level === 'string', 'scan record has level');
  ok(typeof r.msg === 'string', 'scan record has msg');
}

// scan([dir]) — массив каталогов
const scannedList = la.scan([dedupDir]);
eq(scannedList.length, scannedDedup.length, 'scan([dir]) matches scan(dir)');

// scan(dir, {dedupWindowMs:0}) — при 0 мс дубликаты не схлопываются
const noDedup = la.scan(dedupDir, { dedupWindowMs: 0 });
eq(
  noDedup.filter((r) => r.msg === 'db timeout').length,
  4,
  'scan dedupWindowMs:0 keeps all 4 distinct (0 win collapses only same ts)'
);
const wideDedup = la.scan(dedupDir, { dedupWindowMs: 10 * 60 * 1000 });
eq(
  wideDedup.filter((r) => r.msg === 'db timeout').length,
  1,
  'scan dedupWindowMs:10min collapses all 4 into 1'
);

/* ==================================================================== *
 * D. РОТАЦИЯ — порог 49MB / 50MB / 51MB
 * ==================================================================== */

const r49 = tmpDir('rot49');
const r50 = tmpDir('rot50');
const r51 = tmpDir('rot51');

const f49 = makeSizedFile(r49, 'big.log', 49 * MB, {
  level: 'ERROR',
  msg: 'marker-49',
});
const f50 = makeSizedFile(r50, 'big.log', 50 * MB, {
  level: 'ERROR',
  msg: 'marker-50',
});
const f51 = makeSizedFile(r51, 'big.log', 51 * MB, {
  level: 'ERROR',
  msg: 'marker-51',
});

eq(f49.size, 49 * MB, 'fixture 49MB exact size');
eq(f50.size, 50 * MB, 'fixture 50MB exact size');
eq(f51.size, 51 * MB, 'fixture 51MB exact size');

const res49 = la.readLogFileSafe(f49.path);
eq(res49.skipped, false, '49MB is NOT skipped');
eq(res49.size, 49 * MB, '49MB size reported');
ok(Array.isArray(res49.lines), '49MB returns lines array');
gte(res49.lines.length, 1, '49MB yields at least one line');

const res50 = la.readLogFileSafe(f50.path);
eq(res50.skipped, false, '50MB exactly is NOT skipped (strict >)');
eq(res50.size, 50 * MB, '50MB size reported');

const res51 = la.readLogFileSafe(f51.path);
eq(res51.skipped, true, '51MB IS skipped (rotation)');
eq(res51.size, 51 * MB, '51MB size reported');
deep(res51.lines, [], 'skipped file returns no lines');

// scan() уважает порог: 51MB пропускается, маленький файл читается
const mixDir = tmpDir('mixed');
writeLines(mixDir, 'small.log', [
  jsonLine('INFO', 'small-1', BASE_T),
  jsonLine('ERROR', 'small-2', BASE_T + 1),
  jsonLine('WARN', 'small-3', BASE_T + 2),
]);
makeSizedFile(mixDir, 'huge.log', 51 * MB, {
  level: 'ERROR',
  msg: 'should-be-skipped',
});

const mixed = la.scan(mixDir);
eq(mixed.length, 3, 'scan skips >50MB file, keeps 3 small records');
eq(
  mixed.filter((r) => r.msg === 'should-be-skipped').length,
  0,
  'scan did NOT read the 51MB rotated file'
);

// каталог только с 51MB файлом -> []
const onlyHuge = tmpDir('onlyhuge');
makeSizedFile(onlyHuge, 'only.log', 51 * MB, {
  level: 'ERROR',
  msg: 'only-huge',
});
const onlyHugeScan = la.scan(onlyHuge);
deep(onlyHugeScan, [], 'scan of 51MB-only dir returns []');

// 50MB ровно — читается (порог строгий)
const at50 = la.scan(r50, { perFile: 5 });
gte(at50.length, 1, 'scan reads the 50MB file (boundary)');

/* ==================================================================== *
 * E. Пустой / отсутствующий вход — НИКОГДА не бросает
 * ==================================================================== */

const emptyDir = tmpDir('emptydir');
const emptyFileDir = tmpDir('emptyfile');
writeFile(emptyFileDir, 'empty.log', ''); // 0 байт
const wsDir = tmpDir('wsdir');
writeFile(wsDir, 'ws.log', '   \n\t\n  \n'); // только пробелы

const missingDir = path.join(TMP_BASE, 'no_such_dir_' + process.pid);

noThrow(() => la.scan(emptyDir), 'scan(emptyDir) does not throw');
noThrow(() => la.scan(missingDir), 'scan(missingDir) does not throw');
noThrow(() => la.scan([missingDir, emptyDir]), 'scan([missing,empty]) does not throw');
noThrow(() => la.scan([]), 'scan([]) does not throw');

deep(la.scan(emptyDir), [], 'scan(emptyDir) === []');
deep(la.scan(missingDir), [], 'scan(missingDir) === []');
deep(la.scan([missingDir, emptyDir]), [], 'scan([missing,empty]) === []');
deep(la.scan([]), [], 'scan([]) === []');

eq(la.tail(50, { dir: emptyFileDir }).length, 0, 'tail on empty file -> []');
eq(la.tail(50, { dir: wsDir }).length, 0, 'tail on whitespace file -> []');
eq(la.tail(50, { dir: emptyDir }).length, 0, 'tail on empty dir -> []');
eq(la.tail(50, { dir: missingDir }).length, 0, 'tail on missing dir -> []');

noThrow(() => la.tail(50, { dir: emptyFileDir }), 'tail(empty file) does not throw');
noThrow(() => la.tail(50, { dir: wsDir }), 'tail(whitespace) does not throw');
noThrow(() => la.tail(50, { dir: missingDir }), 'tail(missing dir) does not throw');
noThrow(() => la.tail(0, { dir: emptyFileDir }), 'tail(0) does not throw');
noThrow(() => la.tail(-5, { dir: emptyFileDir }), 'tail(-5) does not throw');
noThrow(() => la.tail(undefined, { dir: emptyFileDir }), 'tail(undefined) does not throw');
noThrow(() => la.tail(null, { dir: emptyFileDir }), 'tail(null) does not throw');
noThrow(() => la.tail('abc', { dir: emptyFileDir }), 'tail(garbage) does not throw');

eq(la.tail(0, { dir: emptyFileDir }).length, 0, 'tail(0) -> []');
eq(la.tail(-5, { dir: emptyFileDir }).length, 0, 'tail(-5) -> []');
eq(la.tail(null, { dir: emptyFileDir }).length, 0, 'tail(null) -> []');

// readLastLines на пустом файле
const emptyPath = path.join(emptyFileDir, 'empty.log');
noThrow(() => la.readLastLines(emptyPath, 10), 'readLastLines(empty) does not throw');
deep(la.readLastLines(emptyPath, 10), [], 'readLastLines(empty) -> []');

// byLevel / topErrors на пустом входе
deep(la.byLevel('ERROR', { dir: emptyDir }), [], 'byLevel on empty dir -> []');
deep(la.topErrors(10, { dir: emptyDir }), [], 'topErrors on empty dir -> []');
noThrow(() => la.byLevel('ERROR', { dir: missingDir }), 'byLevel(missing) no throw');
noThrow(() => la.topErrors(10, { dir: missingDir }), 'topErrors(missing) no throw');

/* ==================================================================== *
 * F. tail(n) — порядок и размеры
 * ==================================================================== */

const tailDir = tmpDir('tail');
// Нарочно в перемешанном порядке — tail обязан вернуть отсортированные по ts.
writeLines(tailDir, 't.log', [
  jsonLine('INFO', 'e5', BASE_T + 5000),
  jsonLine('INFO', 'e1', BASE_T + 1000),
  jsonLine('ERROR', 'e3', BASE_T + 3000),
  jsonLine('WARN', 'e2', BASE_T + 2000),
  jsonLine('INFO', 'e4', BASE_T + 4000),
]);

const t3 = la.tail(3, { dir: tailDir });
eq(t3.length, 3, 'tail(3) returns 3 records');
eq(t3[0].msg, 'e3', 'tail(3)[0] is 3rd latest');
eq(t3[1].msg, 'e4', 'tail(3)[1] is 4th latest');
eq(t3[2].msg, 'e5', 'tail(3)[2] is latest');
for (let i = 0; i + 1 < t3.length; i += 1) {
  ok(
    Date.parse(t3[i].ts) <= Date.parse(t3[i + 1].ts),
    'tail records sorted ascending by ts'
  );
}

const tAll = la.tail(100, { dir: tailDir });
eq(tAll.length, 5, 'tail(100) returns all 5');
eq(tAll[0].msg, 'e1', 'tail full: earliest first');
eq(tAll[4].msg, 'e5', 'tail full: latest last');

for (const n of [1, 2, 3, 4, 5, 10, 200]) {
  const r = la.tail(n, { dir: tailDir });
  lte(r.length, Math.min(n, 5), 'tail(' + n + ') length <= min(n,5)');
  ok(Array.isArray(r), 'tail(' + n + ') returns array');
}

eq(la.tail(1, { dir: tailDir })[0].msg, 'e5', 'tail(1) returns the latest');
eq(la.tail('5', { dir: tailDir }).length, 5, 'tail("5") coerces string n');

// tail не бросает на мусоре в каталоге
const garbageDir = tmpDir('garbage');
writeLines(garbageDir, 'g.log', [
  'garbage line no timestamp',
  '[ORCH 21:29:06] \u274C boom happened',
  '{"level":"WARN","msg":"json ok"}',
  '',
  '   ',
]);
noThrow(() => la.tail(50, { dir: garbageDir }), 'tail on garbage lines does not throw');
gte(la.tail(50, { dir: garbageDir }).length, 1, 'garbage dir still yields records');

/* ==================================================================== *
 * G. byLevel(level)
 * ==================================================================== */

const lvlDir = tmpDir('levels');
writeLines(lvlDir, 'l.log', [
  jsonLine('INFO', 'i1', BASE_T + 100),
  jsonLine('INFO', 'i2', BASE_T + 200),
  jsonLine('WARN', 'w1', BASE_T + 300),
  jsonLine('ERROR', 'x1', BASE_T + 400),
  jsonLine('ERROR', 'x2', BASE_T + 500),
  JSON.stringify({ level: 'error', msg: 'x3', ts: iso(BASE_T + 600) }),
  JSON.stringify({ level: 'warning', msg: 'w2', ts: iso(BASE_T + 700) }),
  JSON.stringify({ level: 'critical', msg: 'x4', ts: iso(BASE_T + 800) }),
]);

const errs = la.byLevel('ERROR', { dir: lvlDir });
ok(Array.isArray(errs), 'byLevel(ERROR) returns array');
eq(errs.length, 4, 'byLevel(ERROR) = x1,x2,x3,x4 (aliases critical->ERROR)');
for (const r of errs) {
  eq(r.level, 'ERROR', 'byLevel(ERROR) returns only ERROR');
}

const warns = la.byLevel('WARN', { dir: lvlDir });
eq(warns.length, 2, 'byLevel(WARN) includes alias warning');
for (const r of warns) eq(r.level, 'WARN', 'byLevel(WARN) returns only WARN');

const infos = la.byLevel('INFO', { dir: lvlDir });
eq(infos.length, 2, 'byLevel(INFO) = 2');

// Регистро- и алиас-независимость
eq(la.byLevel('error', { dir: lvlDir }).length, 4, 'byLevel lowercase alias');
eq(la.byLevel('err', { dir: lvlDir }).length, 4, 'byLevel("err") alias');
eq(la.byLevel('critical', { dir: lvlDir }).length, 4, 'byLevel("critical") alias');
eq(la.byLevel('warning', { dir: lvlDir }).length, 2, 'byLevel("warning") alias');
eq(la.byLevel('ERROR', { dir: lvlDir }).length, la.byLevel('err', { dir: lvlDir }).length, 'aliases agree');

// Неизвестный/пустой уровень -> массив (не throw)
ok(Array.isArray(la.byLevel('NOPE', { dir: lvlDir })), 'byLevel(unknown) -> array');
noThrow(() => la.byLevel(null, { dir: lvlDir }), 'byLevel(null) no throw');
noThrow(() => la.byLevel(undefined, { dir: lvlDir }), 'byLevel(undefined) no throw');
ok(Array.isArray(la.byLevel(null, { dir: lvlDir })), 'byLevel(null) -> array');

/* ==================================================================== *
 * H. topErrors(n) — счётчики, сортировка, СТАБИЛЬНОСТЬ n=10
 * ==================================================================== */

const topDir = tmpDir('top');
// Частоты: A=5, B=3, C=1. Внутри сообщения сдвиг 6 мин -> НЕ дедупятся
// (6 мин > окна 5 мин), значит суммируются как отдельные записи.
const topLines = [];
function addMany(msg, times, slot) {
  for (let i = 0; i < times; i += 1) {
    topLines.push(jsonLine('ERROR', msg, BASE_T + slot * 1000 + i * 6 * 60 * 1000));
  }
}
addMany('Alpha failure', 5, 1);
addMany('Beta failure', 3, 2);
addMany('Gamma failure', 1, 3);
writeLines(topDir, 'errors.log', topLines);

const te = la.topErrors(10, { dir: topDir });
ok(Array.isArray(te), 'topErrors returns array');
eq(te.length, 3, 'topErrors finds 3 distinct messages');
eq(te[0].msg, 'Alpha failure', 'topErrors[0] is the most frequent');
eq(te[0].count, 5, 'Alpha count=5');
eq(te[1].msg, 'Beta failure', 'topErrors[1] second');
eq(te[1].count, 3, 'Beta count=3');
eq(te[2].msg, 'Gamma failure', 'topErrors[2] third');
eq(te[2].count, 1, 'Gamma count=1');

// Сортировка строго по count DESC
for (let i = 0; i + 1 < te.length; i += 1) {
  gte(te[i].count, te[i + 1].count, 'topErrors sorted by count DESC');
}
// Форма элементов
for (const item of te) {
  ok(typeof item.msg === 'string', 'topErrors item.msg is string');
  ok(typeof item.count === 'number', 'topErrors item.count is number');
  ok('source' in item, 'topErrors item has source');
}

// СТАБИЛЬНОСТЬ: два свежих scan дают идентичный результат (n=10)
const teA = la.topErrors(10, { dir: topDir });
const teB = la.topErrors(10, { dir: topDir });
deep(teA, teB, 'topErrors(10) stable across fresh scans');
deep(teA, te, 'topErrors(10) stable vs first call');

// Стабильность и на прямом наборе records (n=10)
const fixed = [];
for (let i = 0; i < 12; i += 1) {
  fixed.push(rec('ERROR', 'msg-' + String.fromCharCode(65 + i), BASE_T + i, 's'));
  // каждому задаём count, эмулируя дедуп
  fixed[fixed.length - 1].count = 12 - i;
}
const f1 = la.topErrors(10, { records: fixed });
const f2 = la.topErrors(10, { records: fixed });
deep(f1, f2, 'topErrors(10) stable on explicit records');
eq(f1.length, 10, 'topErrors(10) respects k=10');
eq(f1[0].count, 12, 'topErrors explicit: max count first');
eq(f1[9].count, 3, 'topErrors explicit: 10th has count 3');
for (let i = 0; i + 1 < f1.length; i += 1) {
  gte(f1[i].count, f1[i + 1].count, 'explicit topErrors count DESC');
}

// Тай-брейк по msg ASC при равных count
const tie = la.topErrors(3, {
  records: [
    Object.assign(rec('ERROR', 'zzz', BASE_T), { count: 2 }),
    Object.assign(rec('ERROR', 'aaa', BASE_T), { count: 2 }),
    Object.assign(rec('ERROR', 'mmm', BASE_T), { count: 2 }),
  ],
});
eq(tie[0].msg, 'aaa', 'tie-break alphabetical: aaa first');
eq(tie[1].msg, 'mmm', 'tie-break alphabetical: mmm second');
eq(tie[2].msg, 'zzz', 'tie-break alphabetical: zzz third');

// topErrors применяет k для больших n
eq(la.topErrors(1, { dir: topDir }).length, 1, 'topErrors(1) -> 1 item');
eq(la.topErrors(2, { dir: topDir }).length, 2, 'topErrors(2) -> 2 items');
eq(la.topErrors(100, { dir: topDir }).length, 3, 'topErrors(100) -> all 3');
noThrow(() => la.topErrors(0, { dir: topDir }), 'topErrors(0) no throw');
noThrow(() => la.topErrors(-1, { dir: topDir }), 'topErrors(-1) no throw');
ok(Array.isArray(la.topErrors(0, { dir: topDir })), 'topErrors(0) -> array');

// topErrors учитывает накопленный count после дедупа
const dedupTopDir = tmpDir('deduptop');
writeLines(dedupTopDir, 'dt.log', [
  jsonLine('ERROR', 'repeat me', BASE_T),
  jsonLine('ERROR', 'repeat me', BASE_T + 1000),
  jsonLine('ERROR', 'repeat me', BASE_T + 2000),
  jsonLine('ERROR', 'repeat me', BASE_T + 3000),
]);
const dt = la.topErrors(5, { dir: dedupTopDir });
eq(dt.length, 1, 'deduped errors collapse to 1 message');
eq(dt[0].msg, 'repeat me', 'deduped topErrors keeps msg');
eq(dt[0].count, 4, 'deduped topErrors accumulates count=4');

/* ==================================================================== *
 * I. Реальное сканирование: boxes + phoenix (корень пакета)
 * ==================================================================== */

const BOXES = path.join(ROOT, 'boxes');
const LOGS = path.join(ROOT, 'logs');

ok(fs.existsSync(BOXES), 'boxes/ directory exists in package root (phoenix)');
ok(fs.existsSync(LOGS), 'logs/ directory exists in package root (phoenix)');

// scan(boxes) — не бросает, всегда массив
noThrow(() => la.scan(BOXES), 'scan(boxes) does not throw');
const boxesScan = la.scan(BOXES);
ok(Array.isArray(boxesScan), 'scan(boxes) returns array');
for (const r of boxesScan.slice(0, 100)) {
  ok(typeof r.msg === 'string', 'boxes record msg is string');
  ok(typeof r.level === 'string', 'boxes record level is string');
}

// scan(logs) — реальные логи, ожидаем записи
const logsScan = la.scan(LOGS);
ok(Array.isArray(logsScan), 'scan(logs) returns array');
gte(logsScan.length, 1, 'scan(logs) finds at least one record');
const logsLevels = {};
for (const r of logsScan.slice(0, 200)) logsLevels[r.level] = (logsLevels[r.level] || 0) + 1;
ok(Object.keys(logsLevels).length >= 1, 'scan(logs) yields at least one level');
for (const lvl of Object.keys(logsLevels)) {
  ok(typeof lvl === 'string' && lvl.length > 0, 'logs level key is non-empty string');
}

// scan([boxes, logs]) — «boxes + phoenix»
noThrow(() => la.scan([BOXES, LOGS]), 'scan([boxes,logs]) does not throw');
const combined = la.scan([BOXES, LOGS]);
ok(Array.isArray(combined), 'scan([boxes,logs]) returns array');
gte(combined.length, logsScan.length, 'combined scan covers at least logs');

// byLevel по реальным данным
for (const lvl of ['INFO', 'WARN', 'ERROR', 'OK']) {
  const got = la.byLevel(lvl, { dir: [BOXES, LOGS] });
  ok(Array.isArray(got), 'byLevel(' + lvl + ') real -> array');
  for (const r of got.slice(0, 50)) eq(r.level, lvl, 'byLevel(' + lvl + ') real filters properly');
  // каждый элемент обязан совпадать с уровнем (полная проверка без раздувания счётчика)
  assert.ok(
    got.every((r) => r.level === lvl),
    'byLevel(' + lvl + ') real: all records match'
  );
}

// topErrors(10) по реальным данным — стабильно и отсортировано
const realTopA = la.topErrors(10, { dir: [BOXES, LOGS] });
const realTopB = la.topErrors(10, { dir: [BOXES, LOGS] });
ok(Array.isArray(realTopA), 'real topErrors(10) -> array');
lte(realTopA.length, 10, 'real topErrors(10) length <= 10');
deep(realTopA, realTopB, 'real topErrors(10) stable across scans');
for (let i = 0; i + 1 < realTopA.length; i += 1) {
  gte(realTopA[i].count, realTopA[i + 1].count, 'real topErrors sorted DESC');
}
for (const item of realTopA) {
  ok(typeof item.msg === 'string', 'real top error has msg');
  ok(item.count >= 1, 'real top error count >= 1');
}

// tail(n) по реальным данным
noThrow(() => la.tail(10, { dir: [BOXES, LOGS] }), 'tail(10) real does not throw');
const realTail = la.tail(10, { dir: [BOXES, LOGS] });
lte(realTail.length, 10, 'real tail(10) length <= 10');
for (let i = 0; i + 1 < realTail.length; i += 1) {
  ok(
    Date.parse(realTail[i].ts) <= Date.parse(realTail[i + 1].ts),
    'real tail sorted ascending'
  );
}

/* ==================================================================== *
 * J. Итог: порог >= 160 assert'ов
 * ==================================================================== */

gte(ASSERTIONS, 160, 'total assertions >= 160');
process.stdout.write('LOG_AGGREGATOR_STANDALONE_ASSERTIONS=' + ASSERTIONS + '\n');
process.stdout.write('LOG_AGGREGATOR_STANDALONE_OK\n');
