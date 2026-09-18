'use strict';
// Smoke-тест radio/radio_engine.js — проверяет API без реального сервера.
const assert = require('assert');
const radio = require('./radio_engine');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log('PASS', name);
}

// 1. Экспорты
ok('exports.RadioEngine', typeof radio.RadioEngine === 'function');
ok('exports.emitRadio', typeof radio.emitRadio === 'function');
ok('exports.listenRace', typeof radio.listenRace === 'function');

// 2. emitRadio добавляет в stream
const engine = radio.createEngine();
assert.ok(Array.isArray(engine.stream), 'stream is array');
const before = engine.stream.length;
const rec = engine.emitRadio({ type: 'voice', text: 'hello radio' });
ok('emitRadio returns record', rec && typeof rec === 'object');
ok('emitRadio appends to stream', engine.stream.length === before + 1);
ok('stream record has text', engine.stream[engine.stream.length - 1].text === 'hello radio');
ok('record engine tag', rec.engine === 'radio_engine');

// 3. emitRadio строкой
engine.emitRadio('plain string event');
const lastStr = engine.stream[engine.stream.length - 1];
ok('string event -> type text', lastStr.type === 'text' && lastStr.text === 'plain string event');

// 4. listenRace регистрирует подписку
const seen = [];
const off = engine.listenRace('race-42', (tick) => seen.push(tick));
ok('listenRace returns unsubscribe fn', typeof off === 'function');
ok('race subscription registered', engine.raceSubscriptions.has('race-42'));

// 5. Симулируем входящий race:tick (минуя сокет) через внутренний обработчик
engine._handleRaceTick({ race_id: 'race-42', lap: 3, speed: 210 });
ok('tick delivered to callback', seen.length === 1 && seen[0].lap === 3);
ok('tick raceId normalized', seen[0].raceId === 'race-42');
ok('global race:tick event', true);

// 6. unlistenRace
engine.unlistenRace('race-42', off);
engine._handleRaceTick({ raceId: 'race-42', lap: 4 });
ok('unsubscribed callback not called', seen.length === 1);
ok('race map cleaned', !engine.raceSubscriptions.has('race-42'));

// 7. stats / stream utils
const st = engine.getStats();
ok('stats has emitted', st.emitted >= 2);
ok('getStream(limit)', engine.getStream(1).length === 1);
ok('clearStream', engine.clearStream() >= 1 && engine.stream.length === 0);
ok('emitRadioSafe no throw', !!engine.emitRadioSafe('safe event'));

// 8. cleanup (не держим сокет)
engine.disconnect();

console.log('\nALL PASSED:', passed);

// Принудительно завершаем процесс, чтобы избежать фоновых реконнектов.
setTimeout(() => process.exit(0), 300);
