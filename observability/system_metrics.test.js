'use strict';

/**
 * observability/system_metrics.test.js
 * ---------------------------------------------------------------------------
 * Тесты сборщика системных метрик observability/system_metrics.js.
 *
 * Запуск:  node observability/system_metrics.test.js
 *          node tests/runner.js observability/system_metrics.test.js
 * ---------------------------------------------------------------------------
 */

const assert = require('assert');
const fs = require('fs');

const metrics = require('./system_metrics');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write('  \u2713 ' + name + '\n');
  } catch (err) {
    failed += 1;
    process.stdout.write('  \u2717 ' + name + ' -> ' + err.message + '\n');
  }
}

process.stdout.write('observability/system_metrics.test.js\n');

/* ---- API surface ---------------------------------------------------- */

test('экспортирует collect() и хелперы', function () {
  assert.strictEqual(typeof metrics.collect, 'function');
  assert.strictEqual(typeof metrics.collectDetailed, 'function');
  assert.strictEqual(typeof metrics.createCollector, 'function');
  assert.strictEqual(typeof metrics.readLoadavg, 'function');
  assert.strictEqual(typeof metrics.parseCpuLine, 'function');
  assert.strictEqual(typeof metrics.parseMeminfo, 'function');
});

/* ---- КРИТЕРИЙ: collect() ------------------------------------------- */

test('collect() возвращает ровно cpu_pct, ram_pct, load1, disk_pct', function () {
  const s = metrics.collect();
  assert.deepStrictEqual(
    Object.keys(s).sort(),
    ['cpu_pct', 'disk_pct', 'load1', 'ram_pct']
  );
});

test('collect(): все поля — числа в диапазоне 0..100', function () {
  const s = metrics.collect();
  for (const key of ['cpu_pct', 'ram_pct', 'load1', 'disk_pct']) {
    const v = s[key];
    assert.strictEqual(typeof v, 'number', key + ' должен быть числом');
    assert.ok(Number.isFinite(v), key + ' должен быть конечным');
    assert.ok(v >= 0 && v <= 100, key + '=' + v + ' вне 0..100');
  }
});

test('collect() читает реальный /proc/loadavg', function () {
  if (!fs.existsSync('/proc/loadavg')) {
    return; // не Linux — пропускаем
  }
  const raw = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/)[0];
  const real = Number.parseFloat(raw);
  assert.ok(Number.isFinite(real), 'реальное значение loadavg не число');
  const expected = Math.min(Math.max(real, 0), 100);
  const s = metrics.collect();
  assert.ok(
    Math.abs(s.load1 - expected) <= 0.011,
    'load1=' + s.load1 + ' != /proc/loadavg=' + expected
  );
});

test('readLoadavg() сообщает источник /proc', function () {
  const la = metrics.readLoadavg();
  assert.strictEqual(typeof la.load1, 'number');
  assert.ok(['proc', 'os'].indexOf(la.source) >= 0);
  if (fs.existsSync('/proc/loadavg')) {
    assert.strictEqual(la.source, 'proc');
  }
});

/* ---- Парсеры -------------------------------------------------------- */

test('parseLoadavg() разбирает формат /proc/loadavg', function () {
  const p = metrics.parseLoadavg('0.52 0.31 0.19 2/345 12345');
  assert.strictEqual(p.load1, 0.52);
  assert.strictEqual(p.load5, 0.31);
  assert.strictEqual(p.load15, 0.19);
  assert.strictEqual(p.running, 2);
  assert.strictEqual(p.total, 345);
  assert.strictEqual(p.lastPid, 12345);
  assert.strictEqual(metrics.parseLoadavg(''), null);
  assert.strictEqual(metrics.parseLoadavg('garbage'), null);
});

test('parseCpuLine() суммирует jiffies и idle', function () {
  const line = 'cpu  100 2 50 800 20 5 3 0 0 0';
  const c = metrics.parseCpuLine(line);
  // total = 100+2+50+800+20+5+3 = 980
  assert.strictEqual(c.total, 980);
  // idle = idle + iowait = 800 + 20 = 820
  assert.strictEqual(c.idle, 820);
  assert.strictEqual(metrics.parseCpuLine('cpu0 1 2 3'), null);
  assert.strictEqual(metrics.parseCpuLine('mem 1 2 3 4'), null);
});

test('cpuPercentBetween(): 50% при половине простоя', function () {
  const pct = metrics.cpuPercentBetween({ total: 1000, idle: 400 }, { total: 1200, idle: 500 });
  // dTotal=200, dIdle=100 -> busy = 50%
  assert.strictEqual(pct, 50);
});

test('cpuPercentBetween(): защита от некорректных дельт', function () {
  assert.strictEqual(metrics.cpuPercentBetween(null, { total: 1, idle: 0 }), null);
  assert.strictEqual(
    metrics.cpuPercentBetween({ total: 5, idle: 1 }, { total: 5, idle: 1 }),
    null
  );
});

test('parseMeminfo() переводит кБ в байты', function () {
  const info = metrics.parseMeminfo('MemTotal:  1000 kB\nMemFree: 250 kB\nHugePages_Total: 4');
  assert.strictEqual(info.MemTotal, 1000 * 1024);
  assert.strictEqual(info.MemFree, 250 * 1024);
  assert.strictEqual(info.HugePages_Total, 4);
});

/* ---- Отдельные метрики --------------------------------------------- */

test('readRamPct() в диапазоне 0..100', function () {
  const v = metrics.readRamPct();
  assert.ok(typeof v === 'number' && v >= 0 && v <= 100, 'ram=' + v);
});

test('readCpuPct() в диапазоне 0..100 и повторный вызов даёт дельту', function () {
  const a = metrics.readCpuPct({ reset: true });
  const b = metrics.readCpuPct();
  assert.ok(a >= 0 && a <= 100, 'первый cpu=' + a);
  assert.ok(b >= 0 && b <= 100, 'второй cpu=' + b);
});

test('diskUsagePercent() в диапазоне 0..100', function () {
  const v = metrics.diskUsagePercent('/');
  assert.ok(typeof v === 'number' && v >= 0 && v <= 100, 'disk=' + v);
});

test('clampPct() режет NaN/границы', function () {
  assert.strictEqual(metrics.clampPct(-5), 0);
  assert.strictEqual(metrics.clampPct(150), 100);
  assert.strictEqual(metrics.clampPct(NaN), 0);
  assert.strictEqual(metrics.clampPct(Infinity), 100);
  assert.strictEqual(metrics.clampPct(12.3456), 12.35);
});

/* ---- Расширенный снимок и история ---------------------------------- */

test('collectDetailed() содержит обязательные поля и сырые данные', function () {
  const d = metrics.collectDetailed();
  for (const key of ['cpu_pct', 'ram_pct', 'load1', 'disk_pct']) {
    assert.strictEqual(typeof d[key], 'number', key);
  }
  assert.ok(d.raw && d.raw.loadavg, 'raw.loadavg отсутствует');
  assert.ok(d.sources && d.sources.loadavg, 'sources.loadavg отсутствует');
  assert.ok(typeof d.timestamp === 'number');
});

test('createCollector() ведёт историю и уважает лимит', function () {
  const c = metrics.createCollector({ historyLimit: 3 });
  for (let i = 0; i < 5; i += 1) {
    const s = c.collect();
    assert.strictEqual(typeof s.cpu_pct, 'number');
  }
  const h = c.history();
  assert.strictEqual(h.length, 3, 'лимит истории не соблюдён: ' + h.length);
  assert.ok(c.latest().seq === 5, 'latest.seq=' + c.latest().seq);
  const st = c.stats();
  assert.strictEqual(st.samples, 5);
  assert.strictEqual(st.retained, 3);
  c.reset();
  assert.strictEqual(c.history().length, 0);
  assert.strictEqual(c.latest(), null);
});

/* ---- Итог ----------------------------------------------------------- */

process.stdout.write(
  '\n' + (failed === 0 ? 'ALL PASSED' : 'FAILURES') +
  ' (' + passed + ' passed, ' + failed + ' failed)\n'
);

if (failed > 0) process.exitCode = 1;
