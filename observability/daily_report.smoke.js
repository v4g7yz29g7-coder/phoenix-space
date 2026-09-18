'use strict';

/**
 * observability/daily_report.smoke.js
 * ------------------------------------------------------------------
 * Smoke-тест модуля ежедневного отчёта.
 *
 * Проверяет критерии задачи:
 *   - файл daily_report.js содержит > 180 строк;
 *   - экспортирует API generate();
 *   - generate() возвращает корректный отчёт;
 *   - format()/toJson()/write() работают;
 *   - отчёт всегда формируется даже без источника событий.
 *
 * Запуск: node observability/daily_report.smoke.js
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MODULE_PATH = path.join(__dirname, 'daily_report.js');
const mod = require('./daily_report');

let failures = 0;

function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures += 1;
  const suffix = extra === undefined ? '' : ' :: ' + JSON.stringify(extra);
  process.stdout.write((ok ? 'PASS' : 'FAIL') + ' - ' + name + suffix + '\n');
  return ok;
}

(async function main() {
  // 1. Критерий размера: > 180 строк.
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  const lineCount = src.split('\n').length;
  check('file exists', fs.existsSync(MODULE_PATH));
  check('lines > 180', lineCount > 180, lineCount);

  // 2. Критерий API: generate() — функция.
  check('generate exported', typeof mod.generate === 'function');
  check('generate.format', typeof mod.generate.format === 'function');
  check('module.format', typeof mod.format === 'function');
  check('module.toJson', typeof mod.toJson === 'function');
  check('module.write', typeof mod.write === 'function');

  // 3. Функциональность: отчёт по inline-событиям.
  const now = Date.now();
  const events = [
    { timestamp: new Date(now - 1000).toISOString(), level: 'info', endpoint: '/api/users', latencyMs: 120, count: 100 },
    { timestamp: new Date(now - 2000).toISOString(), level: 'info', endpoint: '/api/orders', latencyMs: 250, count: 50 },
    { timestamp: new Date(now - 3000).toISOString(), level: 'error', endpoint: '/api/orders', latencyMs: 900, count: 5, message: 'timeout' },
    { timestamp: new Date(now - 4000).toISOString(), level: 'warn', endpoint: '/api/users', latencyMs: 300, count: 2 },
  ];

  const report = await mod.generate({ events });
  check('report has summary', report && typeof report.summary === 'object');
  check('summary.totals.requests', report.summary.totals.requests === 157, report.summary.totals.requests);
  check('summary.totals.errors', report.summary.totals.errors === 1, report.summary.totals.errors);
  check('availability in [0,1]', report.summary.availability >= 0 && report.summary.availability <= 1, report.summary.availability);
  check('latency p95 numeric', Number.isFinite(report.summary.latency.p95), report.summary.latency.p95);
  check('slo checks present', report.slo && Array.isArray(report.slo.checks) && report.slo.checks.length >= 2);
  check('slo status boolean', typeof report.slo.passed === 'boolean', report.slo.passed);
  check('endpoints breakdown', Array.isArray(report.summary.endpoints) && report.summary.endpoints.length === 2, report.summary.endpoints.length);
  check('topErrors sorted', Array.isArray(report.summary.topErrors) && report.summary.topErrors[0].message === 'timeout');
  check('health score in [0,100]', report.health && report.health.score >= 0 && report.health.score <= 100, report.health && report.health.score);
  check('markdown embedded', typeof report.markdown === 'string' && report.markdown.includes('# '));

  // 4. format()/toJson().
  const md = mod.format(report);
  check('format returns markdown', typeof md === 'string' && md.split('\n').length > 5, md.split('\n').length);
  const json = mod.toJson(report);
  const reparsed = JSON.parse(json);
  check('toJson valid', reparsed && reparsed.date === report.date);

  // 5. Отчёт формируется без событий (пустой источник).
  const empty = await mod.generate({ events: [] });
  check('empty report still generated', empty && typeof empty.markdown === 'string');
  check('empty totals zero', empty.summary.totals.events === 0);

  // 6. write() сохраняет файл.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-'));
  const written = await mod.write(dir, report);
  check('write returns path', typeof written === 'string' && fs.existsSync(written));
  const writtenText = fs.readFileSync(written, 'utf8');
  check('written file non-empty', writtenText.length > 0);

  process.stdout.write('\n' + (failures === 0 ? 'SMOKE: ALL PASS' : 'SMOKE: FAILURES=' + failures) + '\n');
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  process.stderr.write('SMOKE CRASH: ' + (err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
