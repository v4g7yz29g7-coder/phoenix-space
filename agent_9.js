// agent_9.js — «Адаптивный дуэлянт» (Adaptive Duelist)
//
// УНИКАЛЬНАЯ СТРАТЕГИЯ (гибрид agent_7 + agent_8, её нет ни у одного из agent_1..agent_8):
// АДАПТИВНАЯ ЭСКАЛАЦИЯ ПО ОЦЕНКЕ КРИТИКА.
//
// Стратегия строится на трёх правилах:
//   1) ПЕРВЫЙ ПРОХОД — дешёвый и быстрый: минимальный бюджет инструментов
//      (в духе agent_7 «Диверсанта», самого быстрого агента арены: 15.4s avg).
//   2) Если критик поставил score < THRESHOLD (9) — БОЛЬШОЙ ВТОРОЙ ПРОХОД:
//      агент атакует собственное решение как адвокат дьявола (как agent_8)
//      и отдаёт укреплённую версию.
//   3) Если score >= THRESHOLD — агент не тратит бюджет на второй проход
//      и возвращает первый результат СРАЗУ.
//
// Итог: агент платит за дорогую самоатаку только тогда, когда дешёвый проход
// её не оправдал. Это «дуэль»: первый раунд — разведка, второй — только при
// необходимости.
//
// Отличие от остальных стратегий:
//   agent_1 Консерватор   — минимум изменений, edit вместо write;
//   agent_2 Новатор       — смелые эксперименты;
//   agent_3 Аналитик      — сначала сбор данных, потом действие;
//   agent_4 Скороход      — минимум шагов;
//   agent_5 Перфекционист — внешняя проверка (node --check, тесты);
//   agent_6 Документатор  — подробный журнал в memory/;
//   agent_7 Диверсант     — обходные пути через exec;
//   agent_8 Адвокат дьявола — состязательная самофальсификация на каждом запуске;
// agent_9 объединяет их: дешёвый проход agent_7, эскалация в agent_8 по score.
//
// ВАЖНО: agent_loop_v3.runWithCritic(prompt) не принимает параметр бюджета,
// поэтому «минимальный бюджет» задаётся директивой внутри промпта первого
// прохода (MINIMAL_TOOL_BUDGET). Второй проход — состязательный (self-attack).

const loop = require('./agent_loop_v3');

const STRATEGY = 'adaptive-duelist: minimal first pass, escalate to self-attack only if score < 9';

// Порог: при score >= THRESHOLD второй проход не запускается.
const SCORE_THRESHOLD = 9;

// Лимит инструментов, навязываемый промптом первого (дешёвого) прохода.
const MINIMAL_TOOL_BUDGET = 2;

/**
 * Строит промпт первого прохода: быстрый, с жёстким лимитом инструментов.
 * @param {string} prompt — исходная задача пользователя.
 * @returns {string} промпт дешёвого прохода.
 */
function buildMinimalPrompt(prompt) {
  return [
    'Реши задачу БЫСТРО и ЭКОНОМНО (режим разведки, как agent_7).',
    'Жёсткие ограничения первого прохода:',
    '1) не более ' + MINIMAL_TOOL_BUDGET + ' вызовов инструментов за всё решение;',
    '2) никаких повторных чтений, лишних проверок и промежуточных отчётов;',
    '3) только действия, напрямую приближающие результат;',
    '4) верни сразу готовый результат, без описания процесса.',
    'Точность важнее объёма: решение будет проверено критиком.',
    '',
    '=== ЗАДАЧА ===',
    String(prompt)
  ].join('\n');
}

/**
 * Извлекает score критика из результата agent_loop_v3.
 * Score лежит либо в result.critic.score, либо в последней попытке
 * result.attempts[].critic.score (когда цикл исчерпал попытки).
 * @param {object} result — результат loop.runWithCritic.
 * @returns {number|null} score 1..10 либо null, если оценка недоступна.
 */
function extractScore(result) {
  if (!result) return null;

  // Основной путь: критик одобрил/отклонил на верхнем уровне результата.
  if (result.critic && typeof result.critic.score === 'number') {
    return result.critic.score;
  }

  // Резервный путь: цикл исчерпал попытки, оценка осталась в attempts.
  if (Array.isArray(result.attempts)) {
    for (let i = result.attempts.length - 1; i >= 0; i--) {
      const c = result.attempts[i] && result.attempts[i].critic;
      if (c && typeof c.score === 'number') return c.score;
    }
  }

  // Оценки нет (например, критик не смог проверить) — считаем её неизвестной.
  return null;
}

/**
 * Строит состязательный промпт второго прохода (self-attack, как agent_8).
 * @param {string} originalPrompt — исходная задача пользователя.
 * @param {object} baseResult — результат первого прохода.
 * @returns {string} промпт-атака для второго прохода.
 */
function buildFalsificationPrompt(originalPrompt, baseResult) {
  /* TODO */
}

/**
 * «Дуэль»: выбирает лучший из двух результатов по score критика.
 * @param {object} base — результат первого прохода.
 * @param {object|null} hardened — результат второго (состязательного) прохода.
 * @returns {object} { result, source, baseScore, hardenedScore }
 */
function pickWinner(base, hardened) {
  /* TODO */
}

/**
 * Точка входа агента: адаптивная эскалация по оценке критика.
 * @param {string} prompt — задача пользователя.
 * @param {object} [options] — { threshold } переопределяет SCORE_THRESHOLD.
 * @returns {Promise<object>} результат с метаданными обоих проходов.
 */
async function runAgent(prompt, options = {}) {
  /* TODO */
}

module.exports = { runAgent, STRATEGY };
