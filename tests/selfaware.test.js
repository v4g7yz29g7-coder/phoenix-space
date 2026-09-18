'use strict';
// tests/selfaware.test.js
// Проверка самовоспоминания (Гурджиев): каждые N=3 шага — мета-промпт
// «Что ты делаешь? Соответствует ли цели?», лог с префиксом [SELFAWARE].

const A = require('../selfaware.js');
const B = require('../self_awareness.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

// --- selfaware.js ---
check('N === 3', A.N === 3);
check('META_PROMPT text', A.META_PROMPT === 'Что ты делаешь? Соответствует ли цели?');
check('PREFIX === [SELFAWARE]', A.PREFIX === '[SELFAWARE]');

check('shouldRecall 3 -> true', A.shouldRecall(3) === true);
check('shouldRecall 6 -> true', A.shouldRecall(6) === true);
check('shouldRecall 1 -> false', A.shouldRecall(1) === false);
check('shouldRecall 2 -> false', A.shouldRecall(2) === false);

// перехватываем лог, чтобы проверить префикс и периодичность
const lines = [];
const origLog = console.log;
console.log = (...args) => { lines.push(args.join(' ')); };

const hits = [];
for (let s = 1; s <= 9; s++) {
  const r = A.remind(s, { goal: 'Добавить самовоспоминание', last: 'шаг ' + s });
  if (r) hits.push(s);
}
console.log = origLog;

check('remind сработал на шагах 3,6,9', JSON.stringify(hits) === JSON.stringify([3, 6, 9]));
check('лог содержит мета-промпт', lines.some(l => l.includes('Что ты делаешь? Соответствует ли цели?')));
check('каждая строка лога с [SELFAWARE]', lines.length > 0 && lines.every(l => l.startsWith('[SELFAWARE]')));

// inject в массив сообщений агента
const msgs = [];
const injected = A.inject(3, msgs, { goal: 'g', last: 'l' });
check('inject на 3-м шаге -> true', injected === true && msgs.length === 1);
const notInjected = A.inject(4, msgs, { goal: 'g', last: 'l' });
check('inject на 4-м шаге -> false', notInjected === false && msgs.length === 1);

// --- self_awareness.js (фабрика, общий счётчик) ---
const sa = B.createSelfAwareness({ every: 3, log: () => {} });
const refl = [];
for (let i = 1; i <= 7; i++) {
  const res = sa.step('loop', 'действие ' + i);
  if (res.reflect) refl.push(res.n);
}
check('фабрика: reflect на 3 и 6', JSON.stringify(refl) === JSON.stringify([3, 6]));
check('фабрика: every === 3', sa.every === 3);
check('фабрика: count === 7', sa.count('loop') === 7);
check('shared singleton есть', !!B.shared && typeof B.shared.step === 'function');

console.log('\nRESULT pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
