'use strict';

/**
 * tests/polyphony.test.js — тесты полифонии голосов (POLY-1)
 * ============================================================================
 * Dependency-free: только встроенные модули. Проверяет чистый модуль
 * ../polyphony.js в изоляции — без запуска гонки и без сети.
 *
 * Запуск:  node tests/polyphony.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../polyphony.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name + '\n      ' + (e && e.message));
  }
}

function captureError(fn) {
  const original = console.error;
  const seen = [];
  console.error = (...args) => { seen.push(args.join(' ')); };
  try {
    return { value: fn(), seen };
  } finally {
    console.error = original;
  }
}

console.log('\n=== polyphony.test.js ===');

// --- normalizeVoice ---------------------------------------------------------
console.log('normalizeVoice');
test('строка обрезается', () => {
  assert.deepStrictEqual(P.normalizeVoice('  привет  '), { prompt: 'привет', role: '', style: '' });
});
test('пустая строка → null', () => {
  assert.strictEqual(P.normalizeVoice('   '), null);
});
test('объект с prompt', () => {
  assert.deepStrictEqual(P.normalizeVoice({ prompt: 'голос' }), { prompt: 'голос', role: '', style: '' });
});
test('алиасы task/text', () => {
  assert.strictEqual(P.normalizeVoice({ task: 'A' }).prompt, 'A');
  assert.strictEqual(P.normalizeVoice({ text: 'B' }).prompt, 'B');
});
test('role и style сохраняются', () => {
  const v = P.normalizeVoice({ prompt: 'p', role: ' Критик ', style: 'строгий' });
  assert.deepStrictEqual(v, { prompt: 'p', role: 'Критик', style: 'строгий' });
});
test('неплоский объект → null', () => {
  assert.strictEqual(P.normalizeVoice(null), null);
  assert.strictEqual(P.normalizeVoice([]), null);
  assert.strictEqual(P.normalizeVoice(42), null);
  assert.strictEqual(P.normalizeVoice({}), null);
});

// --- parseVoices ------------------------------------------------------------
console.log('parseVoices');
test('null / пустое → {}', () => {
  assert.deepStrictEqual(P.parseVoices(null), {});
  assert.deepStrictEqual(P.parseVoices(''), {});
  assert.deepStrictEqual(P.parseVoices('   '), {});
});
test('валидный JSON-строкой', () => {
  const v = P.parseVoices('{"agent_4":"x","agent_5":{"prompt":"y"}}');
  assert.strictEqual(v.agent_4.prompt, 'x');
  assert.strictEqual(v.agent_5.prompt, 'y');
});
test('принимает уже готовый объект', () => {
  const v = P.parseVoices({ agent_6: 'z' });
  assert.strictEqual(v.agent_6.prompt, 'z');
});
test('битый JSON → {} + предупреждение', () => {
  const { value, seen } = captureError(() => P.parseVoices('{oops'));
  assert.deepStrictEqual(value, {});
  assert.ok(seen.some((s) => s.indexOf('некорректный JSON') !== -1), 'ждали предупреждение');
});
test('массив → {}', () => {
  assert.deepStrictEqual(P.parseVoices('[1,2,3]'), {});
});
test('__proto__ игнорируется', () => {
  const v = P.parseVoices('{"__proto__":"evil","agent_1":"ok"}');
  assert.strictEqual(v.agent_1.prompt, 'ok');
  assert.ok(!Object.prototype.hasOwnProperty.call(v, '__proto__'));
});

// --- loadVoicesFile ---------------------------------------------------------
console.log('loadVoicesFile');
test('несуществующий файл → {}', () => {
  assert.deepStrictEqual(P.loadVoicesFile('/no/such/file_12345.json'), {});
});
test('валидный файл читается', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-'));
  const file = path.join(dir, 'voices.json');
  fs.writeFileSync(file, '{"agent_7":{"prompt":"из файла","role":"Документатор"}}');
  try {
    const v = P.loadVoicesFile(file);
    assert.strictEqual(v.agent_7.prompt, 'из файла');
    assert.strictEqual(v.agent_7.role, 'Документатор');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- composeVoice -----------------------------------------------------------
console.log('composeVoice');
test('голая строка без изменений', () => {
  assert.strictEqual(P.composeVoice('agent_1', { prompt: 'делай', role: '', style: '' }), 'делай');
});
test('role/style добавляются как префикс', () => {
  const out = P.composeVoice('agent_2', { prompt: 'делай', role: 'Критик', style: 'строгий' });
  assert.ok(out.startsWith('[ГОЛОС agent_2: Критик]\n[СТИЛЬ: строгий]\nделай'));
});
test('пустой голос → null', () => {
  assert.strictEqual(P.composeVoice('agent_1', null), null);
  assert.strictEqual(P.composeVoice('agent_1', { prompt: '' }), null);
});

// --- resolveVoices ----------------------------------------------------------
console.log('resolveVoices');
test('каждому боксу — своя партия', () => {
  const voices = P.parseVoices({ agent_1: 'один', agent_2: 'два' });
  const tasks = P.resolveVoices(['agent_1', 'agent_2'], voices);
  assert.strictEqual(tasks.agent_1, 'один');
  assert.strictEqual(tasks.agent_2, 'два');
});
test('"*" — голос по умолчанию', () => {
  const voices = P.parseVoices({ '*': 'общий', agent_1: 'свой' });
  const tasks = P.resolveVoices(['agent_1', 'agent_2'], voices);
  assert.strictEqual(tasks.agent_1, 'свой');
  assert.strictEqual(tasks.agent_2, 'общий');
});
test('бокс без голоса отсутствует в результате', () => {
  const voices = P.parseVoices({ agent_1: 'один' });
  const tasks = P.resolveVoices(['agent_1', 'agent_9'], voices);
  assert.ok(!Object.prototype.hasOwnProperty.call(tasks, 'agent_9'));
});

// --- assignFromPool ---------------------------------------------------------
console.log('assignFromPool');
test('берёт только pending и по одному на бокс', () => {
  const pool = { tasks: [
    { id: 'T1', prompt: 'первая', status: 'pending' },
    { id: 'T2', prompt: 'вторая', status: 'completed' },
    { id: 'T3', prompt: 'третья', status: 'pending' },
  ] };
  const { tasks, used } = P.assignFromPool(['agent_1', 'agent_2', 'agent_3'], pool);
  assert.deepStrictEqual(Object.keys(tasks), ['agent_1', 'agent_2']);
  assert.strictEqual(tasks.agent_1, 'первая');
  assert.strictEqual(tasks.agent_2, 'третья');
  assert.strictEqual(used.length, 2);
  assert.strictEqual(used[0].id, 'T1');
});
test('пустой пул → пусто', () => {
  assert.deepStrictEqual(P.assignFromPool(['agent_1'], { tasks: [] }).tasks, {});
  assert.deepStrictEqual(P.assignFromPool(['agent_1'], null).tasks, {});
});

// --- buildVoices ------------------------------------------------------------
console.log('buildVoices');
test('env приоритетнее файла', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-'));
  const file = path.join(dir, 'v.json');
  fs.writeFileSync(file, '{"agent_1":"из файла"}');
  try {
    const r = P.buildVoices({ raw: '{"agent_1":"из env"}', file, boxes: ['agent_1'] });
    assert.strictEqual(r.tasks.agent_1, 'из env');
    assert.strictEqual(r.source, 'env:RACE_TASKS_BY_BOX');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('только файл → source=file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-'));
  const file = path.join(dir, 'v.json');
  fs.writeFileSync(file, '{"agent_1":"из файла"}');
  try {
    const r = P.buildVoices({ file, boxes: ['agent_1'] });
    assert.strictEqual(r.source, 'file:RACE_VOICES_FILE');
    assert.strictEqual(r.tasks.agent_1, 'из файла');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('нет env/файла, но есть пул → pool', () => {
  const pool = { tasks: [{ id: 'X', prompt: 'из пула', status: 'pending' }] };
  const r = P.buildVoices({ boxes: ['agent_1'], pool });
  assert.strictEqual(r.source, 'pool:tasks_night_pool.json');
  assert.strictEqual(r.tasks.agent_1, 'из пула');
});
test('ничего нет → source=none, tasks={}', () => {
  const r = P.buildVoices({ boxes: ['agent_1'] });
  assert.strictEqual(r.source, 'none');
  assert.deepStrictEqual(r.tasks, {});
});
test('wildcard-флаг выставляется', () => {
  const r = P.buildVoices({ raw: '{"*":"общий"}', boxes: ['agent_1'] });
  assert.strictEqual(r.wildcard, true);
  assert.strictEqual(r.tasks.agent_1, 'общий');
});

// --- describeVoices ---------------------------------------------------------
console.log('describeVoices');
test('есть голос / нет голоса', () => {
  const lines = P.describeVoices(['agent_1', 'agent_2'], { agent_1: 'много\nстрок' });
  assert.strictEqual(lines[0], 'agent_1 → много строк');
  assert.strictEqual(lines[1], 'agent_2 → (общий RACE_TASK)');
});

// --- итог -------------------------------------------------------------------
console.log('\n--- итог ---');
console.log('passed: ' + passed + ', failed: ' + failed + '\n');

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
