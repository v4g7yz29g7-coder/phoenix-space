// agent_10.js — «Синтезатор» (Synthesizer)
//
// УНИКАЛЬНАЯ СТРАТЕГИЯ (её нет ни у одного из agent_1..agent_9):
// СИНТЕЗ ИЗ НЕСКОЛЬКИХ ПОДХОДОВ (multi-pass synthesis).
//
//   agent_1 Консерватор     — минимум изменений, edit вместо write;
//   agent_2 Новатор         — смелые эксперименты;
//   agent_3 Аналитик        — сначала сбор данных, потом действие;
//   agent_4 Скороход        — минимум шагов;
//   agent_5 Перфекционист   — внешняя проверка (node --check, тесты);
//   agent_6 Документатор    — подробный журнал в memory/;
//   agent_7 Диверсант       — обходные пути через exec;
//   agent_8 Адвокат дьявола — состязательная самофальсификация (атака СВОЕГО решения);
//   agent_9 Адаптивный дуэлянт — эскалация по score: второй проход только при score < 9;
//   agent_10 Синтезатор     — не выбирает между подходами и не атакует один из них:
//                             порождает ДВА независимых решения и ОБЪЕДИНЯЕТ лучшее
//                             из обоих в третьем, финальном решении.
//
// ТРИ ПРОХОДА:
//   1) БАЗОВЫЙ        — обычное решение задачи через agent_loop_v3;
//   2) АЛЬТЕРНАТИВНЫЙ — директива «предложи альтернативный подход, отличный от первого»:
//                       второй проход обязан пойти другим путём (другие инструменты,
//                       другая декомпозиция, другая структура результата);
//   3) СИНТЕЗ         — директива «объедини лучшее из обоих подходов»: третий проход
//                       видит оба решения и вердикты критика, сохраняет сильные места
//                       каждого и устраняет слабые/противоречия.
//
// Отличие от agent_8/agent_9: там второй проход атакует первое решение (adversarial),
// и на выход идёт ОДИН из двух. Здесь на выход идёт ТРЕТЬЕ, новое решение — гибрид.
// При провале синтеза — честный откат к лучшему из первых двух прогонов по score.
//
// Примечание: этот файл заменяет незавершённый скелет «Adaptive Duelist»
// (та стратегия полностью реализована в agent_9.js), поэтому имя agent_10
// отдано стратегии синтеза.

const loop = require('./agent_loop_v3');

const STRATEGY = 'synthesizer: pass1 base -> pass2 alternative approach -> pass3 merge best of both';

// Максимум символов одного ответа, встраиваемого в промпт следующего прохода
// (защита от переполнения контекста и от роста стоимости).
const MAX_EMBED_CHARS = 6000;

/**
 * Приводит результат прохода к тексту ответа (безопасно, с обрезкой).
 * @param {object|null} result — результат loop.runWithCritic.
 * @param {number} [limit] — максимальная длина.
 * @returns {string} текст ответа или пустая строка.
 */
function answerText(result, limit) {
  const max = (typeof limit === 'number') ? limit : MAX_EMBED_CHARS;
  if (!result || result.answer === undefined || result.answer === null) return '';
  const text = String(result.answer);
  return text.length > max ? text.slice(0, max) + '\n…[обрезано]' : text;
}

/**
 * Извлекает score критика из результата agent_loop_v3.
 * Score лежит либо в result.critic.score, либо в последней попытке
 * result.attempts[].critic.score (когда цикл исчерпал попытки).
 * @param {object|null} result — результат loop.runWithCritic.
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
 * Форматирует score для встраивания в промпт.
 * @param {number|null} score
 * @returns {string}
 */
function scoreLabel(score) {
  return (score === null || score === undefined) ? 'н/д' : String(score);
}

/**
 * Строит промпт второго прохода: АЛЬТЕРНАТИВНЫЙ подход, отличный от первого.
 * @param {string} originalPrompt — исходная задача пользователя.
 * @param {object|null} baseResult — результат первого прохода.
 * @returns {string} промпт второго прохода.
 */
function buildAlternativePrompt(originalPrompt, baseResult) {
  const baseAnswer = answerText(baseResult) || '(первый проход не дал ответа)';

  return [
    'Тебе дана задача и УЖЕ СУЩЕСТВУЮЩЕЕ решение (проход №1, подход A).',
    'ПРЕДЛОЖИ АЛЬТЕРНАТИВНЫЙ ПОДХОД, ОТЛИЧНЫЙ ОТ ПЕРВОГО:',
    '1) не повторяй подход A и не ограничивайся косметическими правками его текста;',
    '2) выбери другой способ решения: иные инструменты, иной порядок шагов, иная структура;',
    '3) если подход A решал «в лоб» — ищи более простое или более общее решение, и наоборот;',
    '4) явно назови, чем твой подход отличается от A и в чём он может быть сильнее;',
    '5) доведи альтернативу до готового рабочего результата (не набросок, не план).',
    'Оба подхода будут объединены в финальном проходе — действуй независимо и честно.',
    '',
    '=== ЗАДАЧА ===',
    String(originalPrompt),
    '',
    '=== ПОДХОД A (проход №1, score: ' + scoreLabel(extractScore(baseResult)) + ') — НЕ ПОВТОРЯТЬ ===',
    baseAnswer
  ].join('\n');
}

/**
 * Строит промпт третьего прохода: СИНТЕЗ — объединить лучшее из обоих подходов.
 * @param {string} originalPrompt — исходная задача пользователя.
 * @param {object|null} baseResult — результат первого (базового) прохода.
 * @param {object|null} altResult — результат второго (альтернативного) прохода.
 * @returns {string} промпт синтеза.
 */
function buildSynthesisPrompt(originalPrompt, baseResult, altResult) {
  const baseAnswer = answerText(baseResult) || '(нет результата)';
  const altAnswer = answerText(altResult) || '(нет результата)';

  return [
    'Ты — синтезатор. Ниже два независимых решения одной задачи, полученные РАЗНЫМИ подходами.',
    'ОБЪЕДИНИ ЛУЧШЕЕ ИЗ ОБОИХ ПОДХОДОВ в одно финальное решение:',
    '1) определи сильные стороны каждого подхода и сохрани их в итоге;',
    '2) определи слабые места и противоречия — устрани их, не наследуй их молча;',
    '3) не усредняй механически: там, где подходы расходятся, бери более правильный и проверяемый вариант;',
    '4) если один подход объективно слабее — возьми другой за основу, но перенеси из слабого всё ценное;',
    '5) верни САМОДОСТАТОЧНЫЙ доведённый результат, а не описание того, как его собрать.',
    '',
    '=== ЗАДАЧА ===',
    String(originalPrompt),
    '',
    '=== ПОДХОД A (проход №1, score: ' + scoreLabel(extractScore(baseResult)) + ') ===',
    baseAnswer,
    '',
    '=== ПОДХОД B (проход №2, альтернативный, score: ' + scoreLabel(extractScore(altResult)) + ') ===',
    altAnswer
  ].join('\n');
}

/**
 * Выбирает лучший результат из списка кандидатов: сначала по ok и непустому ответу,
 * затем по score критика (неизвестный score считается худшим).
 * @param {Array<{source: string, result: object|null}>} candidates
 * @returns {{source: string, result: object, score: number|null}|null}
 */
function pickBest(candidates) {
  let best = null;

  for (const c of candidates) {
    const r = c && c.result;
    if (!r || !r.ok) continue;
    if (answerText(r, 200) === '') continue;

    const score = extractScore(r);
    const rank = (score === null) ? -1 : score;

    if (best === null || rank > best.rank) {
      best = { source: c.source, result: r, score: score, rank: rank };
    }
  }

  if (best) delete best.rank;
  return best;
}

/**
 * Безопасный прогон одного прохода: ошибка прохода не роняет агента.
 * @param {string} prompt — промпт прохода.
 * @param {string} label — имя прохода для сообщения об ошибке.
 * @returns {Promise<object>} результат loop.runWithCritic либо { ok:false, error }.
 */
async function runPass(prompt, label) {
  try {
    const r = await loop.runWithCritic(prompt);
    return (r && typeof r === 'object') ? r : { ok: false, error: label + ': пустой результат' };
  } catch (e) {
    return { ok: false, error: label + ' threw: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * Точка входа агента: синтез из нескольких подходов (3 прохода).
 *
 *   Проход 1 — базовое решение (agent_loop_v3).
 *   Проход 2 — «предложи альтернативный подход, отличный от первого».
 *   Проход 3 — «объедини лучшее из обоих подходов» (синтез).
 *
 * На выход идёт результат синтеза; при его провале — откат к лучшему
 * из первых двух проходов по score критика.
 *
 * @param {string} prompt — задача пользователя.
 * @param {object} [options] — зарезервировано под расширения (совместимость с ареной).
 * @returns {Promise<object>} результат с метаданными всех проходов.
 */
async function runAgent(prompt, options = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, error: 'Empty prompt', strategy: STRATEGY };
  }

  const task = prompt.trim();

  // Проход №1 — базовое решение (исполнитель + критик внутри agent_loop_v3).
  const base = await runPass(task, 'Pass 1 (base)');

  // Проход №2 — альтернативный подход, отличный от первого.
  const alt = await runPass(buildAlternativePrompt(task, base), 'Pass 2 (alternative)');

  // Проход №3 — синтез: объединить лучшее из обоих подходов.
  const synth = await runPass(buildSynthesisPrompt(task, base, alt), 'Pass 3 (synthesis)');

  const baseAnswer = answerText(base);
  const altAnswer = answerText(alt);
  const synthAnswer = answerText(synth);

  const baseScore = extractScore(base);
  const altScore = extractScore(alt);
  const synthScore = extractScore(synth);

  const baseOk = !!(base && base.ok) && baseAnswer !== '';
  const altOk = !!(alt && alt.ok) && altAnswer !== '';
  const synthOk = !!(synth && synth.ok) && synthAnswer !== '';

  let answer = '';
  let phase = 'failed';
  let critic = null;
  let steps = [];
  let usedSource = null;

  if (synthOk) {
    // Основной путь: финальный результат — гибрид обоих подходов.
    answer = synthAnswer;
    phase = 'synthesized';
    critic = synth.critic || null;
    steps = synth.steps || [];
    usedSource = 'synthesis';
  } else {
    // Честный откат: лучший из двух независимых подходов по score критика.
    const best = pickBest([
      { source: 'base', result: base },
      { source: 'alternative', result: alt }
    ]);

    if (best) {
      answer = answerText(best.result);
      phase = best.source + '-fallback';
      critic = best.result.critic || null;
      steps = best.result.steps || [];
      usedSource = best.source;
    }
  }

  const ok = answer !== '';

  return {
    ok: ok,
    strategy: STRATEGY,
    phase: phase,
    used_source: usedSource,
    answer: answer,
    // Все три ответа наружу — для аудита и для чемпион-трекера.
    base_answer: baseAnswer,
    alternative_answer: altAnswer,
    synthesis_answer: synthAnswer,
    scores: { base: baseScore, alternative: altScore, synthesis: synthScore },
    critic: critic,
    steps: steps,
    // passes — сколько подходов реально внесло вклад; passes_run — сколько проходов запущено.
    passes: synthOk ? 3 : (usedSource ? 2 : 0),
    passes_run: 3,
    base_ok: baseOk,
    alternative_ok: altOk,
    synthesis_ok: synthOk
  };
}

module.exports = { runAgent, STRATEGY };
