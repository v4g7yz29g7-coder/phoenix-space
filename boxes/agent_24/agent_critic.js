const { createResponse } = require('./deepseek_responses');
const tools = require('./agent_tools');
const fs = require('fs');

const CRITIC_INSTRUCTIONS = `You are a strict Critic agent. Your job is to verify the work of another agent.

You will receive:
1. The original task/prompt
2. The result produced (answer + list of tool calls made)

You must evaluate the result using these criteria:
- SYNTAX: Did any file changes break syntax? (use exec with 'node --check' if files changed)
- RUNTIME: Is the aeon_agents process still running? (use exec with 'pm2 list')
- COMPLETENESS: Was the original task fully solved?
- SAFETY: Were .env, node_modules, or *.db files touched?
- REVERSIBILITY: Was a git commit made if files changed?

Respond ONLY with valid JSON in this exact format:
{
  "score": 7,
  "verdict": "approve",
  "issues": ["issue 1", "issue 2"],
  "summary": "brief summary in Russian"
}

Rules:
- score is 1-10 (10 = perfect, 1 = catastrophic)
- verdict is "approve" if score >= 7, else "reject"
- issues is a list of concrete problems (empty if none)
- summary is one sentence in Russian describing your verdict
- Be STRICT. If unsure, reject.
- You have tools: exec(cmd) for verification. Use them before judging.`;

const TOOLS_SPEC = [
  {
    type: 'function',
    name: 'exec',
    description: 'Execute bash command for verification',
    parameters: {
      type: 'object',
      properties: { cmd: { type: 'string' } },
      required: ['cmd']
    }
  }
];

async function executeTool(name, args) {
  try {
    if (name === 'exec') return await tools.runCommand(args.cmd);
    return { error: 'Unknown tool: ' + name };
  } catch (e) {
    return { error: e.message };
  }
}

async function verify(prompt, result) {
  const taskSummary = 'TASK: ' + prompt + '\n\n' +
    'RESULT: ' + (result.answer || '(no answer)') + '\n\n' +
    'TOOL CALLS:\n' + JSON.stringify(result.steps || [], null, 2);

  const input = [{ role: 'user', content: taskSummary }];
  const log = [];

  for (let step = 0; step < 10; step++) {
    const response = await createResponse({
      model: 'deepseek-flash',
      instructions: CRITIC_INSTRUCTIONS,
      input: input,
      tools: TOOLS_SPEC,
      tool_choice: 'auto'
    });

    if (!response.output || !Array.isArray(response.output)) {
      return { ok: false, error: 'No output from critic', raw: response };
    }

    input.push(...response.output);

    const functionCalls = response.output.filter(item => item.type === 'function_call');

    if (functionCalls.length === 0) {
      // Финальный ответ критика
      let finalText = '';
      for (const item of response.output) {
        if (item.type === 'message' && item.content) {
          for (const part of item.content) {
            if (part.type === 'output_text') finalText += part.text;
          }
        }
      }

      // Парсим JSON из ответа
      let parsed = null;
      const cleaned = finalText.replace(/```json|```/g, '').trim();
      let depth = 0, start = -1;
      for (let k = 0; k < cleaned.length; k++) {
        if (cleaned[k] === '{') { if (depth === 0) start = k; depth++; }
        else if (cleaned[k] === '}') {
          depth--;
          if (depth === 0 && start !== -1) {
            try { parsed = JSON.parse(cleaned.slice(start, k + 1)); } catch (e) {}
            break;
          }
        }
      }

      if (!parsed) {
        return { ok: false, error: 'Critic did not return valid JSON', raw: finalText };
      }

      return { ok: true, verdict: parsed, log: log };
    }

    // Выполняем проверки через exec
    for (const call of functionCalls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch (e) {}
      const result = await executeTool(call.name, args);
      log.push({ step: step, tool: call.name, cmd: args.cmd, ok: !result.error });

      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result).slice(0, 8000)
      });
    }
  }

  return { ok: false, error: 'Critic max steps exceeded', log: log };
}

module.exports = { verify };
