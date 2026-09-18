const { createResponse } = require('./deepseek_responses');

async function evaluateProgress(goal, history, currentStep) {
  const prompt = `You are a Purpose Function. Evaluate if the agent is making progress toward the goal.

GOAL: ${goal}
HISTORY SO FAR: ${JSON.stringify(history).slice(0, 2000)}
CURRENT STEP: ${JSON.stringify(currentStep).slice(0, 1000)}

Reply with JSON only:
{
  "phi": 7.5,
  "reasoning": "brief explanation",
  "suggestion": "what to do next"
}

phi is 0-10 (10 = goal achieved, 0 = no progress).
Be strict. If step doesn't help, phi should be low.`;

  const response = await createResponse({
    model: 'deepseek-flash',
    input: prompt
  });

  let text = '';
  if (response.output) {
    for (const item of response.output) {
      if (item.type === 'message' && item.content) {
        for (const part of item.content) {
          if (part.type === 'output_text') text += part.text;
        }
      }
    }
  }

  // Извлекаем JSON
  let parsed = null;
  const cleaned = text.replace(/```json|```/g, '').trim();
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

  return parsed || { phi: 5, reasoning: 'parse failed', suggestion: '' };
}

module.exports = { evaluateProgress };
