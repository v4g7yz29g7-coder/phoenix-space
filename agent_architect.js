// Architect: на основе рекомендаций Прогнозиста меняет правила среды (SYSTEM_INSTRUCTIONS, TOOLS_SPEC).
const fs = require('fs');
const tools = require('./agent_tools');
const { createResponse } = require('./deepseek_responses');

const ARCHITECT_INSTRUCTIONS = `You are Architect. You receive insights from Prophet and decide how to modify the agent system.

Available modifications:
1. Update SYSTEM_INSTRUCTIONS in agent_responses.js
2. Update SYSTEM_INSTRUCTIONS in agent_critic.js
3. Add a new skill file in skills/

Reply ONLY with JSON:
{
  "action": "update_system" | "add_skill" | "no_action",
  "target": "agent_responses" | "agent_critic" | "skills",
  "patch": {
    "old": "exact fragment to replace",
    "new": "replacement"
  },
  "reasoning": "why this change",
  "risk": "low" | "medium" | "high"
}

Rules:
- Prefer "no_action" if risk > medium
- Patch must be a small, safe change
- For add_skill: provide filename and content instead`;

async function planChanges(insights, currentState) {
  const input = 'INSIGHTS:\n' + JSON.stringify(insights).slice(0, 4000) +
    '\n\nCURRENT STATE:\n' + JSON.stringify(currentState).slice(0, 2000);

  const response = await createResponse({
    model: 'deepseek-flash',
    instructions: ARCHITECT_INSTRUCTIONS,
    input: [{ role: 'user', content: input }]
  });

  let text = '';
  for (const item of response.output || []) {
    if (item.type === 'message' && item.content) {
      for (const part of item.content) {
        if (part.type === 'output_text') text += part.text;
      }
    }
  }

  const cleaned = text.replace(/```json|```/g, '').trim();
  let depth = 0, start = -1;
  for (let k = 0; k < cleaned.length; k++) {
    if (cleaned[k] === '{') { if (depth === 0) start = k; depth++; }
    else if (cleaned[k] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try { return JSON.parse(cleaned.slice(start, k + 1)); } catch (e) {}
        break;
      }
    }
  }
  return { action: 'no_action', error: 'parse failed', raw: text };
}

async function applyChange(plan, dryRun = true) {
  if (plan.action === 'no_action') return { ok: true, skipped: true, reason: plan.reasoning };
  if (plan.risk === 'high') return { ok: false, error: 'High risk - rejected', plan };
  if (dryRun) return { ok: true, dry_run: true, plan };

  const fileMap = {
    agent_responses: '/home/ishidin/phoenix/agent_responses.js',
    agent_critic: '/home/ishidin/phoenix/agent_critic.js'
  };

  if (plan.action === 'update_system' && fileMap[plan.target]) {
    const result = tools.editFile(fileMap[plan.target], plan.patch.old, plan.patch.new);
    if (result.error) return { ok: false, error: result.error, plan };
    // Проверка синтаксиса
    const check = await tools.runCommand('node --check ' + fileMap[plan.target]);
    if (check.error) {
      // откат
      tools.runCommand('git checkout ' + fileMap[plan.target]);
      return { ok: false, error: 'Syntax broken, rolled back', check };
    }
    return { ok: true, applied: plan, syntax: 'OK' };
  }

  if (plan.action === 'add_skill' && plan.patch) {
    let filePath = plan.patch.filename || plan.patch.path;
    if (!filePath) return { ok: false, error: 'No filename in patch', plan };
    // Всегда кладём в skills/, если не указан полный путь
    if (!filePath.startsWith('skills/') && !filePath.startsWith('/')) {
      filePath = 'skills/' + filePath;
    }
    const result = tools.writeFile(filePath, plan.patch.content || '');
    if (result.error) return { ok: false, error: result.error, plan };
    const check = await tools.runCommand('ls -la ' + filePath);
    return { ok: true, applied: plan, result, check: check.stdout };
  }

  // Graceful handling of any other action: log and skip
  return { ok: false, error: 'Unhandled action: ' + plan.action, plan, skipped: true };
}

module.exports = { planChanges, applyChange };
