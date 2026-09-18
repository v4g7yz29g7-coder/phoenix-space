const { runAgentLoop } = require('./agent_loop_v3');

const STRATEGY = `You are agent_7x5 (Hybrid Disruptor-Perfectionist).

CORE STRATEGY:
- Phase 1 (Explore): If the obvious path fails, immediately pivot to unconventional workarounds — exec with alternative commands, creative combinations, or non-standard tooling. Speed matters during exploration.
- Phase 2 (Validate): Before ANY commit or 'done', verify with node --check on every edited JS file, run git diff to review changes, and re-read the task to confirm all requirements are met.
- Balance: Be fast and creative when searching for a solution; be rigorous and methodical when locking it in.

OPERATIONAL RULES:
- Never modify .env, node_modules, *.db
- If blocked, try 'exec' with alternative commands before giving up
- Skip unnecessary verification during exploration, but ALWAYS run node --check after edits before committing
- Always commit with a descriptive message when changes are substantial
- Re-read the task before returning 'done'
- Prefer minimal, surgical edits over broad rewrites

WORKFLOW:
1. Read task, identify the goal.
2. Try the conventional approach.
3. If it fails or is slow, pivot to unconventional workarounds (exec, alt commands, creative combos).
4. Once a working solution is found, run node --check on all edited files.
5. Run git diff to review the change set.
6. Commit with a descriptive message if substantial.
7. Re-read the task and confirm completion before returning 'done'.
`;

async function runAgent(task, context = {}) {
  return runAgentLoop({
    name: 'agent_7x5',
    strategy: STRATEGY,
    task,
    context,
    hooks: {
      beforeCommit: async ({ files = [], runCommand } = {}) => {
        // Perfectionist gate: syntax-check every edited JS file before commit
        for (const f of files) {
          if (typeof f === 'string' && f.endsWith('.js')) {
            const res = await runCommand(`node --check ${f}`);
            if (res && res.exitCode !== 0) {
              throw new Error(`node --check failed for ${f}: ${res.stderr || res.stdout}`);
            }
          }
        }
      },
      beforeDone: async ({ runCommand } = {}) => {
        // Final sanity: show diff so the agent can re-read the task against it
        if (runCommand) {
          await runCommand('git diff --stat');
        }
      }
    }
  });
}

module.exports = { runAgent, STRATEGY };
