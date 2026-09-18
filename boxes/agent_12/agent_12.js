// agent_12.js — «Ментор» (Mentor)
//
// УНИКАЛЬНАЯ СТРАТЕГИЯ: ОБУЧЕНИЕ ЧЕРЕЗ ДЕЙСТВИЕ (learning by doing).
// Её нет ни у одного из agent_1..agent_11.
//
// Ментор отличается от «Документатора» (agent_6, просто журнал в memory/)
// тем, что рефлексия происходит ПОСЛЕ выполнения и привязана к ДЕЙСТВИЮ:
//   1) Сначала агент РЕШАЕТ задачу через agent_loop_v3 (исполнитель + критик).
//   2) После решения он разбирает собственный ход решения по шагам исполнения
//      (какие инструменты реально вызывались, что удалось, что нет) и создаёт
//      .md-файл-урок в memory/mentor/:
//        — что было сделано,
//        — какие инструменты использованы,
//        — что можно улучшить в следующий раз.
//   3) Урок привязан к оценке критика (score/verdict) — это делает вывод
//      проверяемым, а не декларативным.
//
// Ключевая идея: знание рождается из опыта конкретного прогона, а не из
// описания намерений. Следующий запуск агента может прочитать memory/mentor/.

const fs = require('fs');
const path = require('path');
const loop = require('./agent_loop_v3');

const STRATEGY = 'learning-by-doing: solve via agent_loop_v3, then write a reflective lesson to memory/mentor/';

// Каталог уроков (рядом с агентом — работает и в корне, и внутри бокса).
const LESSON_DIR = path.join(__dirname, 'memory', 'mentor');

/**
 * Превращает произвольный текст в безопасный слаг для имени файла.
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  /* TODO */
}

/**
 * Собирает список реально использованных инструментов из шагов исполнения.
 * @param {Array<{tool: string, ok: boolean}>} steps — результат result.steps.
 * @returns {{ tools: string[], counts: Object, failed: string[] }}
 */
function extractToolsUsed(steps) {
  /* TODO */
}

/**
 * Формирует текст урока: что сделано, какие инструменты, что улучшить.
 * @param {string} task — исходная задача.
 * @param {object} result — результат loop.runWithCritic.
 * @param {object} meta — { tools, counts, failed } из extractToolsUsed.
 * @returns {string} markdown-урок.
 */
function buildLessonMarkdown(task, result, meta) {
  /* TODO */
}

/**
 * Записывает .md-урок в memory/mentor/ и возвращает путь к файлу.
 * @param {string} task — исходная задача.
 * @param {object} result — результат loop.runWithCritic.
 * @returns {{ path: string|null, tools: string[], counts: Object, failed: string[] }}
 */
function writeLesson(task, result) {
  /* TODO */
}

/**
 * Точка входа агента: ОБУЧЕНИЕ ЧЕРЕЗ ДЕЙСТВИЕ.
 * @param {string} prompt — задача пользователя.
 * @param {object} [options] — { lessonsDir } переопределяет LESSON_DIR.
 * @returns {Promise<object>} результат прогона + path к уроку и разбор инструментов.
 */
async function runAgent(prompt, options = {}) {
  /* TODO */
}

module.exports = { runAgent, STRATEGY };
