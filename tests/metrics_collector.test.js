'use strict';

/**
 * tests/metrics_collector.test.js
 * ---------------------------------------------------------------------------
 * Тесты модуля `metrics_collector.js` (корень проекта).
 *
 * Модуль — лёгкий сборщик системных метрик без внешних зависимостей:
 *
 *   collect()          -> snapshot        снять метрики и положить в ring-buffer
 *   snapshot()         -> snapshot        снять метрики БЕЗ записи в буфер
 *   latest()           -> snapshot | null последний замер
 *   history(n)         -> snapshot[]      последние n замеров
 *   percentiles([..])  -> number[]        перцентили CPU (+ .cpu/.ram/.load)
 *   start(ms) / stop()                    автосбор каждые 5s по умолчанию
 *
 * ФОКУС ТЕСТОВ (по критерию задачи):
 *   1. Снимок CPU/RAM/load детерминирован по схеме {ts, cpu, ram, load, ...}.
 *   2. Null-safe: отсутствие /proc/meminfo (RAM) или /proc/stat (CPU) НЕ
 *      роняет сборщик — снимок всё равно валиден, значения приводятся к 0.
 *   3. CPU = 0.0 — валидное значение, а не "falsy-баг": ровно 0 сохраняется
 *      в буфере и перцентилях и не подменяется заглушкой.
 *
 * Детерминированность достигается подменой чтения /proc/* и os.loadavg()
 * через `withMockedProc()`, поэтому тесты не зависят от железа/нагрузки.
 *
 * Запуск:
 *   node tests/metrics_collector.test.js                     # standalone
 *   node tests/runner.js tests/metrics_collector.test.js     # через раннер
 *
 * Модуль автостартует таймер при require(), поэтому MC_NO_AUTOSTART=1
 * выставляется ДО загрузки, чтобы тестовый процесс завершался сам.
 */

process.env.MC_NO_AUTOSTART = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = path.resolve(__dirname, '..', 'metrics_collector.js');

/* ========================================================================= *
 * Fixtures: контролируемое содержимое /proc/*
 * ========================================================================= */

// idle == total  ->  CPU ровно 0.0 (регрессия на falsy-баг)
const ZERO_STAT = 'cpu  0 0 0 1000 0 0 0 0 0 0\n';
// busy=300, idle=700 из 1000  ->  CPU ~30%
const BUSY_STAT = 'cpu  300 0 0 700 0 0 0 0 0 0\n';
// busy=1000, idle=0           ->  CPU ~100% (верхняя граница)
const FULL_STAT = 'cpu  1000 0 0 0 0 0 0 0 0 0\n';

// MemAvailable=400000 kB из 1000000 kB  ->  RAM 60%
const MEM_OK = [
  'MemTotal:       1000000 kB',
  'MemFree:         200000 kB',
  'MemAvailable:    400000 kB',
].join('\n') + '\n';

// Нет MemAvailable  ->  fallback на MemFree=200000 -> RAM 80%, не падает
const MEM_NO_AVAIL = [
  'MemTotal:       1000000 kB',
  'MemFree:         200000 kB',
].join('\n') + '\n';

// Нет MemTotal      ->  total=0 -> RAM 0 (не NaN)
const MEM_NO_TOTAL = 'MemFree:         100 kB\n';

/* ========================================================================= *
 * Helpers
 * ========================================================================= */

/**
 * Загружает модуль с подменённым чтением /proc/stat, /proc/meminfo и
 * os.loadavg(). Возвращает свежий инстанс модуля и вызывает fn(module).
 * Все подмены гарантированно откатываются (finally), кэш require чистится,
 * поэтому тесты полностью изолированы друг от друга.
 */
function withMockedProc(opts, fn) {
  const origRead = fs.readFileSync;
  const origLoad = os.loadavg;

  fs.readFileSync = function mockedRead(file, enc) {
    if (file === '/proc/stat') {
      if (opts.statThrows) throw new Error('EACCES: /proc/stat');
      return opts.stat !== undefined ? opts.stat : origRead.call(fs, file, enc);
    }
    if (file === '/proc/meminfo') {
      if (opts.memThrows) throw new Error('EACCES: /proc/meminfo');
      return opts.meminfo !== undefined ? opts.meminfo : origRead.call(fs, file, enc);
    }
    return origRead.call(fs, file, enc);
  };

  if (opts.loadavg) {
    os.loadavg = function mockedLoadavg() {
      return opts.loadavg.slice();
    };
  }

  delete require.cache[MODULE_PATH];
  try {
    return fn(require(MODULE_PATH));
  } finally {
    fs.readFileSync = origRead;
    os.loadavg = origLoad;
    delete require.cache[MODULE_PATH];
  }
}

/** Свежий инстанс модуля на реальных /proc/* (для структурных проверок). */
function loadFresh() {
  delete require.cache[MODULE_PATH];
  return require(MODULE_PATH);
}

const CORE_SCHEMA = ['cpu', 'load', 'ram', 'ts'];

function sortedKeys(obj) {
  return Object.keys(obj).sort();
}

/* ========================================================================= *
 * Test registry (runner-compatible: module.exports = { 'name': fn, ... })
 * ========================================================================= */

const tests = {};

function test(name, fn) {
  tests[name] = fn;
}

/* ---------------------------- 1. API surface ----------------------------- */

test('01. модуль экспортирует collect/snapshot/latest/history/percentiles/start/stop и константы', () => {
  const mc = loadFresh();
  for (const fnName of ['collect', 'snapshot', 'latest', 'history', 'percentiles', 'start', 'stop', 'size']) {
    assert.strictEqual(typeof mc[fnName], 'function', `${fnName} должен быть функцией`);
  }
  assert.strictEqual(typeof mc.RING_SIZE, 'number');
  assert.strictEqual(typeof mc.INTERVAL_MS, 'number');
  assert.ok(mc.RING_SIZE > 0 && mc.INTERVAL_MS > 0, 'RING_SIZE/INTERVAL_MS положительны');
});

/* ---------------------- 2. Схема снимка (deterministic) ------------------ */

test('02. snapshot() детерминирован по схеме: присутствуют {ts,cpu,ram,load}', () => {
  withMockedProc({ stat: ZERO_STAT, meminfo: MEM_OK, loadavg: [0.5, 0.4, 0.3] }, (mc) => {
    const snap = mc.snapshot();
    for (const key of CORE_SCHEMA) {
      assert.ok(Object.prototype.hasOwnProperty.call(snap, key), `нет обязательного поля "${key}"`);
    }
    assert.strictEqual(typeof snap.ts, 'number');
    assert.ok(Number.isFinite(snap.ts), 'ts конечен');
    assert.strictEqual(typeof snap.cpu, 'number');
    assert.strictEqual(typeof snap.ram, 'number');
    assert.ok(snap.load && typeof snap.load === 'object', 'load — объект');
  });
});

test('03. схема одинакова для snapshot(), collect() и каждого элемента history()', () => {
  withMockedProc({ stat: BUSY_STAT, meminfo: MEM_OK, loadavg: [1, 2, 3] }, (mc) => {
    const s = mc.snapshot();
    const c1 = mc.collect();
    const c2 = mc.collect();
    const hist = mc.history();
    assert.strictEqual(hist.length, 2, 'в буфере ровно два замера (snapshot не пишет)');

    const base = sortedKeys(s);
    for (const key of CORE_SCHEMA) assert.ok(base.includes(key), `базовая схема теряет "${key}"`);
    for (const item of [c1, c2, ...hist]) {
      assert.deepStrictEqual(sortedKeys(item), base, 'схема элемента истории отличается от snapshot()');
    }
  });
});

test('04. load содержит 1/5/15, loadavg — массив из 3 конечных чисел', () => {
  withMockedProc({ stat: ZERO_STAT, meminfo: MEM_OK, loadavg: [0.5, 0.4, 0.3] }, (mc) => {
    const snap = mc.snapshot();
    assert.strictEqual(snap.load['1'], 0.5);
    assert.strictEqual(snap.load['5'], 0.4);
    assert.strictEqual(snap.load['15'], 0.3);
    assert.ok(Array.isArray(snap.loadavg), 'loadavg — массив');
    assert.strictEqual(snap.loadavg.length, 3);
    assert.deepStrictEqual(snap.loadavg, [0.5, 0.4, 0.3]);
    for (const v of snap.loadavg) assert.ok(Number.isFinite(v), 'loadavg конечен');
  });
});

/* ------------------------- 5..9. Null-safe сценарии ---------------------- */

test('05. NULL-SAFE: отсутствие /proc/meminfo (RAM) не роняет сборщик', () => {
  withMockedProc({ stat: ZERO_STAT, memThrows: true, loadavg: [0, 0, 0] }, (mc) => {
    let snap;
    assert.doesNotThrow(() => { snap = mc.snapshot(); }, 'сборщик не должен падать без /proc/meminfo');
    assert.strictEqual(typeof snap.ram, 'number', 'ram всё равно число');
    assert.ok(Number.isFinite(snap.ram), 'ram конечен (не NaN)');
    assert.strictEqual(snap.ram, 0, 'без RAM-данных ram = 0');
    assert.ok(snap.mem && typeof snap.mem === 'object', 'mem-блок присутствует');
  });
});

test('06. NULL-SAFE: /proc/meminfo без MemAvailable — fallback на MemFree (RAM=80)', () => {
  withMockedProc({ stat: ZERO_STAT, meminfo: MEM_NO_AVAIL, loadavg: [0, 0, 0] }, (mc) => {
    const snap = mc.snapshot();
    assert.ok(Number.isFinite(snap.ram), 'ram конечен');
    assert.strictEqual(snap.mem.available, snap.mem.free, 'available падает на free');
    assert.strictEqual(Math.round(snap.ram), 80, 'RAM посчитан из MemFree');
  });
});

test('07. NULL-SAFE: /proc/meminfo без MemTotal -> ram = 0 (не NaN, без throw)', () => {
  withMockedProc({ stat: ZERO_STAT, meminfo: MEM_NO_TOTAL, loadavg: [0, 0, 0] }, (mc) => {
    const snap = mc.snapshot();
    assert.strictEqual(snap.mem.total, 0);
    assert.strictEqual(snap.ram, 0);
    assert.ok(Number.isFinite(snap.ram));
  });
});

test('08. NULL-SAFE: отсутствие /proc/stat -> cpu = 0, сборщик не падает', () => {
  withMockedProc({ statThrows: true, meminfo: MEM_OK, loadavg: [0, 0, 0] }, (mc) => {
    let snap;
    assert.doesNotThrow(() => { snap = mc.snapshot(); }, 'нет /proc/stat — не исключение');
    assert.strictEqual(snap.cpu, 0);
    assert.ok(Number.isFinite(snap.cpu));
  });
});

test('09. NULL-SAFE: мусорные /proc/stat и /proc/meminfo -> валидный снимок', () => {
  withMockedProc({ stat: 'not a cpu line\n', meminfo: 'garbage\n', loadavg: [0, 0, 0] }, (mc) => {
    const snap = mc.snapshot();
    assert.strictEqual(snap.cpu, 0);
    assert.strictEqual(snap.ram, 0);
    for (const key of CORE_SCHEMA) assert.ok(key in snap, `поле ${key} присутствует`);
  });
});

/* --------------------- 10..12. CPU = 0.0 (falsy-регрессия) ---------------- */

test('10. CPU=0.0 валиден: строго 0, а не falsy-подмена на заглушку', () => {
  withMockedProc({ stat: ZERO_STAT, meminfo: MEM_OK, loadavg: [0, 0, 0] }, (mc) => {
    const snap = mc.snapshot();
    assert.strictEqual(snap.cpu, 0, 'cpu должен быть ровно 0');
    assert.ok(Object.is(snap.cpu, 0), 'Object.is(cpu, 0) — без -0');
    assert.ok(Number.isFinite(snap.cpu), '0 — валидное конечное число');
    // Явная защита от falsy-бага вида `cpu = cpu || fallback`.
    assert.strictEqual(!snap.cpu, true, '0 — falsy, но это НЕ значит "нет данных"');
  });
});

test('11. CPU=0.0 сохраняется в ring-buffer и в percentiles (не отбрасывается)', () => {
  withMockedProc({ stat: ZERO_STAT, meminfo: MEM_OK, loadavg: [0, 0, 0] }, (mc) => {
    mc.collect();
    mc.collect();
    mc.collect();
    assert.strictEqual(mc.size(), 3);
    assert.strictEqual(mc.latest().cpu, 0, 'latest().cpu === 0');
    for (const s of mc.history()) assert.strictEqual(s.cpu, 0);

    const p = mc.percentiles([50, 95]);
    assert.strictEqual(p.cpu[0], 0, 'p50 CPU === 0');
    assert.strictEqual(p.cpu[1], 0, 'p95 CPU === 0');
    assert.ok(p.cpu.every((v) => Number.isFinite(v)), 'нули не превратились в NaN');
  });
});

test('12. CPU всегда клампится в [0,100] (100% и 0% границы)', () => {
  withMockedProc({ stat: FULL_STAT, meminfo: MEM_OK, loadavg: [0, 0, 0] }, (mc) => {
    assert.strictEqual(mc.snapshot().cpu, 100, 'полная загрузка -> 100');
  });
  withMockedProc({ stat: ZERO_STAT, meminfo: MEM_OK, loadavg: [0, 0, 0] }, (mc) => {
    assert.strictEqual(mc.snapshot().cpu, 0, 'полный idle -> 0');
  });
});

/* ----------------------- 13..15. Буфер и snapshot() --------------------- */

test('13. snapshot() снимает метрики без записи в ring-buffer', () => {
  const mc = loadFresh();
  const before = mc.size();
  mc.snapshot();
  mc.snapshot();
  assert.strictEqual(mc.size(), before, 'size() не изменился после snapshot()');
});

test('14. collect() пишет снимок: size() растёт, latest() возвращает последний', () => {
  const mc = loadFresh();
  const before = mc.size();
  const returned = mc.collect();
  assert.strictEqual(mc.size(), before + 1, 'буфер вырос на 1');
  assert.deepStrictEqual(mc.latest(), returned, 'latest() === последний collect()');
  assert.strictEqual(typeof mc.latest().ts, 'number');
});

test('15. history(n): последние n, все, граница 0 и перебор', () => {
  const mc = loadFresh();
  mc.collect();
  mc.collect();
  mc.collect();

  const all = mc.history();
  assert.strictEqual(all.length, 3);
  const lastTwo = mc.history(2);
  assert.strictEqual(lastTwo.length, 2);
  assert.strictEqual(lastTwo[0], all[1], 'history(2) — хвост истории');
  assert.strictEqual(lastTwo[1], all[2]);
  assert.strictEqual(mc.history(0).length, 0, 'history(0) пустая');
  assert.strictEqual(mc.history(999).length, 3, 'history(>size) возвращает всё');
});

/* --------------------------- 16..17. percentiles ------------------------- */

test('16. percentiles([..]) возвращает массив нужной длины с навешанными .cpu/.ram/.load', () => {
  const mc = loadFresh();
  for (let i = 0; i < 5; i += 1) mc.collect();
  const ps = [50, 90, 95, 99];
  const out = mc.percentiles(ps);
  assert.ok(Array.isArray(out), 'результат — массив');
  assert.strictEqual(out.length, ps.length, 'длина совпадает со списком перцентилей');
  assert.strictEqual(out.cpu.length, ps.length);
  assert.strictEqual(out.ram.length, ps.length);
  assert.strictEqual(out.load.length, ps.length);
  assert.strictEqual(out.p95, out.cpu[2], 'именованное поле p95 совпадает с cpu[2]');
  for (const v of out.cpu) assert.ok(v >= 0 && v <= 100, 'CPU-перцентиль в [0,100]');
});

test('17. percentiles() на пустом буфере -> нули, без исключений', () => {
  const mc = loadFresh();
  mc.history().length; // noop, просто читаем
  let out;
  assert.doesNotThrow(() => { out = mc.percentiles([50, 99]); });
  assert.deepStrictEqual([...out], [0, 0]);
  assert.deepStrictEqual([...out.cpu], [0, 0]);
  assert.deepStrictEqual([...out.ram], [0, 0]);
});

/* ------------------------- 18. Null-safe контракт RAM -------------------- */

test('18. NULL-SAFE-контракт: ram всегда конечное число >= 0 в любом сценарии', () => {
  const scenarios = [
    { name: 'норм', opts: { stat: BUSY_STAT, meminfo: MEM_OK, loadavg: [1, 1, 1] } },
    { name: 'нет MemAvailable', opts: { stat: BUSY_STAT, meminfo: MEM_NO_AVAIL, loadavg: [1, 1, 1] } },
    { name: 'нет MemTotal', opts: { stat: BUSY_STAT, meminfo: MEM_NO_TOTAL, loadavg: [1, 1, 1] } },
    { name: 'meminfo бросает', opts: { stat: BUSY_STAT, memThrows: true, loadavg: [1, 1, 1] } },
    { name: 'всё мусор', opts: { stat: 'x', meminfo: 'y', loadavg: [0, 0, 0] } },
  ];
  for (const { name, opts } of scenarios) {
    withMockedProc(opts, (mc) => {
      const snap = mc.snapshot();
      assert.ok(Number.isFinite(snap.ram), `[${name}] ram конечен`);
      assert.ok(snap.ram >= 0, `[${name}] ram >= 0`);
      assert.strictEqual(typeof snap.ram, 'number', `[${name}] ram — число, не undefined`);
    });
  }
});

/* --------------------------- 19..20. Lifecycle / ts ---------------------- */

test('19. start()/stop(): идемпотентны и не блокируют выход процесса', () => {
  const mc = loadFresh();
  try {
    const t1 = mc.start(50);
    const t2 = mc.start(50);
    assert.ok(t1, 'start() вернул timer');
    assert.strictEqual(t1, t2, 'повторный start() не пересоздаёт timer');
    mc.stop();
    const t3 = mc.start(50);
    assert.notStrictEqual(t3, t1, 'после stop() start() создаёт новый timer');
  } finally {
    mc.stop();
  }
});

test('20. ts — конечен и монотонно не убывает по истории', () => {
  const mc = loadFresh();
  const t0 = Date.now();
  mc.collect();
  mc.collect();
  const ts = mc.history().map((s) => s.ts);
  assert.ok(ts.every((v) => Number.isFinite(v)), 'все ts конечны');
  for (let i = 1; i < ts.length; i += 1) {
    assert.ok(ts[i] >= ts[i - 1], 'ts не убывает');
  }
  assert.ok(mc.latest().ts >= t0 - 1000 && mc.latest().ts <= Date.now() + 1000, 'ts близок к wall-clock');
});

/* ========================================================================= *
 * Standalone runner (не мешает tests/runner.js: свойство не enumerable)
 * ========================================================================= */

function runSuite() {
  const names = Object.keys(tests);
  let failed = 0;
  console.log(`\nmetrics_collector.js — ${names.length} тест-кейсов`);
  for (const name of names) {
    try {
      tests[name]();
      console.log(`  \u2713 ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  \u2717 ${name}\n      ${err && err.message}`);
    }
  }
  const passed = names.length - failed;
  console.log(`\n${passed}/${names.length} passed${failed ? `, ${failed} FAILED` : ' \u2014 ALL PASSED'}\n`);
  if (failed) process.exitCode = 1;
  return failed;
}

Object.defineProperty(tests, 'run', { value: runSuite, enumerable: false });

if (require.main === module) {
  runSuite();
}

module.exports = tests;
