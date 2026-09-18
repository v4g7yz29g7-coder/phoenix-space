'use strict';

/**
 * observability/agent_health.smoke.js
 * ---------------------------------------------------------------------------
 * Smoke test for `checkAll()` from ./agent_health.
 *
 * Run with:  node observability/agent_health.smoke.js
 *
 * It exercises the public API deterministically by overriding the clock
 * (`options.now`) so results do not depend on wall-clock timing.
 * ---------------------------------------------------------------------------
 */

const assert = require('assert');
const health = require('./agent_health');

const {
  checkAll,
  registerAgent,
  heartbeat,
  listAgents,
  STATUS,
} = health;

function main() {
  const t0 = Date.now();

  // 1. API surface.
  assert.strictEqual(typeof checkAll, 'function', 'checkAll must be a function');
  assert.strictEqual(typeof registerAgent, 'function', 'registerAgent must be a function');
  assert.strictEqual(typeof heartbeat, 'function', 'heartbeat must be a function');

  // 2. Register a healthy agent and a stale/erroring one.
  registerAgent({
    id: 'smoke-healthy',
    name: 'healthy',
    heartbeatTtlMs: 30000,
    lastHeartbeat: t0,
    errorRate: 0,
    pending: 0,
  });

  registerAgent({
    id: 'smoke-degraded',
    name: 'degraded',
    heartbeatTtlMs: 30000,
    lastHeartbeat: t0 - 120000,
    errorRate: 0.3,
    pending: 300,
  });

  // 3. checkAll must return a report object.
  const report = checkAll({ now: t0 });
  assert.ok(report && typeof report === 'object', 'report must be an object');
  assert.ok(typeof report.generatedAt === 'string', 'generatedAt must be an ISO string');
  assert.ok(Array.isArray(report.agents), 'report.agents must be an array');
  assert.ok(Number.isFinite(report.total), 'report.total must be a number');
  assert.ok(report.byStatus && typeof report.byStatus === 'object', 'byStatus must be an object');

  // 4. Each agent report has the expected shape.
  for (const a of report.agents) {
    assert.ok(typeof a.id === 'string', 'agent.id must be a string');
    assert.ok(Array.isArray(a.checks), 'agent.checks must be an array');
    assert.ok(Object.prototype.hasOwnProperty.call(report.byStatus, a.status) ||
      report.byStatus[a.status] !== undefined, 'status must be tracked');
  }

  // 5. The stale agent must not be reported as fully healthy.
  const degraded = report.agents.find((a) => a.id === 'smoke-degraded');
  assert.ok(degraded, 'smoke-degraded must be present in the report');
  assert.notStrictEqual(degraded.status, STATUS.OK, 'stale agent must not be OK');

  // 6. heartbeat() must refresh liveness.
  heartbeat('smoke-degraded', { errorRate: 0, pending: 0 });
  const report2 = checkAll({ now: Date.now() });
  const refreshed = report2.agents.find((a) => a.id === 'smoke-degraded');
  assert.ok(refreshed, 'refreshed agent must exist');
  assert.ok(refreshed.heartbeatAgeMs <= 5000, 'fresh heartbeat must be recent');

  // 7. Registry listing is stable.
  assert.ok(listAgents().length >= 2, 'at least the two smoke agents must be registered');

  process.stdout.write('agent_health smoke: OK (' + report.agents.length + ' agents checked)\n');
}

main();
