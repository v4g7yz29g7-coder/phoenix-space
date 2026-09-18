'use strict';

/**
 * trajectory/test_peer_hint.js
 * ============================================================================
 * Тесты для directional peer-hint engine (commit 5c8df3b0,
 * trajectory/peer_hint.js), добавленного без верификации.
 *
 * Контракт suggestHint(leader, follower, raceState[, config]):
 *   -> { hint: string|null, reference: object, trigger: string|null }
 *
 * Покрываемые кейсы (>= 6):
 *   1. коллизия траекторий  -> непустая подсказка
 *   2. расхождение          -> пустая подсказка (null)
 *   3. одиночка             -> безопасная деградация (missing-data)
 *   4. дубликат             -> детерминированный выбор ближайшего
 *   5. пустой вход          -> без исключений, валидная форма
 *   6. большой N            -> приоритизация ближайшего соседа по расстоянию
 *   7. leaderWaypoint       -> ближайший по |progress - leaderProgress|
 *   8..11. ветки хелперов / триггеров / reference
 *
 * Запуск:  node --test trajectory/test_peer_hint.js
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const peerHint = require('./peer_hint.js');
const { suggestHint, TRIGGERS, DEFAULT_CONFIG } = peerHint;

const RESPONSE_KEYS = ['hint', 'reference', 'trigger'].sort();

/** Каждый ответ движка всегда имеет ровно три ключа нужного типа. */
function assertShape(out) {
  assert.ok(out && typeof out === 'object' && !Array.isArray(out),
    'suggestHint должен вернуть plain-объект');
  assert.deepEqual(Object.keys(out).sort(), RESPONSE_KEYS,
    'ответ обязан содержать ровно hint/reference/trigger');
  assert.ok(out.reference && typeof out.reference === 'object' && !Array.isArray(out.reference),
    'reference должен быть объектом');
  assert.ok(out.hint === null || typeof out.hint === 'string',
    'hint должен быть строкой или null');
  assert.ok(out.trigger === null || typeof out.trigger === 'string',
    'trigger должен быть строкой или null');
  return out;
}

/* -------------------------------------------------------------------------- */
/* 0. Экспорт                                                                 */
/* -------------------------------------------------------------------------- */

test('0. экспорт suggestHint подтверждён', () => {
  assert.equal(typeof peerHint.suggestHint, 'function', 'suggestHint не экспортирован');
  assert.equal(typeof peerHint.default, 'function', 'default-экспорт отсутствует');
  assert.equal(peerHint.default, peerHint.suggestHint, 'default !== suggestHint');
  assert.equal(typeof TRIGGERS.STEADY, 'string');
  assert.equal(typeof DEFAULT_CONFIG.maxHintLength, 'number');
  // хелперы открыты наружу для переиспользования
  for (const k of ['gapBetween', 'catchupRate', 'stallCount', 'leaderWaypoint', 'buildReference', 'renderHint']) {
    assert.equal(typeof peerHint[k], 'function', `хелпер ${k} не экспортирован`);
  }
});

/* -------------------------------------------------------------------------- */
/* 1. Коллизия траекторий -> подсказка                                        */
/* -------------------------------------------------------------------------- */

test('1. коллизия траекторий -> непустая подсказка', () => {
  const out = assertShape(suggestHint(
    { id: 'lead', lap: 1, progress: 0.50, speed: 1.0 },
    { id: 'fall', lap: 1, progress: 0.40, speed: 0.8 },
    { raceId: 'r1', totalLaps: 5 },
  ));
  assert.equal(out.trigger, TRIGGERS.STEADY);
  assert.ok(typeof out.hint === 'string' && out.hint.length > 0,
    'на коллизии траекторий подсказка должна быть непустой');
});

/* -------------------------------------------------------------------------- */
/* 2. Расхождение -> молчание                                                 */
/* -------------------------------------------------------------------------- */

test('2. расхождение -> пустая подсказка (null)', () => {
  const ahead = assertShape(suggestHint(
    { id: 'l', lap: 1, progress: 0.30 },
    { id: 'f', lap: 1, progress: 0.50 },
    {},
  ));
  assert.equal(ahead.trigger, TRIGGERS.FOLLOWER_AHEAD);
  assert.equal(ahead.hint, null, 'когда follower впереди — говорить нечего');

  const overlap = assertShape(suggestHint(
    { id: 'l', lap: 1, progress: 0.50 },
    { id: 'f', lap: 1, progress: 0.50 },
    {},
  ));
  assert.equal(overlap.trigger, TRIGGERS.NO_GAP);
  assert.equal(overlap.hint, null, 'нулевой зазор -> подсказки нет');
});

/* -------------------------------------------------------------------------- */
/* 3. Одиночка / отсутствующий второй агент                                   */
/* -------------------------------------------------------------------------- */

test('3. одиночка -> безопасная деградация (missing-data)', () => {
  const variants = [
    [{ id: 'solo' }, undefined],
    [null, null],
    [undefined, { id: 'x' }],
    [5, 'nope'],
    [undefined, undefined],
  ];
  for (const [l, f] of variants) {
    const out = assertShape(suggestHint(l, f, {}));
    assert.equal(out.trigger, TRIGGERS.MISSING_DATA);
    assert.ok(typeof out.hint === 'string' && out.hint.length > 0,
      'в режиме нехватки данных движок обязан дать мягкое направление');
    assert.equal(out.reference.follower.id, 'follower');
  }
});

/* -------------------------------------------------------------------------- */
/* 4. Дубликат агента / путевых точек                                         */
/* -------------------------------------------------------------------------- */

test('4. дубликат -> детерминированный результат', () => {
  // дубликат агента: один и тот же id и позиция
  const dup = assertShape(suggestHint(
    { id: 'same', lap: 1, progress: 0.5 },
    { id: 'same', lap: 1, progress: 0.5 },
    {},
  ));
  assert.equal(dup.trigger, TRIGGERS.NO_GAP);
  assert.equal(dup.hint, null);

  // дубликат путевых точек: стабильно выбирается первая ближайшая
  const track = [
    { id: 'dup', label: 'a', progress: 0.42 },
    { id: 'dup', label: 'b', progress: 0.42 },
    { id: 'far', label: 'c', progress: 0.9 },
  ];
  const out = assertShape(suggestHint(
    { id: 'l', lap: 1, progress: 0.5 },
    { id: 'f', lap: 1, progress: 0.3 },
    { track },
  ));
  assert.equal(out.reference.lookAt, 'dup');
  assert.equal(out.reference.waypoint.label, 'a', 'при равенстве берётся первый элемент');
});

/* -------------------------------------------------------------------------- */
/* 5. Пустой вход                                                             */
/* -------------------------------------------------------------------------- */

test('5. пустой вход -> без исключений и с валидной формой', () => {
  const cases = [
    suggestHint(),
    suggestHint(null, null),
    suggestHint(undefined, undefined, undefined),
    suggestHint({}, {}, {}),
    suggestHint({}, {}, null),
    suggestHint(null, null, { hintsDisabled: true }),
  ];
  for (const out of cases) assertShape(out);

  assert.equal(suggestHint().trigger, TRIGGERS.MISSING_DATA);
  assert.equal(suggestHint(null, null, {}).hint,
    'Не хватает данных о позициях — опирайся на свою траекторию и продолжай движение.');
  assert.equal(suggestHint({}, {}, {}).trigger, TRIGGERS.NO_GAP);
});

/* -------------------------------------------------------------------------- */
/* 6. Большой N -> приоритет ближайшего соседа                                */
/* -------------------------------------------------------------------------- */

test('6. большой N -> приоритизирует ближайшего соседа по расстоянию', () => {
  const N = 1000;
  const track = [];
  for (let i = 0; i < N; i += 1) track.push({ id: `wp${i}`, progress: i / N });

  const out = assertShape(suggestHint(
    { id: 'l', lap: 1, progress: 0.5 },
    { id: 'f', lap: 1, progress: 0.2 },
    { track, totalLaps: 10 },
  ));

  assert.equal(out.reference.lookAt, 'wp500', 'должна быть выбрана точка с progress 0.5');
  assert.equal(out.reference.waypoint.progress, 0.5);
  assert.equal(out.trigger, TRIGGERS.WORRIED);
  assert.ok(out.hint.length > 0);
});

/* -------------------------------------------------------------------------- */
/* 7. leaderWaypoint -> метрика расстояния                                    */
/* -------------------------------------------------------------------------- */

test('7. leaderWaypoint выбирает минимум |progress - leaderProgress|', () => {
  const lw = peerHint.leaderWaypoint;

  // без трека — финиш по умолчанию
  assert.deepEqual(lw({ progress: 0.5 }, {}), { id: 'finish', label: 'финиш', progress: 1 });
  assert.deepEqual(lw({ progress: 0.5 }, null), { id: 'finish', label: 'финиш', progress: 1 });

  // битые элементы пропускаются, побеждает ближайший по расстоянию
  const got = lw({ progress: 0.33 }, {
    track: [
      { id: 'a', progress: 0.1 },
      null,
      { id: 'b', progress: 0.3 },
      { id: 'c', progress: 0.9 },
    ],
  });
  assert.equal(got.id, 'b');
});

/* -------------------------------------------------------------------------- */
/* 8. Хелперы: числовые и объектные ветки                                     */
/* -------------------------------------------------------------------------- */

test('8. хелперы num/clamp/isObject/progressOf/lapOf/speedOf/agentName', () => {
  assert.equal(peerHint.num(5, 0), 5);
  assert.equal(peerHint.num('abc', 7), 7);
  assert.equal(peerHint.num(NaN, 1), 1);
  assert.equal(peerHint.num(undefined, 2), 2);

  assert.equal(peerHint.clamp(5, 0, 1), 1);
  assert.equal(peerHint.clamp(-1, 0, 1), 0);
  assert.equal(peerHint.clamp(0.5, 0, 1), 0.5);

  assert.equal(peerHint.isObject({}), true);
  assert.equal(peerHint.isObject(null), false);
  assert.equal(peerHint.isObject(5), false);
  assert.equal(peerHint.isObject([]), false);

  assert.equal(peerHint.progressOf({ progress: 0.7 }), 0.7);
  assert.equal(peerHint.progressOf({ x: 3, y: 4 }), 5);
  assert.equal(peerHint.progressOf({}), 0);
  assert.equal(peerHint.progressOf(null), 0);

  assert.equal(peerHint.lapOf({ lap: -3 }), 0);
  assert.equal(peerHint.lapOf({ lap: 2 }), 2);
  assert.equal(peerHint.lapOf(null), 0);

  assert.equal(peerHint.speedOf({ speed: 1.5 }, 0), 1.5);
  assert.equal(peerHint.speedOf({}, 9), 9);
  assert.equal(peerHint.speedOf(null, 9), 9);

  assert.equal(peerHint.agentName({ agent: 'A' }, 'x'), 'A');
  assert.equal(peerHint.agentName({ name: 'B' }, 'x'), 'B');
  assert.equal(peerHint.agentName({ id: 'C' }, 'x'), 'C');
  assert.equal(peerHint.agentName({}, 'x'), 'x');
  assert.equal(peerHint.agentName(null, 'x'), 'x');
});

/* -------------------------------------------------------------------------- */
/* 9. gapBetween / catchupRate / stallCount                                   */
/* -------------------------------------------------------------------------- */

test('9. gapBetween/catchupRate/stallCount — все ветки', () => {
  // полный круг перевешивает суб-круговую разницу
  assert.equal(peerHint.gapBetween({ lap: 2, progress: 0.1 }, { lap: 1, progress: 0.9 }), 0.2);
  assert.equal(peerHint.gapBetween({ lap: 1, progress: 0.6 }, { lap: 1, progress: 0.2 }, null), 0.4);
  assert.equal(peerHint.gapBetween(null, null), 0);

  assert.equal(peerHint.catchupRate(null), 0);
  assert.equal(peerHint.catchupRate({ history: 'nope' }), 0);
  assert.equal(peerHint.catchupRate({ history: [{ progress: 0.1 }] }), 0);
  assert.equal(Number(peerHint.catchupRate({ history: [{ progress: 0.1 }, { progress: 0.3 }] }).toFixed(2)), 0.2);
  assert.equal(Number(peerHint.catchupRate({ history: [null, { progress: 0.5 }] }).toFixed(2)), 0.5);

  assert.equal(peerHint.stallCount(null), 0);
  assert.equal(peerHint.stallCount({ stalledTicks: 4 }), 4);
  assert.equal(peerHint.stallCount({ history: [{ progress: 0.5 }, { progress: 0.4 }, { progress: 0.4 }] }), 1);
  assert.equal(peerHint.stallCount({ history: [{ progress: 0.1 }, { progress: 0.2 }] }), 0);
});

/* -------------------------------------------------------------------------- */
/* 10. Все триггеры, default-формулировка и бюджет длины                      */
/* -------------------------------------------------------------------------- */

test('10. все триггеры, default renderHint и бюджет длины', () => {
  const L = { id: 'l', lap: 1, progress: 0.6, speed: 1.1 };
  const F = { id: 'f', lap: 1, progress: 0.2, speed: 0.4 };

  const lap = assertShape(suggestHint({ id: 'l', lap: 2, progress: 0.4 }, { id: 'f', lap: 1, progress: 0.25 }, {}));
  assert.equal(lap.trigger, TRIGGERS.LAP_GAP);

  const stagn = assertShape(suggestHint(
    { lap: 1, progress: 0.6 },
    { lap: 1, progress: 0.3, history: [{ progress: 0.3 }, { progress: 0.3 }, { progress: 0.3 }, { progress: 0.3 }] },
    {},
  ));
  assert.equal(stagn.trigger, TRIGGERS.STAGNANT);

  const catching = assertShape(suggestHint(
    { lap: 1, progress: 0.6 },
    { lap: 1, progress: 0.4, history: [{ progress: 0.3 }, { progress: 0.4 }] },
    {},
  ));
  assert.equal(catching.trigger, TRIGGERS.CATCHING_UP);

  const worried = assertShape(suggestHint(L, F, {}));
  assert.equal(worried.trigger, TRIGGERS.WORRIED);

  const disabled = assertShape(suggestHint(L, F, { hintsDisabled: true }));
  assert.equal(disabled.trigger, TRIGGERS.DISABLED);

  // default-ветка renderHint
  assert.equal(typeof peerHint.renderHint('unknown-trigger', 'f', {}, {}), 'string');

  // бюджет длины: подсказка не может превысить «направление»
  const short = assertShape(suggestHint(L, F, {}, { maxHintLength: 24 }));
  assert.ok(short.hint.length <= 24, 'hint должен быть обрезан до maxHintLength');
  assert.ok(short.hint.endsWith('\u2026'));
});

/* -------------------------------------------------------------------------- */
/* 11. buildReference — ветки raceId/totalLaps/waypoint                        */
/* -------------------------------------------------------------------------- */

test('11. buildReference: raceId/totalLaps/waypoint-ветки', () => {
  const br = peerHint.buildReference(
    TRIGGERS.STEADY,
    { lap: 1, progress: 0.5 },
    { lap: 1, progress: 0.4 },
    { gap: 0.1, rate: 0, stalls: 0 },
    { raceId: 'r', totalLaps: 5 },
  );
  assert.equal(br.raceId, 'r');
  assert.equal(br.lapsToGo, 4);
  assert.equal(br.lookAt, 'finish');
  assert.equal(br.waypoint.label, 'финиш');

  // полностью пустые данные
  const br2 = peerHint.buildReference(TRIGGERS.STEADY, null, null, null, null);
  assert.equal(br2.raceId, null);
  assert.equal(br2.lapsToGo, null);
  assert.equal(br2.gap, 0);
  assert.equal(br2.leader.id, 'leader');
  assert.equal(br2.follower.id, 'follower');

  // waypoint из трека (метка есть)
  const br3 = peerHint.buildReference(
    TRIGGERS.STEADY,
    { lap: 1, progress: 0.5 },
    { lap: 1, progress: 0.4 },
    { gap: 0.1, rate: 0, stalls: 0 },
    { track: [{ id: 'w', label: 'метка', progress: 0.55 }], totalLaps: 0 },
  );
  assert.equal(br3.lookAt, 'w');
  assert.equal(br3.waypoint.label, 'метка');
  assert.equal(br3.lapsToGo, null);

  // waypoint без id/label -> дефолты finish/финиш
  const br4 = peerHint.buildReference(
    TRIGGERS.STEADY,
    { lap: 1, progress: 0.2 },
    { lap: 1, progress: 0.1 },
    { gap: 0.1, rate: 0, stalls: 0 },
    { track: [{ progress: 0.25 }] },
  );
  assert.equal(br4.lookAt, 'finish');
  assert.equal(br4.waypoint.label, 'финиш');
});

/* -------------------------------------------------------------------------- */
/* 12. suggestHint с явным config                                             */
/* -------------------------------------------------------------------------- */

test('12. config-оверрайды влияют на решение', () => {
  // расширенный minGap превращает микро-зазор в no-gap
  const noGap = assertShape(suggestHint(
    { lap: 1, progress: 0.5 },
    { lap: 1, progress: 0.45 },
    {},
    { minGap: 0.2 },
  ));
  assert.equal(noGap.trigger, TRIGGERS.NO_GAP);

  // узкий worriedGap переводит STEADY в WORRIED
  const worried = assertShape(suggestHint(
    { lap: 1, progress: 0.5 },
    { lap: 1, progress: 0.4 },
    {},
    { worriedGap: 0.05 },
  ));
  assert.equal(worried.trigger, TRIGGERS.WORRIED);
  assert.equal(worried.reference.trigger, TRIGGERS.WORRIED);
});
