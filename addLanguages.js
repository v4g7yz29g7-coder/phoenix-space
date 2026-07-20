const db = require('./src/config/db');

// Добавляем колонку lang, если её ещё нет
db.exec(`ALTER TABLE contents ADD COLUMN lang TEXT DEFAULT 'ru'`);

// Обновляем существующие записи — они русские
db.exec(`UPDATE contents SET lang = 'ru' WHERE lang IS NULL OR lang = ''`);

// Функция вставки перевода
const insertTranslation = (hall, title, body, order, lang) => {
  db.prepare('INSERT INTO contents (hall, title, body, "order", lang) VALUES (?, ?, ?, ?, ?)').run(hall, title, body, order, lang);
};

// Переводы для "Шести Врат"
const gates = {
  en: [
    ['1. Reality', 'Everything you feel right now is the only reality. Don\'t run into past or future thoughts. Notice your breath, sounds, body sensations. This is the gate to freedom from illusions.\n\n💎 Tip: Stop for a minute, look around and say: "This is my life. It\'s real."'],
    ['2. Ambivalence', 'You can be angry and loving at the same time. This is not a contradiction — it is fullness. Allow yourself to be complex, unpolished, alive. Don\'t demand clarity.\n\n💎 Tip: Think of a person you have mixed feelings about and wish them well without suppressing your resentment.'],
    ['3. Paradox', 'Truth is almost always paradoxical. The more you give, the richer you become. The deeper you let go, the stronger you acquire. Trust contradictions.\n\n💎 Today: Find one paradox in your life and smile at it.'],
    ['4. Transgression', 'Step beyond familiar boundaries. Not destruction, but creation of the new. Do what you have never done: compliment a stranger, write a poem, take a different route.\n\n💎 Task: Perform a small act of courage today.'],
    ['5. Radicalism', 'Not half-measures. Say to yourself: "I will never betray my depth again." A quiet, unwavering determination to be yourself to the end.\n\n💎 Practice: Say this phrase aloud in front of a mirror.'],
    ['6. Naturalness', 'You don\'t have to try. You are already enough. Relax your shoulders, exhale, allow yourself to be as you are. This is awakening.\n\n💎 Affirmation: "I allow myself to be. Right now."']
  ],
  zh: [
    ['1. 现实', '你现在感受到的一切就是唯一的现实。不要逃入过去或未来的思绪中。注意呼吸、声音、身体的感觉。这是通往自由的大门。\n\n💎 提示：停下一分钟，环顾四周，说："这就是我的生活。它是真实的。"'],
    ['2. 矛盾并存', '你可以同时感到愤怒和爱。这不是矛盾——而是完整。允许自己复杂、不完美、鲜活。不要要求自己非此即彼。\n\n💎 提示：想起一个让你有复杂情绪的人，祝愿他们安好，同时不压抑你的怨恨。'],
    ['3. 悖论', '真理几乎总是矛盾的。你给予越多，就越富有。你放手越深，就越坚强。信任矛盾。\n\n💎 今天：在生活中找到一个悖论，对它微笑。'],
    ['4. 越界', '超越熟悉的界限。不是破坏，而是创造新事物。做你从未做过的事：赞美陌生人、写首诗、走不同的路。\n\n💎 任务：今天完成一个小小勇气之举。'],
    ['5. 激进', '不再半途而废。对自己说："我再也不背叛自己的深度。" 一种安静、不可动摇的决心，做自己到底。\n\n💎 练习：在镜子前大声说出这句话。'],
    ['6. 自然', '你无需努力。你已经足够。放松肩膀，呼气，允许自己如你所是。这就是觉醒。\n\n💎 肯定："我允许自己存在。就在此刻。"']
  ]
};

// Вставляем переводы (hall 'keys', порядок 1-6)
for (const lang of ['en', 'zh']) {
  gates[lang].forEach((gate, idx) => {
    insertTranslation('keys', gate[0], gate[1], idx + 1, lang);
  });
}

console.log('🌍 Мультиязычность добавлена (en, zh). Остальные языки — позже.');
process.exit(0);
