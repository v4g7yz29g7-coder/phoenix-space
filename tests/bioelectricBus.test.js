'use strict';

/**
 * tests/bioelectricBus.test.js
 * ---------------------------------------------------------------------------
 * Тесты in-memory шины биоэлектрического поля (Levin) —
 * `src/utils/bioelectricBus.js`.
 *
 * Покрываемый публичный API:
 *   emit(signal, data) -> boolean   (true, если сигнал кем-то принят)
 *   on(signal, cb)     -> this      (постоянная gap-junction подписка)
 *   once(signal, cb)   -> this      (транзиентный одноразовый импульс)
 *   off(signal, cb)    -> this      (снять конкретную подписку)
 *   offAll(signal?)    -> this      (снять все подписки)
 *   listeners(signal)  -> number    (число рецепторов)
 *   replay(signal?)    -> Array     (история сигналов поля)
 *
 * Гарантии:
 *   • класс наследует EventEmitter (совместимость с .on/.once/.emit);
 *   • emit возвращает false, если на сигнал никто не подписан;
 *   • once срабатывает ровно один раз;
 *   • on/off симметричны, listeners считает корректно;
 *   • некорректное имя сигнала и не-функция слушателя -> TypeError;
 *   • replay возвращает защищённую копию истории.
 *
 * Запуск: node tests/bioelectricBus.test.js
 */

const assert = require('assert');
const { EventEmitter } = require('events');

const { BioelectricBus, createBus, normalizeSignal } = require('../src/utils/bioelectricBus');

let pass = 0;
let fail = 0;

/** Мини-раннер: ловит исключения, печатает PASS/FAIL, не роняет набор. */
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS ' + name);
  } catch (err) {
    fail++;
    console.log('FAIL ' + name + ' :: ' + err.message);
  }
}

/* ------------------------------------------------------------------------- *
 * 1. Базовый контракт: emit + on
 * ------------------------------------------------------------------------- */

test('emit + on: слушатель получает данные', () => {
  const bus = new BioelectricBus();
  let got = null;
  bus.on('Vm', (data) => { got = data; });

  assert.strictEqual(bus.emit('Vm', { mv: -70 }), true, 'emit с слушателем -> true');
  assert.deepStrictEqual(got, { mv: -70 }, 'слушатель получил нагрузку');
});

test('emit без слушателя возвращает false', () => {
  const empty = new BioelectricBus();
  assert.strictEqual(empty.emit('nothing', 42), false);
});

test('несколько слушателей одного сигнала — все уведомлены', () => {
  const bus = createBus();
  const seen = [];
  bus.on('gap', (d) => seen.push('a' + d));
  bus.on('gap', (d) => seen.push('b' + d));
  assert.strictEqual(bus.emit('gap', 1), true);
  assert.deepStrictEqual(seen.sort(), ['a1', 'b1']);
});

/* ------------------------------------------------------------------------- *
 * 2. once — ровно один импульс
 * ------------------------------------------------------------------------- */

test('once срабатывает ровно один раз', () => {
  const bus = createBus();
  let n = 0;
  bus.once('gap', () => { n++; });
  bus.emit('gap');
  bus.emit('gap');
  assert.strictEqual(n, 1);
});

/* ------------------------------------------------------------------------- *
 * 3. listeners / off
 * ------------------------------------------------------------------------- */

test('listeners считает подписки', () => {
  const bus = createBus();
  bus.on('Vm', () => {});
  assert.strictEqual(bus.listeners('Vm'), 1);
});

test('off снимает конкретную подписку', () => {
  const bus = createBus();
  const fn = () => {};
  bus.on('x', fn);
  assert.strictEqual(bus.listeners('x'), 1);
  bus.off('x', fn);
  assert.strictEqual(bus.listeners('x'), 0);
});

test('offAll очищает сигнал и поле целиком', () => {
  const bus = createBus();
  bus.on('a', () => {});
  bus.on('b', () => {});
  bus.offAll('a');
  assert.strictEqual(bus.listeners('a'), 0);
  assert.strictEqual(bus.listeners('b'), 1);
  bus.offAll();
  assert.strictEqual(bus.listeners('b'), 0);
});

/* ------------------------------------------------------------------------- *
 * 4. Чейнинг
 * ------------------------------------------------------------------------- */

test('on/once/off возвращают саму шину (чейнинг)', () => {
  const bus = createBus();
  const fn = () => {};
  assert.strictEqual(bus.on('s', fn), bus);
  assert.strictEqual(bus.once('s2', fn), bus);
  assert.strictEqual(bus.off('s', fn), bus);
});

/* ------------------------------------------------------------------------- *
 * 5. История сигналов
 * ------------------------------------------------------------------------- */

test('replay возвращает историю и защищённую копию', () => {
  const bus = createBus();
  bus.emit('Vm', 1);
  bus.emit('Vm', 2);
  bus.emit('gap', 3);

  assert.strictEqual(bus.replay('Vm').length, 2);
  assert.strictEqual(bus.replay().length, 3);

  const copy = bus.replay();
  copy.push({ forged: true });
  assert.strictEqual(bus.replay().length, 3, 'внешняя мутация не влияет на буфер');
});

/* ------------------------------------------------------------------------- *
 * 6. Совместимость с EventEmitter
 * ------------------------------------------------------------------------- */

test('BioelectricBus наследует EventEmitter', () => {
  assert.ok(new BioelectricBus() instanceof EventEmitter);
});

/* ------------------------------------------------------------------------- *
 * 7. Валидация входных данных
 * ------------------------------------------------------------------------- */

test('пустое/нестроковое имя сигнала -> TypeError', () => {
  const bus = createBus();
  assert.throws(() => bus.on('', () => {}), TypeError);
  assert.throws(() => bus.emit(42, 1), TypeError);
});

test('некорректные символы в имени сигнала -> TypeError', () => {
  const bus = createBus();
  assert.throws(() => bus.emit('bad signal!', 1), TypeError);
  assert.throws(() => bus.emit('a/b', 1), TypeError);
});

test('слушатель обязан быть функцией', () => {
  const bus = createBus();
  assert.throws(() => bus.on('s', 'nope'), TypeError);
  assert.throws(() => bus.once('s', 123), TypeError);
});

test('normalizeSignal пропускает допустимые имена', () => {
  assert.strictEqual(normalizeSignal('Vm.gap_2:main-x'), 'Vm.gap_2:main-x');
});

/* ------------------------------------------------------------------------- */

console.log('\nRESULT pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
