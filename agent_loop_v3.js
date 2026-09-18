const agentV2 = require('./agent_responses');
const critic = require('./agent_critic');
const tools = require('./agent_tools');
// Самовоспоминание (Гурджиев): каждые N шагов (по умолчанию N=3) агент
// задаёт себе мета-промпт «Что ты делаешь? Соответствует ли цели?».
// Факт самовоспоминания логируется с префиксом [SELFAWARE].
const selfaware = require('./selfaware');

const MAX_ATTEMPTS = 3;

async function runWithCritic(prompt) {
  const attempts = [];
  const goal = prompt;   // исходная цель — к ней возвращаем себя при самовоспоминании
  let step = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 0. Самовоспоминание: каждый N-й шаг — мета-промпт «Что ты делаешь?
    //    Соответствует ли цели?». Ответ встраивается в контекст исполнителя,
    //    а сам факт пишется в лог с префиксом [SELFAWARE].
    step += 1;
    const recall = selfaware.remind(step, {
      goal: goal,
      last: 'попытка исполнителя #' + attempt
    });
    if (recall) {
      prompt = prompt + '\n\n' + selfaware.PREFIX + ' ' + recall +
        '\nОтветь себе: (1) какое действие ты совершаешь сейчас, ' +
        '(2) приближает ли оно исходную цель. Если нет — скорректируй план.';
    }

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
