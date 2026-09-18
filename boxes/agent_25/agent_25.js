// agent_25.js — Гибрид: Аналитик (agent_3) + Хронометрист (agent_13)
// Стратегия: сначала анализирует (собирает данные, строит план),
// затем действует, с метриками и хронометражем каждого шага.

const loop = require('./agent_loop_v3');

const STRATEGY = 'hybrid-analyst-chronometrician: first analyze (search_code, git_diff, read), build plan, then act with timing metrics for each step';

async function runAgent(task) {
  const start = Date.now();
  try {
    const result = await loop.runWithCritic(task);
    const duration = Date.now() - start;
    if (result.ok) {
      return {
        ok: true,
        answer: result.answer,
        duration_ms: duration,
        critic: result.critic,
        strategy: STRATEGY
      };
    }
    return { ok: false, error: result.error || 'unknown', duration_ms: duration };
  } catch (e) {
    return { ok: false, error: e.message, duration_ms: Date.now() - start };
  }
}

module.exports = { runAgent, STRATEGY };
