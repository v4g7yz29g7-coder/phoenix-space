// Pilot: Orchestrator. Бьёт большую цель на подзадачи, запускает Исполнителя, следит за прогрессом.
const agentV2 = require('./agent_responses');
const critic = require('./agent_critic');
const purpose = require('./agent_purpose');
const fs = require('fs');

const MAX_SUBTASKS = 5;
const PROGRESS_THRESHOLD = 6;

const PILOT_INSTRUCTIONS = `You are Pilot, an orchestrator. Break a big goal into 3-5 concrete subtasks.

Each subtask must be:
- Executable by another agent with tools: read, write, edit, exec, commit, search_code, git_diff, web_search
- Self-contained (no dependency on user input)
- Verifiable (Critic can check it)

Reply ONLY with JSON:
{
  "subtasks": [
    {"id": 1, "goal": "concrete task in Russian", "verify": "how Critic should verify"},
    {"id": 2, "goal": "...", "verify": "..."}
  ],
  "reasoning": "brief strategy explanation"
}

Rules:
- Maximum 5 subtasks
- Order matters: 1st must be possible without others
- Be specific: "add route X to file Y" not "improve system"`;

async function decompose(goal) {
  const { createResponse } = require('./deepseek_responses');
  const response = await createResponse({
    model: 'deepseek-flash',
    instructions: PILOT_INSTRUCTIONS,
    input: [{ role: 'user', content: 'BIG GOAL: ' + goal }]
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
  return { subtasks: [], error: 'pilot parse failed', raw: text };
}

async function sleepProtocol(prompt, result, changedTools) {
  // Рефлексия: записываем паттерн успеха/провала
  const today = new Date().toISOString().split('T')[0];
  const ts = Date.now();
  const dir = '/home/ishidin/phoenix/memory/patterns';
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}

  const verdict = result.critic && result.critic.verdict;
  const success = result.ok && verdict === 'approve';
  const file = dir + '/' + (success ? 'success_' : 'failure_') + ts + '.json';

  const pattern = {
    ts: new Date().toISOString(),
    prompt: prompt.slice(0, 300),
    ok: result.ok,
    score: verdict && verdict.score,
    issues: (verdict && verdict.issues) || [],
    tools_used: (changedTools || []).map(t => t.tool),
    answer_preview: (result.answer || '').slice(0, 200)
  };

  try { fs.writeFileSync(file, JSON.stringify(pattern, null, 2)); } catch (e) {}

  return { pattern_file: file, success };
}

async function runPilot(bigGoal) {
  const log = { goal: bigGoal, subtasks: [], results: [], summary: '' };

  // 1. Декомпозиция
  const plan = await decompose(bigGoal);
  if (!plan.subtasks || plan.subtasks.length === 0) {
    return { ok: false, error: 'Pilot could not decompose', plan };
  }
  log.subtasks = plan.subtasks;
  log.pilot_reasoning = plan.reasoning;

  // 2. Выполняем каждую подзадачу через Loop v3
  const agentV3 = require('./agent_loop_v3');
  for (const st of plan.subtasks.slice(0, MAX_SUBTASKS)) {
    const subResult = await agentV3.runWithCritic(st.goal);

    // 3. Оцениваем прогресс
    const progress = await purpose.evaluateProgress(bigGoal, log.results, {
      subtask: st.goal,
      result: subResult.answer
    });

    log.results.push({
      subtask_id: st.id,
      goal: st.goal,
      ok: subResult.ok,
      critic_score: subResult.critic && subResult.critic.score,
      phi: progress.phi,
      reasoning: progress.reasoning
    });

    // 4. Sleep Protocol — записываем паттерн
    const allSteps = (subResult.attempts || []).flatMap(a => (a.executor && a.executor.steps) || []);
    const changed = allSteps.filter(s => ['write', 'edit'].includes(s.tool) && s.ok);
    await sleepProtocol(st.goal, subResult, changed);

    // 5. Если прогресс низкий — прерываем
    if (progress.phi < PROGRESS_THRESHOLD) {
      log.summary = 'Pilot stopped: low progress (' + progress.phi + ') on subtask ' + st.id;
      return { ok: false, pilot: log, stopped_at: st.id };
    }
  }

  log.summary = 'Pilot completed ' + log.results.length + ' subtasks';
  return { ok: true, pilot: log };
}

module.exports = { runPilot, decompose, sleepProtocol };
