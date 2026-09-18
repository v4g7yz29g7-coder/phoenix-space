'use strict';

/**
 * Смоук-тест evolution/hybrid_vitality.js
 * Запуск: node evolution/hybrid_vitality.test.js
 */

const assert = require('assert');
const hv = require('./hybrid_vitality');

// 1. Базовый API analyze(...)
const r = hv.analyze({ energy: 80, resilience: 0.9, coherence: 0.7, adaptability: 0.6, symbiosis: 0.5 });
assert.ok(r.vitality >= 0 && r.vitality <= 1, 'vitality в [0,1]');
assert.ok(typeof r.grade === 'string' && r.grade.length > 0, 'grade задан');
assert.strictEqual(r.streamCount, 5, '5 потоков');
assert.ok(r.synergy >= 1, 'синергия >= 1');

// 2. analyze() без аргументов
const r0 = hv.analyze();
assert.ok(Number.isFinite(r0.vitality), 'нулевой ctx даёт число');

// 3. Некорректные данные не роняют движок
const bad = hv.analyze({ energy: NaN, resilience: 'x', coherence: undefined });
assert.ok(Number.isFinite(bad.vitality), 'мусор обрабатывается');

// 4. Гибридизация геномов
const child = hv.hybridize({ speed: 0.9, power: 0.8 }, { speed: 0.3, power: 0.4, agility: 0.7 });
const expr = child.express();
assert.ok('agility' in expr, 'гибрид наследует новый признак');
assert.ok(expr.speed >= 0 && expr.speed <= 1, 'скорость нормализована');

// 5. Движок и тренд
const engine = hv.createDefault({ label: 'test', maxHistory: 3 });
for (let i = 0; i < 5; i++) engine.analyze({ energy: i * 20, resilience: i / 5, coherence: 0.5 });
assert.ok(engine.history.length <= 3, 'история ограничена');
assert.ok(typeof engine.trend() === 'number', 'тренд — число');
assert.ok(engine.stats().historySize > 0, 'статистика доступна');

// 6. analyzeHybrid
const hr = engine.analyzeHybrid({ a: 0.9 }, { a: 0.2, b: 0.8 });
assert.strictEqual(hr.hybrid, true, 'помечен как гибрид');

console.log('ALL TESTS PASSED');
