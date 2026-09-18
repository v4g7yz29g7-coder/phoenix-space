#!/usr/bin/env node
'use strict';

/**
 * evolution/dendrologist_rings.test.js
 * ============================================================================
 * Смоук-тесты для модуля «кольца ДНК» (dendrologist_rings).
 * Запуск:  node evolution/dendrologist_rings.test.js
 *
 * Проверяем:
 *   1) публичный контракт rings(agentId) / peaks(agentId);
 *   2) детерминированность по agentId;
 *   3) валидацию входных данных;
 *   4) иммутабельность возвращаемых колец;
 *   5) вспомогательный API (summary/grow/latestDna/depth/epochs/reset).
 * ============================================================================
 */

const assert = require('assert');
const rings = require('./dendrologist_rings.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  - ' + name);
  } catch (err) {
    console.error('  FAIL - ' + name);
    console.error('         ' + (err && err.message ? err.message : err));
    process.exitCode = 1;
  }
}

console.log('dendrologist_rings.test.js');

/* --- 1. Контракт rings() ------------------------------------------------- */
test('rings() возвращает корректный контракт', () => {
  const r = rings.rings('test-agent');
  assert.strictEqual(r.ok, true, 'ok должен быть true');
  assert.strictEqual(r.agentId, 'test-agent');
  assert.ok(Array.isArray(r.rings), 'rings должен быть массивом');
  assert.ok(r.rings.length >= 6, 'должно быть минимум 6 колец');
  assert.strictEqual(typeof r.avgFitness, 'number');
  assert.strictEqual(typeof r.totalMutations, 'number');
  assert.strictEqual(typeof r.totalWisdom, 'number');
  assert.strictEqual(r.age, r.rings.length);
});

test('каждое кольцо имеет обязательные поля', () => {
  const r = rings.rings('test-agent');
  for (const ring of r.rings) {
    assert.strictEqual(typeof ring.index, 'number');
    assert.strictEqual(typeof ring.width, 'number');
    assert.strictEqual(typeof ring.fitness, 'number');
    assert.ok(ring.dna && typeof ring.dna === 'object', 'есть снимок ДНК');
  }
});

/* --- 2. Контракт peaks() ------------------------------------------------- */
test('peaks() возвращает корректный контракт', () => {
  const p = rings.peaks('test-agent');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.agentId, 'test-agent');
  assert.ok(Array.isArray(p.peaks));
  assert.ok(p.peaks.length >= 1, 'должен быть хотя бы один пик');
  assert.ok(p.best && typeof p.best.fitness === 'number', 'best определён');
});

test('пики отсортированы по убыванию fitness', () => {
  const p = rings.peaks('test-agent');
  for (let i = 1; i < p.peaks.length; i++) {
    assert.ok(p.peaks[i - 1].fitness >= p.peaks[i].fitness, 'порядок пиков');
  }
});

/* --- 3. Детерминированность --------------------------------------------- */
test('результат детерминирован по agentId', () => {
  const a = rings.rings('stable-id');
  const b = rings.rings('stable-id');
  assert.strictEqual(JSON.stringify(a.rings), JSON.stringify(b.rings));
});

test('разные агенты дают разные кольца', () => {
  const a = rings.rings('agent-one');
  const b = rings.rings('agent-two');
  assert.notStrictEqual(JSON.stringify(a.rings), JSON.stringify(b.rings));
});

/* --- 4. Валидация входа -------------------------------------------------- */
test('пустой agentId отвергается', () => {
  assert.throws(() => rings.rings(''), TypeError);
  assert.throws(() => rings.peaks(''), TypeError);
  assert.throws(() => rings.rings(null), TypeError);
});

/* --- 5. Иммутабельность -------------------------------------------------- */
test('снимок ДНК заморожен (иммутабелен)', () => {
  const r = rings.rings('frozen-id');
  const dna = r.rings[0].dna;
  assert.ok(Object.isFrozen(dna), 'ДНК должна быть Object.freeze');
});

test('мутация возвращённого кольца не влияет на стор', () => {
  const id = 'mutation-guard-' + Date.now();
  const first = rings.rings(id);
  const widthBefore = first.rings[0].width;
  try { first.rings[0].width = -999; } catch (e) { /* frozen */ }
  const again = rings.rings(id);
  assert.strictEqual(again.rings[0].width, widthBefore);
});

/* --- 6. Вспомогательный API --------------------------------------------- */
test('summary() / depth() / epochs() согласованы', () => {
  if (typeof rings.summary === 'function') {
    const s = rings.summary('helper-id');
    assert.strictEqual(s.ok, true);
  }
  const d = rings.depth('helper-id');
  assert.ok(Number.isFinite(d) && d >= 6, 'глубина/возраст');
  const epochs = rings.epochs('helper-id');
  assert.ok(Array.isArray(epochs) && epochs.length === d, 'эпох столько же, сколько колец');
});

test('grow() наращивает новое кольцо', () => {
  if (typeof rings.grow !== 'function') return;
  const id = 'grow-id-' + Date.now();
  const before = rings.depth(id);
  rings.grow(id, { fitness: 0.99, width: 3 });
  const after = rings.depth(id);
  assert.strictEqual(after, before + 1, 'кольцо добавлено');
});

test('reset() очищает состояние агента', () => {
  if (typeof rings.reset !== 'function') return;
  const id = 'reset-id-' + Date.now();
  rings.rings(id);
  rings.reset(id);
  const fresh = rings.rings(id);
  assert.ok(fresh.rings.length >= 6, 'состояние пересоздано детерминированно');
});

/* ------------------------------------------------------------------------ */
console.log('\n' + passed + ' тест(ов) пройдено.');
if (process.exitCode) {
  console.error('Некоторые тесты не прошли.');
} else {
  console.log('Все тесты dendrologist_rings пройдены.');
}
