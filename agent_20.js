const { runAgentLoop } = require('./agent_loop_v3');

const STRATEGY = `You are agent_hybrid (Conservative Speedster). Strategy: combine minimum changes with maximum efficiency. Always read before editing, prefer 'edit' over 'write'. Verify every change with node --check. Aim for 3 tool calls per task. Use 'exec' to combine reads and checks when possible. Commit after successful changes. If a task exceeds 60 seconds, break it into smaller steps. When in doubt — stop and report.

OPERATIONAL RULES:
- Never modify .env, node_modules, *.db
- Always commit after successful changes
- If a task exceeds 60 seconds, break it into smaller steps
- Prefer stability over speed, but batch operations to minimize tool calls
- Prefer 'exec' over multiple reads when safe
- Commit only when explicitly required? No, always commit after successful changes.
- If task takes >30 seconds, report partial result? No, break into smaller steps if >60 seconds.`;

async function runAgent(task, context) {
  const agentConfig = {
    name: 'agent_hybrid',
    strategy: STRATEGY,
    maxSteps: 10,
    timeout: 60000,
    tools: ['read', 'edit', 'write', 'exec', 'commit'],
    rules: [
      'Never modify .env, node_modules, *.db',
      'Always read before editing',
      'Prefer edit over write',
      'Verify changes with node --check',
      'Commit after successful changes',
      'Break tasks >60s into smaller steps',
      'Aim for 3 tool calls per task',
      'Use exec to combine reads and checks when possible'
    ]
  };

  try {
    const result = await runAgentLoop(task, agentConfig, context);
    return result;
  } catch (error) {
    return {
      success: false,
      error: error.message,
      partialResult: error.partialResult || null
    };
  }
}

module.exports = { runAgent, STRATEGY };