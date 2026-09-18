// agent_15.js — «Полиглот» (Polyglot)
//
// УНИКАЛЬНАЯ СТРАТЕГИЯ: МУЛЬТИЯЗЫЧНОСТЬ (multilingual relay).
// Её нет ни у одного из agent_1..agent_14.
//
// Все предыдущие агенты молча предполагают, что задача написана по-русски
// (или, в лучшем случае, «как-нибудь»): они улучшают промпт, синтезируют
// подходы, атакуют своё решение, измеряют или документируют — но НИ ОДИН
// не работает с ЯЗЫКОМ задачи как с инженерной переменной.
//
// Полиглот устроен так:
//   1) ОПРЕДЕЛЕНИЕ ЯЗЫКА. Задача анализируется детерминированно, без LLM:
//      сначала по письменности (кириллица / латиница / хань / кана / арабица),
//      затем по стоп-словам и диакритике. Поддержаны 8 языков:
//      ru, en, de, fr, es, zh, ja, ar.
//   2) МОСТ. Рабочие языки ядра — русский и английский. Если язык задачи
//      НЕ ru/en, он переводится на АНГЛИЙСКИЙ (язык-мост для обработки).
//      Технические литералы (пути, команды, имена, код) при переводе
//      сохраняются дословно — это требование к промпту перевода.
//   3) РАБОТА. Задача выполняется через agent_loop_v3.runWithCritic(prompt)
//      (исполнитель + критик). Для ru/en шага перевода нет вообще —
//      задача идёт транзитом, без лишних токенов.
//   4) ОБРАТНЫЙ МОСТ. Ответ, полученный на английском, переводится обратно
//      на исходный язык задачи. Если обратный перевод падает — ответ НЕ
//      теряется: возвращается английский оригинал с флагом degraded.
//   5) ЭКСПОРТ. { runAgent, STRATEGY, detectLanguage, translate } —
//      detectLanguage и translate вызываются автономно, без запуска задачи.
//
// Отличие от agent_13 «Хронометрист» и agent_14: те НЕ меняют промпт вообще
// (наблюдатель), а Полиглот — единственный, кто меняет ЛЕКСИКУ промпта,
// сохраняя его смысл, и делает это ради языков, до которых другие агенты
// не дотягиваются (zh/ja/ar/de/fr/es).
//
// ВАЖНО: agent_loop_v3.runWithCritic(prompt) принимает только промпт,
// поэтому оба «моста» реализованы обёрткой до и после вызова.
//
// ИНВАРИАНТ: любая ошибка перевода НЕ должна приводить к потере задачи.
// Исполнитель обязан получить работу в любом случае (fail-open).

const loop = require('./agent_loop_v3');

const STRATEGY = 'polyglot: detect language deterministically (8 langs) -> bridge non-ru/en tasks to English -> run via agent_loop_v3 -> bridge the answer back to the source language';

/** Языки-мосты: на них ядро работает без перевода. */
const BRIDGE_LANGUAGES = ['ru', 'en'];

/* ------------------------------------------------------------------ *
 * 1. Каталог языков и маркеры
 * ------------------------------------------------------------------ */

/** Поддерживаемые языки: код -> имена и письменность. */
const LANGUAGES = {
  ru: { name: 'русский', english: 'Russian', script: 'cyrillic' },
  en: { name: 'английский', english: 'English', script: 'latin' },
  de: { name: 'немецкий', english: 'German', script: 'latin' },
  fr: { name: 'французский', english: 'French', script: 'latin' },
  es: { name: 'испанский', english: 'Spanish', script: 'latin' },
  zh: { name: 'китайский', english: 'Chinese', script: 'han' },
  ja: { name: 'японский', english: 'Japanese', script: 'kana' },
  ar: { name: 'арабский', english: 'Arabic', script: 'arabic' },
};

/**
 * Стоп-слова-маркеры. Для zh/ja сравниваются ПОСИМВОЛЬНО (в CJK нет пробелов),
 * для остальных — по словам (токенам). Многословных записей быть не должно.
 */
const STOPWORDS = {
  ru: ['и', 'в', 'не', 'на', 'что', 'с', 'он', 'как', 'это', 'по', 'но', 'они', 'к', 'у', 'из', 'за', 'для', 'то', 'есть', 'нужно', 'надо', 'сделай', 'создай', 'файл', 'пожалуйста', 'код', 'который', 'чтобы', 'будет', 'все', 'мы', 'вы', 'или', 'если', 'этот', 'при', 'от', 'до', 'же', 'только', 'ещё', 'еще', 'можно', 'задачу', 'проверь', 'напиши'],
  en: ['the', 'and', 'is', 'are', 'to', 'of', 'in', 'for', 'that', 'with', 'this', 'it', 'you', 'please', 'create', 'file', 'need', 'should', 'a', 'an', 'be', 'on', 'as', 'at', 'by', 'from', 'or', 'not', 'will', 'can', 'we', 'do', 'does', 'if', 'then', 'when', 'which', 'there', 'must', 'write', 'code', 'make', 'use', 'check', 'task'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'für', 'auf', 'dass', 'sie', 'ich', 'werden', 'bitte', 'erstellen', 'datei', 'den', 'dem', 'des', 'zu', 'von', 'im', 'sich', 'auch', 'als', 'aber', 'oder', 'wenn', 'dann', 'kann', 'muss', 'soll', 'wir', 'du', 'es', 'hat', 'haben', 'wird', 'nach', 'bei', 'nur', 'noch', 'aus', 'um', 'so', 'code', 'prüfen', 'aufgabe'],
  fr: ['le', 'la', 'les', 'des', 'une', 'est', 'et', 'pour', 'dans', 'que', 'qui', 'ne', 'pas', 'vous', 'avec', 'un', 'du', 'au', 'aux', 'ce', 'cette', 'il', 'elle', 'je', 'nous', 'ils', 'sont', 'être', 'avoir', 'sur', 'par', 'plus', 'mais', 'ou', 'si', 'alors', 'peut', 'doit', 'fichier', 'créer', 'code', 'faire', 'très', 'aussi', 'comme', 'tout', 'vérifier', 'tâche'],
  es: ['el', 'la', 'los', 'las', 'una', 'es', 'y', 'para', 'en', 'que', 'no', 'con', 'del', 'por', 'se', 'como', 'un', 'unos', 'unas', 'de', 'al', 'lo', 'su', 'sus', 'pero', 'o', 'si', 'entonces', 'puede', 'debe', 'archivo', 'crear', 'código', 'hacer', 'muy', 'también', 'todo', 'está', 'son', 'este', 'esta', 'verificar', 'tarea'],
  zh: ['的', '了', '是', '我', '你', '他', '她', '们', '在', '有', '和', '不', '请', '创建', '文件', '一个', '这个', '需要', '可以', '代码', '执行', '然后', '如果', '就', '都', '会', '到', '把', '被', '任务', '检查', '写'],
  ja: ['の', 'は', 'を', 'に', 'が', 'で', 'と', 'も', 'から', 'まで', 'です', 'ます', 'する', 'した', 'して', 'ある', 'いる', 'これ', 'それ', 'あなた', '私', 'ファイル', '作成', 'コード', 'ください', 'できる', 'ため', 'よう', 'ない', 'た', 'タスク', '確認'],
  ar: ['من', 'في', 'على', 'هذا', 'هذه', 'أن', 'إلى', 'عن', 'مع', 'لا', 'ما', 'هو', 'هي', 'التي', 'الذي', 'كان', 'يكون', 'قد', 'كل', 'أو', 'ثم', 'إذا', 'ملف', 'إنشاء', 'كود', 'يرجى', 'عند', 'بعد', 'قبل', 'حتى', 'لكن', 'مهمة', 'تحقق'],
};

/** Диакритика, специфичная для языка (сильный признак при равных баллах). */
const DIACRITICS = {
  ru: 'ыэъё',
  de: 'äöüß',
  fr: 'àâçèêëîïôûùœæé',
  es: 'áíóúñ¿¡',
};

/** Буквы, выдающие кириллицу «не-русского» извода (uk/be/sr) — понижают уверенность. */
const NON_RUSSIAN_CYRILLIC = 'іїєґўђјљњћџ';

/** Порядок разрешения ничьих: en первым — он язык-мост, перевод для него не нужен. */
const TIE_PRIORITY = ['en', 'ru', 'de', 'fr', 'es', 'zh', 'ja', 'ar'];

/* ------------------------------------------------------------------ *
 * 2. Низкоуровневые признаки (детерминированные, без LLM)
 * ------------------------------------------------------------------ */

/**
 * Считает символы по письменностям.
 * @param {string} text — анализируемый текст.
 * @returns {{latin: number, cyrillic: number, han: number, kana: number,
 *            arabic: number, other: number, letters: number}} профиль.
 */
function scriptProfile(text) {
  const p = { latin: 0, cyrillic: 0, han: 0, kana: 0, arabic: 0, other: 0, letters: 0 };

  for (const ch of String(text)) {
    if (/[\u3040-\u30ff]/.test(ch)) p.kana++;
    else if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) p.han++;
    else if (/[\u0400-\u04ff\u0500-\u052f]/.test(ch)) p.cyrillic++;
    else if (/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/.test(ch)) p.arabic++;
    else if (/[A-Za-z\u00c0-\u024f\u1e00-\u1eff]/.test(ch)) p.latin++;
    else if (/\p{L}/u.test(ch)) p.other++;
  }

  p.letters = p.latin + p.cyrillic + p.han + p.kana + p.arabic + p.other;
  return p;
}

/**
 * Доля письменности от всех букв текста.
 * @param {{letters: number}} profile — профиль из scriptProfile.
 * @param {string} key — 'latin'|'cyrillic'|'han'|'kana'|'arabic'.
 * @returns {number} 0..1.
 */
function scriptRatio(profile, key) {
  if (!profile || !profile.letters) return 0;
  return (profile[key] || 0) / profile.letters;
}

/**
 * Разбивает текст на слова (Unicode-буквы), в нижнем регистре.
 * @param {string} text
 * @returns {string[]} токены.
 */
function tokenize(text) {
  const m = String(text).toLowerCase().match(/\p{L}+/gu);
  return m || [];
}

/**
 * Доля стоп-слов языка среди токенов.
 * @param {string[]} tokens — токены текста.
 * @param {string} lang — код языка.
 * @returns {number} 0..1.
 */
function stopwordHits(tokens, lang) {
  const list = STOPWORDS[lang];
  if (!list || !tokens.length) return 0;
  const set = new Set(tokens);
  let hits = 0;
  for (const w of list) {
    if (!set.has(w)) continue;
    // Короткие служебные слова (y, o, a, de) слишком легко совпадают случайно.
    hits += (w.length >= 3) ? 1 : (w.length === 2 ? 0.5 : 0.2);
  }
  // На коротком тексте лексике доверяем пропорционально меньше.
  const tokenTrust = Math.min(1, tokens.length / 5);
  return Math.min(1, (hits / tokens.length) * tokenTrust);
}

/**
 * Доля найденных маркерных символов языка (для CJK, где нет пробелов).
 * @param {string} text
 * @param {string} lang
 * @returns {number} 0..1.
 */
function charHits(text, lang) {
  const list = STOPWORDS[lang];
  if (!list || !list.length) return 0;
  const src = String(text);
  let hits = 0;
  for (const c of list) if (src.indexOf(c) !== -1) hits++;
  // Нормируем на «ожидаемое» число совпадений, а не на длину списка.
  return Math.min(1, hits / 12);
}

/**
 * Доля символов-диакритик языка среди всех букв.
 * @param {string} text
 * @param {string} lang
 * @returns {number} 0..1.
 */
function diacriticRatio(text, lang) {
  const marks = DIACRITICS[lang];
  if (!marks) return 0;
  const p = scriptProfile(text);
  if (!p.letters) return 0;
  let hits = 0;
  for (const ch of String(text).toLowerCase()) if (marks.indexOf(ch) !== -1) hits++;
  return Math.min(1, hits / p.letters * 5);
}

/**
 * Итоговый балл языка: письменность + лексика + диакритика.
 * @param {string} text — текст.
 * @param {string[]} tokens — токены текста.
 * @param {object} profile — scriptProfile.
 * @param {string} lang — код языка.
 * @returns {number} 0..1.
 */
function languageScore(text, tokens, profile, lang) {
  const meta = LANGUAGES[lang];
  let scriptPart = 0;

  if (lang === 'ja') {
    // Японский = кана + хань (кандзи). Кана — решающий признак.
    scriptPart = Math.min(1, scriptRatio(profile, 'kana') * 3 + scriptRatio(profile, 'han') * 0.6);
  } else if (lang === 'zh') {
    // Китайский = хань без каны (кана штрафует: иначе любой японский текст = zh).
    scriptPart = Math.max(0, scriptRatio(profile, 'han') - scriptRatio(profile, 'kana') * 2);
  } else {
    scriptPart = scriptRatio(profile, meta.script);
  }

  const isCJK = (lang === 'zh' || lang === 'ja');
  const lexPart = isCJK ? charHits(text, lang) : stopwordHits(tokens, lang);
  const diaPart = diacriticRatio(text, lang);

  const score = scriptPart * 0.55 + lexPart * 0.35 + diaPart * 0.25;
  return Math.max(0, Math.min(1, score));
}

/**
 * Доминирующая письменность текста (для отчёта, не для решения).
 * @param {object} profile — scriptProfile.
 * @returns {string} 'latin'|'cyrillic'|'han'|'kana'|'arabic'|'mixed'|'unknown'.
 */
function dominantScript(profile) {
  if (!profile || !profile.letters) return 'unknown';
  const keys = ['latin', 'cyrillic', 'han', 'kana', 'arabic'];
  let best = null;
  for (const k of keys) if (best === null || profile[k] > profile[best]) best = k;
  const ratio = scriptRatio(profile, best);
  return ratio >= 0.5 ? best : 'mixed';
}

/* ------------------------------------------------------------------ *
 * 3. Определение языка
 * ------------------------------------------------------------------ */

/**
 * Определяет язык текста детерминированно (без обращения к LLM):
 * сначала письменность, затем стоп-слова и диакритика.
 * @param {string} text — анализируемый текст.
 * @returns {{code: string, name: string, english: string, script: string,
 *            confidence: number, reliable: boolean, scores: Object, notes: string[]}}
 */
function detectLanguage(text) {
  const notes = [];
  const src = (text === null || text === undefined) ? '' : String(text);
  const profile = scriptProfile(src);
  const tokens = tokenize(src);

  if (!profile.letters) {
    return {
      code: 'unknown',
      name: 'неизвестный',
      english: 'Unknown',
      script: 'unknown',
      confidence: 0,
      reliable: false,
      scores: {},
      notes: ['в тексте нет букв — язык определить невозможно'],
    };
  }

  // Баллы по всем поддерживаемым языкам.
  const scores = {};
  for (const lang of Object.keys(LANGUAGES)) {
    scores[lang] = languageScore(src, tokens, profile, lang);
  }

  // Сортировка с разрешением ничьих по TIE_PRIORITY.
  const order = TIE_PRIORITY.filter(function (l) { return l in scores; });
  order.sort(function (a, b) {
    if (scores[b] !== scores[a]) return scores[b] - scores[a];
    return TIE_PRIORITY.indexOf(a) - TIE_PRIORITY.indexOf(b);
  });

  let best = order[0];
  let bestScore = scores[best];
  const second = order[1] || null;
  let secondScore = second ? scores[second] : 0;

  // Латиница без выраженных языковых маркеров (фрагмент кода, имя, термин) —
  // это не французский и не испанский, а «английский по умолчанию»: перевода
  // не требуется, и ошибка здесь дешевле, чем лишний вызов LLM.
  const LATIN_DEFAULT_MIN_SCORE = 0.6;
  if (LANGUAGES[best].script === 'latin' && best !== 'en' && bestScore < LATIN_DEFAULT_MIN_SCORE) {
    notes.push('латиница без выраженных маркеров: принят английский по умолчанию ('
      + best + ' набрал ' + (Math.round(bestScore * 1000) / 1000) + ' < ' + LATIN_DEFAULT_MIN_SCORE + ')');
    best = 'en';
    bestScore = scores.en;
    secondScore = 0;
  }

  // Уверенность = отрыв лидера от второго места.
  let confidence = Math.max(0, Math.min(1, bestScore - secondScore * 0.5));
  confidence = Math.round(confidence * 1000) / 1000;

  // Признаки «соседних» языков, о которых полезно знать вызывающему коду.
  if (best === 'ru') {
    let foreign = 0;
    for (const ch of src.toLowerCase()) if (NON_RUSSIAN_CYRILLIC.indexOf(ch) !== -1) foreign++;
    if (foreign > 0) notes.push('кириллица с не-русскими буквами: определён ближайший поддерживаемый язык — русский');
  }
  if (best === 'ar') {
    notes.push('арабица общая для арабского/персидского/урду: выбран ближайший поддерживаемый язык');
  }
  if (best === 'zh' && scriptRatio(profile, 'kana') > 0) {
    notes.push('в тексте есть кана — вероятно, японский (проверьте определение)');
  }
  if (profile.letters > 0 && profile.latin / profile.letters > 0.05 && LANGUAGES[best].script !== 'latin') {
    notes.push('текст смешанный: латиница присутствует наряду с основной письменностью');
  }

  const rounded = {};
  for (const lang of order) rounded[lang] = Math.round(scores[lang] * 1000) / 1000;

  return {
    code: best,
    name: LANGUAGES[best].name,
    english: LANGUAGES[best].english,
    script: dominantScript(profile),
    confidence: confidence,
    reliable: confidence >= 0.3,
    scores: rounded,
    notes: notes,
  };
}

/**
 * Переводит текст с одного языка на другой через LLM.
 * @param {string} text — исходный текст.
 * @param {string} from — код исходного языка ('ru','en','de','fr','es','zh','ja','ar','unknown').
 * @param {string} to — код целевого языка.
 * @param {object} [options] — { maxTokens, keepLiterals, timeoutMs }.
 * @returns {Promise<{ok: boolean, text: string, from: string, to: string, skipped?: boolean, error?: string}>}
 */
async function translate(text, from, to, options) {
  /* TODO */
}

/**
 * Пропускает задачу через мосты и ядро: определить язык → перевести на
 * английский (если нужно) → agent_loop_v3 → перевести ответ обратно.
 * @param {string} task — задача пользователя на любом из 8 языков.
 * @param {object} [options] — { maxTokens, translateAnswer }.
 * @returns {Promise<object>} результат с полями ok, answer, language, bridges, steps, critic.
 */
async function runAgent(task, options) {
  /* TODO */
}

module.exports = { runAgent, STRATEGY, detectLanguage, translate };
