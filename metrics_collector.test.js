'use strict';

/**
 * metrics_collector.test.js
 * ---------------------------------------------------------------------------
 * Тесты сборщика системных метрик `metrics_collector.js`
 * (снимок CPU / RAM / load с null-safe обработкой).
 *
 * КРИТЕРИИ:
 *   - >= 10 кейсов;
 *   - отсутствие поля/данных RAM не роняет сборщик (null-safe);
 *   - CPU = 0.0 — валидное значение (не falsy-баг: не подменяется на NaN/undefined);
 *   - снимок детерминирован по схеме { cpu, ram, load, ts }.
 *
 * Запуск:
 *   node metrics_collector.test.js
 *   node tests/runner.js metrics_collector.test.js
 *
 * Техника: модуль читает /proc/* через fs и load average через os, поэтому
 * тесты временно подменяют fs.readFileSync и os.loadavg (monkey-patch общего
 * объекта модулей) и восстанавливают их в finally — без правок продакшн-кода.
 *
 * Только стандартная библиотека Node.js.
 * ---------------------------------------------------------------------------
 */

// Модуль сам запускает автозамер при require — отключаем, чтобы тесты были
// детерминированы и не держали таймер.
process.env.MC_NO_AUTOSTART = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');

const mc = require('./metrics_collector.js');

/* ===========================================================================
 * Мини-раннер (standalone): считает кейсы, печатает ✓ / ✗, ставит exit code.
 * ========================================================================= */

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write('  \u2713 ' + name + '\n');
  } catch (err) {
    failed += 1;
    process.stdout.write(
      '  \u2717 ' + name + ' -> ' + (err && err.message ? err.message : err) + '\n'
    );
  }
}

process.stdout.write('metrics_collector.test.js\n');

/* ===========================================================================
 * Хелперы моков /proc и loadavg
 * ========================================================================= */

const REAL_READ_FILE_SYNC = fs.readFileSync;
const REAL_LOADAVG = os.loadavg;

/**
 * Временно подменяет источники метрик.
 * @param {{stat?:string|null, meminfo?:string|null, loadavg?:Function}} opts
 *        null для пути => бросаем ENOENT (симуляция отсутствия файла).
 * @param {Function} fn тело теста
 */
function withMocks(opts, fn) {
  fs.readFileSync = function (p, ...rest) {
    const sp = String(p);
    if (sp === '/proc/stat') {
      if (opts.stat === null || opts.stat === undefined) {
        const e = new Error('ENOENT: no such file or directory, open /proc/stat');
        e.code = 'ENOENT';
        throw e;
      }
      return opts.stat;
    }
    if (sp === '/proc/meminfo') {
      if (opts.meminfo === null || opts.meminfo === undefined) {
        const e = new Error('ENOENT: no such file or directory, open /proc/meminfo');
        e.code = 'ENOENT';
        throw e;
      }
      return opts.meminfo;
    }
    return REAL_READ_FILE_SYNC.call(fs, p, ...rest);
  };

  if (typeof opts.loadavg === 'function') {
    os.loadavg = opts.loadavg;
  }

  try {
    return fn();
  } finally {
    fs.readFileSync = REAL_READ_FILE_SYNC;
    os.loadavg = REAL_LOADAVG;
  }
}

/** Строка /proc/stat с заданными user/nice/system/idle/iowait... */
function statLine({ user = 0, nice = 0, system = 0, idle = 0, iowait = 0 } = {}) {
  return 'cpu  ' + [user, nice, system, idle, iowait, 0, 0, 0, 0, 0].join(' ') + '\n';
}

/** Минимальный валидный /proc/meminfo. */
function meminfo({ totalKb = 1000, freeKb = 250, availKb = 400 } = {}) {
  return (
    'MemTotal:       ' + totalKb + ' kB\n' +
    'MemFree:        ' + freeKb + ' kB\n' +
    'MemAvailable:   ' + availKb + ' kB\n'
  );
}

const REQUIRED_KEYS = ['cpu', 'ram', 'load', 'ts'];

/* ===========================================================================
 * 1. API-поверхность
 * ========================================================================= */

test('1. экспортирует публичный API (collect/latest/history/percentiles/snapshot/start/stop)', function () {
  for (const fn of ['collect', 'latest', 'history', 'percentiles', 'snapshot', 'start', 'stop', 'size']) {
    assert.strictEqual(typeof mc[fn], 'function', fn + ' должен быть функцией');
  }
  assert.strictEqual(typeof mc.RING_SIZE, 'number');
  assert.strictEqual(typeof mc.INTERVAL_MS, 'number');
});

/* ===========================================================================
 * 2. Схема снимка { cpu, ram, load, ts } и типы
 * ========================================================================= */

test('2. snapshot() содержит обязательные поля cpu/ram/load/ts с верными типами', function () {
  const s = mc.snapshot();
  for (const k of REQUIRED_KEYS) {
    assert.ok(k in s, 'нет обязательного поля ' + k);
  }
  assert.strictEqual(typeof s.cpu, 'number');
  assert.strictEqual(typeof s.ram, 'number');
  assert.strictEqual(typeof s.ts, 'number');
  assert.strictEqual(typeof s.load, 'object');
  assert.strictEqual(typeof s.load['1'], 'number');
  assert.strictEqual(typeof s.load['5'], 'number');
  assert.strictEqual(typeof s.load['15'], 'number');
});

test('3. snapshot() не пишет в ring-buffer (детерминированный, побочных эффектов нет)', function () {
  const before = mc.size();
  const a = mc.snapshot();
  const b = mc.snapshot();
  assert.strictEqual(mc.size(), before, 'snapshot() не должен менять размер буфера');
  for (const k of REQUIRED_KEYS) {
    assert.ok(k in a && k in b, 'схема должна повторяться между вызовами: ' + k);
  }
});

test('4. collect() кладёт снимок в буфер и возвращает его (size +1)', function () {
  const before = mc.size();
  const s = mc.collect();
  assert.strictEqual(mc.size(), before + 1, 'collect() должен добавить ровно 1 точку');
  for (const k of REQUIRED_KEYS) {
    assert.ok(k in s, 'collect() вернул снимок без поля ' + k);
  }
});

test('5. схема снимка детерминирована: обязательные ключи есть в каждом из 5 замеров', function () {
  for (let i = 0; i < 5; i += 1) {
    const s = mc.collect();
    for (const k of REQUIRED_KEYS) {
      assert.ok(k in s, 'итерация ' + i + ': пропало поле ' + k);
    }
  }
});

/* ===========================================================================
 * 6-8. CPU = 0.0 — валиден (не falsy-баг)
 * ========================================================================= */

test('6. CPU=0.0 валиден: постоянные счётчики дают ровно 0 (а не NaN/undefined)', function () {
  withMocks(
    { stat: statLine({ idle: 100 }), meminfo: meminfo(), loadavg: () => [0, 0, 0] },
    function () {
      mc.snapshot(); // прайминг дельты
      const s = mc.snapshot();
      assert.strictEqual(s.cpu, 0, 'CPU=0 должен остаться ровно 0');
      assert.ok(Number.isFinite(s.cpu), 'CPU=0 должен быть конечным числом');
      assert.strictEqual(typeof s.cpu, 'number');
    }
  );
});

test('7. CPU=0.0 не подменяется falsy-логикой (0 !== "ложный" -> не NaN)', function () {
  withMocks(
    { stat: statLine({ idle: 500 }), meminfo: meminfo(), loadavg: () => [0, 0, 0] },
    function () {
      mc.snapshot();
      const s = mc.snapshot();
      // Явная защита от бага вида `cpu = value || fallback`.
      assert.ok(s.cpu === 0, 'ожидали строгое 0, получили ' + s.cpu);
      assert.ok(!Number.isNaN(s.cpu), 'cpu не должен становиться NaN');
      assert.ok('cpu' in s, 'поле cpu не должно исчезать');
    }
  );
});

test('8. CPU в допустимом диапазоне 0..100 при полностью занятых счётчиках', function () {
  withMocks(
    { stat: statLine({ user: 60, system: 40, idle: 0 }), meminfo: meminfo(), loadavg: () => [0, 0, 0] },
    function () {
      const s = mc.snapshot();
      assert.ok(s.cpu >= 0 && s.cpu <= 100, 'cpu=' + s.cpu + ' вне 0..100');
      assert.ok(Number.isFinite(s.cpu), 'cpu должен быть конечным');
    }
  );
});

/* ===========================================================================
 * 9-11. Отсутствие данных RAM / /proc не роняет сборщик (null-safe)
 * ========================================================================= */

test('9. отсутствие /proc/meminfo не роняет collect(): ram остаётся числом, схема цела', function () {
  withMocks(
    { stat: statLine({ idle: 100 }), meminfo: null, loadavg: () => [1, 1, 1] },
    function () {
      let s;
      assert.doesNotThrow(function () { s = mc.collect(); }, 'collect() упал без /proc/meminfo');
      assert.strictEqual(typeof s.ram, 'number', 'ram должен остаться числом');
      assert.ok(Number.isFinite(s.ram), 'ram должен быть конечным при отсутствии meminfo');
      for (const k of REQUIRED_KEYS) {
        assert.ok(k in s, 'поле ' + k + ' потеряно при отсутствии meminfo');
      }
    }
  );
});

test('10. отсутствие /proc/meminfo не роняет snapshot(): ram=0, без исключений', function () {
  withMocks(
    { stat: statLine({ idle: 100 }), meminfo: null, loadavg: () => [0, 0, 0] },
    function () {
      let s;
      assert.doesNotThrow(function () { s = mc.snapshot(); });
      assert.strictEqual(s.ram, 0, 'при отсутствии meminfo ram должен деградировать в 0');
      assert.ok('ram' in s, 'поле ram не должно исчезать');
    }
  );
});

test('11. отсутствие /proc/stat не роняет сборщик: cpu деградирует в 0', function () {
  withMocks(
    { stat: null, meminfo: meminfo(), loadavg: () => [0, 0, 0] },
    function () {
      let s;
      assert.doesNotThrow(function () { s = mc.collect(); }, 'collect() упал без /proc/stat');
      assert.strictEqual(typeof s.cpu, 'number');
      assert.ok(Number.isFinite(s.cpu), 'cpu должен быть числом даже без /proc/stat');
      assert.ok(s.cpu >= 0 && s.cpu <= 100, 'cpu вне 0..100 без /proc/stat');
    }
  );
});

test('12. полное отсутствие /proc/stat и /proc/meminfo: снимок остаётся по схеме {cpu,ram,load,ts}', function () {
  withMocks(
    { stat: null, meminfo: null, loadavg: () => [0.1, 0.2, 0.3] },
    function () {
      let s;
      assert.doesNotThrow(function () { s = mc.collect(); });
      for (const k of REQUIRED_KEYS) {
        assert.ok(k in s, 'при полном отказе /proc пропало поле ' + k);
      }
      assert.ok(Number.isFinite(s.cpu), 'cpu не число');
      assert.ok(Number.isFinite(s.ram), 'ram не число');
      assert.ok(Number.isFinite(s.ts), 'ts не число');
    }
  );
});

/* ===========================================================================
 * 13-14. load average: схема и нулевые значения (не falsy)
 * ========================================================================= */

test('13. load содержит ключи 1/5/15 и берёт значения из os.loadavg()', function () {
  withMocks(
    { stat: statLine({ idle: 100 }), meminfo: meminfo(), loadavg: () => [1.5, 0.75, 0.25] },
    function () {
      const s = mc.snapshot();
      assert.strictEqual(s.load['1'], 1.5);
      assert.strictEqual(s.load['5'], 0.75);
      assert.strictEqual(s.load['15'], 0.25);
      assert.ok(Array.isArray(s.loadavg), 'loadavg должен быть массивом');
      assert.strictEqual(s.loadavg.length, 3);
    }
  );
});

test('14. нулевой load валиден: load={1:0,5:0,15:0} не подменяется на NaN', function () {
  withMocks(
    { stat: statLine({ idle: 100 }), meminfo: meminfo(), loadavg: () => [0, 0, 0] },
    function () {
      const s = mc.snapshot();
      assert.strictEqual(s.load['1'], 0);
      assert.strictEqual(s.load['5'], 0);
      assert.strictEqual(s.load['15'], 0);
      assert.ok(!Number.isNaN(s.load['1']), 'load 0 не должен становиться NaN');
    }
  );
});

/* ===========================================================================
 * 15-18. Буфер, история, перцентили, жизненный цикл
 * ========================================================================= */

test('15. history(n) возвращает последние n снимков по возрастанию времени', function () {
  mc.collect();
  mc.collect();
  mc.collect();
  const h2 = mc.history(2);
  assert.strictEqual(h2.length, 2, 'history(2) должен вернуть 2 точки');
  assert.ok(h2[0].ts <= h2[1].ts, 'история должна идти по возрастанию ts');
  assert.strictEqual(mc.history(0).length, 0, 'history(0) пуст');
  assert.ok(mc.history().length >= 3, 'history() без аргумента возвращает всё');
});

test('16. latest() возвращает последний collect()', function () {
  const s = mc.collect();
  const l = mc.latest();
  assert.ok(l, 'latest() не должен быть null после collect()');
  assert.strictEqual(l.ts, s.ts, 'latest().ts должен совпасть с последним снимком');
});

test('17. percentiles([50,95,99]) -> длина 3 и ось .cpu/.ram/.load с корректным диапазоном', function () {
  withMocks(
    { stat: statLine({ idle: 100 }), meminfo: meminfo(), loadavg: () => [0, 0, 0] },
    function () {
      // добавим точек с cpu=0, чтобы перцентили работали и с нулём (falsy-guard)
      for (let i = 0; i < 3; i += 1) mc.collect();
      const p = mc.percentiles([50, 95, 99]);
      assert.ok(Array.isArray(p), 'percentiles должен возвращать массив');
      assert.strictEqual(p.length, 3, 'длина результата = число перцентилей');
      assert.ok(Array.isArray(p.cpu) && p.cpu.length === 3, '.cpu ось');
      assert.ok(Array.isArray(p.ram) && p.ram.length === 3, '.ram ось');
      assert.ok(Array.isArray(p.load) && p.load.length === 3, '.load ось');
      for (const v of p.cpu) {
        assert.ok(v >= 0 && v <= 100, 'cpu-перцентиль ' + v + ' вне 0..100');
      }
      assert.strictEqual(p.cpu[0], 0, 'медиана CPU при нулях должна быть ровно 0');
    }
  );
});

test('18. RING_SIZE/INTERVAL_MS и start()/stop() жизненный цикл', function () {
  assert.strictEqual(mc.RING_SIZE, 720, 'ring-buffer на 720 точек');
  assert.strictEqual(mc.INTERVAL_MS, 5000, 'интервал автозамера 5s');
  assert.ok(mc.size() <= mc.RING_SIZE, 'size() не превышает RING_SIZE');

  const t1 = mc.start(20);
  assert.ok(t1 && typeof t1 === 'object', 'start() возвращает таймер');
  const t2 = mc.start(20);
  assert.strictEqual(t1, t2, 'повторный start() не создаёт второй таймер');
  mc.stop();
  const t3 = mc.start(20);
  assert.notStrictEqual(t3, t1, 'после stop() start() создаёт новый таймер');
  mc.stop();
});

/* ===========================================================================
 * 19-22. Дополнительные null-safe сценарии (мусор, частичные данные)
 * ========================================================================= */

test('19. мусорный /proc/stat и /proc/meminfo: сборщик не падает, cpu/ram конечны', function () {
  withMocks(
    { stat: 'garbage\n', meminfo: 'garbage\n', loadavg: () => [0, 0, 0] },
    function () {
      let s;
      assert.doesNotThrow(function () { s = mc.collect(); }, 'мусор в /proc уронил сборщик');
      assert.ok(Number.isFinite(s.cpu), 'cpu должен быть конечным при мусоре');
      assert.ok(Number.isFinite(s.ram), 'ram должен быть конечным при мусоре');
      for (const k of REQUIRED_KEYS) {
        assert.ok(k in s, 'при мусоре потеряно поле ' + k);
      }
    }
  );
});

test('20. meminfo без MemAvailable не роняет сборщик: ram finite (фолбэк на MemFree)', function () {
  withMocks(
    {
      stat: statLine({ idle: 100 }),
      meminfo: 'MemTotal:       1000 kB\nMemFree:         200 kB\n',
      loadavg: () => [0, 0, 0],
    },
    function () {
      let s;
      assert.doesNotThrow(function () { s = mc.snapshot(); });
      assert.ok(Number.isFinite(s.ram), 'ram должен быть конечным без MemAvailable');
      assert.strictEqual(s.mem.available, 200 * 1024, 'available должен упасть на MemFree');
      assert.strictEqual(s.mem.total, 1000 * 1024);
    }
  );
});

test('21. пустой /proc/meminfo: ram=0, схема не рушится', function () {
  withMocks(
    { stat: statLine({ idle: 100 }), meminfo: '', loadavg: () => [0, 0, 0] },
    function () {
      const s = mc.snapshot();
      assert.strictEqual(s.ram, 0, 'пустой meminfo -> ram 0');
      assert.ok(Number.isFinite(s.ram));
      assert.ok('ram' in s);
    }
  );
});

test('22. полностью простаивающий CPU (idle==total) даёт строго 0.0', function () {
  withMocks(
    { stat: statLine({ idle: 1000 }), meminfo: meminfo(), loadavg: () => [0, 0, 0] },
    function () {
      mc.snapshot();
      const s = mc.snapshot();
      assert.strictEqual(s.cpu, 0);
      assert.strictEqual(typeof s.cpu, 'number');
      assert.ok(!Number.isNaN(s.cpu));
    }
  );
});

/* ===========================================================================
 * Итог
 * ========================================================================= */

process.stdout.write(
  '\n' + (failed === 0 ? 'ALL PASSED' : 'FAILURES') +
  ' (' + passed + ' passed, ' + failed + ' failed)\n'
);

if (passed < 10) {
  process.stdout.write('КРИТЕРИЙ НАРУШЕН: нужно >= 10 кейсов, выполнено ' + passed + '\n');
  process.exitCode = 1;
}
if (failed > 0) process.exitCode = 1;
