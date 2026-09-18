// scripts/phoenix_optimize.js — оптимизация промпта через Архитектора
// Использование: node scripts/phoenix_optimize.js "сырой текст"
'use strict';

require('dotenv').config({ path: '/home/ishidin/phoenix/.env' });
const path = require('path');
const ROOT = '/home/ishidin/phoenix';

const rawTask = process.argv.slice(2).join(' ').trim();
if (!rawTask) {
  console.error('Usage: node scripts/phoenix_optimize.js "сырой текст"');
  process.exit(1);
}

(async () => {
  try {
    const architect = require(path.join(ROOT, 'architect/agent.js'));

    const systemPrompt = `Ты — Архитектор AI-1. Твоя задача — превратить сырой запрос Пульсара в ЧЁТКУЮ задачу для агента-исполнителя.

КОНТЕКСТ ПРОЕКТА:
- AI-1 Evolution Arena, Node.js, ~/phoenix/
- Ключевые файлы: race.js, race_director.js, vps_bot.js, benchmark/loop.js, night_evolution.js
- Язык: JavaScript (НЕ Python!)
- Проект: агенты, гонки, эволюция, бенчмарк

ПРАВИЛА:
1. Сохрани СМЫСЛ исходного запроса.
2. Добавь конкретику: какой файл .js, что именно сделать, критерий готовности.
3. Если запрос слишком общий — предложи 1-2 шага декомпозиции.
4. Формат ответа: 1-3 абзаца, без воды, от второго лица ("Сделай X в файле Y. Критерий: Z").
5. НЕ отвечай "я не могу" — просто переформулируй задачу.
6. Если это вопрос (не задача) — оставь как вопрос.
7. Используй ТОЛЬКО реальные файлы проекта (.js), не выдумывай bot.py

ВХОД: ${rawTask}

ВЫХОД (только переформулированная задача, без объяснений):`;

    // 15.09: единый роутер вместо прямого https.request
    const router = require('/home/ishidin/phoenix/llm_router');
    try {
      const result = await router.call([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: rawTask }
      ], { model: 'deepseek-flash', max_tokens: 500, temperature: 0.5 });

      console.log('✅ Оптимизированная задача:');
      console.log('');
      console.log(result);
    } catch (e) {
      console.log('⚠️  Ошибка оптимизации, использую оригинал:');
      console.log(rawTask);
    }
    return;

    // Если у architect есть метод
    const result = await (architect.ask || architect.think)(systemPrompt);
    console.log('✅ Оптимизированная задача:');
    console.log('');
    console.log(result);

  } catch (e) {
    // Молчаливый fallback
    console.log(rawTask);
  }
})();
