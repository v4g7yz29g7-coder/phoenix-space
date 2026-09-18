'use strict';

/**
 * task_profiler.js
 * ------------------------------------------------------------------
 * Профилирование задачи (task profiling) для химического планировщика.
 *
 * API:
 *   profile(taskText) -> TaskProfile
 *
 * Профиль описывает задачу по набору ортогональных измерений:
 *   - категория / домен задачи
 *   - сложность (0..100)
 *   - объём и энтропия текста
 *   - требуемые ресурсы (время, инструменты, знания)
 *   - риски и неопределённость
 *   - теги, извлечённые из текста
 *
 * Модуль не имеет внешних зависимостей и детерминирован.
 * ------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Словари признаков
// ---------------------------------------------------------------------------

const DOMAIN_LEXICON = {
  code: [
    'код', 'code', 'функция', 'function', 'баг', 'bug', 'рефактор', 'refactor',
    'тест', 'test', 'сборка', 'build', 'скрипт', 'script', 'api', 'класс',
    'class', 'модуль', 'module', 'import', 'compile', 'lint', 'deploy',
  ],
  data: [
    'данные', 'data', 'csv', 'json', 'parquet', 'таблица', 'table', 'метрика',
    'metric', 'аналитика', 'analytics', 'датасет', 'dataset', 'парс', 'parse',
    'etl', 'база', 'sql', 'pipeline',
  ],
  research: [
    'исследование', 'research', 'гипотеза', 'hypothesis', 'эксперимент',
    'experiment', 'статья', 'paper', 'обзор', 'survey', 'анализ', 'analysis',
    'доказательство', 'proof', 'модель', 'model',
  ],
  planning: [
    'план', 'plan', 'роадмап', 'roadmap', 'задача', 'task', 'спринт', 'sprint',
    'этап', 'milestone', 'приоритет', 'priority', 'расписание', 'schedule',
    'оценка', 'estimate',
  ],
  docs: [
    'документ', 'doc', 'readme', 'инструкция', 'manual', 'гайд', 'guide',
    'описание', 'описании', 'комментарий', 'comment', 'шаблон', 'template',
  ],
  ui: [
    'интерфейс', 'ui', 'ux', 'кнопка', 'button', 'форма', 'form', 'вёрстка',
    'layout', 'css', 'html', 'стиль', 'style', 'страница', 'page', 'дизайн',
  ],
};

const RISK_TERMS = [
  ['удалить', 12], ['delete', 12], ['drop', 14], ['утечка', 15], ['leak', 15],
  ['секрет', 10], ['secret', 10], ['пароль', 12], ['password', 12],
  ['прод', 13], ['production', 13], ['prod', 13], ['миграц', 11], ['migrat', 11],
  ['необратим', 16], ['irreversible', 16], ['критичн', 10], ['critical', 10],
  ['безопасн', 8], ['security', 8], ['уязвим', 12], ['vulnerab', 12],
];

const VAGUE_TERMS = [
  'может быть', 'наверное', 'как-нибудь', 'что-то', 'примерно', 'где-то',
  'maybe', 'perhaps', 'somehow', 'something', 'around', 'roughly', 'kind of',
  'вроде', 'типа',
];

const AMBITION_TERMS = [
  ['оптимизир', 8], ['optimiz', 8], ['ускор', 7], ['speed', 7],
  ['масштаб', 9], ['scale', 9], ['архитектур', 10], ['architect', 10],
  ['рефактор', 6], ['refactor', 6], ['с нуля', 11], ['from scratch', 11],
  ['полност', 6], ['full', 4], ['комплексн', 9], ['comprehensive', 9],
];

const STOPWORDS = new Set([
  'и', 'в', 'на', 'с', 'по', 'для', 'из', 'к', 'о', 'от', 'это', 'как',
  'что', 'не', 'но', 'а', 'или', 'же', 'бы', 'ли', 'the', 'a', 'an', 'of',
  'to', 'in', 'on', 'for', 'with', 'and', 'or', 'is', 'are', 'be', 'it',
]);

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

/**
 * Нормализует текст: приводит к нижнему регистру и заменяет ё→е.
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  if (typeof text !== 'string') return '';
  return text.toLowerCase().replace(/ё/g, 'е');
}

/**
 * Разбивает текст на слова (буквенно-цифровые токены).
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  const norm = normalize(text);
  const matches = norm.match(/[a-zа-я0-9_\-]+/g);
  return matches ? matches : [];
}

/**
 * Ограничивает значение диапазоном.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Округляет до заданного количества знаков.
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
function round(value, digits) {
  const k = Math.pow(10, digits || 0);
  return Math.round(value * k) / k;
}

/**
 * Складывает все значения Map/объекта.
 * @param {Object<string, number>} obj
 * @returns {number}
 */
function sumValues(obj) {
  return Object.keys(obj).reduce((acc, key) => acc + obj[key], 0);
}

// ---------------------------------------------------------------------------
// Измерения профиля
// ---------------------------------------------------------------------------

/**
 * Определяет домен(ы) задачи на основе лексикона.
 * @param {string[]} tokens
 * @returns {{primary: string, scores: Object<string, number>}}
 */
function detectDomain(tokens) {
  const set = new Set(tokens);
  const scores = {};
  let best = 'general';
  let bestScore = 0;

  for (const domain of Object.keys(DOMAIN_LEXICON)) {
    let score = 0;
    for (const term of DOMAIN_LEXICON[domain]) {
      if (set.has(term)) score += 1;
      else if (tokens.some((t) => t.indexOf(term) === 0)) score += 0.5;
    }
    scores[domain] = round(score, 2);
    if (score > bestScore) {
      bestScore = score;
      best = domain;
    }
  }

  return { primary: bestScore > 0 ? best : 'general', scores };
}

/**
 * Оценивает сложность задачи по длине, домену и ключевым словам.
 * @param {string} text
 * @param {string[]} tokens
 * @param {string} primaryDomain
 * @returns {number} сложность 0..100
 */
function estimateComplexity(text, tokens, primaryDomain) {
  const words = tokens.length;
  // Вклад объёма: 40 слов ≈ базовый уровень.
  const volumePart = clamp(Math.log2(Math.max(1, words)) * 8, 0, 40);

  // Вклад структуры: наличие списков, пунктов, чисел.
  const structureMarkers = (text.match(/[:\-•]/g) || []).length;
  const structurePart = clamp(structureMarkers * 1.5, 0, 15);

  // Вклад домена.
  const domainWeight = {
    general: 0, docs: 4, data: 8, planning: 8, code: 12, research: 14, ui: 9,
  };
  const domainPart = domainWeight[primaryDomain] || 0;

  // Вклад амбиций.
  const norm = normalize(text);
  let ambitionPart = 0;
  for (const [term, weight] of AMBITION_TERMS) {
    if (norm.indexOf(term) !== -1) ambitionPart += weight;
  }
  ambitionPart = clamp(ambitionPart, 0, 25);

  const total = volumePart + structurePart + domainPart + ambitionPart;
  return round(clamp(total, 1, 100), 1);
}

/**
 * Считает энтропию распределения токенов (мера неопределённости).
 * @param {string[]} tokens
 * @returns {number}
 */
function textEntropy(tokens) {
  if (tokens.length === 0) return 0;
  const freq = {};
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue;
    freq[t] = (freq[t] || 0) + 1;
  }
  const total = sumValues(freq);
  if (total === 0) return 0;
  let entropy = 0;
  for (const key of Object.keys(freq)) {
    const p = freq[key] / total;
    entropy -= p * Math.log2(p);
  }
  return round(entropy, 3);
}

/**
 * Извлекает ключевые слова (наиболее частые значимые токены).
 * @param {string[]} tokens
 * @param {number} limit
 * @returns {string[]}
 */
function extractKeywords(tokens, limit) {
  const freq = {};
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    freq[t] = (freq[t] || 0) + 1;
  }
  const sorted = Object.keys(freq)
    .filter((k) => /[a-zа-я]/.test(k))
    .sort((a, b) => {
      if (freq[b] !== freq[a]) return freq[b] - freq[a];
      return a.localeCompare(b);
    });
  return sorted.slice(0, limit || 12);
}

/**
 * Оценивает риск задачи.
 * @param {string} text
 * @param {number} complexity
 * @returns {{score: number, level: string, triggers: string[]}}
 */
function estimateRisk(text, complexity) {
  const norm = normalize(text);
  let score = complexity * 0.25;
  const triggers = [];

  for (const [term, weight] of RISK_TERMS) {
    if (norm.indexOf(term) !== -1) {
      score += weight;
      triggers.push(term);
    }
  }

  score = round(clamp(score, 0, 100), 1);
  let level = 'low';
  if (score >= 65) level = 'critical';
  else if (score >= 40) level = 'high';
  else if (score >= 20) level = 'medium';

  return { score, level, triggers };
}

/**
 * Оценивает неопределённость (насколько расплывчато описана задача).
 * @param {string} text
 * @param {number} complexity
 * @param {number} entropy
 * @returns {{score: number, vagueHits: number}}
 */
function estimateUncertainty(text, complexity, entropy) {
  const norm = normalize(text);
  let vagueHits = 0;
  for (const term of VAGUE_TERMS) {
    if (norm.indexOf(term) !== -1) vagueHits += 1;
  }
  const score = round(
    clamp(vagueHits * 7 + entropy * 2 + complexity * 0.1, 0, 100),
    1
  );
  return { score, vagueHits };
}

/**
 * Оценивает требования к ресурсам.
 * @param {number} complexity
 * @param {number} words
 * @returns {{effortHours: number, tools: string[], knowledge: string[]}}
 */
function estimateResources(complexity, words) {
  const effortHours = round(
    clamp(0.5 + complexity / 12 + words / 400, 0.25, 48),
    2
  );
  const tools = ['editor'];
  const knowledge = ['domain-basics'];

  if (complexity > 25) tools.push('tests');
  if (complexity > 40) {
    tools.push('version-control');
    knowledge.push('architecture');
  }
  if (complexity > 60) {
    tools.push('profiler');
    knowledge.push('systems-design');
  }
  if (complexity > 80) {
    tools.push('incident-playbook');
    knowledge.push('expert-level');
  }

  return { effortHours, tools, knowledge };
}

/**
 * Возвращает уровневую метку сложности.
 * @param {number} complexity
 * @returns {string}
 */
function complexityBand(complexity) {
  if (complexity >= 80) return 'very-high';
  if (complexity >= 60) return 'high';
  if (complexity >= 35) return 'medium';
  if (complexity >= 15) return 'low';
  return 'trivial';
}

/**
 * Формирует набор тегов профиля.
 * @param {Object} parts
 * @returns {string[]}
 */
function buildTags(parts) {
  const tags = new Set();
  tags.add('domain:' + parts.domain);
  tags.add('complexity:' + complexityBand(parts.complexity));
  tags.add('risk:' + parts.risk.level);

  if (parts.uncertainty.score >= 30) tags.add('uncertain');
  if (parts.words < 12) tags.add('terse');
  if (parts.words > 120) tags.add('verbose');
  if (parts.entropy > 4.5) tags.add('diverse');
  if (parts.keywords.length > 0) tags.add('kw:' + parts.keywords[0]);
  if (parts.risk.triggers.length > 0) tags.add('guarded');

  return Array.from(tags);
}

/**
 * Строит краткое человекочитаемое резюме профиля.
 * @param {TaskProfileLike} p
 * @returns {string}
 */
function summarizeProfile(p) {
  const lines = [];
  lines.push(`Домен: ${p.domain} (уверенность ${p.domainConfidence})`);
  lines.push(
    `Сложность: ${p.complexity} (${complexityBand(p.complexity)})`
  );
  lines.push(`Риск: ${p.risk.level} (${p.risk.score})`);
  lines.push(`Неопределённость: ${p.uncertainty.score}`);
  lines.push(`Трудозатраты: ~${p.resources.effortHours}ч`);
  lines.push(`Теги: ${p.tags.join(', ')}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Основной API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TaskProfileLike
 * @property {string} domain
 * @property {number} complexity
 * @property {Object} risk
 * @property {Object} uncertainty
 * @property {Object} resources
 * @property {string[]} tags
 * @property {number} domainConfidence
 */

/**
 * Профилирует задачу по её текстовому описанию.
 *
 * Возвращает детерминированный объект-профиль, пригодный
 * для последующего матчинга агентов и планирования.
 *
 * @param {string} taskText — текстовое описание задачи.
 * @returns {TaskProfileLike}
 */
function profile(taskText) {
  const text = typeof taskText === 'string' ? taskText : '';
  const tokens = tokenize(text);
  const words = tokens.length;
  const chars = text.length;

  const domainInfo = detectDomain(tokens);
  const domain = domainInfo.primary;
  const domainConfidence = computeDomainConfidence(domainInfo.scores, domain);

  const complexity = estimateComplexity(text, tokens, domain);
  const entropy = textEntropy(tokens);
  const keywords = extractKeywords(tokens, 12);
  const risk = estimateRisk(text, complexity);
  const uncertainty = estimateUncertainty(text, complexity, entropy);
  const resources = estimateResources(complexity, words);

  const tags = buildTags({
    domain,
    complexity,
    risk,
    uncertainty,
    words,
    entropy,
    keywords,
  });

  const result = {
    version: 1,
    domain,
    domainScores: domainInfo.scores,
    domainConfidence,
    complexity,
    complexityBand: complexityBand(complexity),
    metrics: {
      chars,
      words,
      uniqueWords: countUnique(tokens),
      entropy,
      lexicalDensity: round(words ? countSignificant(tokens) / words : 0, 3),
    },
    keywords,
    risk,
    uncertainty,
    resources,
    tags,
    empty: words === 0,
  };

  result.summary = summarizeProfile(result);
  result.toString = function toString() {
    return '[TaskProfile ' + this.domain + '/' + this.complexity + ']';
  };

  return result;
}

/**
 * Считает уникальные токены.
 * @param {string[]} tokens
 * @returns {number}
 */
function countUnique(tokens) {
  const set = new Set(tokens);
  return set.size;
}

/**
 * Считает значимые (не стоп-слова) токены.
 * @param {string[]} tokens
 * @returns {number}
 */
function countSignificant(tokens) {
  let n = 0;
  for (const t of tokens) {
    if (!STOPWORDS.has(t) && t.length >= 3) n += 1;
  }
  return n;
}

/**
 * Вычисляет уверенность домена как долю лучшего скора.
 * @param {Object<string, number>} scores
 * @param {string} domain
 * @returns {number} 0..1
 */
function computeDomainConfidence(scores, domain) {
  const total = sumValues(scores);
  if (total <= 0) return 0;
  const best = scores[domain] || 0;
  return round(best / total, 3);
}

// ---------------------------------------------------------------------------
// Сравнение профилей
// ---------------------------------------------------------------------------

/**
 * Вычисляет косинусное сходство двух профилей по тегам.
 * @param {TaskProfileLike} a
 * @param {TaskProfileLike} b
 * @returns {number} 0..1
 */
function similarity(a, b) {
  if (!a || !b || !a.tags || !b.tags) return 0;
  const setA = new Set(a.tags);
  const setB = new Set(b.tags);
  let inter = 0;
  for (const tag of setA) if (setB.has(tag)) inter += 1;
  const denom = Math.sqrt(setA.size) * Math.sqrt(setB.size);
  return denom === 0 ? 0 : round(inter / denom, 3);
}

/**
 * Ранжирует список задач относительно эталонного профиля.
 * @param {TaskProfileLike} base
 * @param {Array<{text: string}>} items
 * @returns {Array<{text: string, score: number}>}
 */
function rankSimilar(base, items) {
  const list = Array.isArray(items) ? items : [];
  const scored = list.map((item) => {
    const p = profile(item && item.text ? item.text : '');
    return { text: item && item.text, score: similarity(base, p) };
  });
  scored.sort((x, y) => y.score - x.score);
  return scored;
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

module.exports = {
  profile,
  similarity,
  rankSimilar,
  // низкоуровневые помощники (для тестов и повторного использования)
  _internal: {
    tokenize,
    normalize,
    detectDomain,
    estimateComplexity,
    textEntropy,
    extractKeywords,
    estimateRisk,
    estimateUncertainty,
    estimateResources,
    complexityBand,
    buildTags,
    clamp,
    round,
  },
};
