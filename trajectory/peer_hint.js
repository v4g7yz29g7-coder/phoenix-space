'use strict';

/**
 * trajectory/peer_hint.js
 * ============================================================================
 * Подсказки лидера отстающему участнику гонки AI-агентов.
 *
 * ФИЛОСОФИЯ — «направление, а не решение»
 * --------------------------------------
 * Лидер никогда не отдаёт follower'у готовый ответ: ни координат, ни
 * победного хода, ни копируемого действия, ни целевого счёта. Лидер лишь
 * указывает направление и тот фрагмент реальности, которым follower уже
 * владеет. Решение остаётся за follower:
 *
 *   hint      — направляющая фраза («посмотри сюда», «смени угол»);
 *   reference — ориентир, который follower может изучить сам;
 *   trigger   — наблюдаемое условие, КОГДА действовать.
 *
 * ПУБЛИЧНЫЙ API
 * -------------
 *   const { suggestHint } = require('./trajectory/peer_hint');
 *   const { hint, reference, trigger } = suggestHint(leader, follower, raceState);
 *
 *   leader    : { id?, name?, lap?, progress?, speed?, step?, history? }
 *   follower  : { id?, name?, lap?, progress?, speed?, step?, history? }
 *   raceState : {
 *                 raceId?, totalLaps?, elapsed?,
 *                 track?:       [{ id, label, progress }],
 *                 tickHistory?: [{ ts, positions: [{ agent, lap, progress }] }],
 *                 actions?:     [{ agent, action, outcome, score }],
 *                 hintsDisabled?: boolean
 *               }
 *
 * ФОРМА ОТВЕТА — всегда ровно три ключа
 * -------------------------------------
 *   {
 *     hint:      string | null,  // только направление; null — когда лучше молчать
 *     reference: object,         // измеримые факты / куда смотреть
 *     trigger:   string | null   // машинно-читаемый код причины
 *   }
 *
 * ГАРАНТИИ
 * --------
 *   - Только встроенные модули Node.js: никакого I/O и побочных эффектов
 *     на этапе require(), поэтому `node --check` и офлайн-запуск безопасны.
 *   - Полностью защищённый разбор: битые, частичные или отсутствующие данные
 *     деградируют к значениям по умолчанию.
 *   - Детерминированность: одинаковый вход => одинаковая подсказка.
 *   - Слой формулировок «только направление» по построению: зашить в текст
 *     конкретное действие, координату или целевой счёт — это баг.
 *
 * САМОПРОВЕРКА
 * ------------
 *   node trajectory/peer_hint.js
 * ============================================================================
 */

/* -------------------------------------------------------------------------- */
/* Конфигурация                                                               */
/* -------------------------------------------------------------------------- */

const DEFAULT_CONFIG = Object.freeze({
  /** Минимальный зазор, который вообще оправдывает подсказку. */
  minGap: 0.02,
  /** Зазор, при котором лидер начинает всерьёз переживать. */
  worriedGap: 0.25,
  /** Зазор, за которым follower уже вне досягаемости. */
  maxGap: 0.6,
  /** Если follower сокращает отставание быстрее этого — молчим (пусть едет). */
  catchupEpsilon: 0.02,
  /** Сколько подряд «плоских» тиков считаются настоящим застоем. */
  stallTicks: 3,
  /** Полный круг отставания весит столько против суб-кругового прогресса. */
  lapWeight: 1.0,
  /** Подсказки длиннее этого обрезаются, чтобы остаться направлением. */
  maxHintLength: 220,
});

/** Машинно-читаемые коды причин, возвращаемые вызывающей стороне. */
const TRIGGERS = Object.freeze({
  FOLLOWER_AHEAD: 'follower-ahead', // follower вообще-то впереди
  NO_GAP: 'no-gap',                 // зазор пренебрежим — говорить нечего
  MISSING_DATA: 'missing-data',     // нет данных о позициях
  CATCHING_UP: 'catching-up',       // follower быстро сокращает — не мешать
  LAP_GAP: 'lap-gap',               // отставание на круг и больше
  STAGNANT: 'stagnant',             // follower встал
  WORRIED: 'worried',               // большой зазор, не сокращается
  STEADY: 'steady',                 // зазор стабилен — общий кивок
  DISABLED: 'hints-disabled',       // правила гонки запрещают подсказки
});

/* -------------------------------------------------------------------------- */
/* Защищённые числовые и объектные помощники                                  */
/* -------------------------------------------------------------------------- */

/** Приводит к конечному числу, иначе — `fallback`. */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Зажимает `value` в включительный диапазон [lo, hi]. */
function clamp(value, lo, hi) {
  const v = num(value, lo);
  return Math.max(lo, Math.min(hi, v));
}

/** True для не-null plain(-подобных) объектов. */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Эффективный прогресс агента с терпимостью к координатам вместо progress. */
function progressOf(agent) {
  if (!isObject(agent)) return 0;
  if (Number.isFinite(Number(agent.progress))) return num(agent.progress, 0);
  if (Number.isFinite(Number(agent.x)) && Number.isFinite(Number(agent.y))) {
    return Math.hypot(num(agent.x, 0), num(agent.y, 0));
  }
  return 0;
}

/** Счётчик кругов агента, никогда не отрицательный. */
function lapOf(agent) {
  if (!isObject(agent)) return 0;
  return Math.max(0, num(agent.lap, 0));
}

/** Скорость агента с запасным значением. */
function speedOf(agent, fallback) {
  if (!isObject(agent)) return fallback;
  return num(agent.speed, fallback);
}

/** Человекочитаемое имя агента с безопасным запасным значением. */
function agentName(agent, fallback) {
  if (!isObject(agent)) return fallback;
  return agent.agent || agent.name || agent.id || fallback;
}

/** История прогресса агента (пустой массив, если её нет). */
function historyOf(agent) {
  if (!isObject(agent)) return [];
  return Array.isArray(agent.history) ? agent.history : [];
}

/* -------------------------------------------------------------------------- */
/* Анализ зазора и темпа                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Эффективная дистанция от лидера до follower, нормализованная так, чтобы
 * целый круг перевешивал любую суб-круговую разницу прогресса (и чтобы
 * лидер на круге 2 / 0.1 читался впереди follower'а на круге 1 / 0.9).
 */
function gapBetween(leader, follower, cfg) {
  const c = isObject(cfg) ? cfg : DEFAULT_CONFIG;
  const lapGap = lapOf(leader) - lapOf(follower);
  const progGap = progressOf(leader) - progressOf(follower);
  return lapGap * num(c.lapWeight, 1) + progGap;
}

/**
 * Изменение прогресса за тик, выведенное из собственной истории follower'а.
 * Возвращает 0, когда истории нет (вызывающие трактуют 0 как «неизвестно»).
 */
function catchupRate(follower) {
  const history = historyOf(follower);
  if (history.length < 2) return 0;
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  const rate = num(last && last.progress, 0) - num(prev && prev.progress, 0);
  return Number.isFinite(rate) ? rate : 0;
}

/** Считает завершающие тики, которые follower провёл без прогресса. */
function stallCount(follower) {
  const history = historyOf(follower);
  if (history.length < 2) {
    const direct = num(isObject(follower) ? follower.stalledTicks : 0, 0);
    return Math.max(0, Math.round(direct));
  }
  let stall = 0;
  for (let i = history.length - 1; i > 0; i -= 1) {
    const a = num(history[i] && history[i].progress, 0);
    const b = num(history[i - 1] && history[i - 1].progress, 0);
    if (a > b) break;
    stall += 1;
  }
  return stall;
}

/** Ближайшая путевая точка, к которой стремится лидер (если есть трек). */
function leaderWaypoint(leader, raceState) {
  const track = isObject(raceState) && Array.isArray(raceState.track)
    ? raceState.track
    : [];
  if (!track.length) {
    return { id: 'finish', label: 'финиш', progress: 1 };
  }
  const lp = progressOf(leader);
  let best = null;
  let bestGap = Infinity;
  for (const wp of track) {
    if (!isObject(wp)) continue;
    const d = Math.abs(num(wp.progress, 0) - lp);
    if (d < bestGap) {
      bestGap = d;
      best = wp;
    }
  }
  return best || { id: 'finish', label: 'финиш', progress: 1 };
}

/* -------------------------------------------------------------------------- */
/* Выбор триггера                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Решает, стоит ли вообще слать подсказку, и почему.
 * Порядок веток = приоритет причины.
 *
 * @returns {{ trigger: string, facts: object }}
 */
function decideTrigger(leader, follower, raceState, cfg) {
  const c = isObject(cfg) ? cfg : DEFAULT_CONFIG;

  if (!isObject(leader) || !isObject(follower)) {
    return { trigger: TRIGGERS.MISSING_DATA, facts: { gap: 0, rate: 0, stalls: 0 } };
  }

  const gap = gapBetween(leader, follower, c);
  const rate = catchupRate(follower);
  const stalls = stallCount(follower);
  const facts = { gap, rate, stalls };

  if (isObject(raceState) && raceState.hintsDisabled === true) {
    return { trigger: TRIGGERS.DISABLED, facts };
  }
  if (gap < -num(c.minGap, 0)) {
    return { trigger: TRIGGERS.FOLLOWER_AHEAD, facts };
  }
  if (Math.abs(gap) < num(c.minGap, 0)) {
    return { trigger: TRIGGERS.NO_GAP, facts };
  }
  if (lapOf(leader) - lapOf(follower) >= 1) {
    return { trigger: TRIGGERS.LAP_GAP, facts };
  }
  if (stalls >= num(c.stallTicks, 3)) {
    return { trigger: TRIGGERS.STAGNANT, facts };
  }
  if (rate > num(c.catchupEpsilon, 0)) {
    return { trigger: TRIGGERS.CATCHING_UP, facts };
  }
  if (gap >= num(c.worriedGap, 0.25)) {
    return { trigger: TRIGGERS.WORRIED, facts };
  }
  return { trigger: TRIGGERS.STEADY, facts };
}

/* -------------------------------------------------------------------------- */
/* Сборка ориентира (reference)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Собирает измеримые факты и «куда смотреть» — но не решение.
 *
 * @returns {object}
 */
function buildReference(trigger, leader, follower, facts, raceState) {
  const waypoint = leaderWaypoint(leader, raceState);
  const totalLaps = num(isObject(raceState) ? raceState.totalLaps : 0, 0);
  const fal = lapOf(follower);

  return {
    trigger,
    raceId: isObject(raceState) && raceState.raceId != null ? raceState.raceId : null,
    gap: Number(num(facts && facts.gap, 0).toFixed(3)),
    catchupRate: Number(num(facts && facts.rate, 0).toFixed(3)),
    stalledTicks: Math.max(0, Math.round(num(facts && facts.stalls, 0))),
    leader: {
      id: agentName(leader, 'leader'),
      lap: lapOf(leader),
      progress: Number(progressOf(leader).toFixed(3)),
      speed: speedOf(leader, null),
    },
    follower: {
      id: agentName(follower, 'follower'),
      lap: fal,
      progress: Number(progressOf(follower).toFixed(3)),
      speed: speedOf(follower, null),
    },
    lookAt: waypoint.id || 'finish',
    waypoint: {
      id: waypoint.id || 'finish',
      label: waypoint.label || 'финиш',
      progress: num(waypoint.progress, 1),
    },
    lapsToGo: totalLaps > 0 ? Math.max(0, totalLaps - fal) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Слой формулировок — только направления, никогда решения                     */
/* -------------------------------------------------------------------------- */

/**
 * Превращает код триггера в направляющую фразу. Никаких координат, готовых
 * действий или целевых очков — только «куда смотреть» и «что за чем следить».
 *
 * @returns {string|null}
 */
function renderHint(trigger, name, facts, reference) {
  const who = name || 'follower';

  switch (trigger) {
    case TRIGGERS.FOLLOWER_AHEAD:
    case TRIGGERS.NO_GAP:
      return null;

    case TRIGGERS.MISSING_DATA:
      return 'Не хватает данных о позициях — опирайся на свою траекторию и продолжай движение.';

    case TRIGGERS.DISABLED:
      return 'Подсказки сейчас отключены правилами гонки — ориентируйся на собственные данные.';

    case TRIGGERS.LAP_GAP:
      return `${who}, ты отстаёшь на круг — дело в темпе, а не в удаче. ` +
        'Посмотри на переходы между кругами и найди, где именно теряешь время.';

    case TRIGGERS.STAGNANT:
      return `${who}, ты замер. Не проси готовый ход — вернись к своим последним ` +
        'шагам и выбери то, что раньше давало движение. Ориентир — просто сдвинуться.';

    case TRIGGERS.CATCHING_UP:
      return `${who}, ты сокращаешь разрыв. Держи выбранный угол — тебе не нужен мой ` +
        'ход, твоё направление уже работает.';

    case TRIGGERS.WORRIED:
      return `${who}, разрыв большой и не тает. Не пытайся догнать за один шаг — ` +
        'сузь фокус до одного отрезка и доведи его до конца.';

    case TRIGGERS.STEADY:
      return `${who}, позиция устойчивая. Смотри не на меня, а на свои слабые ` +
        'участки — направление важнее скорости.';

    default:
      return 'Держи собственное направление — ориентируйся на свои данные.';
  }
}

/* -------------------------------------------------------------------------- */
/* Публичный API                                                              */
/* -------------------------------------------------------------------------- */

/**
 * suggestHint(leader, follower, raceState[, config])
 *
 * Выдаёт не более одной направляющей подсказки от лидера к отстающему
 * follower'у. Лидер указывает — но никогда не решает за него.
 *
 * @param   {object} leader
 * @param   {object} follower
 * @param   {object} [raceState]
 * @param   {object} [config] разовые переопределения DEFAULT_CONFIG
 * @returns {{ hint:(string|null), reference:object, trigger:(string|null) }}
 */
function suggestHint(leader, follower, raceState, config) {
  const state = isObject(raceState) ? raceState : {};
  const cfg = Object.assign({}, DEFAULT_CONFIG, isObject(config) ? config : {});

  const decided = decideTrigger(leader, follower, state, cfg);
  const trigger = decided.trigger;
  const reference = buildReference(trigger, leader, follower, decided.facts, state);

  let hint = renderHint(trigger, agentName(follower, 'follower'), decided.facts, reference);

  // Жёсткий бюджет: подсказка не может превысить лимит «направления».
  if (typeof hint === 'string' && hint.length > cfg.maxHintLength) {
    hint = hint.slice(0, cfg.maxHintLength - 1).trimEnd() + '\u2026';
  }

  return { hint, reference, trigger };
}

/* -------------------------------------------------------------------------- */
/* Экспорт                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  suggestHint,
  TRIGGERS,
  DEFAULT_CONFIG,
  // помощники открыты для тестов и переиспользования
  gapBetween,
  catchupRate,
  stallCount,
  decideTrigger,
  leaderWaypoint,
  buildReference,
  renderHint,
  clamp,
  num,
  isObject,
  progressOf,
  lapOf,
  speedOf,
  agentName,
};

module.exports.default = suggestHint;

/* -------------------------------------------------------------------------- */
/* Самопроверка при прямом запуске: node trajectory/peer_hint.js              */
/* -------------------------------------------------------------------------- */

if (require.main === module) {
  const cases = [
    {
      title: 'lap gap',
      leader: { id: 'a', lap: 2, progress: 0.4, speed: 1.2 },
      follower: { id: 'b', lap: 1, progress: 0.25, speed: 0.3 },
      state: { raceId: 'demo', totalLaps: 5, track: [{ id: 'wp2', label: 'вираж 2', progress: 0.5 }] },
    },
    {
      title: 'stagnant',
      leader: { id: 'a', lap: 1, progress: 0.6, speed: 1.0 },
      follower: { id: 'b', lap: 1, progress: 0.3, speed: 0.4, history: [{ progress: 0.3 }, { progress: 0.3 }, { progress: 0.3 }, { progress: 0.3 }] },
      state: { raceId: 'demo' },
    },
    {
      title: 'catching up',
      leader: { id: 'a', lap: 1, progress: 0.6, speed: 1.0 },
      follower: { id: 'b', lap: 1, progress: 0.4, speed: 0.9, history: [{ progress: 0.3 }, { progress: 0.4 }] },
      state: { raceId: 'demo' },
    },
    {
      title: 'follower ahead',
      leader: { id: 'a', lap: 1, progress: 0.3, speed: 1.0 },
      follower: { id: 'b', lap: 1, progress: 0.5, speed: 1.0 },
      state: {},
    },
    {
      title: 'missing data',
      leader: null,
      follower: undefined,
      state: {},
    },
  ];

  for (const c of cases) {
    const out = suggestHint(c.leader, c.follower, c.state);
    console.log('== ' + c.title + ' -> ' + out.trigger);
    console.log(JSON.stringify(out, null, 2));
  }
}
