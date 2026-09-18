'use strict';
// Self-test for sensors/sensor_fusion.js
const SF = require('./sensor_fusion.js');
const assert = require('assert');

assert.strictEqual(typeof SF.fuse, 'function', 'fuse must be a function');

const scalar = SF.fuse([
  { id: 'a', value: 10, variance: 1 },
  { id: 'b', value: 12, variance: 1 },
]);
assert.ok(scalar.ok, 'scalar fusion ok');
assert.ok(Math.abs(scalar.value - 11) < 1e-9, 'scalar mean ~11, got ' + scalar.value);

const vec = SF.fuse([
  { id: 'v1', value: [1, 2, 3], variance: [1, 1, 1] },
  { id: 'v2', value: [1.1, 2.2, 2.9], variance: [0.5, 0.5, 0.5] },
]);
assert.ok(vec.ok, 'vector fusion ok');
assert.strictEqual(vec.value.length, 3, 'vector dim 3');

const obj = SF.fuse([
  { id: 'o1', value: { x: 1, y: 2 }, variance: { x: 1, y: 1 } },
  { id: 'o2', value: { x: 3, y: 4 }, variance: { x: 1, y: 1 } },
]);
assert.ok(obj.ok, 'object fusion ok');
assert.ok(Math.abs(obj.value.x - 2) < 1e-9, 'object x ~2');

const st = SF.selfTest();
assert.ok(st.ok, 'selfTest ok');

const empty = SF.fuse([]);
assert.strictEqual(empty.ok, false, 'empty -> ok false');

const health = SF.health();
assert.strictEqual(health.ok, true, 'health ok');

console.log(JSON.stringify({ ok: true, scalar: scalar.value, vec: vec.value, obj: obj.value, health: health.version }, null, 2));
