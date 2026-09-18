'use strict';

/**
 * chemistry/task_profiler.js
 * ---------------------------
 * Профилировщик задач (task profiler).
 *
 * API:
 *   profile(taskText) -> profile object
 *
 * Профиль задачи — это структурированное описание того, ЧТО представляет
 * собой задача: её тема, тип, сложность, требования, сущности, риски и
 * рекомендуемая стратегия решения. Модуль не зависит от внешних библиотек
 * и работает в любом окружении Node.js >= 12.
 *
 * Пример:
 *   const { profile } = require('./chemistry/task_profiler');
 *   console.log(profile('Найди все упоминания EverOS в проекте. Ничего не меняй.'));
 */

// ---------------------------------------------------------------------------
// 1. Словари и константы
// ---------------------------------------------------------------------------

const DOMAIN_KEYWORDS = {
  chemistry: ['chemistry', 'химия', 'молекул', 'reaction', 'реакц', 'вещество', 'valence', 'формул'],
  code: ['code', 'код', 'function', 'функц', 'class', 'класс', 'bug', 'баг', 'refactor', 'рефактор'],
  git: ['git', 'commit', 'коммит', 'branch', 'ветк', 'merge', 'merge', 'rebase', 'repo', 'репозитор'],
  files: ['file', 'файл', 'директор', 'папк', 'path', 'путь', 'readme', 'csv', 'json'],
  data: ['data', 'данн', 'csv', 'parquet', 'pandas', 'dataset', 'таблиц'],
  web: ['http', 'url', 'server', 'сервер', 'nginx', 'port', 'порт', 'webserver', 'docker'],
  docs: ['docs', 'документ', 'readme', 'описан', 'инструкц', 'manual'],
  tests: ['test', 'тест', 'spec', 'assert', 'assertion', 'coverage', 'покрыти'],
  search: ['найд', 'поиск', 'search', 'grep', 'упоминан', 'find', 'locate'],
  security: ['security', 'безопасн', 'secret', 'token', 'парол', 'password', 'auth'],
};

const ACTION_VERBS = {
  create: ['созда', 'добав', 'напиши', 'create', 'add', 'write', 'сформируй', 'сгенерируй'],
  modify: ['измен', 'исправ', 'поправ', 'modify', 'fix', 'update', 'редактир', 'замени'],
  delete: ['удали', 'удали', 'remove', 'delete', 'drop', 'очист'],
  read: ['прочит', 'read', 'посмотр', 'изуч', 'покажи', 'выведи'],
  find: ['найд', 'find', 'search', 'найди', 'поищи', 'определи'],
  run: ['запуст', 'run', 'execute', 'выполни', 'исполни', 'build', 'собери'],
  verify: ['провер', 'verify', 'validate', 'убедись', 'тест'],
  analyze: ['проанализ', 'analyze', 'оцен', 'разбер', 'исследуй'],
};

const NEGATIVE_CONSTRAINTS = [
  'ничего не меняй',
  'не меняй',
  'не трогай',
  'не изменяй',
  'не удаляй',
  'не создавай',
  'только прочитай',
  'do not modify',
  'do not change',
  'read only',
  'readonly',
  'без изменений',
];

const POSITIVE_CONSTRAINTS = [
  'обязательно',
  'must',
  'should',
  'требуется',
  'нужно',
  'необходимо',
  'убедись',
  'verify',
  'критерий',
];

const RISK_PATTERNS = [
  { re: /delete|удали|drop|rm -rf/i, weight: 9, label: 'destructive-operations' },
  { re: /production|прод|prod\b/i, weight: 7, label: 'production-impact' },
  { re: /database|\.db|postgres|mysql|sqlite/i, weight: 6, label: 'data-store-touch' },
  { re: /secret|token|password|\.env/i, weight: 8, label: 'secrets-exposure' },
  { re: /deploy|deployment|release/i, weight: 7, label: 'deployment' },
  { re: /migrat/i, weight: 6, label: 'migration' },
  { re: /всё|everything|все файлы/i, weight: 4, label: 'broad-scope' },
];

const DEFAULTS = {
  maxKeywords: 24,
  maxEntities: 32,
  snippetLength: 120,
  complexityScale: 10,
  confidenceScale: 100,
};

// ---------------------------------------------------------------------------
// 2. Утилиты
// ---------------------------------------------------------------------------

/**
 * Приводит текст к нижнему регистру и нормализует пробелы.
 * @param {*} value
 * @returns {string}
 */
function normalize(value) {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Разбивает текст на предложения.
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  const raw = String(text || '');
  const parts = raw.split(/[.!?;:\n]+/u);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Токенизация: слова длиной >= 2.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  const matches = normalize(text).match(/[a-zа-яё0-9_\-]{2,}/giu);
  return matches ? matches : [];
}

/**
 * Уникальный массив.
 * @param {Array} arr
 * @returns {Array}
 */
function uniq(arr) {
  return Array.from(new Set(arr));
}

/**
 * Ограничивает длину строки.
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/**
 * Безопасный clamp.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Округляет до n знаков.
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
function round(value, digits) {
  const k = Math.pow(10, digits || 0);
  return Math.round(value * k) / k;
}

// ---------------------------------------------------------------------------
// 3. Извлечение признаков
// ---------------------------------------------------------------------------

/**
 * Определяет домены задачи по ключевым словам.
 * @param {string} text
 * @returns {string[]}
 */
function detectDomains(text) {
  const t = normalize(text);
  const found = [];
  Object.keys(DOMAIN_KEYWORDS).forEach((domain) => {
    const kws = DOMAIN_KEYWORDS[domain];
    if (kws.some((k) => t.indexOf(k) !== -1)) found.push(domain);
  });
  return found;
}

/**
 * Определяет действия (глаголы) задачи.
 * @param {string} text
 * @returns {string[]}
 */
function detectActions(text) {
  const t = normalize(text);
  const actions = [];
  Object.keys(ACTION_VERBS).forEach((action) => {
    const verbs = ACTION_VERBS[action];
    if (verbs.some((v) => t.indexOf(v) !== -1)) actions.push(action);
  });
  return actions;
}

/**
 * Извлекает сущности: файлы, пути, идентификаторы, числа.
 * @param {string} text
 * @returns {object}
 */
function extractEntities(text) {
  const raw = String(text || '');
  const files = uniq(raw.match(/[\w./-]+\.[a-z]{1,6}\b/gi) || []);
  const paths = uniq(raw.match(/(?:\/[\w.-]+){2,}\/?/g) || []);
  const identifiers = uniq(raw.match(/\b[a-z_][a-z0-9_]{3,}\b/gi) || [])
    .filter((id) => /[_]/.test(id) || /[A-Z]/.test(id.slice(1)))
    .slice(0, DEFAULTS.maxEntities);
  const numbers = uniq(raw.match(/\b\d+(?:\.\d+)?\b/g) || []).map(Number);
  const quoted = uniq((raw.match(/["'`]([^"'`]{1,60})["'`]/g) || []).map((q) => q.slice(1, -1)));
  return { files, paths, identifiers, numbers, quoted };
}

/**
 * Извлекает ключевые слова по частоте.
 * @param {string} text
 * @returns {Array<{term: string, count: number}>}
 */
function extractKeywords(text) {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'и', 'в', 'на', 'с', 'по',
    'не', 'что', 'как', 'это', 'все', 'для', 'или', 'но', 'же', 'бы', 'ли', 'то', 'из',
  ]);
  const counts = new Map();
  tokenize(text).forEach((tok) => {
    const t = tok.toLowerCase();
    if (stop.has(t) || t.length < 3) return;
    counts.set(t, (counts.get(t) || 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => (b.count - a.count) || a.term.localeCompare(b.term))
    .slice(0, DEFAULTS.maxKeywords);
}

/**
 * Извлекает ограничения (чего делать нельзя / что обязательно).
 * @param {string} text
 * @returns {object}
 */
function extractConstraints(text) {
  const t = normalize(text);
  const forbidden = NEGATIVE_CONSTRAINTS.filter((p) => t.indexOf(p) !== -1);
  const required = POSITIVE_CONSTRAINTS.filter((p) => t.indexOf(p) !== -1);
  return {
    forbidModification: forbidden.length > 0,
    forbiddenPhrases: uniq(forbidden),
    requiredPhrases: uniq(required),
  };
}

/**
 * Оценивает риски.
 * @param {string} text
 * @returns {object}
 */
function assessRisks(text) {
  const hits = [];
  RISK_PATTERNS.forEach((p) => {
    if (p.re.test(text)) hits.push({ label: p.label, weight: p.weight });
  });
  const score = clamp(hits.reduce((acc, h) => acc + h.weight, 0), 0, 30);
  let level = 'low';
  if (score >= 18) level = 'critical';
  else if (score >= 12) level = 'high';
  else if (score >= 6) level = 'medium';
  return { score, level, factors: hits };
}

/**
 * Оценивает сложность задачи.
 * @param {object} features
 * @returns {object}
 */
function assessComplexity(features) {
  const lengthFactor = clamp(Math.log10(features.length + 1) * 2, 0, 3);
  const domainFactor = clamp(features.domains.length * 0.8, 0, 4);
  const actionFactor = clamp(features.actions.length * 0.5, 0, 2.5);
  const entityFactor = clamp(features.entities.files.length * 0.3 + features.entities.paths.length * 0.3, 0, 2);
  const constraintFactor = features.constraints.forbiddenPhrases.length * 0.4;
  const raw = lengthFactor + domainFactor + actionFactor + entityFactor + constraintFactor;
  const score = clamp(round(raw, 2), 0, DEFAULTS.complexityScale);
  let bucket = 'trivial';
  if (score >= 8) bucket = 'hard';
  else if (score >= 5) bucket = 'moderate';
  else if (score >= 2.5) bucket = 'easy';
  return { score, bucket, factors: { lengthFactor, domainFactor, actionFactor, entityFactor, constraintFactor } };
}

/**
 * Определяет тип задачи.
 * @param {object} features
 * @returns {string}
 */
function classifyTask(features) {
  const a = new Set(features.actions);
  if (a.has('find') && features.constraints.forbidModification) return 'readonly-search';
  if (a.has('create') && a.has('verify')) return 'implement-and-test';
  if (a.has('create')) return 'implementation';
  if (a.has('modify')) return 'modification';
  if (a.has('delete')) return 'removal';
  if (a.has('verify')) return 'verification';
  if (a.has('analyze')) return 'analysis';
  if (a.has('run')) return 'execution';
  if (a.has('read')) return 'reading';
  return 'unknown';
}

/**
 * Оценка уверенности профиля.
 * @param {object} features
 * @returns {number} 0..100
 */
function confidence(features) {
  let c = 40;
  c += Math.min(features.domains.length * 8, 30);
  c += Math.min(features.actions.length * 6, 24);
  if (features.keywords.length > 3) c += 10;
  if (features.textLength > 40) c += 10;
  if (features.constraints.forbiddenPhrases.length > 0) c += 5;
  return clamp(Math.round(c), 0, DEFAULTS.confidenceScale);
}

// ---------------------------------------------------------------------------
// 4. Рекомендации и стратегия
// ---------------------------------------------------------------------------

/**
 * Формирует рекомендуемую стратегию решения.
 * @param {object} features
 * @param {object} complexity
 * @param {object} risks
 * @returns {object}
 */
function buildStrategy(features, complexity, risks) {
  const taskType = classifyTask(features);
  const steps = [];
  if (taskType === 'readonly-search') {
    steps.push('Использовать только чтение: exec/grep/search_code.');
    steps.push('Собрать список совпадений и файлов.');
    steps.push('НЕ выполнять запись, коммиты и изменения.');
  } else if (taskType === 'implementation') {
    steps.push('Спланировать структуру файла/модуля.');
    steps.push('Реализовать минимальный рабочий вариант.');
    steps.push('Проверить синтаксис (node --check) и поведение.');
  } else if (taskType === 'modification') {
    steps.push('Локализовать место изменения.');
    steps.push('Внести точечную правку.');
    steps.push('Проверить регрессию.');
  } else if (taskType === 'verification') {
    steps.push('Определить критерий успеха.');
    steps.push('Выполнить проверку.');
    steps.push('Зафиксировать результат и улики.');
  } else {
    steps.push('Разобрать формулировку задачи.');
    steps.push('Выполнить требуемые действия.');
    steps.push('Проверить результат по критерию.');
  }
  if (risks.level === 'high' || risks.level === 'critical') {
    steps.push('Соблюдать максимальную осторожность (высокий риск).');
  }
  return {
    taskType,
    steps,
    parallelizable: complexity.score < 4,
    estimatedSteps: Math.max(1, Math.ceil(complexity.score / 2)),
    readOnly: features.constraints.forbidModification,
  };
}

/**
 * Формирует список требований/проверок.
 * @param {object} features
 * @returns {string[]}
 */
function buildRequirements(features) {
  const reqs = [];
  if (features.constraints.forbidModification) reqs.push('Запрещено изменять файлы.');
  if (features.domains.indexOf('code') !== -1) reqs.push('Код должен проходить синтаксическую проверку.');
  if (features.domains.indexOf('tests') !== -1) reqs.push('Необходимы тесты/проверки.');
  if (features.domains.indexOf('git') !== -1) reqs.push('Учесть состояние git-репозитория.');
  if (features.entities.files.length > 0) reqs.push('Обработать указанные файлы.');
  if (features.entities.numbers.length > 0) reqs.push('Соблюсти числовые критерии из задачи.');
  return uniq(reqs);
}

/**
 * Формирует диагностические заметки.
 * @param {object} features
 * @returns {string[]}
 */
function buildNotes(features) {
  const notes = [];
  if (features.actions.length === 0) notes.push('Действие не распознано — уточнить формулировку.');
  if (features.domains.length === 0) notes.push('Домен не определён — вероятна общая задача.');
  if (features.textLength < 20) notes.push('Очень короткое описание задачи.');
  if (features.entities.files.length > 5) notes.push('Много файлов — задача широкого охвата.');
  return notes;
}

// ---------------------------------------------------------------------------
// 5. Основной API
// ---------------------------------------------------------------------------

/**
 * Строит профиль задачи по её тексту.
 *
 * @param {string} taskText Текст задачи.
 * @param {object} [options] Дополнительные опции.
 * @returns {object} Профиль задачи.
 */
function profile(taskText, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const text = String(taskText === undefined || taskText === null ? '' : taskText);

  const entities = extractEntities(text);
  const features = {
    textLength: text.length,
    sentenceCount: splitSentences(text).length,
    wordCount: tokenize(text).length,
    domains: detectDomains(text),
    actions: detectActions(text),
    keywords: extractKeywords(text),
    constraints: extractConstraints(text),
    entities,
    snippet: truncate(text.replace(/\s+/g, ' ').trim(), opts.snippetLength),
  };

  const complexity = assessComplexity(features);
  const risks = assessRisks(text);
  const taskType = classifyTask(features);
  const strategy = buildStrategy(features, complexity, risks);
  const conf = confidence(features);
  const requirements = buildRequirements(features);
  const notes = buildNotes(features);

  const suggestions = [];
  if (complexity.bucket === 'hard') suggestions.push('Разбить задачу на подзадачи.');
  if (risks.level !== 'low') suggestions.push('Проверить риски перед выполнением.');
  if (strategy.readOnly) suggestions.push('Не вносить изменений — режим только чтения.');
  if (features.domains.indexOf('code') !== -1) suggestions.push('Прогнать node --check / линтер.');

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    input: {
      length: features.textLength,
      words: features.wordCount,
      sentences: features.sentenceCount,
      snippet: features.snippet,
    },
    summary: {
      taskType,
      domains: features.domains,
      actions: features.actions,
      readOnly: strategy.readOnly,
      complexityScore: complexity.score,
      complexityBucket: complexity.bucket,
      riskLevel: risks.level,
      confidence: conf,
    },
    features: {
      domains: features.domains,
      actions: features.actions,
      keywords: features.keywords,
      constraints: features.constraints,
      entities: features.entities,
    },
    assessment: {
      complexity,
      risks,
      confidence: conf,
    },
    requirements,
    strategy,
    suggestions,
    notes,
  };
}

/**
 * Короткая сводка профиля (для логов).
 * @param {object} p
 * @returns {string}
 */
function summarize(p) {
  if (!p || !p.summary) return 'no-profile';
  const s = p.summary;
  return `[${s.taskType}] domains=${s.domains.join(',') || '-'} complexity=${s.complexityScore}/${s.complexityBucket} risk=${s.riskLevel} confidence=${s.confidence}`;
}

// ---------------------------------------------------------------------------
// 6. Экспорт
// ---------------------------------------------------------------------------

module.exports = {
  profile,
  summarize,
  // низкоуровневые утилиты (полезны для тестов)
  _internal: {
    normalize,
    tokenize,
    splitSentences,
    detectDomains,
    detectActions,
    extractEntities,
    extractKeywords,
    extractConstraints,
    assessRisks,
    assessComplexity,
    classifyTask,
    confidence,
    buildStrategy,
    buildRequirements,
    buildNotes,
  },
};
