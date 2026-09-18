'use strict';
/* Self-test for tests/runner.js — verifies the runner actually runs tests. */

const { describe, it, before, after, beforeEach, assert, expect } = require('./runner.js');

describe('runner self-test', () => {
  let counter = 0;

  before(() => {
    counter = 0;
  });

  beforeEach(() => {
    counter += 1;
  });

  it('runs synchronous tests', () => {
    assert.strictEqual(1 + 1, 2);
  });

  it('supports deep equality', () => {
    assert.deepEqual({ a: [1, 2, { b: 3 }] }, { a: [1, 2, { b: 3 }] });
  });

  it('supports async tests', async () => {
    const value = await Promise.resolve(42);
    assert.strictEqual(value, 42);
  });

  it('applies beforeEach hooks', () => {
    expect(counter).toBeGreaterThan(0);
  });

  it('detects thrown errors', () => {
    assert.throws(() => {
      throw new TypeError('boom');
    }, TypeError);
  });

  it('handles rejected promises', async () => {
    await assert.rejects(Promise.reject(new Error('nope')), /nope/);
  });

  it.skip('is a skipped test', () => {
    assert.fail('should never run');
  });

  after(() => {
    assert.ok(true);
  });
});
