// agent_8.js — «Адвокат дьявола» (Devil's Advocate)
//
// УНИКАЛЬНАЯ СТРАТЕГИЯ (её нет ни у одного из agent_1..agent_7):
// СОСТЯЗАТЕЛЬНАЯ САМОФАЛЬСИФИКАЦИЯ.
// Агент не просто выполняет задачу и не просто проверяет результат снаружи —
// он сначала получает первое решение через agent_loop_v3, а затем сам
// становится противником собственного ответа: строит промпт-атаку, в котором
// ищет конкретные способы, которыми это решение может быть неверным
// (скрытые допущения, обойдённые требования задачи, непроверенные факты,
// отсутствующие шаги верификации). Это состязательное задание ещё раз
// прогоняется через agent_loop_v3 — и на выход отдаётся уже укреплённая
// версия, прошедшая атаку.
//
// Отличие от остальных стратегий:
//   agent_1 Консерватор   — минимум изменений, edit вместо write;
//   agent_2 Новатор       — смелые эксперименты;
//   agent_3 Аналитик      — сначала сбор данных, потом действие;
//   agent_4 Скороход      — минимум шагов;
//   agent_5 Перфекционист — внешняя проверка (node --check, тесты);
//   agent_6 Документатор  — подробный журнал в memory/;
//   agent_7 Диверсант     — обходные пути через exec.
// agent_8 атакует сам себя до тех пор, пока решение не выдержит атаку.

const loop = require('./agent_loop_v3');

const STRATEGY = 'devils-advocate: adversarial self-falsification';

const ADVERSARY_INSTRUCTIONS = [
  'Ты — противник приведённого ниже решения (адвокат дьявола).',
  'Не защищай его: найди конкретные причины, по которым оно НЕВЕРНО или НЕПОЛНО.',
  'Проверь по пунктам:',
  '1) все ли требования исходной задачи выполнены буквально;',
  '2) какие скрытые допущения сделаны и могут быть ложными;',
  '3) какие факты, пути к файлам или API не проверены;',
  '4) какие шаги верификации пропущены;',
  '5) что сломается в граничных случаях.',
  'Затем выполни исходную задачу заново с учётом найденных слабых мест',
  'и верни исправленное, укреплённое решение.'
].join('\n');

/**
 * Строит состязательный промпт: исходная задача + атакуемое решение.
 * @param {string} originalPrompt — исходная задача пользователя.
 * @param {object} baseResult — результат первого прогона agent_loop_v3.
 * @returns {string} промпт-атака для второго прогона.
 */
function buildFalsificationPrompt(originalPrompt, baseResult) {
  const answer = (baseResult && baseResult.answer) ? String(baseResult.answer) : '(решения нет)';
  const critic = (baseResult && baseResult.critic) ? JSON.stringify(baseResult.critic) : '{}';

  return [
    ADVERSARY_INSTRUCTIONS,
    '',
    '=== ИСХОДНАЯ ЗАДАЧА ===',
    originalPrompt,
    '',
    '=== АТАКУЕМОЕ РЕШЕНИЕ ===',
    answer,
    '',
    '=== ВЕРДИКТ ПЕРВОГО ПРОГОНА ===',
    critic
  ].join('\n');
}

/**
 * Точка входа агента.
 * Прогон №1 даёт базовое решение; прогон №2 атакует его как противник и
 * возвращает укреплённую версию. Если атака не удалась — честный откат к базе.
 * @param {string} prompt — задача пользователя.
 * @returns {Promise<object>} результат с метаданными обоих прогонов.
 */
async function runAgent(prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, error: 'Empty prompt', strategy: STRATEGY };
  }

  const task = prompt.trim();

  // Прогон №1 — базовое решение (исполнитель + критик внутри agent_loop_v3).
  const base = await loop.runWithCritic(task);
  const baseAnswer = (base && base.answer) ? String(base.answer) : '';

  // Прогон №2 — состязательная самофальсификация: агент атакует свой ответ.
  const attack = buildFalsificationPrompt(task, base);
  let hardened = null;
  try {
    hardened = await loop.runWithCritic(attack);
  } catch (e) {
    hardened = { ok: false, error: 'Adversary pass threw: ' + e.message };
  }

  const hardenedAnswer = (hardened && hardened.answer) ? String(hardened.answer) : '';
  const usedHardened = !!(hardened && hardened.ok && hardenedAnswer);

  const answer = usedHardened ? hardenedAnswer : baseAnswer;
  const baseOk = !!(base && base.ok);

  return {
    ok: (usedHardened || baseOk) && answer !== '',
    strategy: STRATEGY,
    phase: usedHardened ? 'hardened' : 'base-fallback',
    answer: answer,
    base_answer: baseAnswer,
    adversarial_critique: usedHardened ? (hardened.critic || null) : null,
    critic: usedHardened ? (hardened.critic || null) : ((base && base.critic) || null),
    steps: usedHardened ? (hardened.steps || []) : ((base && base.steps) || []),
    passes: usedHardened ? 2 : 1,
    base_ok: baseOk
  };
}

module.exports = { runAgent, STRATEGY };
