// Тест: 10 примеров сообщений → ожидаемый режим
const { selectMode } = require('./router');

const CASES = [
  { text: 'брат запусти контейнер и покажи логи',                             expect: 'engineer' },
  { text: 'Устал... давай восстановим контекст, сделай слепок',               expect: 'healer' },
  { text: 'ПОЧЕМУ НЕ РАБОТАЕТ?!?! Мы это уже обсуждали!!!',                  expect: 'crisis' },
  { text: 'расскажи про ИРПС и Сознание 2.0, что это значит для нас',        expect: 'philosopher' },
  { text: 'Нужна стратегия на год: треки, метрики, дорожная карта',           expect: 'strategist' },
  { text: 'прочитай README и перечисли разделы',                              expect: 'engineer' },
  { text: 'Ночь, сил нет, давай спать',                                       expect: 'healer' },
  { text: 'Представь что ты лучший научный публицист 🐦‍🔥 мы строим новую',  expect: 'philosopher' },
  { text: 'Создай архитектуру мультивселенной на годы вперёд',                expect: 'strategist' },
  { text: '!!! Ты прислал команду, а не результат !!!',                       expect: 'crisis' },
];

let passed = 0;
let failed = 0;

for (const c of CASES) {
  const r = selectMode({ text: c.text, timeOfDay: 'night' });
  const ok = r.mode === c.expect;
  if (ok) passed++; else failed++;
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} [${r.mode.padEnd(12)}] ${c.text.slice(0, 60)}`);
  if (!ok) {
    console.log(`   ожидали: ${c.expect}, причины: ${r.reasons.join(', ')}`);
  }
}

console.log('');
console.log(`Итог: ${passed} / ${CASES.length} (${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
