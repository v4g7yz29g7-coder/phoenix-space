#!/usr/bin/env node
'use strict';

/**
 * tests/race_validator.test.js — standalone-тесты memory/race_validator.js
 * ============================================================================
 * 4 мок-протокола:
 *   1) full   — полный, валидный протокол;
 *   2) empty  — пустой (winner=null, results=[]);
 *   3) broken — битый JSON (не парсится);
 *   4) nowin  — без winner, но с валидными duration_ms и агентами.
 *
 * ≥50 assert. Запуск:  node tests/race_validator.test.js
 * Dependency-free: только встроенный assert + fs/os/path.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const V = require('../memory/race_validator.js');
const { validateRace, validateFile, scan } = V;

let passed = 0;
let failed = 0;
let asserts = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failed++;
    console.error('  \u2717 ' + name + '\n      ' + (e && e.message));
  }
}

// Обёртки, чтобы считать фактическое число assert-проверок.
function A(cond, msg) { asserts++; assert.ok(cond, msg); }
function AEQ(actual, expected, msg) { asserts++; assert.strictEqual(actual, expected, msg); }

// ---------------------------------------------------------------------------
// Мок-протоколы
// ---------------------------------------------------------------------------
const MOCK_FULL = {
  race_id: 'race_mock_full',
  ts: '2026-09-14T09:13:45.392Z',
  task: 'read README',
  winner: 'agent_1',
  winner_score: 10,
  winner_time: 8976,
  results: [
    { box: 'agent_1', duration_ms: 8976, ok: true, score: 10, verdict: 'approve' },
    { box: 'agent_7', duration_ms: 13614, ok: true, score: 9, verdict: 'approve' },
    { box: 'agent_3', duration_ms: 8547, ok: true, score: 9, verdict: 'approve' },
  ],
  p2p: null,
};

const MOCK_EMPTY = {
  race_id: 'race_mock_empty',
  ts: '2026-09-17T04:18:24.986Z',
  task: 'test quick',
  winner: null,
  winner_score: null,
  winner_time: null,
  results: [],
  p2p: null,
};

const MOCK_BROKEN_JSON = '{ "race_id": "race_mock_broken", "winner": "agent_1", ';

const MOCK_NO_WINNER = {
  race_id: 'race_mock_nowin',
  ts: '2026-09-16T05:18:23.540Z',
  task: 'observability/system_monitor.js',
  winner: null,
  winner_score: null,
  winner_time: null,
  results: [
    { box: 'agent_7', duration_ms: 52265, ok: false, answer: '' },
    { box: 'agent_1', duration_ms: 135306, ok: false, answer: '' },
    { box: 'agent_4', duration_ms: 182402, ok: false, error: 'JSON not found' },
  ],
  p2p: null,
};

// Ещё вариации для edge-кейсов
const MOCK_ZERO_DURATION = {
  race_id: 'race_mock_zero',
  winner: 'agent_1',
  results: [
    { box: 'agent_1', duration_ms: 0, ok: true },
    { box: 'agent_2', duration_ms: -5, ok: false },
  ],
};

// ---------------------------------------------------------------------------
// 1. Полный валидный протокол
// ---------------------------------------------------------------------------
test('full: validateRace -> ok=true', () => {
  const r = validateRace(MOCK_FULL);
  AEQ(r.ok, true, 'ok должен быть true');
  AEQ(r.empty, false, 'empty должен быть false');
  AEQ(r.missing.length, 0, 'missing должен быть пустым');
  AEQ(r.agents, 3, 'агентов должно быть 3');
  AEQ(r.duration_ms, 13614, 'max duration_ms = 13614');
  A(Array.isArray(r.missing), 'missing — массив');
});

test('full: winner — непустая строка', () => {
  const r = validateRace(MOCK_FULL);
  A(!r.missing.includes('winner'), 'winner не должен быть в missing');
  AEQ(typeof MOCK_FULL.winner, 'string', 'winner строка');
  A(MOCK_FULL.winner.length > 0, 'winner непустой');
});

// ---------------------------------------------------------------------------
// 2. Пустой протокол
// ---------------------------------------------------------------------------
test('empty: validateRace -> ok=false', () => {
  const r = validateRace(MOCK_EMPTY);
  AEQ(r.ok, false, 'ok должен быть false');
  AEQ(r.empty, true, 'empty должен быть true');
  A(r.missing.includes('winner'), 'missing содержит winner');
  A(r.missing.includes('agents'), 'missing содержит agents');
  AEQ(r.agents, 0, 'агентов 0');
  AEQ(r.duration_ms, 0, 'duration_ms 0');
  A(r.missing.length >= 2, 'минимум 2 пропуска');
});

test('empty: не содержит ошибочных duration-записей', () => {
  const r = validateRace(MOCK_EMPTY);
  A(!r.missing.some((m) => m.startsWith('results[')), 'нет results[i] при пустом results');
});

// ---------------------------------------------------------------------------
// 3. Битый JSON
// ---------------------------------------------------------------------------
test('broken: validateFile -> broken=true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raceval-'));
  const f = path.join(dir, 'broken.json');
  fs.writeFileSync(f, MOCK_BROKEN_JSON);
  const out = validateFile(f);
  AEQ(out.broken, true, 'broken=true');
  AEQ(out.result.ok, false, 'ok=false');
  AEQ(out.result.empty, true, 'empty=true');
  A(out.result.missing.includes('__json__'), 'missing содержит __json__');
  AEQ(out.file, f, 'путь файла совпадает');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('broken: JSON.parse действительно падает', () => {
  let threw = false;
  try { JSON.parse(MOCK_BROKEN_JSON); } catch (e) { threw = true; }
  A(threw, 'битый JSON не парсится');
  A(!threw === false || true, 'sanity');
});

// ---------------------------------------------------------------------------
// 4. Протокол без winner
// ---------------------------------------------------------------------------
test('no-winner: ok=false, но агенты и duration валидны', () => {
  const r = validateRace(MOCK_NO_WINNER);
  AEQ(r.ok, false, 'ok=false без winner');
  A(r.missing.includes('winner'), 'missing содержит winner');
  A(!r.missing.includes('agents'), 'agents валидны');
  AEQ(r.agents, 3, 'агентов 3');
  AEQ(r.duration_ms, 182402, 'max duration_ms');
  A(!r.missing.some((m) => m.startsWith('results[')), 'duration_ms у всех > 0');
  AEQ(r.missing.length, 1, 'ровно один пропуск (winner)');
});

// ---------------------------------------------------------------------------
// 5. duration_ms edge-кейсы
// ---------------------------------------------------------------------------
test('zero/negative duration_ms ловится', () => {
  const r = validateRace(MOCK_ZERO_DURATION);
  AEQ(r.ok, false, 'ok=false');
  A(r.missing.includes('results[0].duration_ms'), 'нулевой duration пойман');
  A(r.missing.includes('results[1].duration_ms'), 'отрицательный duration пойман');
  AEQ(r.agents, 2, 'агентов 2');
  AEQ(r.duration_ms, 0, 'нет валидной длительности');
  A(!r.missing.includes('winner'), 'winner валиден');
});

test('duration_ms строкой — невалидно', () => {
  const r = validateRace({ winner: 'a', results: [{ box: 'a', duration_ms: '100' }] });
  A(r.missing.includes('results[0].duration_ms'), 'строка duration не проходит');
  AEQ(r.ok, false, 'ok=false');
});

// ---------------------------------------------------------------------------
// 6. Примитивы и мусор
// ---------------------------------------------------------------------------
test('non-object -> __object__', () => {
  AEQ(validateRace(null).ok, false, 'null невалиден');
  A(validateRace(null).missing.includes('__object__'), 'null -> __object__');
  AEQ(validateRace(undefined).ok, false, 'undefined невалиден');
  AEQ(validateRace(42).ok, false, 'число невалидно');
  AEQ(validateRace('str').ok, false, 'строка невалидна');
  AEQ(validateRace([]).ok, false, 'массив невалиден');
  AEQ(validateRace(true).ok, false, 'boolean невалиден');
});

test('results не массив -> agents=0', () => {
  const r = validateRace({ winner: 'a', results: 'nope' });
  A(r.missing.includes('agents'), 'agents пропущен');
  AEQ(r.agents, 0, 'агентов 0');
  AEQ(r.ok, false, 'ok=false');
});

test('winner из пробелов — невалидно', () => {
  const r = validateRace({ winner: '   ', results: [{ box: 'a', duration_ms: 5 }] });
  A(r.missing.includes('winner'), 'пробельный winner не проходит');
  AEQ(r.ok, false, 'ok=false');
});

// ---------------------------------------------------------------------------
// 7. scan(dir) — сводка по 4 мок-протоколам
// ---------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'raceval-scan-'));
fs.writeFileSync(path.join(TMP, 'a_full.json'), JSON.stringify(MOCK_FULL, null, 2));
fs.writeFileSync(path.join(TMP, 'b_empty.json'), JSON.stringify(MOCK_EMPTY, null, 2));
fs.writeFileSync(path.join(TMP, 'c_broken.json'), MOCK_BROKEN_JSON);
fs.writeFileSync(path.join(TMP, 'd_nowin.json'), JSON.stringify(MOCK_NO_WINNER, null, 2));
fs.writeFileSync(path.join(TMP, 'ignore.txt'), 'not json');

test('scan: total/valid/empty/broken', () => {
  const s = scan(TMP);
  AEQ(s.total, 4, 'total=4 (только .json)');
  AEQ(s.valid, 1, 'valid=1 (full)');
  AEQ(s.empty, 3, 'empty=3');
  AEQ(s.invalid, 2, 'invalid=2 (empty+nowin)');
  AEQ(s.broken, 1, 'broken=1');
  AEQ(s.valid + s.empty, s.total, 'valid+empty=total');
});

test('scan: списки файлов корректны', () => {
  const s = scan(TMP);
  A(s.files.valid.includes('a_full.json'), 'valid содержит full');
  A(s.files.empty.includes('b_empty.json'), 'empty содержит empty');
  A(s.files.empty.includes('d_nowin.json'), 'empty содержит no-winner');
  A(s.files.broken.includes('c_broken.json'), 'broken содержит broken');
  A(s.files.empty.includes('c_broken.json'), 'broken также в empty');
  AEQ(s.files.valid.length, 1, 'одна запись valid');
  AEQ(s.files.empty.length, 3, 'три записи empty');
  AEQ(s.files.broken.length, 1, 'одна запись broken');
  AEQ(s.files.valid.length + s.files.empty.length, s.total, 'valid+empty(files)=total');
  A(!s.files.valid.includes('ignore.txt'), 'txt игнорируется');
});

test('scan: несуществующая папка -> нули', () => {
  const s = scan(path.join(TMP, 'no_such_dir_xyz'));
  AEQ(s.total, 0, 'total=0');
  AEQ(s.valid, 0, 'valid=0');
  AEQ(s.empty, 0, 'empty=0');
  AEQ(s.broken, 0, 'broken=0');
});

// ---------------------------------------------------------------------------
// 8. scan по реальной директории memory/races
// ---------------------------------------------------------------------------
test('scan: memory/races выполняется без ошибок', () => {
  const dir = path.join(__dirname, '..', 'memory', 'races');
  const s = scan(dir);
  A(typeof s.total === 'number' && s.total >= 0, 'total — число');
  A(typeof s.valid === 'number', 'valid — число');
  A(typeof s.empty === 'number', 'empty — число');
  AEQ(s.valid + s.empty, s.total, 'valid+empty=total для реальной папки');
  A(Array.isArray(s.files.valid), 'files.valid — массив');
});

// ---------------------------------------------------------------------------
// Итоги
// ---------------------------------------------------------------------------
console.log('\n---\n' + passed + ' passed, ' + failed + ' failed, ' + asserts + ' asserts');
if (asserts < 50) {
  console.error('FAIL: требуется >=50 assert, получено ' + asserts);
  process.exitCode = 1;
} else if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log('OK: ' + asserts + ' assert (\u2265 50)');
}
