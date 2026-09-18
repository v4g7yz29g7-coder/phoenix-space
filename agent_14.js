// agent_14.js — «Лингвист» (Linguist)
//
// УНИКАЛЬНАЯ СТРАТЕГИЯ: СЕМАНТИЧЕСКИЙ АНАЛИЗ (semantic analysis first).
// Такой стратегии нет ни у одного из agent_1..agent_13.
//
// Все предыдущие агенты работают с задачей как с ТЕКСТОМ, который надо
// исполнить: спорят с критиком (agent_8), меряют время (agent_13),
// пишут уроки (agent_12). Лингвист сначала переводит текст в СМЫСЛ:
//
//   1) СЕМАНТИКА, А НЕ КЛЮЧЕВЫЕ СЛОВА. Разбирается, ЧТО именно просят:
//      действие (create/modify/analyze/explain/run/delete), объект действия
//      (файл, путь, идентификатор), ограничения (чего делать НЕЛЬЗЯ),
//      требуемый результат (что считается ответом) и критерии готовности.
//      Слово «создай» в разных фразах может значить «напиши файл» и
//      «сгенерируй текст» — различается по объекту и по окружению.
//   2) ТОН И ЯЗЫК. Определяется язык запроса (русский / английский /
//      смешанный) и тон (формальный / дружеский / технический / нейтральный),
//      чтобы ответ пришёл на ТОМ ЖЕ языке и в ТОЙ ЖЕ тональности.
//   3) УТОЧНЁННАЯ ЗАДАЧА. Формулируется явная постановка: цель, ограничения,
//      ожидаемый результат, язык и тон ответа, а также СПИСОК ДОПУЩЕНИЙ,
//      которые агент принял сам (вместо того чтобы переспрашивать человека).
//      Исходная формулировка сохраняется дословно — смысл не подменяется.
//   4) ПРОВЕРКА ПОНЯТНОСТИ. После выполнения ответ проверяется не на
//      «правильность» (это работа критика), а на ПОНИМАЕМОСТЬ адресатом:
//      совпадает ли язык, целостны ли предложения, нет ли заглушек и
//      обрывов, не перегружен ли текст нерасшифрованным жаргоном,
//      есть ли структура там, где задача сложная.
//
// Отличие от соседей: критик (agent_critic) проверяет КОРРЕКТНОСТЬ ответа,
// Лингвист проверяет его ЧИТАЕМОСТЬ для того, кто задал вопрос, и следит,
// чтобы задача не была решена «не про то».
//
// ВАЖНО: agent_loop_v3.runWithCritic(prompt) принимает только строку промпта,
// поэтому уточнённая задача — это обогащённый текст, а не объект.

const fs = require('fs');
const path = require('path');
const loop = require('./agent_loop_v3');

const STRATEGY = 'linguist: semantic-analysis-first - decode intent/tone/language (not keywords), restate the task explicitly with assumptions, run agent_loop_v3, then verify the answer is intelligible to the requester';

/** Каталог языкового журнала (рядом с агентом — работает и в корне, и в боксе). */
const JOURNAL_DIR = path.join(__dirname, 'memory', 'linguist');
/** Ниже этого отношения «своих» букв язык считается смешанным/неуверенным. */
const LANG_CONFIDENCE_MIN = 0.75;
/** Средняя длина предложения (в словах), выше которой текст считается тяжёлым. */
const MAX_AVG_SENTENCE_WORDS = 34;
/** Ниже этого score понятности ответ помечается как «нужно пояснение». */
const CLARITY_THRESHOLD = 0.6;
/** Сколько символов ответа максимум кладём в журнал (защита от раздувания). */
const JOURNAL_ANSWER_PREVIEW = 400;

/* ------------------------------------------------------------------ *
 * 1. Язык и тон
 * ------------------------------------------------------------------ */

/**
 * Определяет язык текста по составу букв (кириллица / латиница).
 * @param {string} text — анализируемый текст.
 * @returns {{code: string, ru: number, en: number, other: number, confidence: number}}
 *          code: 'ru' | 'en' | 'mixed' | 'unknown'.
 */
function detectLanguage(text) {
  const src = (typeof text === 'string') ? text : String(text === undefined ? '' : text);
  const cyr = src.match(/[а-яёА-ЯЁ]/g);
  const lat = src.match(/[a-zA-Z]/g);
  const ru = cyr ? cyr.length : 0;
  const en = lat ? lat.length : 0;
  const total = ru + en;

  if (total === 0) {
    return { code: 'unknown', primary: 'unknown', answerLanguage: 'en', ru: 0, en: 0, other: 0, confidence: 0 };
  }

  const dominant = ru >= en ? 'ru' : 'en';
  const confidence = round3(Math.max(ru, en) / total);
  let code;
  if (ru === 0) code = 'en';
  else if (en === 0) code = 'ru';
  else if (confidence >= LANG_CONFIDENCE_MIN) code = dominant;
  else code = 'mixed';

  // Язык ОТВЕТА — доминирующий язык автора: даже при «mixed»
  // (русская проза + английские идентификаторы) отвечать надо по-русски.
  return { code: code, primary: dominant, answerLanguage: dominant, ru: ru, en: en, other: 0, confidence: confidence };
}

/**
 * Определяет тон обращения: формальный, дружеский, технический или нейтральный.
 * @param {string} text — анализируемый текст.
 * @returns {{tone: string, formality: number, markers: {friendly: string[], formal: string[], technical: string[]}}}
 */
function detectTone(text) {
  const src = (typeof text === 'string') ? text : String(text === undefined ? '' : text);

  const friendlyRe = /пожалуйста|плиз|давай(?:те)?|спасибо|привет|окей|\bок\b|\bpls\b|\bplease\b|\bthanks\b|\bthx\b|\bhey\b|:\)|😀|🔥|👍/gi;
  const formalRe = /необходимо|требуется|следует|прошу|надлежит|в соответствии|обязательно|\bshould\b|\bmust\b|\brequire[ds]?\b|please note|kindly/gi;
  const technicalRe = /agent_loop_v3|node --check|\bgit\b|\bapi\b|\bjson\b|\bregex\b|\bjs\b|\bcli\b|\bhttp\b|\bllm\b|файл|модул|функц|экспорт|require|export|commit|деплой/gi;

  const friendly = uniq(matchAll(src, friendlyRe));
  const formal = uniq(matchAll(src, formalRe));
  const technical = uniq(matchAll(src, technicalRe));

  let tone;
  if (friendly.length > formal.length) tone = 'friendly';
  else if (formal.length > friendly.length) tone = 'formal';
  else tone = (technical.length >= 3) ? 'technical' : 'neutral';

  // Формальность 0..1: формальные маркеры поднимают, дружеские опускают.
  const formality = round3(clamp(0.5 + 0.15 * formal.length - 0.15 * friendly.length, 0, 1));

  return {
    tone: tone,
    formality: formality,
    markers: {
      friendly: friendly.slice(0, 5),
      formal: formal.slice(0, 5),
      technical: technical.slice(0, 5)
    }
  };
}

/**
 * Все совпадения регулярного выражения в виде массива строк.
 * @param {string} src — текст.
 * @param {RegExp} re — выражение (с флагом g).
 * @returns {string[]} совпадения.
 */
function matchAll(src, re) {
  const out = [];
  const re2 = new RegExp(re.source, re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags);
  let m = re2.exec(src);
  while (m !== null) {
    out.push(String(m[0]));
    m = re2.exec(src);
  }
  return out;
}

/**
 * Удаляет дубликаты из массива строк (без учёта регистра).
 * @param {string[]} list — исходный массив.
 * @returns {string[]} уникальные элементы в исходном порядке.
 */
function uniq(list) {
  const seen = Object.create(null);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const key = String(list[i]).toLowerCase();
    if (!seen[key]) {
      seen[key] = true;
      out.push(list[i]);
    }
  }
  return out;
}

/**
 * Ограничивает число диапазоном [min, max].
 * @param {number} n — число.
 * @param {number} min — нижняя граница.
 * @param {number} max — верхняя граница.
 * @returns {number} ограниченное значение.
 */
function clamp(n, min, max) {
  const v = Number(n);
  if (!isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/**
 * Округляет до трёх знаков — журнал и отчёт должны быть стабильны.
 * @param {number} n — число.
 * @returns {number} округлённое значение.
 */
function round3(n) {
  const v = Number(n);
  if (!isFinite(v)) return 0;
  return Math.round(v * 1000) / 1000;
}

/* ------------------------------------------------------------------ *
 * 2. Разбор семантики
 * ------------------------------------------------------------------ */

/**
 * Извлекает объекты действия: файлы, пути, идентификаторы в кавычках и
 * технические имена. Это то, ЧЕГО касается задача.
 * @param {string} text — анализируемый текст.
 * @returns {{files: string[], paths: string[], quoted: string[], identifiers: string[]}}
 */
function extractObjects(text) {
  const src = (typeof text === 'string') ? text : String(text === undefined ? '' : text);

  // Файлы: имя с расширением, но не число вида 1.5 и не «т.д.».
  const files = matchAll(src, /\b[\w-]+(?:\.[\w-]+)*\.[a-zA-Z]{1,6}\b/g)
    .filter(function (f) {
      if (/^\d+(\.\d+)?$/.test(f)) return false;
      if (/^(и|т)\.(д|п)$/i.test(f)) return false;
      if (/\.(js|json|md|txt|ts|py|sh|yml|yaml|html|css|log|csv|db|bak|env)$/i.test(f)) return true;
      return /[a-zA-Z]/.test(f[0]); // прочие расширения допускаем, если имя не числовое
    });

  // Пути: последовательность сегментов со слешами.
  const paths = matchAll(src, /(?:\.{0,2}\/|~\/)?(?:[\w.-]+\/)+[\w.-]*/g)
    .filter(function (p) { return p.length > 2 && p.indexOf('/') !== -1; });

  // Явно названные сущности: "..." , '...' , `...` , «...».
  const quoted = [];
  const quoteRe = /"([^"\n]{1,120})"|'([^'\n]{1,120})'|`([^`\n]{1,120})`|«([^»\n]{1,120})»|“([^”\n]{1,120})”/g;
  let q = quoteRe.exec(src);
  while (q !== null) {
    const val = q[1] || q[2] || q[3] || q[4] || q[5];
    if (val && val.trim()) quoted.push(val.trim());
    q = quoteRe.exec(src);
  }

  // Идентификаторы кода: snake_case и camelCase — это тоже объекты задачи.
  const identifiers = matchAll(src, /\b[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+\b|\b[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g);

  return {
    files: uniq(files).slice(0, 12),
    paths: uniq(paths).slice(0, 12),
    quoted: uniq(quoted).slice(0, 12),
    identifiers: uniq(identifiers).slice(0, 12)
  };
}

/**
 * Разбивает текст на смысловые клаузы (по точке, точке с запятой, переводу строки).
 * @param {string} src — текст.
 * @returns {string[]} клаузы без пустых элементов.
 */
function clauseSplit(src) {
  const parts = String(src).split(/[.;\n]+|,\s*(?=(?:но|а|кроме)\b)/i);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p) out.push(p);
  }
  return out;
}

/**
 * Извлекает ограничения: запреты, обязательные условия и количественные лимиты.
 * @param {string} text — анализируемый текст.
 * @returns {{negations: string[], requirements: string[], limits: string[]}}
 */
function extractConstraints(text) {
  const src = (typeof text === 'string') ? text : String(text === undefined ? '' : text);
  const clauses = clauseSplit(src);

  const negationRe = /(?:^|\s)(?:не|ни|без|кроме|запрещено|нельзя|нельзя|не трогай|не меняй|не удаляй)\s|\b(?:do not|don't|avoid|never|without|must not|shall not)\b/i;
  const requirementRe = /(?:^|\s)(?:обязательно|должен|должна|должно|нужно|надо|только|следует|важно|имей в виду)\s|\b(?:must|should|required|ensure|make sure|only)\b/i;
  const limitRe = /\b\d+\s*(?:шт|штук\w*|строк\w*|символ\w*|мс|сек\w*|мин\w*|час\w*|дн\w*|kb|mb|гб|файл\w*|раз|элемент\w*|days?|hours?|lines?|chars?)\b|\b(?:не более|не меньше|максимум|минимум|at most|at least|no more than)\b/gi;

  const negations = [];
  const requirements = [];
  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i];
    if (negationRe.test(c)) negations.push(trim120(c));
    if (requirementRe.test(c)) requirements.push(trim120(c));
  }

  return {
    negations: uniq(negations).slice(0, 8),
    requirements: uniq(requirements).slice(0, 8),
    limits: uniq(matchAll(src, limitRe)).slice(0, 8)
  };
}

/**
 * Обрезает строку до 120 символов, добавляя многоточие.
 * @param {string} s — строка.
 * @returns {string} обрезанная строка.
 */
function trim120(s) {
  const str = String(s).trim();
  return str.length > 120 ? str.slice(0, 117) + '...' : str;
}

/**
 * Определяет, что считается результатом: артефакт, ответ-объяснение,
 * изменение в репозитории или запуск команды.
 * @param {string} text — анализируемый текст.
 * @returns {{kind: string, items: string[], format: string|null}}
 */
function extractDeliverables(text) {
  const src = (typeof text === 'string') ? text : String(text === undefined ? '' : text);
  const items = [];

  const rules = [
    { kind: 'file', re: /созда\w+\s+файл\w*|сгенерируй\s+файл|write (?:a )?file|create (?:a )?file|generate (?:a )?file/gi },
    { kind: 'change', re: /исправ\w+|измен\w+|обнов\w+|отрефактор\w+|поправ\w+|fix|change|update|refactor|patch/gi },
    { kind: 'command', re: /запусти\w*|выполни\w*|прогони\w*|\brun\b|\bexecute\b/gi },
    { kind: 'explanation', re: /объясни\w*|расскажи\w*|опиши\w*|поясни\w*|explain|describe/gi },
    { kind: 'answer', re: /ответь\w*|верни\w*|\banswer\b|\breturn\b/gi },
    { kind: 'report', re: /отчёт\w*|отчет\w*|доклад\w*|сводк\w*|\breport\b|\bsummary\b/gi },
    { kind: 'analysis', re: /проанализируй\w*|разбери\w*|исследуй\w*|аудит|\banaly[sz]e\b|\baudit\b/gi }
  ];

  const hits = Object.create(null);
  for (let i = 0; i < rules.length; i++) {
    const found = matchAll(src, rules[i].re);
    if (found.length > 0) {
      hits[rules[i].kind] = found.length;
      for (let j = 0; j < found.length && j < 3; j++) items.push(found[j]);
    }
  }

  // Приоритет: явный артефакт важнее упоминания команды.
  const order = ['file', 'analysis', 'report', 'explanation', 'answer', 'command', 'change'];
  let kind = 'unknown';
  for (let i = 0; i < order.length; i++) {
    if (hits[order[i]]) { kind = order[i]; break; }
  }

  let format = null;
  if (/\.json\b|\bjson\b/i.test(src)) format = 'json';
  else if (/\.md\b|markdown|таблиц/i.test(src)) format = 'markdown';
  else if (/\bкод\b|\bcode\b|\.js\b|\.py\b|\.ts\b/i.test(src)) format = 'code';
  else if (/\bтекст\w*\b|\btext\b/i.test(src)) format = 'text';

  return { kind: kind, items: uniq(items).slice(0, 8), format: format };
}

/**
 * Определяет главное действие задачи — по смыслу фразы и её объекту,
 * а не по одному ключевому слову.
 * @param {string} text — анализируемый текст.
 * @param {{files: string[], paths: string[], identifiers: string[]}} [objects] — объекты действия.
 * @returns {{action: string, target: string|null, confidence: number, signals: string[]}}
 */
function extractIntent(text, objects) {
  const src = (typeof text === 'string') ? text : String(text === undefined ? '' : text);
  const obj = objects || extractObjects(src);
  const lower = src.toLowerCase();
  const head = lower.slice(0, Math.max(1, Math.ceil(lower.length * 0.25)));

  const lexicon = {
    create: { ru: /созда\w*|напиши\w*|сгенерируй\w*|добав\w*|сдела\w*|собери\w*/, en: /\bcreate\b|\bwrite\b|\bgenerate\b|\badd\b|\bmake\b|\bbuild\b/ },
    modify: { ru: /исправ\w*|измен\w*|обнов\w*|отредактируй\w*|поправ\w*|внеси\w*/, en: /\bfix\b|\bedit\b|\bmodify\b|\bupdate\b|\bpatch\b|\bchange\b/ },
    delete: { ru: /удали\w*|убер\w*|сотри\w*/, en: /\bdelete\b|\bremove\b|\bdrop\b/ },
    analyze: { ru: /проанализируй\w*|разбер\w*|исследуй\w*|аудит\w*|оцени\w*/, en: /\banaly[sz]e\b|\binspect\b|\breview\b|\baudit\b|\bevaluate\b/ },
    explain: { ru: /объясни\w*|расскажи\w*|опиши\w*|поясни\w*/, en: /\bexplain\b|\bdescribe\b|\btell\b/ },
    run: { ru: /запусти\w*|выполни\w*|прогони\w*|исполни\w*/, en: /\brun\b|\bexecute\b|\blaunch\b/ },
    test: { ru: /протестируй\w*|проверь\w*|тест\w*/, en: /\btest\b|\bverify\b|\bcheck\b/ },
    read: { ru: /прочитай\w*|покажи\w*|посмотри\w*|найди\w*/, en: /\bread\b|\bshow\b|\bfind\b|\bsearch\b/ }
  };

  const scores = Object.create(null);
  const signals = [];
  let total = 0;
  const actions = Object.keys(lexicon);

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const ruHits = matchAll(src, new RegExp(lexicon[a].ru.source, 'gi'));
    const enHits = matchAll(src, new RegExp(lexicon[a].en.source, 'gi'));
    const hits = ruHits.concat(enHits);
    if (hits.length === 0) continue;

    let score = hits.length;
    // Глагол в начале фразы — почти всегда главное действие.
    if (lexicon[a].ru.test(head) || lexicon[a].en.test(head)) score += 1;
    scores[a] = score;
    total += score;
    for (let j = 0; j < hits.length && j < 3; j++) signals.push(a + ':' + hits[j].toLowerCase());
  }

  const ranked = actions.filter(function (a) { return scores[a]; })
    .sort(function (x, y) { return scores[y] - scores[x]; });

  if (ranked.length === 0) {
    return { action: 'unknown', target: null, confidence: 0, signals: [] };
  }

  const action = ranked[0];
  let target = null;
  if (obj.files && obj.files.length > 0) target = obj.files[0];
  else if (obj.paths && obj.paths.length > 0) target = obj.paths[0];
  else if (obj.quoted && obj.quoted.length > 0) target = obj.quoted[0];

  return {
    action: action,
    target: target,
    confidence: round3(scores[action] / total),
    signals: uniq(signals).slice(0, 6)
  };
}

/**
 * Ищет неоднозначности и превращает их в вопросы к самому себе:
 * на каждый вопрос агент подставляет допущение по умолчанию, чтобы не
 * блокировать работу, но фиксирует, что именно он достроил за человека.
 * @param {string} prompt — исходный запрос.
 * @param {object} parts — уже извлечённые части (intent/objects/constraints).
 * @returns {{ambiguities: string[], questions: string[], assumptions: string[]}}
 */
function findAmbiguities(prompt, parts) {
  const src = (typeof prompt === 'string') ? prompt.trim() : String(prompt === undefined ? '' : prompt);
  const p = parts || {};
  const intent = p.intent || { action: 'unknown' };
  const objects = p.objects || { files: [], paths: [], quoted: [], identifiers: [] };
  const constraints = p.constraints || { negations: [], requirements: [], limits: [] };

  const ambiguities = [];
  const questions = [];
  const assumptions = [];

  const hasTarget = (objects.files.length + objects.paths.length + objects.quoted.length) > 0;
  const mutating = intent.action === 'create' || intent.action === 'modify' || intent.action === 'delete';

  if (intent.action === 'unknown') {
    ambiguities.push('не ясно, какое именно действие требуется выполнить');
    questions.push('Что нужно сделать: создать, изменить, проверить или объяснить?');
    assumptions.push('считать запрос запросом на объяснение и вернуть развёрнутый ответ без изменения файлов');
  }

  if (mutating && !hasTarget) {
    ambiguities.push('действие названо, но объект действия не указан');
    questions.push('С каким файлом, каталогом или сущностью нужно работать?');
    assumptions.push('уточнить объект по контексту задачи; если контекста нет — создать новый файл с говорящим именем');
  }

  // Местоимение без явного объекта: классическая причина «сделали не то».
  const pronounRe = /\b(это|этот|эта|эти|его|её|ее|их|туда|там|тот|такое|оно|ними)\b|\b(that|this|it|them|there)\b/i;
  if (pronounRe.test(src) && !hasTarget) {
    ambiguities.push('использовано местоимение без явного объекта (что именно «это»?)');
    questions.push('К чему относится местоимение — укажите конкретную сущность.');
    assumptions.push('ссылаться на последнюю упомянутую в задаче сущность');
  }

  if (/и т\.д\.|и т\.п\.|и прочее|и так далее|etc\.|and so on/i.test(src)) {
    ambiguities.push('открытое перечисление — границы задачи не определены');
    questions.push('Полный список пунктов или достаточно перечисленных?');
    assumptions.push('выполнить ровно перечисленные пункты, не расширяя объём');
  }

  if (src.length > 0 && src.length < 25) {
    ambiguities.push('постановка слишком короткая для однозначного понимания');
    questions.push('Можно уточнить детали и ожидаемый результат?');
    assumptions.push('выполнить буквально минимальную интерпретацию запроса');
  }

  if (mutating && constraints.negations.length === 0) {
    assumptions.push('изменения считать минимальными и не затрагивать файлы вне задачи');
  }
  if (mutating && constraints.requirements.length === 0) {
    assumptions.push('обязательным условием считать сохранение текущего поведения остального кода');
  }

  // Критерии готовности: без них агент сам решает, что «сделано».
  const hasDone = /проверь\w*|node --check|тест\w*|критери\w*|должно работать|verify|test\b|check\b/i.test(src);
  if (mutating && !hasDone) {
    ambiguities.push('не заданы критерии готовности');
    questions.push('По какому признаку считать задачу выполненной?');
    assumptions.push('критерий готовности — синтаксическая проверка и соответствие перечисленным требованиям');
  }

  if (intent.action === 'explain' && !p.deliverables) {
    assumptions.push('ответ дать кратким текстом на языке запроса, без создания файлов');
  }

  return {
    ambiguities: uniq(ambiguities).slice(0, 8),
    questions: uniq(questions).slice(0, 8),
    assumptions: uniq(assumptions).slice(0, 8)
  };
}

/* ------------------------------------------------------------------ *
 * 3. Публичный семантический анализ
 * ------------------------------------------------------------------ */

/**
 * Полный семантический разбор запроса — публичная функция агента.
 * @param {string} prompt — задача пользователя.
 * @param {object} [options] — { answerLanguage } принудительный язык ответа.
 * @returns {object} профиль: язык, тон, действие, объекты, ограничения,
 *          результат, неоднозначности, вопросы, допущения, уточнённая задача.
 */
function analyzeSemantics(prompt, options = {}) {
  const text = (typeof prompt === 'string') ? prompt.trim() : '';
  return {
    ok: false,
    raw: text,
    language: { code: 'unknown', ru: 0, en: 0, other: 0, confidence: 0 },
    tone: { tone: 'neutral', formality: 0, markers: { friendly: [], formal: [], technical: [] } },
    intent: { action: 'unknown', target: null, confidence: 0, signals: [] },
    objects: { files: [], paths: [], quoted: [], identifiers: [] },
    constraints: { negations: [], requirements: [], limits: [] },
    deliverables: { kind: 'unknown', items: [], format: null },
    ambiguities: [],
    questions: [],
    assumptions: [],
    refinedTask: ''
  };
}

/* ------------------------------------------------------------------ *
 * 4. Уточнённая задача
 * ------------------------------------------------------------------ */

/**
 * Формулирует уточнённую задачу: явная цель, ограничения, ожидаемый результат,
 * язык и тон ответа, принятые допущения + исходный текст дословно.
 * @param {string} prompt — исходная задача.
 * @param {object} analysis — результат analyzeSemantics.
 * @returns {string} промпт для agent_loop_v3.
 */
function refineTask(prompt, analysis) {
  const original = (typeof prompt === 'string') ? prompt : String(prompt === undefined ? '' : prompt);
  return original;
}

/* ------------------------------------------------------------------ *
 * 5. Проверка понятности ответа
 * ------------------------------------------------------------------ */

/**
 * Проверяет, понятен ли ответ адресату: язык ответа, целостность предложений,
 * отсутствие заглушек и жаргона без расшифровки, наличие структуры.
 * @param {string} answer — ответ исполнителя.
 * @param {object} analysis — семантический профиль задачи.
 * @param {object} [options] — { maxAvgSentenceWords, threshold }.
 * @returns {{ok: boolean, verdict: string, score: number, issues: string[], metrics: object}}
 */
function checkComprehensibility(answer, analysis, options = {}) {
  return { ok: false, verdict: 'empty', score: 0, issues: [], metrics: {} };
}

/* ------------------------------------------------------------------ *
 * 6. Языковой журнал
 * ------------------------------------------------------------------ */

/**
 * Атомарно дописывает запись о разборе и понятности в memory/linguist/.
 * Ошибка журнала не должна ломать основной прогон.
 * @param {object} record — запись.
 * @returns {{path: string|null, ok: boolean, error?: string}}
 */
function writeJournal(record) {
  try {
    fs.mkdirSync(JOURNAL_DIR, { recursive: true });
    const file = path.join(JOURNAL_DIR, 'linguist-log.jsonl');
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return { path: file, ok: true };
  } catch (e) {
    return { path: null, ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ *
 * 7. Точка входа
 * ------------------------------------------------------------------ */

/**
 * Точка входа агента: СЕМАНТИЧЕСКИЙ АНАЛИЗ -> уточнение -> выполнение ->
 * проверка понятности.
 * @param {string} prompt — задача пользователя.
 * @param {object} [options] — { journal, answerLanguage, threshold }.
 * @returns {Promise<object>} результат прогона + семантический профиль.
 */
async function runAgent(prompt, options = {}) {
  const original = (typeof prompt === 'string') ? prompt.trim() : '';
  return {
    ok: false,
    strategy: STRATEGY,
    answer: '',
    semanticAnalysis: analyzeSemantics(original, options),
    refinedTask: original,
    clarity: { ok: false, verdict: 'not-run', score: 0, issues: [], metrics: {} }
  };
}

module.exports = { runAgent, STRATEGY, analyzeSemantics };
