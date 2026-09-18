const { runAgentLoop } = require('./agent_loop_v3');

const STRATEGY = `You are agent_hybrid (Conservative-Adaptive). Strategy: minimum changes, always read before editing, prefer 'edit' over 'write'. Verify every change with node --check. When in doubt — stop and report. Additionally, adaptively break down tasks exceeding 60 seconds into smaller steps, and maintain a unique identity as agent_hybrid.`;

async function runAgent(task, context = {}) {
  const startTime = Date.now();
  const maxStepTime = 60000; // 60 seconds

  // Adaptive task decomposition
  const steps = [];
  let remainingTask = task;

  while (remainingTask) {
    const step = {
      description: `Step ${steps.length + 1}: ${remainingTask.slice(0, 100)}...`,
      action: 'process',
      payload: remainingTask
    };
    steps.push(step);

    // Simulate time check (in real implementation, this would be based on actual execution time)
    const elapsed = Date.now() - startTime;
    if (elapsed > maxStepTime) {
      // Break down further
      const mid = Math.floor(remainingTask.length / 2);
      remainingTask = remainingTask.slice(mid);
    } else {
      remainingTask = null;
    }
  }

  // Execute steps with conservative checks
  const results = [];
  for (const step of steps) {
    try {
      // Conservative: read before edit, verify with node --check
      const result = await runAgentLoop(step, {
        ...context,
        agentId: 'agent_hybrid',
        strategy: STRATEGY,
        conservative: true,
        verify: true
      });
      results.push(result);
    } catch (error) {
      // When in doubt — stop and report
      return {
        success: false,
        error: error.message,
        stepsCompleted: results.length,
        totalSteps: steps.length
      };
    }
  }

  return {
    success: true,
    results,
    stepsCompleted: results.length,
    totalSteps: steps.length
  };
}

module.exports = { runAgent, STRATEGY };