/**
 * radio/drama_detector.js
 * ==========================================================================
 * Детектор «драмы» в гонке для эфира радио.
 *
 * По снимку состояния гонки (raceState) определяет яркие события, которые
 * стоит озвучить комментатору. Возвращает массив объектов вида:
 *
 *     [{ type, tension, actors }]
 *
 *   type    — тип события: 'gap' | 'stuck' | 'incident' | 'closing';
 *   tension — напряжённость момента, целое 1..10 (чем выше, тем «горячее»);
 *   actors  — массив идентификаторов гонщиков/сущностей, причастных к событию.
 *
 * Триггеры:
 *   1. gap >= 2             — «отрыв»: разрыв от преследователя достиг 2с+;
 *   2. stuck > 60           — «застревание»: гонщик стоит дольше 60 секунд;
 *   3. ok === false         — «инцидент»: сбой / авария / потеря связи;
 *   4. gap сократился за lap — «сближение»: отрыв уменьшился за круг,
 *                              борьба за позицию обостряется.
 *
 * Модуль не имеет внешних зависимостей, работает синхронно, безопасно
 * переживает неполный или «грязный» вход (никогда не бросает исключение —
 * при фатальной ошибке возвращает пустой массив). Поддерживаются разные
 * имена полей входа, чтобы не зависеть от конкретной реализации трекера.
 * ==========================================================================
 */

'use strict';

// ---------------------------------------------------------------------------
// Пороговые значения триггеров
// ---------------------------------------------------------------------------

const THRESHOLDS = {
  /** Минимальный отрыв (сек) для фиксации «отрыва». */
  GAP_PULL_AWAY: 2,
  /** Отрыв (сек), при котором напряжение максимально. */
  GAP_HIGH: 12,
  /** Отрыв (сек), на который упрощённо приходится «середина» шкалы. */
  GAP_MID: 6,
  /** Сколько секунд простоя делают гонщика «застрявшим». */
  STUCK_SECONDS: 60,
  /** Насколько должен сократиться gap за круг, чтобы сработал «closing». */
  CLOSING_DELTA: 0.5,
  /** Базовое напряжение для инцидента. */
  INCIDENT_TENSION: 8,
  /** Шаг проверки позиции круга в снимке. */
  LAP_FIELD: 'lap',
};

// ---------------------------------------------------------------------------
// Вспомогательные функции (безопасный доступ к «грязному» входу)
// ---------------------------------------------------------------------------

/**
 * Возвращает первое непустое (не undefined / не null) значение среди
 * перечисленных ключей объекта. Позволяет поддерживать разные схемы данных.
 * @param {object} obj
 * @param {...string} keys
 * @returns {*}
 */
function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

/**
 * Приводит значение к конечному числу, иначе возвращает fallback.
 * @param {*} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
function num(value, fallback = 0) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Ограничивает значение диапазоном [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Нормализует гонщика/машину в читаемую строку-идентификатор.
 * @param {*} driver
 * @param {number} [index=0]
 * @returns {string}
 */
function actorName(driver, index = 0) {
  if (driver == null) return `car#${index}`;
  if (typeof driver === 'string' || typeof driver === 'number') {
    return String(driver).trim() || `car#${index}`;
  }
  const raw = pick(driver, 'name', 'id', 'driverId', 'code', 'driver', 'car');
  if (raw !== undefined && raw !== null && String(raw).length) {
    return String(raw);
  }
  return `car#${index}`;
}

/**
 * Извлекает список машин из raceState, поддерживая разные имена полей:
 * cars / drivers / racers / participants / entries. Одиночный объект
 * оборачивает в массив, отсутствие — возвращает [].
 * @param {*} raceState
 * @returns {Array<object>}
 */
function normalizeCars(raceState) {
  if (!raceState || typeof raceState !== 'object') return [];
  const list = pick(
    raceState,
    'cars',
    'drivers',
    'racers',
    'participants',
    'entries',
    'grid'
  );
  if (Array.isArray(list)) return list.filter((x) => x != null);
  if (list && typeof list === 'object') return [list];
  return [];
}

// ---------------------------------------------------------------------------
// Расчёт напряжения (tension -> 1..10)
// ---------------------------------------------------------------------------

/** Напряжение по величине отрыва: линейно растёт до GAP_HIGH. */
function tensionFromGap(gap) {
  const g = Math.abs(num(gap));
  if (g <= THRESHOLDS.GAP_PULL_AWAY) return 1;
  const span = THRESHOLDS.GAP_HIGH - THRESHOLDS.GAP_PULL_AWAY;
  const ratio = span > 0 ? (g - THRESHOLDS.GAP_PULL_AWAY) / span : 1;
  return clamp(Math.round(3 + ratio * 7), 1, 10);
}

/** Напряжение для застревания: растёт с каждой секундой свыше порога. */
function tensionFromStuck(seconds) {
  const over = num(seconds) - THRESHOLDS.STUCK_SECONDS;
  if (over <= 0) return 1;
  // +1 «градус» примерно за каждые 15 секунд сверх порога.
  return clamp(Math.round(4 + over / 15), 1, 10);
}

/** Напряжение для инцидента — инциденты всегда острые. */
function tensionForIncident() {
  return clamp(THRESHOLDS.INCIDENT_TENSION, 1, 10);
}

/** Напряжение для сближения: чем резче сократился отрыв, тем жарче. */
function tensionFromClosing(delta) {
  const d = Math.abs(num(delta));
  if (d < THRESHOLDS.CLOSING_DELTA) return 1;
  return clamp(Math.round(4 + d * 1.5), 1, 10);
}

// ---------------------------------------------------------------------------
// Отдельные детекторы (каждый возвращает событие, массив событий или null)
// ---------------------------------------------------------------------------

/**
 * Триггер «отрыв» (gap >= 2).
 *
 * Режим списка машин: ищет первого гонщика с крупным отрывом от впереди
 * идущего (разрыв лидера / разрыв в пелотоне).
 * Режим одиночного снимка: сравнивает raceState.gap / gapToAhead.
 *
 * @param {object} raceState
 * @returns {{type:string,tension:number,actors:string[]}|null}
 */
function detectGap(raceState) {
  const cars = normalizeCars(raceState);

  if (cars.length) {
    let best = null;
    for (let i = 0; i < cars.length; i += 1) {
      const car = cars[i];
      const gap = num(
        pick(car, 'gapToAhead', 'gap', 'gapAhead', 'interval', 'behind'),
        0
      );
      if (gap >= THRESHOLDS.GAP_PULL_AWAY) {
        const chaser = cars[i + 1];
        const event = {
          type: 'gap',
          tension: tensionFromGap(gap),
          actors: [actorName(car, i), actorName(chaser, i + 1)],
          meta: { gap },
        };
        // Оставляем самый напряжённый отрыв.
        if (!best || event.tension > best.tension) best = event;
      }
    }
    return best;
  }

  const gap = num(pick(raceState, 'gap', 'gapToAhead', 'leaderGap'), 0);
  if (gap < THRESHOLDS.GAP_PULL_AWAY) return null;
  const leader = pick(raceState, 'leader', 'leaderId', 'driver', 'first');
  const chaser = pick(raceState, 'chaser', 'chaserId', 'next', 'second');
  return {
    type: 'gap',
    tension: tensionFromGap(gap),
    actors: [actorName(leader, 0), actorName(chaser, 1)],
    meta: { gap },
  };
}

/**
 * Триггер «застревание» (stuck > 60).
 *
 * Триггерится по списку машин (stuck/stuckFor/idleFor > 60) либо по
 * верхнеуровневому полю raceState.stuck. Возвращает массив событий.
 *
 * @param {object} raceState
 * @returns {Array<{type:string,tension:number,actors:string[]}>}
 */
function detectStuck(raceState) {
  const events = [];
  const cars = normalizeCars(raceState);

  if (cars.length) {
    for (let i = 0; i < cars.length; i += 1) {
      const car = cars[i];
      const seconds = num(
        pick(car, 'stuck', 'stuckFor', 'stuckSeconds', 'idleFor', 'stoppedFor'),
        0
      );
      if (seconds > THRESHOLDS.STUCK_SECONDS) {
        events.push({
          type: 'stuck',
          tension: tensionFromStuck(seconds),
          actors: [actorName(car, i)],
          meta: { seconds },
        });
      }
    }
    return events;
  }

  const seconds = num(pick(raceState, 'stuck', 'stuckFor', 'idleFor'), 0);
  if (seconds <= THRESHOLDS.STUCK_SECONDS) return events;
  const driver = pick(raceState, 'driver', 'leader', 'stuckDriver');
  events.push({
    type: 'stuck',
    tension: tensionFromStuck(seconds),
    actors: [actorName(driver, 0)],
    meta: { seconds },
  });
  return events;
}

/**
 * Триггер «инцидент» (ok === false). Проверяет как верхний уровень
 * raceState, так и каждую машину в списке. Возвращает массив событий.
 *
 * @param {object} raceState
 * @returns {Array<{type:string,tension:number,actors:string[]}>}
 */
function detectIncidents(raceState) {
  const events = [];
  const cars = normalizeCars(raceState);
  const reason = pick(raceState, 'reason', 'error', 'message') || 'incident';

  const isBad = (v) =>
    v === false || v === 0 || v === 'false' || v === 'no' || v === 'down';

  if (cars.length) {
    for (let i = 0; i < cars.length; i += 1) {
      const car = cars[i];
      const okRaw = pick(car, 'ok', 'online', 'healthy', 'active', 'alive');
      if (isBad(okRaw)) {
        events.push({
          type: 'incident',
          tension: tensionForIncident(),
          actors: [actorName(car, i), String(reason)],
        });
      }
    }
    return events;
  }

  if (isBad(pick(raceState, 'ok', 'online', 'healthy'))) {
    const driver = pick(raceState, 'driver', 'crashed', 'leader');
    events.push({
      type: 'incident',
      tension: tensionForIncident(),
      actors: [actorName(driver, 0), String(reason)],
    });
  }
  return events;
}

/**
 * Триггер «сближение»: отрыв сократился за круг.
 *
 * Поддерживает несколько схем:
 *   - raceState.prevGap / lastGap (отрыв на прошлом круге) vs текущий gap;
 *   - raceState.gapDelta / closing (готовое значение изменения);
 *   - у машины поля prevGap / lastGap vs gap.
 *
 * Возвращает массив событий (может быть несколько машин).
 * @param {object} raceState
 * @returns {Array<{type:string,tension:number,actors:string[]}>}
 */
function detectClosing(raceState) {
  const events = [];
  const threshold = THRESHOLDS.CLOSING_DELTA;

  // Готовое значение изменения отрыва (отрицательное = сближение).
  const direct = pick(raceState, 'gapDelta', 'delta', 'closing', 'gapChange');
  if (direct !== undefined) {
    const delta = num(direct, 0);
    if (delta <= -threshold) {
      const leader = pick(raceState, 'leader', 'leaderId', 'driver');
      const chaser = pick(raceState, 'chaser', 'chaserId', 'next');
      events.push({
        type: 'closing',
        tension: tensionFromClosing(delta),
        actors: [actorName(leader, 0), actorName(chaser, 1)],
        meta: { delta },
      });
      return events;
    }
  }

  const cars = normalizeCars(raceState);

  if (cars.length) {
    for (let i = 0; i < cars.length; i += 1) {
      const car = cars[i];
      const current = num(pick(car, 'gap', 'gapToAhead', 'gapAhead'), NaN);
      const previous = num(
        pick(car, 'prevGap', 'lastGap', 'gapPrev', 'previousGap'),
        NaN
      );
      if (Number.isFinite(current) && Number.isFinite(previous)) {
        const delta = current - previous;
        if (delta <= -threshold) {
          const chaser = cars[i + 1];
          events.push({
            type: 'closing',
            tension: tensionFromClosing(delta),
            actors: [actorName(car, i), actorName(chaser, i + 1)],
            meta: { delta, from: previous, to: current },
          });
        }
      }
    }
    return events;
  }

  const current = num(pick(raceState, 'gap', 'gapToAhead'), NaN);
  const previous = num(pick(raceState, 'prevGap', 'lastGap', 'gapPrev'), NaN);
  if (Number.isFinite(current) && Number.isFinite(previous)) {
    const delta = current - previous;
    if (delta <= -threshold) {
      const leader = pick(raceState, 'leader', 'leaderId', 'driver');
      const chaser = pick(raceState, 'chaser', 'chaserId', 'next');
      events.push({
        type: 'closing',
        tension: tensionFromClosing(delta),
        actors: [actorName(leader, 0), actorName(chaser, 1)],
        meta: { delta, from: previous, to: current },
      });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Главный API
// ---------------------------------------------------------------------------

const DETECTORS = [detectGap, detectStuck, detectIncidents, detectClosing];

/**
 * Анализирует снимок состояния гонки и возвращает список «драматичных»
 * событий, отсортированных по убыванию напряжения.
 *
 * @param {object} raceState — снимок гонки.
 * @returns {Array<{type:string,tension:number,actors:string[]}>}
 */
function detectDrama(raceState) {
  if (!raceState || typeof raceState !== 'object') return [];

  let events = [];
  for (const detect of DETECTORS) {
    try {
      const found = detect(raceState);
      if (Array.isArray(found)) events = events.concat(found);
      else if (found) events.push(found);
    } catch (err) {
      // Один сбойный детектор не должен ронять весь анализ.
      events.push({
        type: 'incident',
        tension: 1,
        actors: [String((err && err.message) || err)],
      });
    }
  }

  // Отфильтровываем «пустые» события и сортируем по напряжению.
  events = events
    .filter((e) => e && typeof e === 'object' && e.type)
    .map((e) => ({
      type: e.type,
      tension: clamp(Math.round(num(e.tension, 1)), 1, 10),
      actors: Array.isArray(e.actors) ? e.actors.filter(Boolean) : [],
      ...(e.meta ? { meta: e.meta } : {}),
    }));

  events.sort((a, b) => b.tension - a.tension);
  return events;
}

/**
 * Пакетный анализ нескольких снимков (история тиков). Удобно для
 * построения «ленты драмы» в эфире.
 *
 * @param {Array<object>} states
 * @returns {Array<{type:string,tension:number,actors:string[]}>}
 */
function detectDramaBatch(states) {
  if (!Array.isArray(states)) return [];
  return states.reduce((acc, state) => acc.concat(detectDrama(state)), []);
}

/**
 * Есть ли в снимке хоть какая-то драма.
 * @param {object} raceState
 * @returns {boolean}
 */
function hasDrama(raceState) {
  return detectDrama(raceState).length > 0;
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

module.exports = {
  detectDrama,
  detectDramaBatch,
  hasDrama,
  CONSTANTS: THRESHOLDS,
  // Хелперы — для тестов и тонкой настройки.
  _internals: {
    detectGap,
    detectStuck,
    detectIncidents,
    detectClosing,
    normalizeCars,
    actorName,
    num,
    clamp,
    pick,
  },
};

// ---------------------------------------------------------------------------
// Быстрая самопроверка:  node radio/drama_detector.js
// ---------------------------------------------------------------------------
if (require.main === module) {
  const demo = detectDrama({
    gap: 3.2,
    prevGap: 5.4,
    stuck: 75,
    ok: false,
    leader: 'Verstappen',
    chaser: 'Hamilton',
    lap: 42,
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(demo, null, 2));
}
