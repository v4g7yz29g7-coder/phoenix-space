// self_awareness.js — «Самовоспоминание» (Г. И. Гурджиев).
//
// Идея: система (агент/директор) периодически «просыпается» и задаёт себе
// мета-промпт, возвращая себя к цели, а не к механическому выполнению шагов.
//
//   каждые N шагов →
//       «Что ты делаешь? Соответствует ли цели?»
//
// Все записи самовоспоминания пишутся в лог с префиксом [SELFAWARE].
// N берётся из окружения (SELFAWARE_N), по умолчанию 3.
'use strict';

const DEFAULT_EVERY = parseInt(process.env.SELFAWARE_N || '3', 10) || 3;

const META_PROMPT = 'Что ты делаешь? Соответствует ли цели?';

/**
 * Фабрика счётчика самовоспоминания.
 * @param {object} [opts]
 * @param {number} [opts.every=N]     — каждые сколько шагов «вспоминать»
 * @param {string|function} [opts.goal] — цель (строка или функция, вызываемая на каждом reflections)
 * @param {function} [opts.log]       — функция логирования (по умолчанию console.log)
 * @param {string} [opts.prefix]      — префикс лога (по умолчанию [SELFAWARE])
 */
function createSelfAwareness(opts = {}) {
  const every = Math.max(1, parseInt(opts.every, 10) || DEFAULT_EVERY);
  const log = typeof opts.log === 'function' ? opts.log : console.log;
  const prefix = opts.prefix || '[SELFAWARE]';
  const counters = new Map();

  function resolveGoal() {
    try {
      const g = typeof opts.goal === 'function' ? opts.goal() : opts.goal;
      return g ? String(g) : '(цель не задана)';
    } catch (e) {
      return '(цель недоступна)';
    }
  }

  /**
   * Зафиксировать один шаг. Каждый N-й шаг — мета-промпт самовоспоминания.
   * @param {string} [scope='default'] — область/поток (своя нумерация шагов)
   * @param {string} [action='']       — что именно делается на этом шаге
   * @param {object} [meta]            — доп. данные (detail и т.п.)
   * @returns {{n:number, reflect:boolean}}
   */
  function step(scope = 'default', action = '', meta = null) {
    const key = String(scope || 'default');
    const n = (counters.get(key) || 0) + 1;
    counters.set(key, n);

    if (n % every !== 0) return { n, reflect: false };

    const actionText = action ? String(action) : '(действие не указано)';
    const detail = meta && meta.detail ? String(meta.detail) : '';
    log(`${prefix} шаг ${n}: ${META_PROMPT}`);
    log(`${prefix}   цель: ${resolveGoal()}`);
    log(`${prefix}   сейчас: ${actionText}${detail ? ' — ' + detail : ''}`);
    return { n, reflect: true };
  }

  function reset(scope = 'default') {
    counters.delete(String(scope || 'default'));
  }

  function count(scope = 'default') {
    return counters.get(String(scope || 'default')) || 0;
  }

  return { step, reset, count, every, prefix, META_PROMPT };
}

// Общий (singleton) экземпляр для тех, кому нужен просто счётчик.
const shared = createSelfAwareness();

/** Удобная обёртка над shared.step. */
function selfRemember(scope, action, meta) {
  return shared.step(scope, action, meta);
}

module.exports = {
  createSelfAwareness,
  selfRemember,
  shared,
  META_PROMPT,
  DEFAULT_EVERY,
  N: DEFAULT_EVERY,
};
