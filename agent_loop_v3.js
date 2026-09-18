const agentV2 = require('./agent_responses');
const critic = require('./agent_critic');
const tools = require('./agent_tools');

const MAX_ATTEMPTS = 3;

async function runWithCritic(prompt) {
  const attempts = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 1. Исполнитель делает работу
    const execResult = await agentV2.runAgent(prompt);

    if (!execResult.ok) {
      return { ok: false, error: 'Executor failed', attempt: attempt, result: execResult, attempts: attempts };
    }

    // 2. Критик проверяет
    const criticResult = await critic.verify(prompt, execResult);

    attempts.push({
      attempt: attempt,
      executor: { answer: execResult.answer, steps: execResult.steps },
      critic: criticResult.verdict || { error: criticResult.error }
    });

    if (!criticResult.ok) {
      // Критик не смог проверить - возвращаем как есть
      return { ok: false, error: 'Critic failed', attempts: attempts };
    }

    // 3. Если Критик одобрил - возвращаем
    if (criticResult.verdict.verdict === 'approve') {
      return {
        ok: true,
        answer: execResult.answer,
        steps: execResult.steps,
        critic: criticResult.verdict,
        attempts: attempts
      };
    }

    // 4. Если отклонил - пробуем снова с учётом замечаний
    console.log('Attempt ' + attempt + ' rejected by critic. Score: ' + criticResult.verdict.score);
    console.log('Issues: ' + JSON.stringify(criticResult.verdict.issues));

    // Обогащаем промпт для следующей попытки
    prompt = prompt + '\n\n[CRITIC FEEDBACK from attempt ' + attempt + ']:\n' +
      'Score: ' + criticResult.verdict.score + '\n' +
      'Issues: ' + (criticResult.verdict.issues || []).join('; ') + '\n' +
      'Please fix these issues.';
  }

  return { ok: false, error: 'Max attempts reached', attempts: attempts };
}

module.exports = { runWithCritic };
