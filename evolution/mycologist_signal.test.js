'use strict';
/* Smoke-test for evolution/mycologist_signal.js */
const assert = require('assert');
const myco = require('./mycologist_signal.js');

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('  ok  ' + name); }

ok('exports emitSignal', () => assert.strictEqual(typeof myco.emitSignal, 'function'));
ok('SIGNAL_TYPES frozen', () => assert(Object.isFrozen(myco.SIGNAL_TYPES)));

const grid = new myco.MyceliumSignalGrid({ now: () => 1000, rng: () => 0.9 });
grid.seed('root', { role: 'hub' });
grid.seed('tip-a', { role: 'tip' });
grid.seed('tip-b', { role: 'tip' });
grid.growHypha('root', 'tip-a', { latency: 2 });
grid.growHypha('tip-a', 'tip-b');

const s = grid.emitSignal('root', 'tip-a', 'nutrient', { amount: 7 });
ok('signal is Signal', () => assert(s instanceof myco.Signal));
ok('signal fields', () => {
  assert.strictEqual(s.from, 'root');
  assert.strictEqual(s.to, 'tip-a');
  assert.strictEqual(s.type, 'nutrient');
  assert.strictEqual(s.payload.amount, 7);
  assert.strictEqual(s.priority, myco.PRIORITY.HIGH);
});
ok('signal frozen', () => assert(Object.isFrozen(s)));

const t = grid.trace('root', 'tip-b', 'spore', {});
ok('trace path via tip-a', () => assert.deepStrictEqual(t.path, ['root', 'tip-a', 'tip-b']));
ok('trace hops', () => assert.strictEqual(t.hops, 2));

const seen = [];
const off = grid.on('spore', (sig) => seen.push(sig.id));
grid.emitSignal('root', 'tip-b', 'spore', {});
ok('listener fired', () => assert.strictEqual(seen.length, 1));
off();
grid.emitSignal('root', 'tip-b', 'spore', {});
ok('unsubscribe works', () => assert.strictEqual(seen.length, 1));

const bc = grid.broadcast('root', 'ping', {});
ok('broadcast reaches 2 peers', () => assert.strictEqual(bc.length, 2));

ok('eavesdrop tip-b', () => assert(grid.eavesdrop('tip-b').length >= 3));
ok('historyOf filter', () => assert(grid.historyOf({ type: 'ping' }).length === 2));

const st = grid.stats();
ok('stats counts nodes', () => assert.strictEqual(st.nodes, 3));
ok('stats counts hyphae', () => assert.strictEqual(st.hyphae, 2));
ok('stats has types map', () => assert.strictEqual(st.types.ping, 2));

grid.decay(100);
ok('decay lowers congestion', () => assert.strictEqual(grid._avgCongestion(), 0));

const snap = grid.snapshot();
ok('snapshot nodes/hyphae', () => {
  assert.strictEqual(snap.nodes.length, 3);
  assert.strictEqual(snap.hyphae.length, 2);
});

// сбойный слушатель не валит сеть и эмитит warning
let warned = 0;
grid.on('warning', () => { warned += 1; });
grid.on('growth', () => { throw new Error('boom'); });
grid.emitSignal('root', 'tip-a', 'growth', {});
ok('faulty listener -> warning', () => assert.strictEqual(warned, 1));

// забитая гифа -> сигнал не доставляется
const congested = new myco.MyceliumSignalGrid({ now: () => 1000, rng: () => 0.99 });
congested.seed('a'); congested.seed('b');
const hy = congested.growHypha('a', 'b');
hy.congestion = 1;
const lost = congested.emitSignal('a', 'b', 'ping', {});
ok('congested link drops signal', () => assert.strictEqual(lost.delivered, false));
ok('undelivered tracked', () => assert.strictEqual(congested.stats().undelivered, 1));

// модульные обёртки поверх defaultGrid
myco.reset();
const s2 = myco.emitSignal('x', 'y', 'sync', { n: 1 });
ok('module emitSignal works', () => assert.strictEqual(s2.type, 'sync'));
ok('module route null for unknown', () => assert.strictEqual(myco.route('x', 'y').distance, 0));
myco.configure({ now: () => 42, ttl: 10 });
ok('configure injected now', () => assert.strictEqual(myco.emitSignal('x', 'y', 'ping', {}).at, 42));
ok('ttl from configure', () => assert.strictEqual(myco.emitSignal('x', 'y', 'ping', {}).ttl, 10));
ok('noop returns undefined', () => assert.strictEqual(myco.noop(), undefined));

// валидация аргументов
ok('throws on bad from', () => assert.throws(() => myco.emitSignal('', 'y', 'ping', {}), TypeError));

console.log('\n' + passed + ' checks passed');
