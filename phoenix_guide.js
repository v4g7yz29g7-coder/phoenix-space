// ============================================================================
//  phoenix_guide.js — Контекст-проводник Академии Phoenix
//  Читает README.md, ROADMAP.md и страницы public/ через fs,
//  отдаёт краткое описание проекта и отвечает на вопросы новичков.
//  Экспорт: { getContext, getFullContext, answerQuestion, recordInteraction }
// ============================================================================

const fs = require('fs');
const path = require('path');

const { askDeepSeekChat } = require('./llm_client');
const everos_client = require('./everos_client');

const WORKSPACE = '/home/ishidin/phoenix';
const README_PATH = path.join(WORKSPACE, 'README.md');
const ROADMAP_PATH = path.join(WORKSPACE, 'ROADMAP.md');
const PUBLIC_DIR = path.join(WORKSPACE, 'public');

const MAX_README_CHARS = 500;
const MAX_ROADMAP_CHARS = 300;
const MAX_DOC_CHARS = 1500;
const MAX_HTML_FILES = 3;

// Роль Проводника Академии Phoenix — задаёт тон и область знаний ответа.
const GUIDE_SYSTEM_PROMPT =
  'Ты — Проводник Академии Phoenix, помогаешь новичкам ориентироваться в практиках, залах и артефактах';

// Безопасное чтение: файл может отсутствовать — не роняем вызывающий код.
function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return '';
  }
}

// Контекст-срез Академии Phoenix: ровно первые 500 символов README.md.
function getContext() {
  const about = readText(README_PATH).slice(0, MAX_README_CHARS).trim();

  if (!about) {
    return '[phoenix_guide] README.md недоступен.';
  }

  return about;
}

// Расширенный контекст: README-срез + заголовки разделов ROADMAP.md.
function getFullContext() {
  const about = getContext();
  const roadmap = readText(ROADMAP_PATH);

  // Из ROADMAP берём только заголовки разделов — это компактный план развития.
  const plan = roadmap
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^#{1,3}\s/.test(line))
    .slice(0, 5)
    .join('\n');

  if (!plan) {
    return about;
  }

  return [about, plan.slice(0, MAX_ROADMAP_CHARS)].filter(Boolean).join('\n\n');
}

// Первые N .html-страниц из public/ — компактный срез публичного контента.
function firstHtmlPages(dir, limit = MAX_HTML_FILES) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.html'))
      .sort()
      .slice(0, limit)
      .map((name) => path.join(dir, name));
  } catch (err) {
    return [];
  }
}

// Ответ на вопрос новичка: README.md + первые 3 .html из public/ идут в контекст,
// ответ генерирует DeepSeek через askDeepSeekChat из llm_client.js.
async function answerQuestion(question, user_id) {
  const readme = readText(README_PATH).slice(0, MAX_DOC_CHARS).trim();

  const pages = firstHtmlPages(PUBLIC_DIR)
    .map((filePath) => {
      const content = readText(filePath).slice(0, MAX_DOC_CHARS).trim();
      return content ? `=== ${path.basename(filePath)} ===\n${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  const knowledge = [
    readme ? `=== README.md ===\n${readme}` : '',
    pages
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages = [
    { role: 'system', content: GUIDE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        'Материалы Академии Phoenix:',
        knowledge || '(материалы недоступны)',
        '',
        `Вопрос от ${user_id || 'новичка'}: ${question}`
      ].join('\n')
    }
  ];

  return askDeepSeekChat(messages);
}

// Сохраняет состоявшийся диалог проводника в EverOS: вопрос и ответ
// уходят одной записью в виде текста 'Q: ... A: ...'.
async function recordInteraction(question, answer, user_id) {
  const text = 'Q: ' + question + ' A: ' + answer;

  return everos_client.recordTask(
    text,
    { answer: String(answer == null ? '' : answer) },
    { score: 'n/a', verdict: 'guide:' + (user_id || 'guest') }
  );
}

module.exports = { getContext, getFullContext, answerQuestion, recordInteraction };
