'use strict';

/**
 * Самовоспоминание (Гурджиев).
 *
 * Идея: агент, увлекаясь механикой шагов, теряет цель. Каждые N шагов он должен
 * «вспомнить себя» — задать себе мета-вопрос:
 *
 *     "Что ты делаешь? Соответствует ли цели?"
 *
 * Ответ на этот вопрос возвращается в контекст модели, а факт самовоспоминания
 * пишется в лог с префиксом [SELFAWARE].
 *
 * N по умолчанию = 3 (переопределяется через env SELFAWARE_N).
 */

const N = (function () {
  const raw = parseInt(process.env.SELFAWARE_N || '3', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
})();

const META_PROMPT = 'Что ты делаешь? Соответствует ли цели?';

const PREFIX = '[SELFAWARE]';

function log(message) {
  // Единая точка логирования — гарантирует префикс [SELFAWARE] на каждом событии.
  console.log(PREFIX + ' ' + message);
}

function truncate(value, max) {
  const s = value === undefined || value === null ? '' : String(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Нужно ли вспомнить себя на данном шаге.
 * step считается с 1 (первый шаг = 1), каждый N-й шаг — самовоспоминание.
 */
function shouldRecall(step, n) {
  const period = Number.isFinite(n) && n > 0 ? n : N;
  return step > 0 && step % period === 0;
}

/**
 * Возвращает текст мета-промпта, если на этом шаге пора вспомнить себя, иначе null.
 * Побочный эффект: пишет строку [SELFAWARE] в лог.
 *
 * @param {number} step — текущий номер шага (1-based)
 * @param {{goal?:string, last?:string, extra?:string}} [ctx] — контекст для аудита
 */
function remind(step, ctx) {
  if (!shouldRecall(step)) return null;

  const goal = truncate(ctx && ctx.goal ? ctx.goal : '(цель не задана)', 160);
  const last = truncate(ctx && ctx.last ? ctx.last : '(нет предыдущего действия)', 160);

  log('шаг ' + step + ': «' + META_PROMPT + '»');
  log('  цель : ' + goal);
  log('  делаю: ' + last);

  return META_PROMPT;
}

/**
 * Инжектит мета-промпт в массив сообщений агента (input) и возвращает true,
 * если вставка произошла. Безопасен к некорректному input.
 */
function inject(step, input, ctx) {
  const text = remind(step, ctx);
  if (!text) return false;

  if (Array.isArray(input)) {
    input.push({
      role: 'user',
      content: PREFIX + ' ' + text +
        '\nОтветь одной-двумя строками: (1) какое действие ты только что совершил, ' +
        '(2) приближает ли оно исходную цель. Если нет — скорректируй план.'
    });
  }
  return true;
}

module.exports = {
  N: N,
  META_PROMPT: META_PROMPT,
  PREFIX: PREFIX,
  log: log,
  shouldRecall: shouldRecall,
  remind: remind,
  inject: inject
};
