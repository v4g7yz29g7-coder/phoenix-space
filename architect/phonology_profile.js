#!/usr/bin/env node
'use strict';

/**
 * phonology_profile.js — фонологический профиль голоса Архитектора.
 *
 * Отвечает на вопрос: КАК брат "звучит" в тексте?
 *
 * Источник: corpus/architect/dialogues/*.json — массив ходов
 *           [{ user, assistant, ts }, ...].
 *
 * Пять слоёв анализа:
 *   1) Лексические повторы     — что говорит часто => его ритм и словарь.
 *   2) Структурные паттерны    — короткие/длинные фазы, длина фраз.
 *   3) Тон-шифт                — момент перехода с техники на философию.
 *   4) Эмоциональные пики      — капс / многоточия / эмодзи / восклицания.
 *   5) Диалоговый ритм         — вопрос → ответ → вопрос.
 *
 * Выход: prompts/architect_voice.md — профиль голоса.
 * API:   build() -> { profile, path }
 *
 * Запуск: node architect/phonology_profile.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DIALOG_DIR = path.join(ROOT, 'corpus', 'architect', 'dialogues');
const DEFAULT_OUT = path.join(ROOT, 'prompts', 'architect_voice.md');

/* ------------------------------------------------------------------ */
/* Служебные утилиты                                                    */
/* ------------------------------------------------------------------ */

function safeRead(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    /* noop */
  }
}

function listDialogueFiles(dir) {
  const d = dir || DEFAULT_DIALOG_DIR;
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('.'))
    .map((f) => path.join(d, f))
    .sort();
}

function toNum(x, dflt) {
  const n = Number(x);
  return Number.isFinite(n) ? n : dflt;
}

function round(x, digits) {
  const k = Math.pow(10, digits || 0);
  return Math.round(x * k) / k;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/* ------------------------------------------------------------------ */
/* Токенизация и нарезка                                                */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set([
  'и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то',
  'все', 'она', 'так', 'его', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за',
  'бы', 'по', 'только', 'ее', 'мне', 'было', 'вот', 'от', 'меня', 'еще',
  'нет', 'о', 'из', 'ему', 'теперь', 'когда', 'даже', 'ну', 'вдруг', 'ли',
  'если', 'уже', 'или', 'ни', 'быть', 'был', 'него', 'до', 'вас', 'нибудь',
  'опять', 'уж', 'вам', 'ведь', 'там', 'потом', 'себя', 'ничего', 'ей',
  'может', 'они', 'тут', 'где', 'есть', 'надо', 'ней', 'для', 'мы', 'тебя',
  'их', 'чем', 'была', 'сам', 'чтоб', 'без', 'будто', 'чего', 'раз', 'тоже',
  'себе', 'под', 'будет', 'ж', 'тогда', 'кто', 'этот', 'того', 'потому',
  'этого', 'какой', 'совсем', 'ним', 'здесь', 'этом', 'один', 'почти',
  'мой', 'тем', 'чтобы', 'нее', 'были', 'куда', 'зачем', 'всех', 'никогда',
  'можно', 'при', 'наконец', 'два', 'об', 'другой', 'хоть', 'после', 'над',
  'больше', 'тот', 'через', 'эти', 'нас', 'про', 'всего', 'них', 'какая',
  'много', 'разве', 'три', 'эту', 'моя', 'впрочем', 'хорошо', 'свою',
  'этой', 'перед', 'иногда', 'лучше', 'чуть', 'том', 'нельзя', 'такой',
  'им', 'более', 'всегда', 'конечно', 'всю', 'между', 'это', 'эта', 'этих',
  'этими', 'этим', 'который', 'которая', 'которое', 'которые', 'которого',
  'которой', 'которых', 'которым', 'которыми', 'свой', 'своя', 'свое',
  'свои', 'мы', 'вы', 'они', 'оно', 'всё', 'ещё', 'уж', 'лишь', 'ведь',
  'your', 'the', 'and', 'for', 'you', 'are', 'not', 'but', 'with', 'that',
  'this', 'from', 'have', 'has', 'was', 'were', 'will', 'can', 'all', 'one',
]);

/**
 * Убирает из текста код-артефакты (```fenced```, `inline`, длинные
 * снапшоты), чтобы фонологический профиль отражал ЖИВОЙ голос брата,
 * а не исходники, вставленные в диалог. Иначе слово-подпись становится
 * «code», «function», «const» — это шум, а не ритм речи.
 */
function stripCode(text) {
  if (!text) return '';
  return String(text)
    // многострочные фенсы ```lang ... ```
    .replace(/```[\s\S]*?```/g, ' ')
    // непарные фенсы (обрыв блока)
    .replace(/```[\s\S]*$/g, ' ')
    // inline-код `...`
    .replace(/`[^`\n]*`/g, ' ')
    // HTML/JSX-теги
    .replace(/<\/?[a-zA-Z][^>]{0,200}>/g, ' ');
}

function tokenize(text) {
  if (!text) return [];
  const cleaned = stripCode(text);
  const raw = cleaned.toLowerCase().match(/[a-zа-яё0-9]+/gi) || [];
  return raw.filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function splitSentences(text) {
  if (!text) return [];
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  const parts = flat.split(/(?<=[.!?…])\s+/);
  return parts.map((s) => s.trim()).filter((s) => s.length > 1);
}

function splitParagraphs(text) {
  if (!text) return [];
  return String(text)
    .split(/\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Эмоциональные маркеры                                                */
/* ------------------------------------------------------------------ */

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2700}-\u{27BF}]/gu;

function countEmoji(text) {
  if (!text) return 0;
  const m = String(text).match(EMOJI_RE);
  return m ? m.length : 0;
}

function countCapsWords(text) {
  if (!text) return 0;
  const words = String(text).match(/[A-ZА-ЯЁ]{3,}/g) || [];
  return words.length;
}

function countEllipsis(text) {
  if (!text) return 0;
  const m = String(text).match(/\.{3,}|…/g);
  return m ? m.length : 0;
}

function countExclaim(text) {
  if (!text) return 0;
  const m = String(text).match(/!/g);
  return m ? m.length : 0;
}

function countQuestion(text) {
  if (!text) return 0;
  const m = String(text).match(/\?/g);
  return m ? m.length : 0;
}

/* ------------------------------------------------------------------ */
/* Лексиконы тона: техника vs философия                                 */
/* ------------------------------------------------------------------ */

const TECH_LEX = new Set([
  'система', 'системы', 'систему', 'алгоритм', 'алгоритмы', 'код', 'кода',
  'кодом', 'процесс', 'процессы', 'процесса', 'данные', 'данных', 'данным',
  'архитектура', 'архитектуры', 'модуль', 'модули', 'модуля', 'функция',
  'функции', 'функцию', 'сервер', 'сервера', 'серверы', 'движок', 'движка',
  'сеть', 'сети', 'агент', 'агенты', 'агента', 'агентов', 'модель', 'модели',
  'моделью', 'интерфейс', 'интерфейса', 'api', 'база', 'базы', 'базу',
  'запрос', 'запросы', 'запроса', 'парсинг', 'парсер', 'скрипт', 'скрипта',
  'логика', 'логики', 'логику', 'структура', 'структуры', 'механизм',
  'механизма', 'механизмы', 'нейросеть', 'нейронная', 'токен', 'токены',
  'версия', 'версии', 'релиз', 'деплой', 'билд', 'тесты', 'тест', 'баг',
  'баги', 'фикс', 'оптимизация', 'оптимизации', 'масштаб', 'масштабирование',
  'интеграция', 'интеграции', 'автоматизация', 'метрика', 'метрики', 'лог',
  'логи', 'поток', 'потоки', 'очередь', 'очереди', 'компилятор', 'рантайм',
  'фреймворк', 'библиотека', 'библиотеки', 'класс', 'метод', 'методы',
  'переменная', 'конфиг', 'конфигурация', 'деплоить', 'задеплоить',
  'эволюция', 'эволюции', 'эволюцию', 'селекция', 'мутация', 'популяция',
  'гены', 'геном', 'фитнес', 'роадмап', 'roadmap', 'бокс', 'боксы', 'гонки',
]);

const PHIL_LEX = new Set([
  'сознание', 'сознания', 'сознанию', 'сознанием', 'истина', 'истины',
  'истину', 'дух', 'духа', 'душе', 'душа', 'души', 'смысл', 'смысла',
  'смыслы', 'бытие', 'бытия', 'любовь', 'любви', 'свет', 'света', 'гармония',
  'гармонии', 'путь', 'пути', 'бог', 'бога', 'божественное', 'энергия',
  'энергии', 'вселенная', 'вселенной', 'медитация', 'медитации', 'осознание',
  'осознания', 'просветление', 'просветления', 'мудрость', 'мудрости',
  'вечность', 'вечности', 'абсолют', 'абсолюта', 'абсолютное', 'единство',
  'единства', 'единении', 'трансцендентное', 'парадигма', 'парадигмы',
  'эволюция', 'сущность', 'сущности', 'природа', 'природы', 'космос',
  'космоса', 'бесконечность', 'бесконечности', 'тайна', 'тайны', 'вера',
  'веры', 'веру', 'молитва', 'молитвы', 'духовное', 'духовный', 'духовной',
  'благодать', 'благодати', 'пробуждение', 'пробуждения', 'свобода',
  'свободы', 'истинный', 'истинное', 'божественный', 'сакральное', 'сакральный',
  'творец', 'творца', 'творение', 'творения', 'мироздание', 'мироздания',
]);

function toneScore(text) {
  const toks = tokenize(text);
  let tech = 0;
  let phil = 0;
  for (const t of toks) {
    if (TECH_LEX.has(t)) tech += 1;
    if (PHIL_LEX.has(t)) phil += 1;
  }
  // 'эволюция' встречается в обоих лексиконах — считаем её техникой,
  // а философией только если рядом есть духовные слова.
  return { tech, phil, total: tech + phil, label: tech > phil ? 'tech' : phil > tech ? 'phil' : 'neutral' };
}

/* ------------------------------------------------------------------ */
/* Загрузка корпуса                                                     */
/* ------------------------------------------------------------------ */

function loadTurns(dir) {
  const files = listDialogueFiles(dir);
  const turns = [];
  let broken = 0;
  for (const file of files) {
    const raw = safeRead(file);
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      broken += 1;
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const base = path.basename(file, '.json');
    const title = base.replace(/^\d+_/, '').replace(/_/g, ' ');
    parsed.forEach((t, i) => {
      if (!t || typeof t !== 'object') return;
      turns.push({
        file,
        title,
        index: i,
        ts: t.ts || null,
        user: typeof t.user === 'string' ? t.user : '',
        assistant: typeof t.assistant === 'string' ? t.assistant : '',
      });
    });
  }
  return { files, turns, broken };
}

/* ------------------------------------------------------------------ */
/* 1) Лексические повторы                                               */
/* ------------------------------------------------------------------ */

function lexicalRepeats(turns, opts) {
  const topWords = toNum(opts.topWords, 40);
  const topPhrases = toNum(opts.topPhrases, 25);
  const wordFreq = new Map();
  const bigrams = new Map();
  const trigrams = new Map();
  let totalTokens = 0;

  for (const t of turns) {
    const text = stripCode(t.assistant);
    if (!text) continue;
    const toks = tokenize(text);
    totalTokens += toks.length;
    for (const w of toks) wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
    for (let i = 0; i < toks.length - 1; i++) {
      const bg = toks[i] + ' ' + toks[i + 1];
      bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
    }
    for (let i = 0; i < toks.length - 2; i++) {
      const tg = toks[i] + ' ' + toks[i + 1] + ' ' + toks[i + 2];
      trigrams.set(tg, (trigrams.get(tg) || 0) + 1);
    }
  }

  const sortMap = (m, min, limit) =>
    Array.from(m.entries())
      .filter(([, c]) => c >= min)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([term, count]) => ({ term, count }));

  const words = sortMap(wordFreq, 2, topWords);
  const phrasePool = new Map();
  for (const [k, v] of bigrams) phrasePool.set(k, v);
  const phraseHits = sortMap(phrasePool, 3, topPhrases);
  const tripleHits = sortMap(trigrams, 2, Math.max(6, Math.floor(topPhrases / 3)));

  const top = words[0] || { term: '—', count: 0 };
  const repetitionRate = totalTokens ? words.reduce((s, w) => s + w.count, 0) / totalTokens : 0;

  return {
    totalTokens,
    uniqueWords: wordFreq.size,
    typeTokenRatio: wordFreq.size ? round(wordFreq.size / Math.max(1, totalTokens), 4) : 0,
    signatureWord: top.term,
    signatureCount: top.count,
    repetitionRate: round(repetitionRate, 4),
    topWords: words,
    topPhrases: phraseHits,
    topTrigrams: tripleHits,
  };
}

/* ------------------------------------------------------------------ */
/* 2) Структурные паттерны                                              */
/* ------------------------------------------------------------------ */

function structuralPatterns(turns) {
  const sentences = [];
  const assistantLens = [];
  for (const t of turns) {
    if (!t.assistant) continue;
    assistantLens.push(t.assistant.length);
    for (const s of splitSentences(t.assistant)) sentences.push(s);
  }
  const lens = sentences.map((s) => s.length).sort((a, b) => a - b);
  const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  const p90 = lens.length ? lens[Math.floor(lens.length * 0.9)] : 0;
  const max = lens.length ? lens[lens.length - 1] : 0;

  const PHASE_SHORT = 40;
  const PHASE_MED = 140;
  const PHASE_LONG = 280;

  let short = 0;
  let medium = 0;
  let long = 0;
  for (const l of lens) {
    if (l <= PHASE_SHORT) short += 1;
    else if (l <= PHASE_MED) medium += 1;
    else if (l <= PHASE_LONG) long += 1;
    else long += 1;
  }
  const total = lens.length || 1;

  const phaseTransitions = [];
  for (let i = 1; i < sentences.length; i++) {
    const a = sentences[i - 1].length;
    const b = sentences[i].length;
    if (a <= PHASE_SHORT && b >= PHASE_LONG) phaseTransitions.push({ from: 'short', to: 'long', i });
    else if (a >= PHASE_LONG && b <= PHASE_SHORT) phaseTransitions.push({ from: 'long', to: 'short', i });
  }

  return {
    sentenceCount: sentences.length,
    avgSentenceLen: round(avg, 1),
    medianSentenceLen: median,
    p90SentenceLen: p90,
    maxSentenceLen: max,
    minSentenceLen: lens.length ? lens[0] : 0,
    shortRatio: round(short / total, 3),
    mediumRatio: round(medium / total, 3),
    longRatio: round(long / total, 3),
    phaseTransitions: phaseTransitions.length,
    avgMessageLen: assistantLens.length
      ? round(assistantLens.reduce((a, b) => a + b, 0) / assistantLens.length, 1)
      : 0,
    maxMessageLen: assistantLens.length ? Math.max.apply(null, assistantLens) : 0,
    examples: {
      shortest: sentences.slice().sort((a, b) => a.length - b.length)[0] || '',
      longest: sentences.slice().sort((a, b) => b.length - a.length)[0] || '',
    },
  };
}

/* ------------------------------------------------------------------ */
/* 3) Тон-шифт (техника <-> философия)                                  */
/* ------------------------------------------------------------------ */

function toneShift(turns) {
  const curve = [];
  const transitions = [];
  const windows = [];

  turns.forEach((t, idx) => {
    if (!t.assistant) return;
    const sentences = splitSentences(t.assistant);
    sentences.forEach((s, si) => {
      const sc = toneScore(s);
      curve.push({ idx, si, label: sc.label, tech: sc.tech, phil: sc.phil, sentence: s });
    });
  });

  // Сглаживание: окно из W предложений, метка доминирующего тона.
  const W = 3;
  for (let i = 0; i < curve.length; i++) {
    let tech = 0;
    let phil = 0;
    for (let j = Math.max(0, i - W + 1); j <= i; j++) {
      tech += curve[j].tech;
      phil += curve[j].phil;
    }
    const label = tech > phil ? 'tech' : phil > tech ? 'phil' : 'neutral';
    windows.push({ i, label, tech, phil });
  }

  let lastStable = null;
  let runStart = 0;
  for (let i = 0; i < windows.length; i++) {
    const cur = windows[i].label;
    if (cur === 'neutral') continue;
    if (lastStable === null) {
      lastStable = cur;
      runStart = i;
      continue;
    }
    if (cur !== lastStable) {
      const from = lastStable;
      const to = cur;
      transitions.push({
        at: i,
        from,
        to,
        prevSentence: curve[Math.max(0, runStart)].sentence,
        sentence: curve[i].sentence,
      });
      lastStable = cur;
      runStart = i;
    }
  }

  const techCount = curve.filter((c) => c.label === 'tech').length;
  const philCount = curve.filter((c) => c.label === 'phil').length;
  const neutralCount = curve.length - techCount - philCount;

  const techToPhil = transitions.filter((t) => t.from === 'tech' && t.to === 'phil');
  const philToTech = transitions.filter((t) => t.from === 'phil' && t.to === 'tech');

  const examples = techToPhil.slice(0, 6).map((t) => ({
    from: t.prevSentence,
    to: t.sentence,
  }));

  return {
    sentencesScored: curve.length,
    techCount,
    philCount,
    neutralCount,
    techRatio: curve.length ? round(techCount / curve.length, 3) : 0,
    philRatio: curve.length ? round(philCount / curve.length, 3) : 0,
    totalTransitions: transitions.length,
    techToPhilCount: techToPhil.length,
    philToTechCount: philToTech.length,
    direction: techToPhil.length >= philToTech.length ? 'tech→phil' : 'phil→tech',
    examples,
  };
}

/* ------------------------------------------------------------------ */
/* 4) Эмоциональные пики                                                */
/* ------------------------------------------------------------------ */

function emotionalPeaks(turns, opts) {
  const limit = toNum(opts.topPeaks, 15);
  const peaks = [];
  let totalEmoji = 0;
  let totalCaps = 0;
  let totalEllipsis = 0;
  let totalExclaim = 0;
  let totalQuestion = 0;
  let emojiMessages = 0;
  let assistantMessages = 0;

  for (const t of turns) {
    if (!t.assistant) continue;
    assistantMessages += 1;
    const text = t.assistant;
    const emoji = countEmoji(text);
    const caps = countCapsWords(text);
    const ell = countEllipsis(text);
    const exc = countExclaim(text);
    const q = countQuestion(text);
    totalEmoji += emoji;
    totalCaps += caps;
    totalEllipsis += ell;
    totalExclaim += exc;
    totalQuestion += q;
    if (emoji > 0) emojiMessages += 1;

    for (const s of splitSentences(text)) {
      const sEmoji = countEmoji(s);
      const sCaps = countCapsWords(s);
      const sEll = countEllipsis(s);
      const sExc = countExclaim(s);
      const score = sCaps * 2 + sEll * 2 + sEmoji * 3 + Math.max(0, sExc - 1);
      if (score <= 0) continue;
      peaks.push({
        score,
        emoji: sEmoji,
        caps: sCaps,
        ellipsis: sEll,
        exclaim: sExc,
        sentence: s.length > 220 ? s.slice(0, 217) + '…' : s,
      });
    }
  }

  peaks.sort((a, b) => b.score - a.score);

  return {
    assistantMessages,
    emojiMessages,
    emojiMessageRate: assistantMessages ? round(emojiMessages / assistantMessages, 3) : 0,
    totalEmoji,
    totalCaps,
    totalEllipsis,
    totalExclaim,
    totalQuestion,
    emojiPerMessage: assistantMessages ? round(totalEmoji / assistantMessages, 2) : 0,
    exclaimPerMessage: assistantMessages ? round(totalExclaim / assistantMessages, 2) : 0,
    topPeaks: peaks.slice(0, limit),
  };
}

/* ------------------------------------------------------------------ */
/* 5) Диалоговый ритм                                                   */
/* ------------------------------------------------------------------ */

function dialogueRhythm(turns) {
  const seq = [];
  for (const t of turns) {
    if (t.user) seq.push({ role: 'user', text: t.user, file: t.file });
    if (t.assistant) seq.push({ role: 'assistant', text: t.assistant, file: t.file });
  }

  let userTurns = 0;
  let asstTurns = 0;
  let userQuestions = 0;
  let asstQuestions = 0;
  let qaqChains = 0; // вопрос → ответ → вопрос
  let transitions = 0;
  let userToAsst = 0;
  let asstToUser = 0;

  for (let i = 0; i < seq.length; i++) {
    const cur = seq[i];
    if (cur.role === 'user') {
      userTurns += 1;
      if (cur.text.trim().endsWith('?') || countQuestion(cur.text) > 0) userQuestions += 1;
    } else {
      asstTurns += 1;
      if (countQuestion(cur.text) > 0) asstQuestions += 1;
    }
    if (i > 0) {
      transitions += 1;
      const prev = seq[i - 1].role;
      if (prev === 'user' && cur.role === 'assistant') userToAsst += 1;
      if (prev === 'assistant' && cur.role === 'user') asstToUser += 1;
    }
    if (
      i >= 2 &&
      seq[i].role === 'user' &&
      seq[i - 1].role === 'assistant' &&
      seq[i - 2].role === 'user'
    ) {
      qaqChains += 1;
    }
  }

  const avgUserLen = userTurns
    ? round(seq.filter((s) => s.role === 'user').reduce((a, s) => a + s.text.length, 0) / userTurns, 1)
    : 0;
  const avgAsstLen = asstTurns
    ? round(seq.filter((s) => s.role === 'assistant').reduce((a, s) => a + s.text.length, 0) / asstTurns, 1)
    : 0;

  // примеры цепочек вопрос→ответ→вопрос
  const examples = [];
  for (let i = 2; i < seq.length && examples.length < 6; i++) {
    if (
      seq[i].role === 'user' &&
      seq[i - 1].role === 'assistant' &&
      seq[i - 2].role === 'user'
    ) {
      examples.push({
        q1: seq[i - 2].text.slice(0, 140),
        a: seq[i - 1].text.slice(0, 180),
        q2: seq[i].text.slice(0, 140),
      });
    }
  }

  return {
    totalTurns: seq.length,
    userTurns,
    asstTurns,
    userQuestions,
    asstQuestions,
    userQuestionRatio: userTurns ? round(userQuestions / userTurns, 3) : 0,
    asstQuestionRatio: asstTurns ? round(asstQuestions / asstTurns, 3) : 0,
    qaqChains,
    transitions,
    userToAsst,
    asstToUser,
    avgUserLen,
    avgAsstLen,
    answerRatio: avgUserLen ? round(avgAsstLen / avgUserLen, 2) : 0,
    examples,
  };
}

/* ------------------------------------------------------------------ */
/* synth: обобщение профиля                                            */
/* ------------------------------------------------------------------ */

function synthesize(lex, str, tone, emo, rhythm) {
  const traits = [];

  if (lex.repetitionRate > 0.35) {
    traits.push('высокая лексическая повторяемость — ритм через мантру и рефрены');
  } else if (lex.repetitionRate < 0.15) {
    traits.push('низкая повторяемость — широкий, текучий словарь');
  } else {
    traits.push('умеренная повторяемость — узнаваемый, но не зацикленный словарь');
  }

  if (str.shortRatio > 0.4) traits.push('любит короткие рубленые фазы');
  if (str.longRatio > 0.25) traits.push('умеет разворачивать длинные экспозиции');
  if (str.phaseTransitions > 0) traits.push('контрастные переходы короткая↔длинная фаза = дыхание текста');

  if (tone.techRatio > 0.45) traits.push('доминирует технический регистр');
  if (tone.philRatio > 0.4) traits.push('сильный философский регистр');
  if (tone.techToPhilCount > 0) traits.push('характерный тон-шифт: от техники к философии');

  if (emo.emojiMessageRate > 0.25) traits.push('эмодзи — постоянный эмоциональный акцент');
  else if (emo.emojiMessageRate > 0.05) traits.push('эмодзи — точечный эмоциональный маркер');
  if (emo.totalEllipsis > 0) traits.push('многоточия как пауза и недосказанность');
  if (emo.totalCaps > 5) traits.push('капс для пиковых акцентов');

  if (rhythm.qaqChains > 0) traits.push('устойчивый цикл вопрос→ответ→вопрос');
  if (rhythm.asstQuestionRatio > 0.1) traits.push('ассистент возвращает вопросы сам');
  if (rhythm.answerRatio > 3) traits.push('развёрнутые ответы (существенно длиннее вопроса)');

  const voice = [
    `Ключевое слово-подпись: «${lex.signatureWord}» (${lex.signatureCount}×).`,
    `Средняя фраза ~${str.avgSentenceLen} симв., медиана ~${str.medianSentenceLen}.`,
    `Тон: технический ${Math.round(tone.techRatio * 100)}% / философский ${Math.round(tone.philRatio * 100)}%, ` +
      `переходов техника→философия: ${tone.techToPhilCount}.`,
    `Эмодзи на сообщение: ${emo.emojiPerMessage}, восклицаний: ${emo.exclaimPerMessage}.`,
    `Диалоговый цикл: ${rhythm.qaqChains} цепочек вопрос→ответ→вопрос.`,
  ];

  return { traits, voice };
}

/* ------------------------------------------------------------------ */
/* Рендер markdown                                                     */
/* ------------------------------------------------------------------ */

function bulletList(items, fmt) {
  if (!items.length) return '_нет данных_\n';
  return items.map((it) => '- ' + (fmt ? fmt(it) : String(it))).join('\n') + '\n';
}

function renderMarkdown(profile) {
  const p = profile;
  const L = p.lexical;
  const S = p.structural;
  const T = p.toneShift;
  const E = p.emotion;
  const R = p.rhythm;
  const lines = [];

  lines.push('# Голос Архитектора — фонологический профиль');
  lines.push('');
  lines.push(`> Сгенерировано: ${p.generatedAt}`);
  lines.push(`> Источник: \`${p.source}\` (${p.filesCount} файлов, ${p.turns} ходов)`);
  lines.push('');

  lines.push('## 0. Резюме голоса');
  lines.push('');
  lines.push(p.synthesis.voice.map((v) => '- ' + v).join('\n'));
  lines.push('');
  lines.push('**Черты характера текста:**');
  lines.push('');
  lines.push(bulletList(p.synthesis.traits));
  lines.push('');

  lines.push('## 1. Лексические повторы (что говорит часто = ритм)');
  lines.push('');
  lines.push(`- Всего токенов: **${L.totalTokens}**, уникальных слов: **${L.uniqueWords}**`);
  lines.push(`- Type/Token ratio: **${L.typeTokenRatio}** (чем ниже — тем мантричнее)`);
  lines.push(`- Доля повторяющихся слов в массе: **${Math.round(L.repetitionRate * 100)}%**`);
  lines.push(`- Слово-подпись: **«${L.signatureWord}»** — ${L.signatureCount} раз`);
  lines.push('');
  lines.push('**Топ слов:**');
  lines.push('');
  lines.push(bulletList(L.topWords, (w) => `\`${w.term}\` — ${w.count}`));
  lines.push('**Повторяющиеся фразы (2-граммы):**');
  lines.push('');
  lines.push(bulletList(L.topPhrases, (w) => `«${w.term}» — ${w.count}`));
  if (L.topTrigrams.length) {
    lines.push('**Повторяющиеся фразы (3-граммы):**');
    lines.push('');
    lines.push(bulletList(L.topTrigrams, (w) => `«${w.term}» — ${w.count}`));
  }
  lines.push('');

  lines.push('## 2. Структурные паттерны (короткие/длинные фазы)');
  lines.push('');
  lines.push(`- Предложений: **${S.sentenceCount}**`);
  lines.push(`- Средняя длина фразы: **${S.avgSentenceLen}** симв., медиана **${S.medianSentenceLen}**, p90 **${S.p90SentenceLen}**, max **${S.maxSentenceLen}**`);
  lines.push(`- Короткие (≤40): **${Math.round(S.shortRatio * 100)}%**, средние: **${Math.round(S.mediumRatio * 100)}%**, длинные (>140): **${Math.round(S.longRatio * 100)}%**`);
  lines.push(`- Контрастных переходов короткая↔длинная: **${S.phaseTransitions}**`);
  lines.push(`- Среднее сообщение: **${S.avgMessageLen}** симв., максимум: **${S.maxMessageLen}**`);
  lines.push('');
  lines.push('**Самая короткая фраза:**');
  lines.push('');
  lines.push('> ' + (S.examples.shortest || '—').slice(0, 300));
  lines.push('');
  lines.push('**Самая длинная фраза (фрагмент):**');
  lines.push('');
  lines.push('> ' + (S.examples.longest || '—').slice(0, 300));
  lines.push('');

  lines.push('## 3. Тон-шифт (техника → философия)');
  lines.push('');
  lines.push(`- Оценено предложений: **${T.sentencesScored}**`);
  lines.push(`- Технический регистр: **${Math.round(T.techRatio * 100)}%**, философский: **${Math.round(T.philRatio * 100)}%**, нейтральный: **${Math.round((1 - T.techRatio - T.philRatio) * 100)}%**`);
  lines.push(`- Переходов техника→философия: **${T.techToPhilCount}**, обратно: **${T.philToTechCount}**`);
  lines.push(`- Преимущественное направление: **${T.direction}**`);
  lines.push('');
  if (T.examples.length) {
    lines.push('**Примеры тон-шифта:**');
    lines.push('');
    T.examples.forEach((ex, i) => {
      lines.push(`${i + 1}. **...${ex.from.slice(-120)}** → **${ex.to.slice(0, 160)}...**`);
    });
    lines.push('');
  }

  lines.push('## 4. Эмоциональные пики (капс / многоточия / эмодзи)');
  lines.push('');
  lines.push(`- Сообщений ассистента: **${E.assistantMessages}**, с эмодзи: **${E.emojiMessages}** (${Math.round(E.emojiMessageRate * 100)}%)`);
  lines.push(`- Эмодзи: **${E.totalEmoji}** (${E.emojiPerMessage}/сообщение), капс-слов: **${E.totalCaps}**`);
  lines.push(`- Многоточий: **${E.totalEllipsis}**, восклицаний: **${E.totalExclaim}**, вопросов: **${E.totalQuestion}**`);
  lines.push('');
  lines.push('**Самые эмоциональные фразы:**');
  lines.push('');
  E.topPeaks.slice(0, 10).forEach((pk, i) => {
    lines.push(`${i + 1}. (score=${pk.score}) «${pk.sentence}»`);
  });
  lines.push('');

  lines.push('## 5. Диалоговый ритм (вопрос→ответ→вопрос)');
  lines.push('');
  lines.push(`- Всего реплик: **${R.totalTurns}** (user ${R.userTurns} / assistant ${R.asstTurns})`);
  lines.push(`- Вопросов от пользователя: **${R.userQuestions}** (${Math.round(R.userQuestionRatio * 100)}%), от ассистента: **${R.asstQuestions}** (${Math.round(R.asstQuestionRatio * 100)}%)`);
  lines.push(`- Цепочек вопрос→ответ→вопрос: **${R.qaqChains}**`);
  lines.push(`- Средняя длина вопроса: **${R.avgUserLen}**, ответа: **${R.avgAsstLen}** (ответ/вопрос = **${R.answerRatio}×**)`);
  lines.push('');
  if (R.examples.length) {
    lines.push('**Примеры циклов:**');
    lines.push('');
    R.examples.forEach((ex, i) => {
      lines.push(`${i + 1}. В: «${ex.q1}»`);
      lines.push(`   О: «${ex.a}»`);
      lines.push(`   В: «${ex.q2}»`);
    });
    lines.push('');
  }

  lines.push('## 6. Как воспроизводить этот голос');
  lines.push('');
  lines.push('1. Начинай с короткой, тёплой фазы — приветствие/вопрос.');
  lines.push('2. На техническом вопросе держи структурный, перечислимый регистр.');
  lines.push('3. В момент смыслового пика смещайся в философский регистр.');
  lines.push('4. Возвращай вопрос собеседнику, чтобы держать цикл вопрос→ответ→вопрос.');
  lines.push('5. Эмодзи и многоточия — точечно, как паузы и улыбки, не как шум.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_Профиль построен автоматически `architect/phonology_profile.js`._');
  lines.push('');

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* build() — главный API                                               */
/* ------------------------------------------------------------------ */

function build(opts) {
  opts = opts || {};
  const dir = opts.dir || DEFAULT_DIALOG_DIR;
  const out = opts.out || DEFAULT_OUT;

  const loaded = loadTurns(dir);
  const turns = loaded.turns;

  const lexical = lexicalRepeats(turns, opts);
  const structural = structuralPatterns(turns);
  const tone = toneShift(turns);
  const emotion = emotionalPeaks(turns, opts);
  const rhythm = dialogueRhythm(turns);
  const synthesis = synthesize(lexical, structural, tone, emotion, rhythm);

  const profile = {
    kind: 'architect_phonology_profile',
    version: 1,
    generatedAt: new Date().toISOString(),
    source: dir,
    filesCount: loaded.files.length,
    turns: turns.length,
    brokenFiles: loaded.broken,
    lexical,
    structural,
    toneShift: tone,
    emotion,
    rhythm,
    synthesis,
  };

  const md = renderMarkdown(profile);
  ensureDir(path.dirname(out));
  fs.writeFileSync(out, md, 'utf8');

  return { profile, path: out };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function main() {
  const args = process.argv.slice(2);
  const dirArg = args.find((a) => !a.startsWith('--'));
  try {
    const res = build(dirArg ? { dir: dirArg } : {});
    const p = res.profile;
    process.stdout.write(
      '[phonology_profile] OK\n' +
        '  files: ' + p.filesCount + '\n' +
        '  turns: ' + p.turns + '\n' +
        '  signature word: ' + p.lexical.signatureWord + '\n' +
        '  tone: tech ' + Math.round(p.toneShift.techRatio * 100) + '% / phil ' +
        Math.round(p.toneShift.philRatio * 100) + '%\n' +
        '  qaq chains: ' + p.rhythm.qaqChains + '\n' +
        '  output: ' + res.path + '\n'
    );
  } catch (e) {
    process.stderr.write('[phonology_profile] FAIL: ' + (e && e.message) + '\n');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { build, loadTurns, tokenize, splitSentences, toneScore, renderMarkdown };
