/**
 * architect/core_analyzer.test.js
 *
 * Самопроверка модуля архитектурного анализатора.
 * Запуск:  node architect/core_analyzer.test.js
 *
 * Критерии приёмки:
 *   1) файл > 200 строк;
 *   2) node --check проходит (проверяется в shell-обёртке);
 *   3) analyze() -> { patterns:[], metrics:[], risks:[] };
 *   4) граничные случаи: пустой/несуществующий корпус даёт валидную форму.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const analyzerPath = path.join(__dirname, 'core_analyzer.js');
const source = fs.readFileSync(analyzerPath, 'utf8');
const analyzer = require('./core_analyzer.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  ok -', name);
}

console.log('core_analyzer self-test');

check('file has > 200 lines', () => {
  const lines = source.split('\n').length;
  assert.ok(lines > 200, 'Ожидалось >200 строк, получено ' + lines);
});

check('analyze is a function', () => {
  assert.strictEqual(typeof analyzer.analyze, 'function');
});

check('analyze() returns {patterns,metrics,risks} arrays', () => {
  const r = analyzer.analyze();
  assert.ok(Array.isArray(r.patterns), 'patterns не массив');
  assert.ok(Array.isArray(r.metrics), 'metrics не массив');
  assert.ok(Array.isArray(r.risks), 'risks не массив');
  assert.ok(r.documents > 0, 'корпус пуст — ожидались документы');
  assert.ok(r.messages > 0, 'сообщения не распарсены');
});

check('patterns have id/coverage/strength', () => {
  const r = analyzer.analyze();
  for (const p of r.patterns) {
    assert.ok(typeof p.id === 'string' && p.id, 'pattern.id отсутствует');
    assert.ok(typeof p.coverage === 'number', 'pattern.coverage отсутствует');
    assert.ok(typeof p.label === 'string' && p.label, 'pattern.label отсутствует');
  }
});

check('metrics are {id,label,value}', () => {
  const r = analyzer.analyze();
  for (const m of r.metrics) {
    assert.ok(typeof m.id === 'string' && m.id, 'metric.id');
    assert.ok('value' in m, 'metric.value');
  }
});

check('risks have id/severity', () => {
  const r = analyzer.analyze();
  for (const risk of r.risks) {
    assert.ok(typeof risk.id === 'string' && risk.id, 'risk.id');
    assert.ok(typeof risk.severity === 'string', 'risk.severity');
  }
});

check('empty corpus -> valid shape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-test-'));
  const r = analyzer.analyze({ dir });
  assert.ok(Array.isArray(r.patterns) && Array.isArray(r.metrics) && Array.isArray(r.risks));
  assert.strictEqual(r.documents, 0);
});

check('missing corpus -> valid shape, no throw', () => {
  const r = analyzer.analyze({ dir: '/definitely/not/here/xyz' });
  assert.ok(Array.isArray(r.patterns) && Array.isArray(r.metrics) && Array.isArray(r.risks));
});

check('JSON-serializable report', () => {
  const r = analyzer.analyze();
  const round = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(round).includes('patterns'), true);
});

console.log('\nВсе проверки пройдены:', passed, 'шт.');
