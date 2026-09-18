/**
 * architect/core_analyzer.js
 * ============================================================================
 * Анализатор паттернов мышления «брата» — Архитектора проекта «Феникс».
 *
 * Источник данных: markdown-файлы `corpus/architect/core/*.md`.
 * Формат каждого файла корпуса:
 *
 *     # Заголовок
 *
 *     _Дата: YYYY-MM-DD · Сообщений пользователя: N_
 *
 *     ---
 *     первое сообщение
 *     ---
 *     второе сообщение
 *
 * Модуль разбирает каждый файл на заголовок и отдельные сообщения и извлекает:
 *
 *   • patterns — когнитивно-коммуникативные паттерны (что встречается,
 *                в какой доле сообщений = coverage, и как часто = hits);
 *   • metrics  — измеримые характеристики корпуса (объём, длины сообщений,
 *                доля вопросов/восклицаний, лексическое разнообразие, даты);
 *   • risks    — сигналы риска (деструктивные команды без откатов,
 *                возможные утечки секретов, эмоциональные выбросы,
 *                перегрузка контекста, слабая верификация и т.п.).
 *
 * Публичный API (CommonJS):
 *
 *     const { analyze } = require('./architect/core_analyzer');
 *     const report = analyze();          // корпус по умолчанию
 *     const report = analyze({ dir });   // произвольная директория корпуса
 *
 * Гарантии контракта:
 *   • analyze() ВСЕГДА возвращает объект с массивами patterns/metrics/risks;
 *   • отсутствие или пустота корпуса НЕ приводит к исключению;
 *   • результат JSON-сериализуем;
 *   • нет внешних зависимостей (только fs и path), Node.js >= 12.
 *
 * Дополнительно экспортируются низкоуровневые функции (`_internal`) для тестов
 * и повторного использования в других модулях.
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* -------------------------------------------------------------------------- */
/* Конфигурация                                                               */
/* -------------------------------------------------------------------------- */

/** Каталог корпуса по умолчанию: <repo>/corpus/architect/core */
const DEFAULT_DIR = path.join(__dirname, '..', 'corpus', 'architect', 'core');

const CONFIG = {
  /** Порог «короткого» сообщения (символов). */
  shortChars: 40,
  /** Порог «длинного» сообщения (символов). */
  longChars: 800,
  /** Максимальная длина примера-сэмпла. */
  maxSample: 200,
  /** Регулярка секретоподобных присваиваний. */
  secretRe: /(api[_-]?key|secret|password|passwd|токен|token|bearer|private[_-]?key)\s*[:=]\s*['"]?[a-z0-9_\-]{8,}/iu,
};

/* -------------------------------------------------------------------------- */
/* Общие утилиты                                                              */
/* -------------------------------------------------------------------------- */

/** Безопасно прочитать файл как UTF-8; при ошибке — пустая строка. */
function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return '';
  }
}

/** Округлить до n знаков после запятой (7 -> '7.0000'). */
function round(value, digits) {
  const d = Number.isFinite(digits) ? digits : 4;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = Math.pow(10, d);
  return Math.round(n * factor) / factor;
}

/** Зажать число в диапазон [0, 1]. */
function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Обрезать текст до max символов, добавив многоточие. */
function sample(text, max) {
  const limit = Number.isFinite(max) ? max : CONFIG.maxSample;
  const str = String(text || '').replace(/\s+/g, ' ').trim();
  if (str.length <= limit) return str;
  return str.slice(0, limit - 1).trimEnd() + '…';
}

/** Сколько раз подстрока встречается в тексте (регистронезависимо). */
function countOccurrences(text, needle) {
  if (!text || !needle) return 0;
  const hay = String(text).toLowerCase();
  const need = String(needle).toLowerCase();
  if (!need) return 0;
  let index = 0;
  let count = 0;
  while ((index = hay.indexOf(need, index)) !== -1) {
    count += 1;
    index += need.length;
  }
  return count;
}

/** true, если в тексте есть хотя бы одно из слов (подстрочно). */
function includesAny(text, words) {
  if (!text || !Array.isArray(words)) return false;
  const hay = String(text).toLowerCase();
  for (const w of words) {
    if (w && hay.indexOf(String(w).toLowerCase()) !== -1) return true;
  }
  return false;
}

/** Сумма количеств вхождений всех слов. */
function countAny(text, words) {
  if (!text || !Array.isArray(words)) return 0;
  let total = 0;
  for (const w of words) total += countOccurrences(text, w);
  return total;
}

/** Проверка регулярки без риска из-за глобального флага. */
function reTest(re, text) {
  if (!re || typeof text !== 'string') return false;
  try {
    return new RegExp(re.source, re.flags).test(text);
  } catch (err) {
    return false;
  }
}

/** Количество совпадений регулярки (с добавлением флага g). */
function countMatches(text, re) {
  if (!re || typeof text !== 'string') return 0;
  try {
    const flags = re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags;
    const matches = text.match(new RegExp(re.source, flags));
    return matches ? matches.length : 0;
  } catch (err) {
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Файловые утилиты                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Список *.md-файлов корпуса, отсортированный по имени.
 * Для несуществующего каталога возвращает [] — без исключений.
 */
function listCoreFiles(dir) {
  const target = (typeof dir === 'string' && dir) ? dir : DEFAULT_DIR;
  let names;
  try {
    names = fs.readdirSync(target);
  } catch (err) {
    return [];
  }
  if (!Array.isArray(names)) return [];
  return names
    .filter((name) => typeof name === 'string' && /\.md$/i.test(name))
    .map((name) => path.join(target, name))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile();
      } catch (err) {
        return false;
      }
    })
    .sort();
}

/** Имя файла `001_2025-04-27_Заголовок.md` -> {index, date, title}. */
function parseFileName(filePath) {
  const base = path.basename(String(filePath || ''), '.md');
  const m = base.match(/^(\d+)_(\d{4}-\d{2}-\d{2})_(.+)$/);
  if (!m) return { index: null, date: null, title: base.replace(/_/g, ' ') };
  return { index: Number(m[1]), date: m[2], title: m[3].replace(/_/g, ' ') };
}

/**
 * Разобрать один markdown-файл корпуса.
 * Первый блок — заголовок/мета, последующие — сообщения.
 */
function parseDocument(filePath, rawContent) {
  const raw = typeof rawContent === 'string' ? rawContent : safeReadFile(filePath);
  const meta = parseFileName(filePath);
  let title = meta.title || '';
  let date = meta.date || null;

  const normalized = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  // Разбиваем на блоки по горизонтальным линиям "---".
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (/^[ \t]*-{3,}[ \t]*$/.test(line)) {
      blocks.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  blocks.push(current.join('\n'));

  const header = blocks.length ? blocks.shift() : '';

  const headingMatch = header.match(/^#\s+(.+?)\s*$/m);
  if (headingMatch) title = headingMatch[1].trim();

  const dateMatch = header.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) date = dateMatch[1];

  let messages = blocks
    .map((block) => String(block || '').trim())
    .filter((block) => block.length > 0);

  // Если разделителей не было — весь файл является одним сообщением.
  if (messages.length === 0) {
    const body = header
      .replace(/^#\s+.+$/m, '')
      .replace(/^_.*_$/m, '')
      .trim();
    if (body) messages = [body];
  }

  return { file: filePath, title, date, messages };
}

/** Прочитать весь корпус: массив документов. */
function readCorpus(dir) {
  const files = listCoreFiles(dir);
  const docs = [];
  for (const filePath of files) {
    docs.push(parseDocument(filePath));
  }
  return docs;
}

/** Разбить текст на токены (слова/числа), нижний регистр. */
function tokenize(text) {
  if (!text) return [];
  const matches = String(text).toLowerCase().match(/[0-9a-zа-яё'’-]+/gi);
  return matches || [];
}

/** Доля уникальных токенов среди всех (лексическое разнообразие). */
function uniqueRatio(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  if (list.length === 0) return 0;
  return round(new Set(list).size / list.length, 4);
}

/** Медиана числового массива. */
function median(values) {
  const arr = Array.isArray(values) ? values.slice().sort((a, b) => a - b) : [];
  if (arr.length === 0) return 0;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

/** Доля сообщений, удовлетворяющих предикату. */
function ratioWhere(messages, predicate) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return 0;
  let count = 0;
  for (const msg of list) {
    if (predicate(msg)) count += 1;
  }
  return round(count / list.length, 4);
}

/* -------------------------------------------------------------------------- */
/* Определения паттернов                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Набор «слов-маркеров» для каждого паттерна мышления.
 * Матчинг — подстрочный и регистронезависимый (устойчив к словоформам).
 */
function buildPatternDefs() {
  return [
    {
      id: 'questioning',
      label: 'Вопрошание',
      description: 'Склонность задавать вопросы и искать причины, а не только команды.',
      words: ['?', 'почему', 'зачем', 'как ', 'что если', 'а если', 'какой', 'какая', 'когда', 'сколько'],
    },
    {
      id: 'imperative_task',
      label: 'Императивные задачи',
      description: 'Постановка прямых задач: создать, сделать, запустить, исправить.',
      words: ['создай', 'сделай', 'запусти', 'напиши', 'исправь', 'добавь', 'удали', 'проверь', 'нужно', 'надо', 'давай'],
    },
    {
      id: 'verification_demand',
      label: 'Требование верификации',
      description: 'Запрос на доказательство, тесты и проверку результата.',
      words: ['проверь', 'протестируй', 'докажи', 'убедись', 'покажи', 'подтверди', 'тест', 'проверка'],
    },
    {
      id: 'risk_awareness',
      label: 'Осознание рисков',
      description: 'Упоминание опасностей, откатов, страховок и отказоустойчивости.',
      words: ['риск', 'опасн', 'осторож', 'бэкап', 'backup', 'откат', 'страхов', 'уязвим', 'может сломать'],
    },
    {
      id: 'system_thinking',
      label: 'Системное мышление',
      description: 'Мысль о связях, архитектуре, модулях и целостности систем.',
      words: ['систем', 'архитектур', 'модул', 'компонент', 'интеграц', 'структур', 'связ', 'экосистем'],
    },
    {
      id: 'abstraction',
      label: 'Абстрагирование',
      description: 'Выход к сути, смыслу, концепциям, парадигмам и метафорам.',
      words: ['смысл', 'суть', 'метафор', 'парадигм', 'концепц', 'теори', 'философ', 'онтолог'],
    },
    {
      id: 'visionary',
      label: 'Визионерство',
      description: 'Масштабные образы будущего: эволюция, человечество, сознание, свет.',
      words: ['будущ', 'эволюц', 'человечеств', 'вселенн', 'сознани', 'мировоззр', 'прорыв', 'трансформац'],
    },
    {
      id: 'pragmatic',
      label: 'Прагматизм',
      description: 'Опора на шаги, план, практический результат и конкретику.',
      words: ['шаг', 'план', 'результ', 'практик', 'конкретн', 'метрик', 'измер', 'реализац', 'по факту'],
    },
    {
      id: 'emotional_express',
      label: 'Эмоциональная экспрессия',
      description: 'Капс, восклицания, многоточия и эмодзи — эмоциональный накал.',
      words: ['!', '...', '🙂', '😊', '🔥', '❤', '👍', '😉', '🙏'],
    },
    {
      id: 'collaboration',
      label: 'Со-творчество',
      description: 'Обращение «брат», «мы», «вместе», просьбы о помощи и диалоге.',
      words: ['брат', 'вместе', 'мы ', 'помоги', 'давай', 'спасибо', 'пожалуйста', 'друг'],
    },
    {
      id: 'dialectical',
      label: 'Диалектичность',
      description: 'Удержание противоречий: «но», «однако», «с другой стороны», баланс.',
      words: ['однако', 'с другой стороны', 'противореч', 'баланс', 'зато', 'с одной стороны', 'но и'],
    },
    {
      id: 'numeric_precision',
      label: 'Числовая точность',
      description: 'Использование чисел, процентов и метрик для аргументации.',
      words: ['%', 'процент', ' 10', ' 100', ' в раз', 'числ', 'статистик', 'данн'],
    },
  ];
}

/** Сила паттерна: смесь охвата (coverage) и частоты появлений. */
function strength(hits, coverage) {
  const freq = Math.min(1, Number(hits || 0) / 10);
  return round(clamp01(0.6 * Number(coverage || 0) + 0.4 * freq), 4);
}

/**
 * Найти паттерны в массиве сообщений.
 * @param {string[]} messages
 * @returns {Array<{id,label,description,coverage,hits,messages,strength,sample}>}
 */
function detectPatterns(messages) {
  const list = Array.isArray(messages) ? messages.filter((m) => typeof m === 'string') : [];
  const total = list.length;
  const joined = list.join('\n');
  const defs = buildPatternDefs();
  const result = [];

  for (const def of defs) {
    const hitMessages = list.filter((msg) => includesAny(msg, def.words));
    const hits = countAny(joined, def.words);
    const coverage = total > 0 ? round(hitMessages.length / total, 4) : 0;
    const example = hitMessages.length > 0 ? hitMessages[0] : '';
    result.push({
      id: def.id,
      label: def.label,
      description: def.description,
      coverage,
      hits,
      messages: hitMessages.length,
      strength: strength(hits, coverage),
      sample: sample(example, CONFIG.maxSample),
    });
  }

  return result.sort((a, b) => (b.coverage - a.coverage) || (b.hits - a.hits));
}

/* -------------------------------------------------------------------------- */
/* Метрики корпуса                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Вычислить измеримые характеристики корпуса.
 * @returns {Array<{id,label,value,unit}>}
 */
function computeMetrics(docs, messages) {
  const docList = Array.isArray(docs) ? docs : [];
  const list = Array.isArray(messages) ? messages.filter((m) => typeof m === 'string') : [];

  const lengths = list.map((m) => m.length);
  const charsTotal = lengths.reduce((acc, n) => acc + n, 0);
  const tokens = list.reduce((acc, m) => acc.concat(tokenize(m)), []);
  const dates = docList
    .map((d) => (d && d.date ? Date.parse(d.date) : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  let dateSpanDays = 0;
  if (dates.length >= 2) {
    dateSpanDays = Math.round((dates[dates.length - 1] - dates[0]) / 86400000);
  }

  const metrics = [
    { id: 'documents', label: 'Документов в корпусе', value: docList.length, unit: 'шт' },
    { id: 'messages', label: 'Сообщений (фрагментов)', value: list.length, unit: 'шт' },
    { id: 'chars_total', label: 'Символов всего', value: charsTotal, unit: 'симв' },
    { id: 'avg_message_chars', label: 'Средняя длина сообщения', value: round(list.length ? charsTotal / list.length : 0, 2), unit: 'симв' },
    { id: 'median_message_chars', label: 'Медианная длина сообщения', value: round(median(lengths), 2), unit: 'симв' },
    { id: 'avg_words', label: 'Среднее число слов', value: round(list.length ? tokens.length / list.length : 0, 2), unit: 'слов' },
    { id: 'total_tokens', label: 'Токенов всего', value: tokens.length, unit: 'шт' },
    { id: 'unique_token_ratio', label: 'Лексическое разнообразие', value: uniqueRatio(tokens), unit: 'доля' },
    { id: 'short_message_ratio', label: 'Доля коротких сообщений', value: ratioWhere(list, (m) => m.length < CONFIG.shortChars), unit: 'доля' },
    { id: 'long_message_ratio', label: 'Доля длинных сообщений', value: ratioWhere(list, (m) => m.length > CONFIG.longChars), unit: 'доля' },
    { id: 'question_ratio', label: 'Доля сообщений с вопросом', value: ratioWhere(list, (m) => m.indexOf('?') !== -1), unit: 'доля' },
    { id: 'exclamation_ratio', label: 'Доля сообщений с восклицанием', value: ratioWhere(list, (m) => m.indexOf('!') !== -1), unit: 'доля' },
    { id: 'docs_with_dates', label: 'Документов с датой', value: dates.length, unit: 'шт' },
    { id: 'date_span_days', label: 'Охват по датам', value: dateSpanDays, unit: 'дней' },
  ];

  return metrics;
}

/* -------------------------------------------------------------------------- */
/* Риски                                                                      */
/* -------------------------------------------------------------------------- */

/** Собрать объект риска. */
function makeRisk(id, severity, label, description, value) {
  return { id, severity, label, description, value };
}

/**
 * Определить сигналы риска на основе сообщений, документов и найденных паттернов.
 * @returns {Array<{id,severity,label,description,value}>}
 */
function detectRisks(messages, docs, patterns, metrics) {
  const list = Array.isArray(messages) ? messages.filter((m) => typeof m === 'string') : [];
  const docList = Array.isArray(docs) ? docs : [];
  const patternList = Array.isArray(patterns) ? patterns : [];
  const joined = list.join('\n');
  const byId = new Map(patternList.map((p) => [p.id, p]));

  const destructiveWords = ['rm ', 'rmdir', 'drop ', 'truncate', 'wipe', 'format ', 'delete ', 'удали', 'удалить', 'снести'];
  const rollbackWords = ['бэкап', 'backup', 'откат', 'восстанов', 'снапшот', 'snapshot', 'сохран'];
  const risks = [];

  // 1. Деструктивные команды без стратегии отката.
  const destructiveHits = countAny(joined, destructiveWords);
  const rollbackHits = countAny(joined, rollbackWords);
  if (destructiveHits > 0 && rollbackHits === 0) {
    risks.push(makeRisk(
      'risk_destructive_no_rollback',
      'high',
      'Деструктивные команды без отката',
      'Обнаружены удаляющие операции, но ни разу не упомянута страховка/бэкап/откат.',
      destructiveHits
    ));
  }

  // 2. Возможная утечка секретов.
  if (reTest(CONFIG.secretRe, joined)) {
    risks.push(makeRisk(
      'risk_secret_leak',
      'high',
      'Возможная утечка секретов',
      'В корпусе встречаются строки, похожие на ключи/токены/пароли.',
      countMatches(joined, CONFIG.secretRe)
    ));
  }

  // 3. Эмоциональные выбросы.
  const emotional = byId.get('emotional_express');
  if (emotional && emotional.coverage >= 0.2) {
    risks.push(makeRisk(
      'risk_emotional_spike',
      'medium',
      'Эмоциональные выбросы',
      'Заметная доля сообщений содержит капс/восклицания/многоточия.',
      emotional.coverage
    ));
  }

  // 4. Перегрузка контекста очень длинными сообщениями.
  const longCount = list.filter((m) => m.length > CONFIG.longChars).length;
  if (list.length > 0 && longCount / list.length >= 0.5) {
    risks.push(makeRisk(
      'risk_context_overload',
      'medium',
      'Перегрузка контекста',
      'Более половины сообщений превышают ' + CONFIG.longChars + ' символов.',
      longCount
    ));
  }

  // 5. Слабая верификация при высокой императивности.
  const imperative = byId.get('imperative_task');
  const verification = byId.get('verification_demand');
  if (imperative && verification &&
      imperative.coverage > verification.coverage * 1.5 &&
      imperative.coverage > 0) {
    risks.push(makeRisk(
      'risk_low_verification',
      'medium',
      'Недостаток верификации',
      'Команды даются заметно чаще, чем запросы на проверку результата.',
      round(imperative.coverage - verification.coverage, 4)
    ));
  }

  // 6. Слепота к рискам на объёмном корпусе.
  const riskPattern = byId.get('risk_awareness');
  if (docList.length >= 3 && (!riskPattern || riskPattern.coverage < 0.05)) {
    risks.push(makeRisk(
      'risk_blind_spot',
      'medium',
      'Слепота к рискам',
      'На объёмном корпусе почти не называются риски, откаты и страхование.',
      riskPattern ? riskPattern.coverage : 0
    ));
  }

  // 7. Узкая база наблюдений.
  if (docList.length === 1) {
    risks.push(makeRisk(
      'risk_single_doc',
      'low',
      'Узкая база наблюдений',
      'Один документ — выводы статистически хрупкие.',
      docList.length
    ));
  }

  const order = { high: 0, medium: 1, low: 2 };
  return risks.sort((a, b) => (order[a.severity] || 9) - (order[b.severity] || 9));
}

/* -------------------------------------------------------------------------- */
/* Публичный API                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Главная точка входа. Читает `corpus/architect/core/*.md` и возвращает отчёт.
 * Никогда не бросает исключение: при любой ошибке возвращается валидная форма.
 *
 * @param {Object} [options]
 * @param {string} [options.dir] переопределить каталог корпуса (для тестов)
 * @returns {{patterns:Array, metrics:Array, risks:Array, documents:number,
 *            messages:number, generated_at:string}}
 */
function analyze(options) {
  const opts = (options && typeof options === 'object') ? options : {};
  const dir = (typeof opts.dir === 'string' && opts.dir) ? opts.dir : DEFAULT_DIR;
  const empty = {
    patterns: [],
    metrics: [],
    risks: [],
    documents: 0,
    messages: 0,
    generated_at: new Date().toISOString(),
  };

  try {
    const docs = readCorpus(dir);
    const messages = [];
    for (const doc of docs) {
      if (doc && Array.isArray(doc.messages)) {
        for (const msg of doc.messages) messages.push(msg);
      }
    }

    const patterns = detectPatterns(messages);
    const metrics = computeMetrics(docs, messages);
    const risks = detectRisks(messages, docs, patterns, metrics);

    return {
      patterns,
      metrics,
      risks,
      documents: docs.length,
      messages: messages.length,
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    // Контракт: даже при внутренней ошибке — валидная структура.
    empty.error = String((err && err.message) || err);
    return empty;
  }
}

/** Путь к корпусу по умолчанию — для диагностики и тестов. */
function corpusDir() {
  return DEFAULT_DIR;
}

/* -------------------------------------------------------------------------- */
/* Экспорт                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  analyze,
  corpusDir,
  // Низкоуровневые функции (для тестов и повторного использования).
  _internal: {
    DEFAULT_DIR,
    CONFIG,
    safeReadFile,
    round,
    clamp01,
    sample,
    countOccurrences,
    includesAny,
    countAny,
    reTest,
    countMatches,
    listCoreFiles,
    parseFileName,
    parseDocument,
    readCorpus,
    tokenize,
    uniqueRatio,
    median,
    ratioWhere,
    buildPatternDefs,
    detectPatterns,
    computeMetrics,
    detectRisks,
    strength,
  },
};

/* -------------------------------------------------------------------------- */
/* CLI: `node architect/core_analyzer.js` печатает краткую сводку.            */
/* -------------------------------------------------------------------------- */

if (require.main === module) {
  const report = analyze();
  const top = report.patterns.slice(0, 5).map((p) => p.id + ':' + p.coverage);
  process.stdout.write(
    'core_analyzer: docs=' + report.documents +
    ' messages=' + report.messages +
    ' patterns=' + report.patterns.length +
    ' risks=' + report.risks.length + '\n'
  );
  process.stdout.write('top patterns: ' + top.join(', ') + '\n');
  if (report.risks.length) {
    process.stdout.write('risks: ' + report.risks.map((r) => r.severity + ':' + r.id).join(', ') + '\n');
  }
}
