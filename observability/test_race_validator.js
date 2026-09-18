'use strict';

/**
 * observability/test_race_validator.js
 * ---------------------------------------------------------------------------
 * Standalone-тест валидатора протоколов гонок (observability/race_validator.js).
 *
 * Покрывает 4 мок-протокола (полный, пустой, битый JSON, без winner) плюс
 * граничные случаи validateRace()/parseRace()/validateFile()/scan().
 *
 * Критерий задачи: >= 50 assert на этих моках.
 *
 * Запуск:
 *   node observability/test_race_validator.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rv = require('./race_validator');

const {
  validateRace,
  scan,
  parseRace,
  readRace,
  validateFile,
  REQUIRED_FIELDS,
} = rv;

// ---------------------------------------------------------------------------
// Мягкий assert-харнесс: считается каждый assert, падение не обрывает прогон.
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let assertCount = 0;

const A = {
  ok(value, msg) {
    assertCount += 1;
    if (value) passed += 1;
    else {
      failed += 1;
      console.error(`  \u2717 ${msg} (expected truthy, got ${JSON.stringify(value)})`);
    }
  },
  eq(actual, expected, msg) {
    assertCount += 1;
    if (Object.is(actual, expected)) passed += 1;
    else {
      failed += 1;
      console.error(`  \u2717 ${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
    }
  },
  deep(actual, expected, msg) {
    assertCount += 1;
    try {
      assert.deepStrictEqual(actual, expected);
      passed += 1;
    } catch (e) {
      failed += 1;
      console.error(`  \u2717 ${msg} :: ${e.message}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Мок-протоколы
// ---------------------------------------------------------------------------

// 1) Полный валидный протокол: winner + 2 агента + положительные duration_ms.
const MOCK_FULL = {
  race_id: 'mock_full_1',
  ts: '2026-09-17T09:00:00.000Z',
  task: 'mock task',
  winner: 'agent_4',
  winner_score: 9,
  winner_time: 12000,
  results: [
    { box: 'agent_4', duration_ms: 12000, ok: true, score: 9, steps_count: 4 },
    { box: 'agent_7', duration_ms: 13500, ok: false, score: 6, steps_count: 2 },
  ],
  p2p: { winner: 'agent_4', shared_with: ['agent_7'], skills_copied: 0, errors: [] },
};

// 2) Пустой протокол.
const MOCK_EMPTY = {};

// 3) Битый JSON (строка, а не объект).
const MOCK_BROKEN_TEXT = '{ "race_id": "mock_broken", "winner": "agent_1", ';

// 4) Протокол без winner (агенты и время есть, победитель = null).
const MOCK_NO_WINNER = {
  race_id: 'mock_no_winner',
  ts: '2026-09-17T09:05:00.000Z',
  winner: null,
  winner_score: null,
  winner_time: null,
  results: [
    { box: 'agent_10', duration_ms: 208436, ok: false, score: null },
    { box: 'agent_11', duration_ms: 210234, ok: false, score: null },
  ],
};

console.log('race_validator standalone test');

// ---------------------------------------------------------------------------
// 1. API surface
// ---------------------------------------------------------------------------
console.log('\n[1] API surface');
A.eq(typeof validateRace, 'function', 'validateRace is a function');
A.eq(typeof scan, 'function', 'scan is a function');
A.eq(typeof parseRace, 'function', 'parseRace is a function');
A.eq(typeof readRace, 'function', 'readRace is a function');
A.eq(typeof validateFile, 'function', 'validateFile is a function');
A.ok(Array.isArray(REQUIRED_FIELDS), 'REQUIRED_FIELDS is an array');
A.deep(REQUIRED_FIELDS, ['winner', 'duration_ms', 'agents'], 'REQUIRED_FIELDS order');

// ---------------------------------------------------------------------------
// 2. Мок 1 — ПОЛНЫЙ протокол
// ---------------------------------------------------------------------------
console.log('\n[2] mock: full protocol');
const full = validateRace(MOCK_FULL);
A.eq(full.ok, true, 'full: ok === true');
A.eq(full.missing.length, 0, 'full: missing is empty');
A.ok(Array.isArray(full.missing), 'full: missing is an array');
A.eq(full.missing.indexOf('winner'), -1, 'full: winner satisfied');
A.eq(full.missing.indexOf('duration_ms'), -1, 'full: duration_ms satisfied');
A.eq(full.missing.indexOf('agents'), -1, 'full: agents satisfied');
A.eq(rv.countAgents(MOCK_FULL), 2, 'full: countAgents === 2');
A.eq(rv.hasPositiveDuration(MOCK_FULL), true, 'full: hasPositiveDuration === true');
A.eq(rv.isNonEmptyString(MOCK_FULL.winner), true, 'full: winner is non-empty string');
A.deep(validateRace(MOCK_FULL), validateRace(MOCK_FULL), 'full: deterministic result');
A.eq(validateRace(JSON.parse(JSON.stringify(MOCK_FULL))).ok, true, 'full: survives JSON round-trip');
A.eq(rv.isObject(MOCK_FULL), true, 'full: isObject true');
A.eq(rv.isPositiveNumber(12000), true, 'full: isPositiveNumber(12000)');
A.eq(rv.isPositiveNumber(0), false, 'full: isPositiveNumber(0) false');
A.eq(rv.isPositiveNumber(-1), false, 'full: isPositiveNumber(-1) false');
A.eq(rv.isPositiveNumber(NaN), false, 'full: isPositiveNumber(NaN) false');

// agent count via numeric field
A.eq(rv.countAgents({ agents: 3 }), 3, 'agents numeric field -> 3');
A.eq(rv.countAgents({ agents: [1, 2] }), 2, 'agents array -> 2');

// ---------------------------------------------------------------------------
// 3. Мок 4 — БЕЗ WINNER
// ---------------------------------------------------------------------------
console.log('\n[3] mock: no winner');
const nw = validateRace(MOCK_NO_WINNER);
A.eq(nw.ok, false, 'no-winner: ok === false');
A.deep(nw.missing, ['winner'], 'no-winner: missing === [winner]');
A.eq(nw.missing.length, 1, 'no-winner: exactly one missing field');
A.eq(nw.missing.indexOf('winner') !== -1, true, 'no-winner: reports winner');
A.eq(nw.missing.indexOf('duration_ms'), -1, 'no-winner: duration_ms satisfied');
A.eq(nw.missing.indexOf('agents'), -1, 'no-winner: agents satisfied');
A.eq(rv.countAgents(MOCK_NO_WINNER), 2, 'no-winner: countAgents === 2');
A.eq(rv.hasPositiveDuration(MOCK_NO_WINNER), true, 'no-winner: hasPositiveDuration true');

// ---------------------------------------------------------------------------
// 4. Мок 2 — ПУСТОЙ протокол + граничные случаи
// ---------------------------------------------------------------------------
console.log('\n[4] mock: empty protocol + edges');
const empty = validateRace(MOCK_EMPTY);
A.eq(empty.ok, false, 'empty: ok === false');
A.deep(empty.missing, ['winner', 'duration_ms', 'agents'], 'empty: missing all three');
A.eq(empty.missing.length, 3, 'empty: 3 missing');
A.eq(empty.missing[0], 'winner', 'empty: order[0] winner');
A.eq(empty.missing[1], 'duration_ms', 'empty: order[1] duration_ms');
A.eq(empty.missing[2], 'agents', 'empty: order[2] agents');
A.eq(rv.countAgents(MOCK_EMPTY), 0, 'empty: countAgents 0');
A.eq(rv.hasPositiveDuration(MOCK_EMPTY), false, 'empty: hasPositiveDuration false');

A.eq(validateRace(null).ok, false, 'null: ok false');
A.eq(validateRace(null).missing.length, 3, 'null: 3 missing');
A.deep(validateRace(null).missing, REQUIRED_FIELDS.slice(), 'null: missing list');
A.eq(validateRace(undefined).ok, false, 'undefined: ok false');
A.eq(validateRace(undefined).missing.length, 3, 'undefined: 3 missing');
A.eq(validateRace([]).ok, false, 'array: ok false');
A.eq(validateRace([]).missing.length, 3, 'array: 3 missing');
A.eq(validateRace('string').ok, false, 'string: ok false');
A.eq(validateRace(42).ok, false, 'number: ok false');
A.eq(validateRace({ winner: '' }).missing.indexOf('winner') !== -1, true, 'empty-string winner flagged');
A.eq(validateRace({ winner: '   ' }).missing.indexOf('winner') !== -1, true, 'whitespace winner flagged');
A.eq(
  validateRace({ winner: 'a', results: [], duration_ms: 5 }).missing.indexOf('agents') !== -1,
  true,
  'no agents flagged'
);
A.eq(
  validateRace({ winner: 'a', results: [{ box: 'x', duration_ms: 0 }] }).missing.indexOf('duration_ms') !== -1,
  true,
  'duration_ms=0 flagged'
);
A.eq(
  validateRace({ winner: 'a', results: [{ box: 'x', duration_ms: -5 }] }).missing.indexOf('duration_ms') !== -1,
  true,
  'duration_ms<0 flagged'
);
A.eq(
  validateRace({ winner: 'a', results: [{ box: 'x', duration_ms: '100' }] }).missing.indexOf('duration_ms') !== -1,
  true,
  'string duration_ms flagged'
);
A.eq(validateRace({ winner: 'a', results: [{ box: 'x', duration_ms: 1 }] }).ok, true, 'minimal valid race');
A.eq(validateRace({ winner: 'a', agents: 1, duration_ms: 5 }).ok, true, 'valid via numeric agents');

// ---------------------------------------------------------------------------
// 5. Мок 3 — БИТЫЙ JSON
// ---------------------------------------------------------------------------
console.log('\n[5] mock: broken JSON');
const broken = parseRace(MOCK_BROKEN_TEXT);
A.eq(broken.ok, false, 'broken: parseRace ok false');
A.eq(broken.race, null, 'broken: race null');
A.eq(typeof broken.error, 'string', 'broken: error is string');
A.ok(broken.error.length > 0, 'broken: error non-empty');
A.eq(parseRace('').ok, false, 'broken: empty string fails');
A.eq(parseRace('{').ok, false, 'broken: "{" fails');
A.eq(parseRace(null).ok, false, 'broken: null text fails');
A.eq(parseRace('null').ok, true, 'parseRace("null") parses');
A.eq(parseRace('{}').ok, true, 'parseRace("{}") parses');
const fullParsed = parseRace(JSON.stringify(MOCK_FULL));
A.eq(fullParsed.ok, true, 'parseRace(full) ok');
A.eq(fullParsed.race.winner, 'agent_4', 'parseRace(full) winner');
A.eq(validateRace(broken.race).ok, false, 'broken: validateRace(null race) ok false');
A.eq(validateRace(broken.race).missing.length, 3, 'broken: validateRace(null race) 3 missing');

// ---------------------------------------------------------------------------
// 6. validateFile() / scan() на временном каталоге из 4 моков
// ---------------------------------------------------------------------------
console.log('\n[6] validateFile() / scan() over 4 mock files');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'race-validator-'));
const P = (n) => path.join(tmp, n);
fs.writeFileSync(P('a_full.json'), JSON.stringify(MOCK_FULL, null, 2));
fs.writeFileSync(P('b_empty.json'), JSON.stringify(MOCK_EMPTY));
fs.writeFileSync(P('c_broken.json'), MOCK_BROKEN_TEXT);
fs.writeFileSync(P('d_no_winner.json'), JSON.stringify(MOCK_NO_WINNER));
// не-json файл не должен попадать в сводку
fs.writeFileSync(P('ignore.txt'), 'not json');

const summary = scan(tmp);
A.eq(summary.total, 4, 'scan.total === 4 (.json only)');
A.eq(summary.valid, 1, 'scan.valid === 1');
A.eq(summary.empty, 3, 'scan.empty === 3');
A.eq(summary.total, summary.valid + summary.empty, 'invariant total = valid + empty');
A.eq(summary.broken, 1, 'scan.broken === 1');
A.eq(summary.noWinner, 2, 'scan.noWinner === 2');
A.eq(summary.byReason.broken_json, 1, 'byReason.broken_json === 1');
A.eq(summary.byReason.winner, 2, 'byReason.winner === 2');
A.eq(summary.dir, tmp, 'scan.dir echoed');

const vfFull = validateFile(P('a_full.json'));
A.eq(vfFull.ok, true, 'validateFile(full).ok true');
A.eq(vfFull.broken, false, 'validateFile(full).broken false');
A.eq(vfFull.missing.length, 0, 'validateFile(full).missing empty');

const vfNo = validateFile(P('d_no_winner.json'));
A.eq(vfNo.ok, false, 'validateFile(no-winner).ok false');
A.deep(vfNo.missing, ['winner'], 'validateFile(no-winner).missing [winner]');

const vfBroken = validateFile(P('c_broken.json'));
A.eq(vfBroken.ok, false, 'validateFile(broken).ok false');
A.eq(vfBroken.broken, true, 'validateFile(broken).broken true');
A.ok(vfBroken.error && vfBroken.error.length > 0, 'validateFile(broken).error set');

const vfMissing = validateFile(P('does_not_exist.json'));
A.eq(vfMissing.ok, false, 'validateFile(missing file).ok false');
A.eq(vfMissing.broken, true, 'validateFile(missing file).broken true');

const rr = readRace(P('a_full.json'));
A.eq(rr.ok, true, 'readRace(full).ok true');
A.eq(rr.race.winner, 'agent_4', 'readRace(full).race.winner');

const noDir = scan(P('no_such_dir_xyz'));
A.eq(noDir.total, 0, 'scan(missing dir).total 0');
A.ok(typeof noDir.error === 'string' && noDir.error.length > 0, 'scan(missing dir).error set');
A.eq(noDir.valid, 0, 'scan(missing dir).valid 0');
A.eq(noDir.empty, 0, 'scan(missing dir).empty 0');

fs.rmSync(tmp, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 7. Реальный каталог memory/races (мягкая проверка, не ломает прогон)
// ---------------------------------------------------------------------------
console.log('\n[7] real memory/races dir (soft)');
const realDir = path.join(__dirname, '..', 'memory', 'races');
if (fs.existsSync(realDir)) {
  const real = scan(realDir);
  A.ok(real.total > 0, 'real: total > 0');
  A.eq(real.total, real.valid + real.empty, 'real: invariant total = valid + empty');
  A.eq(typeof real.broken, 'number', 'real: broken is number');
  A.eq(typeof real.noWinner, 'number', 'real: noWinner is number');
} else {
  console.log('  (memory/races not found — skipped)');
}

// ---------------------------------------------------------------------------
// Итоги
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed, ${assertCount} asserts`);
if (assertCount < 50) {
  console.error(`CRITERION FAIL: only ${assertCount} asserts (< 50)`);
  process.exitCode = 1;
} else if (failed > 0) {
  process.exitCode = 1;
}
