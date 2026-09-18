/**
 * dialogue_analyzer.js — читает corpus/architect/dialogues/*.json
 * (пары user+assistant) и выдаёт сообщения в формате, совместимом с
 * core_analyzer.parseDocument() → { file, title, date, messages: string[] }.
 *
 * Используется dna_builder.js когда opts.useDialogues = true.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'corpus', 'architect', 'dialogues');

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

function listDialogueFiles(dir) {
  const d = dir || DEFAULT_DIR;
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => path.join(d, f))
    .sort();
}

/**
 * Преобразует один файл диалога в "документ":
 *  - messages: склеенные пары "USER: ... ASSISTANT: ..."
 *  - сохраняет разделение на USER и ASST фрагменты отдельными записями
 *    в поле turns для тонкого анализа.
 */
function parseDialogue(filePath) {
  const raw = safeRead(filePath);
  if (!raw) return { file: filePath, title: null, date: null, messages: [], turns: [] };

  let turns;
  try { turns = JSON.parse(raw); } catch (e) {
    return { file: filePath, title: null, date: null, messages: [], turns: [] };
  }

  const base = path.basename(filePath, '.json');
  // Имя вида "001_Приветствие_и_предложение_помощи"
  const m = base.match(/^(\d+)_(.+)$/);
  const title = m ? m[2].replace(/_/g, ' ') : base;

  const messages = [];
  for (const t of turns) {
    // Каждое сообщение — отдельная строка для частотного анализа
    if (t.user) messages.push(t.user);
    if (t.assistant) messages.push(t.assistant);
  }

  const date = turns.length && turns[0].ts ? String(turns[0].ts).slice(0, 10) : null;

  return {
    file: filePath,
    title,
    date,
    messages,
    turns: turns.map((t) => ({
      user: t.user || '',
      assistant: t.assistant || '',
      ts: t.ts || null,
    })),
  };
}

/** Собрать "документы" из всех файлов dialogues/. */
function collectDialogueDocuments(dir) {
  return listDialogueFiles(dir).map(parseDialogue);
}

/** Собрать все сообщения из dialogues/ (плоский массив строк). */
function collectDialogueMessages(dir) {
  const docs = collectDialogueDocuments(dir);
  const out = [];
  for (const d of docs) for (const m of d.messages) out.push(m);
  return out;
}


/**
 * Конвертирует dialogues/*.json в массив {file, content} для core_analyzer.analyze({raw: [...]}).
 * Каждый turn → две строки: user и assistant, разделённые "\n---\n".
 */
function toRawDocuments(dir) {
  const docs = collectDialogueDocuments(dir);
  const out = [];
  for (const d of docs) {
    const lines = [];
    lines.push('# ' + (d.title || 'untitled'));
    if (d.date) lines.push('');
    if (d.date) lines.push('_Дата: ' + d.date + '_');
    lines.push('');
    for (const t of d.turns) {
      if (t.user) {
        lines.push('---');
        lines.push('');
        lines.push(t.user);
        lines.push('');
      }
      if (t.assistant) {
        lines.push('---');
        lines.push('');
        lines.push(t.assistant);
        lines.push('');
      }
    }
    out.push({
      file: d.file,
      content: lines.join('\n'),
    });
  }
  return out;
}

module.exports = { toRawDocuments,
  DEFAULT_DIR,
  listDialogueFiles,
  parseDialogue,
  collectDialogueDocuments,
  collectDialogueMessages,
};
