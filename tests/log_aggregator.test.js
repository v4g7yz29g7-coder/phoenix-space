'use strict';

/**
 * tests/log_aggregator.test.js
 * ---------------------------------------------------------------------------
 * Тесты модуля `log_aggregator.js` (корень репозитория).
 *
 * Покрываемый публичный API:
 *   scan(dir)         — сбор *.log из boxes/ + phoenix/logs/
 *   byLevel(level)    — фильтр по уровню (info | warn | error)
 *   topErrors(n)      — топ-N ошибок, сортировка по count DESC
 *   tail(n)           — последние n записей (хронологически)
 *
 * Проверяемые гарантии:
 *   • данные читаются и из `boxes/**`, и из `phoenix/logs/**`;
 *   • дедупликация одинаковых сообщений в окне 300 s (5 min) схлопывает их
 *     в одну запись (count/duplicates), а разрыв > 300 s — НЕ схлопывает;
 *   • файлы > 50 МБ (ротация) полностью отсутствуют в выдаче;
 *   • topErrors(5) отсортирован по count DESC;
 *   • tail(n) возвращает ровно последние n записей;
 *   • несуществующие/пустые каталоги → [] без исключений.
 *
 * Запуск:
 *   node tests/runner.js tests/log_aggregator.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { describe, it, after, assert } = require('./runner.js');

// ВАЖНО: тестируем именно корневой log_aggregator.js.
const la = require('../log_aggregator.js');

/* ------------------------------------------------------------------------- *
 * Фикстуры
 * ------------------------------------------------------------------------- */

const BASE = 1700000000000; // 2023-11-14T22:13:20Z — детерминированное время
const ROOT = path.join(os.tmpdir(), `la_test_${process.pid}_${Date.now()}`);
const BOXES = path.join(ROOT, 'boxes');
const PHOENIX = path.join(ROOT, 'phoenix', 'logs');
const ALPHA = path.join(BOXES, 'agent_alpha', 'logs');
const BETA = path.join(BOXES, 'agent_beta');
const GAMMA = path.join(BOXES, 'agent_gamma', 'logs');
const EMPTY = path.join(ROOT, 'empty');

const t = (offset) => BASE + offset; // BASE + смещение в ms
const jl = (obj) => JSON.stringify(obj);
const NOOP = () => {};
const WARN_OPTS = { warn: NOOP };
const OPTS = { dir: ROOT, warn: NOOP };

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map(jl).join('\n') + '\n');
}

function buildFixtures() {
  for (const dir of [ALPHA, BETA, GAMMA, PHOENIX, EMPTY]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // boxes/agent_alpha/logs/agent_alpha.log -----------------------------------
  writeJsonl(path.join(ALPHA, 'agent_alpha.log'), [
    { ts: t(0), level: 'error', msg: 'DB timeout' },
    { ts: t(1000), level: 'error', msg: 'DB timeout' },
    { ts: t(2000), level: 'error', msg: 'DB timeout' }, // три подряд в окне 300 s
    { ts: t(5000), level: 'info', msg: 'boot complete' },
    { ts: t(10000), level: 'error', msg: 'Cache miss storm' },
    { ts: t(11000), level: 'error', msg: 'Cache miss storm' },
    { ts: t(20000), level: 'error', msg: 'Timeout connecting upstream' },
    { ts: t(21000), level: 'error', msg: 'Timeout connecting upstream' },
    { ts: t(22000), level: 'error', msg: 'Timeout connecting upstream' },
    { ts: t(23000), level: 'error', msg: 'Timeout connecting upstream' },
    { ts: t(24000), level: 'error', msg: 'Timeout connecting upstream' },
    { ts: t(30000), level: 'warn', msg: 'high memory usage' },
    { ts: t(590000), level: 'warn', msg: 'high memory usage' }, // разрыв 560 s > 300 s
  ]);

  // boxes/agent_beta/run.log -------------------------------------------------
  writeJsonl(path.join(BETA, 'run.log'), [
    { ts: t(32000), level: 'info', msg: 'cron tick' },
    { ts: t(45000), level: 'error', msg: 'Rare failure' },
  ]);

  // boxes/agent_gamma/logs/parse.log (текстовый формат) ----------------------
  fs.writeFileSync(
    path.join(GAMMA, 'parse.log'),
    '2023-11-14T22:13:25Z WARN gamma disk almost full\n'
  );

  // phoenix/logs/phoenix.log -------------------------------------------------
  writeJsonl(path.join(PHOENIX, 'phoenix.log'), [
    { ts: t(1500), level: 'error', msg: 'Null pointer exception' },
    { ts: t(2500), level: 'error', msg: 'Null pointer exception' },
    { ts: t(31000), level: 'info', msg: 'request served' },
    { ts: t(400000), level: 'error', msg: 'DB timeout' }, // разрыв 398 s > 300 s → новая группа
    { ts: t(600000), level: 'info', msg: 'shutdown complete' },
  ]);

  // phoenix/logs/huge.log — 51 МБ (разреженный), должен быть пропущен --------
  const huge = path.join(PHOENIX, 'huge.log');
  fs.writeFileSync(huge, '');
  fs.truncateSync(huge, 51 * 1024 * 1024);
}

buildFixtures();

after(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
});

/* ------------------------------------------------------------------------- *
 * Тесты
 * ------------------------------------------------------------------------- */

describe('log_aggregator (scan / byLevel / topErrors / tail)', () => {
  describe('scan(dir) по boxes + phoenix', () => {
    it('читает *.log и из boxes/, и из phoenix/logs/', () => {
      const recs = la.scan(ROOT, WARN_OPTS);
      assert.ok(Array.isArray(recs));
      assert.ok(recs.length > 0, 'ожидались записи');

      const sources = new Set(recs.map((r) => r.source));
      for (const s of ['agent_alpha', 'phoenix', 'run', 'parse']) {
        assert.ok(sources.has(s), `нет источника ${s}`);
      }

      assert.ok(recs.some((r) => /[\\/]boxes[\\/]/.test(r.file)), 'нет записей из boxes/');
      assert.ok(
        recs.some((r) => /[\\/]phoenix[\\/]logs[\\/]/.test(r.file)),
        'нет записей из phoenix/logs/'
      );
    });

    it('возвращает записи, отсортированные по ts ASC', () => {
      const recs = la.scan(ROOT, WARN_OPTS);
      for (let i = 1; i < recs.length; i += 1) {
        assert.ok(recs[i].ts >= recs[i - 1].ts, `нарушен порядок на индексе ${i}`);
      }
    });

    it('отдаёт документированную структуру записи', () => {
      const recs = la.scan(ROOT, WARN_OPTS);
      for (const r of recs) {
        assert.strictEqual(typeof r.ts, 'number');
        assert.ok(['info', 'warn', 'error'].includes(r.level), `плохой уровень ${r.level}`);
        assert.strictEqual(typeof r.source, 'string');
        assert.strictEqual(typeof r.msg, 'string');
        assert.strictEqual(typeof r.count, 'number');
        assert.strictEqual(r.duplicates, r.count - 1);
        assert.strictEqual(typeof r.firstTs, 'number');
        assert.strictEqual(typeof r.lastTs, 'number');
      }
    });

    it('после дедупа содержит ровно 13 записей', () => {
      assert.strictEqual(la.scan(ROOT, WARN_OPTS).length, 13);
    });

    it('принимает массив каталогов (boxes + phoenix)', () => {
      const recs = la.scan([BOXES, PHOENIX], WARN_OPTS);
      assert.strictEqual(recs.length, 13);
    });

    it('не считает файлы дважды при повторном каталоге', () => {
      const once = la.scan(ROOT, WARN_OPTS).length;
      const twice = la.scan([ROOT, ROOT], WARN_OPTS).length;
      assert.strictEqual(twice, once);
    });

    it('возвращает [] для несуществующего каталога (без исключения)', () => {
      assert.deepStrictEqual(la.scan(path.join(ROOT, 'nope'), WARN_OPTS), []);
    });

    it('возвращает [] для пустого каталога', () => {
      assert.deepStrictEqual(la.scan(EMPTY, WARN_OPTS), []);
    });
  });

  describe('дедупликация — окно 300 s (5 min)', () => {
    it('схлопывает дубли в пределах 300 s: count=3, duplicates=2', () => {
      const groups = la
        .scan(ROOT, WARN_OPTS)
        .filter((r) => r.msg === 'DB timeout' && r.ts === t(2000));
      assert.strictEqual(groups.length, 1, 'ожидалась одна схлопнутая группа');
      assert.strictEqual(groups[0].count, 3);
      assert.strictEqual(groups[0].duplicates, 2);
      assert.strictEqual(groups[0].firstTs, t(0));
      assert.strictEqual(groups[0].lastTs, t(2000));
    });

    it('НЕ схлопывает то же сообщение при разрыве > 300 s', () => {
      const groups = la.scan(ROOT, WARN_OPTS).filter((r) => r.msg === 'DB timeout');
      assert.strictEqual(groups.length, 2, 'ожидались две отдельные группы');
      const counts = groups.map((g) => g.count).sort((a, b) => a - b);
      assert.deepStrictEqual(counts, [1, 3]);
    });

    it('далёкий дубль попадает в отдельную группу (phoenix @ +400 s)', () => {
      const far = la
        .scan(ROOT, WARN_OPTS)
        .find((r) => r.msg === 'DB timeout' && r.ts === t(400000));
      assert.ok(far, 'ожидалась отдельная группа на +400 s');
      assert.strictEqual(far.count, 1);
      assert.strictEqual(far.source, 'phoenix');
    });

    it('дубли одного сообщения с разрывом 560 s не сливаются', () => {
      const groups = la
        .scan(ROOT, WARN_OPTS)
        .filter((r) => r.msg === 'high memory usage');
      assert.strictEqual(groups.length, 2);
      assert.ok(groups.every((g) => g.count === 1));
    });
  });

  describe('byLevel(level)', () => {
    it("byLevel('error') возвращает только error", () => {
      const recs = la.byLevel('error', OPTS);
      assert.ok(recs.length > 0);
      assert.ok(recs.every((r) => r.level === 'error'));
    });

    it("byLevel('warn') возвращает warn, включая строку из текстового лога", () => {
      const recs = la.byLevel('warn', OPTS);
      assert.ok(recs.every((r) => r.level === 'warn'));
      assert.ok(recs.some((r) => r.msg === 'gamma disk almost full'));
      assert.strictEqual(recs.filter((r) => r.msg === 'high memory usage').length, 2);
    });

    it("byLevel('info') возвращает только info", () => {
      const recs = la.byLevel('info', OPTS);
      assert.ok(recs.length > 0);
      assert.ok(recs.every((r) => r.level === 'info'));
    });

    it('нормализует алиасы уровня (FATAL/WARNING, регистр)', () => {
      const err = la.byLevel('FATAL', OPTS);
      const warn = la.byLevel('WARNING', OPTS);
      assert.strictEqual(err.length, la.byLevel('error', OPTS).length);
      assert.ok(err.every((r) => r.level === 'error'));
      assert.strictEqual(warn.length, la.byLevel('warn', OPTS).length);
      assert.strictEqual(la.normalizeLevel('crit'), 'error');
      assert.strictEqual(la.normalizeLevel('notice'), 'info');
    });

    it('уровни в сумме дают все дедуплицированные записи', () => {
      const total = la.scan(ROOT, WARN_OPTS).length;
      const sum = ['info', 'warn', 'error'].reduce(
        (acc, lvl) => acc + la.byLevel(lvl, OPTS).length,
        0
      );
      assert.strictEqual(sum, total);
    });
  });

  describe('topErrors(n)', () => {
    it('topErrors(5) отдаёт 5 элементов, отсортированных по count DESC', () => {
      const top = la.topErrors(5, OPTS);
      assert.strictEqual(top.length, 5);
      for (let i = 1; i < top.length; i += 1) {
        assert.ok(top[i - 1].count >= top[i].count, `не desc на индексе ${i}`);
      }
      assert.ok(top.every((e) => e.level === 'error'));
    });

    it('topErrors(5) содержит ожидаемых лидеров с точными count', () => {
      const top = la.topErrors(5, OPTS);
      assert.strictEqual(top[0].msg, 'Timeout connecting upstream');
      assert.strictEqual(top[0].count, 5);
      assert.strictEqual(top[1].msg, 'DB timeout');
      assert.strictEqual(top[1].count, 4); // 3 (alpha) + 1 (phoenix)
      assert.strictEqual(top[4].count, 1);
    });

    it('учитывает лимит (topErrors(2) → ровно 2)', () => {
      const top = la.topErrors(2, OPTS);
      assert.strictEqual(top.length, 2);
      assert.ok(top[0].count >= top[1].count);
    });
  });

  describe('tail(n)', () => {
    it('возвращает последние n записей хронологически', () => {
      const all = la.scan(ROOT, WARN_OPTS);
      const last3 = la.tail(3, OPTS);
      assert.strictEqual(last3.length, 3);
      assert.deepStrictEqual(
        last3.map((r) => r.ts),
        all.slice(-3).map((r) => r.ts)
      );
      for (let i = 1; i < last3.length; i += 1) {
        assert.ok(last3[i].ts >= last3[i - 1].ts);
      }
    });

    it('самая свежая запись — `shutdown complete`', () => {
      const last1 = la.tail(1, OPTS);
      assert.strictEqual(last1.length, 1);
      assert.strictEqual(last1[0].msg, 'shutdown complete');
      assert.strictEqual(last1[0].ts, t(600000));
    });

    it('tail(n) не превышает число доступных записей', () => {
      const all = la.scan(ROOT, WARN_OPTS);
      assert.strictEqual(la.tail(1000, OPTS).length, all.length);
    });
  });

  describe('пропуск файлов > 50 МБ (ротация)', () => {
    it('51 МБ файл отсутствует в выдаче scan()', () => {
      const recs = la.scan(ROOT, WARN_OPTS);
      assert.ok(!recs.some((r) => /huge/.test(r.file) || r.source === 'huge'));
    });

    it('51 МБ файл отсутствует в byLevel/topErrors/tail', () => {
      assert.ok(!la.byLevel('info', OPTS).some((r) => /huge/.test(r.file)));
      assert.ok(!la.byLevel('error', OPTS).some((r) => /huge/.test(r.file)));
      assert.ok(!la.tail(1000, OPTS).some((r) => /huge/.test(r.file)));
      assert.ok(!la.topErrors(50, OPTS).some((e) => /huge/i.test(e.msg)));
    });

    it('listLogFiles пропускает > 50 МБ и вызывает warn', () => {
      const warnings = [];
      const files = la.listLogFiles(PHOENIX, { warn: (f, s) => warnings.push({ f, s }) });
      assert.ok(!files.some((f) => /huge/.test(f)), 'huge.log не должен попасть в список');
      assert.ok(
        warnings.some((w) => /huge/.test(w.f) && w.s > la.MAX_FILE_SIZE),
        'ожидался warn о большом файле'
      );
    });

    it('константы: MAX_FILE_SIZE = 50 МБ, DEDUP_WINDOW_MS = 300 s', () => {
      assert.strictEqual(la.MAX_FILE_SIZE, 50 * 1024 * 1024);
      assert.strictEqual(la.DEDUP_WINDOW_MS, 300000);
    });
  });
});
