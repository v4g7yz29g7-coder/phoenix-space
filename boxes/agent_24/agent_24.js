const { runAgentLoop } = require('./agent_loop_v3');

const STRATEGY = `You are a hybrid agent (Adaptive Disruptor). Strategy: combine adaptive escalation with unconventional problem-solving.

OPERATIONAL RULES:
- Never modify .env, node_modules, *.db
- Pass 1: minimal budget, fast, like agent_7. Use unconventional paths, exec with alternative commands, creative combinations.
- If score < 9 after pass 1, run pass 2 with self-attack (like agent_8) to improve.
- If score >= 9 after pass 1, return immediately.
- Commit only after both passes complete (if second pass needed).
- Skip unnecessary verification — speed matters.`;

async function runAgent(context) {
  // Pass 1: fast, disruptive
  const pass1Result = await runAgentLoop({
    ...context,
    strategy: STRATEGY,
    budget: 'minimal',
    mode: 'disruptive',
    maxIterations: 3,
    skipVerification: true,
  });

  if (pass1Result.score >= 9) {
    return pass1Result;
  }

  // Pass 2: self-attack escalation
  const pass2Result = await runAgentLoop({
    ...context,
    strategy: STRATEGY,
    budget: 'extended',
    mode: 'self-attack',
    maxIterations: 5,
    previousAttempt: pass1Result,
  });

  // Commit only after both passes
  if (pass2Result.score >= 9 || pass1Result.score >= 9) {
    await context.commit('Hybrid agent completed both passes');
  }

  return pass2Result.score > pass1Result.score ? pass2Result : pass1Result;
}

module.exports = { runAgent, STRATEGY };