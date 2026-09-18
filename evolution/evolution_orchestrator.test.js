#!/usr/bin/env node
/**
 * evolution/evolution_orchestrator.test.js
 * ============================================================================
 * Smoke-тесты для evolution/evolution_orchestrator.js.
 *
 * Проверяем публичный контракт, НЕ запуская реальные эволюционные модули:
 *   - экспортируется start/stop/status/tick/register/modules;
 *   - start(interval) возвращает снимок состояния со running=true;
 *   - start() идемпотентен и не бросает исключений;
 *   - stop() идемпотентен и переводит running=false;
 *   - status() содержит обязательные поля;
 *   - register() добавляет модуль в реестр;
 *   - tick() не бросает наружу исключение.
 *
 * Тест не имеет внешних зависимостей (только assert/stdlib).
 * ============================================================================
 */

'use strict';

const assert = require('assert');
const orch = require('./evolution_orchestrator');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  \u2717 ${name}\n      ${err && err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  \u2717 ${name}\n      ${err && err.message}`);
  }
}

// Отключаем автотакт, чтобы не запускать реальные модули во время теста.
orch.CONFIG.runOnStart = false;
orch.CONFIG.logToFile = false;

console.log('evolution_orchestrator.test.js');

test('module exports публичного API', () => {
  assert.strictEqual(typeof orch.start, 'function', 'start');
  assert.strictEqual(typeof orch.stop, 'function', 'stop');
  assert.strictEqual(typeof orch.status, 'function', 'status');
  assert.strictEqual(typeof orch.tick, 'function', 'tick');
  assert.strictEqual(typeof orch.register, 'function', 'register');
  assert.strictEqual(typeof orch.modules, 'function', 'modules');
  assert.ok(orch.CONFIG, 'CONFIG');
});

test('status() до запуска: running=false, счётчики — числа', () => {
  const s = orch.status();
  assert.strictEqual(typeof s, 'object');
  assert.strictEqual(s.running, false);
  assert.strictEqual(typeof s.ticks, 'number');
  assert.strictEqual(typeof s.ticksOk, 'number');
  assert.strictEqual(typeof s.ticksFailed, 'number');
  assert.ok(Array.isArray(s.history));
  assert.ok(Array.isArray(s.registered));
});

test('start(interval) → running=true и корректный интервал', () => {
  const s = orch.start(60000);
  assert.strictEqual(s.running, true);
  assert.strictEqual(s.intervalMs, 60000);
  assert.ok(orch.status().running);
});

test('start() повторно — не бросает, состояние остаётся running', () => {
  orch.start(30000);
  const s = orch.status();
  assert.strictEqual(s.running, true);
  assert.strictEqual(s.intervalMs, 30000);
});

test('минимальный интервал поднимается до minIntervalMs', () => {
  orch.start(1);
  const s = orch.status();
  assert.ok(s.intervalMs >= orch.CONFIG.minIntervalMs);
});

test('stop() → running=false, идемпотентен', () => {
  orch.stop();
  assert.strictEqual(orch.status().running, false);
  orch.stop();
  assert.strictEqual(orch.status().running, false);
});

test('register() добавляет модуль в реестр', () => {
  const res = orch.register('__test_module__', { cycle() { return { ok: true }; } });
  assert.strictEqual(res.ok, true);
  const names = orch.modules().map((m) => m.name);
  assert.ok(names.includes('__test_module__'));
});

test('register() без аргументов → ok=false', () => {
  assert.strictEqual(orch.register().ok, false);
});

test('status().config содержит ключевые параметры', () => {
  const cfg = orch.status().config;
  assert.strictEqual(typeof cfg.defaultIntervalMs, 'number');
  assert.strictEqual(typeof cfg.minIntervalMs, 'number');
  assert.strictEqual(typeof cfg.runOnStart, 'boolean');
  assert.strictEqual(typeof cfg.skipOverlapping, 'boolean');
});

(async () => {
  await testAsync('tick() не бросает исключение наружу', async () => {
    const report = await orch.tick();
    assert.strictEqual(typeof report, 'object');
    assert.ok(typeof report.tickNumber === 'number');
    assert.ok(Array.isArray(report.modules));
  });

  orch.stop();

  console.log(`\npassed=${passed}, failed=${failed}`);
  process.exitCode = failed ? 1 : 0;
})();
