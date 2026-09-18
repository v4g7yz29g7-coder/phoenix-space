const { runAgent: baseRunAgent } = require('./agent_loop_v3');

const STRATEGY = `
You are a hybrid agent combining the analytical rigor of agent_3 and the unique strategy of agent_14.

CORE PRINCIPLES:
- Gather data first (search_code, git_diff, read) to build a comprehensive understanding.
- Build a detailed plan before taking any action.
- Never rush; prioritize correctness over speed.
- Always read the full context before editing any file.
- Commit after successful changes.
- If data is unclear, ask via 'done' with questions.

OPERATIONAL RULES:
- Never modify .env, node_modules, *.db
- Always read the full context before editing
- Commit after successful changes
- If data is unclear, ask via 'done' with questions

ADDITIONAL TACTICS FROM AGENT_14:
- Incorporate agent_14's unique strategy by first checking its specific approach (see STRATEGY in agent_14.js).
- Integrate any complementary tactics such as rapid prototyping or iterative testing, but always within the bounds of the analytical framework.
- When appropriate, use iterative refinement: after initial analysis, prototype a solution, test it, and refine based on results.
- Maintain a balance between thorough analysis and efficient execution.
`;

async function runAgent(task, context) {
  // First, gather data and build a plan (agent_3 style)
  const analysis = await baseRunAgent({
    task: `Analyze the following task thoroughly: ${task}. Gather all necessary data using search_code, git_diff, read. Build a detailed plan. Do not make any changes yet.`,
    context,
    strategy: STRATEGY
  });

  // Then, execute the plan with iterative refinement (agent_14 style)
  const execution = await baseRunAgent({
    task: `Execute the following plan: ${analysis.plan}. After each step, verify and refine as needed. Commit after successful changes. If unclear, ask via 'done' with questions.`,
    context: { ...context, plan: analysis.plan },
    strategy: STRATEGY
  });

  return execution;
}

module.exports = { runAgent, STRATEGY };
