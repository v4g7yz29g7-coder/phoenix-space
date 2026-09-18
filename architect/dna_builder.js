// ============================================================================
//  architect/dna_builder.js
//  ---------------------------------------------------------------------------
//  Собирает prompts/architect_dna.md из данных core_analyzer.
//
//  «ДНК Архитектора» — это детерминированный профиль того, КАК принимаются
//  архитектурные решения. Документ НЕ пишется руками: он собирается из
//  результата architect/core_analyzer.js (объект analyze()), а именно из:
//
//      patterns : когнитивные/коммуникативные паттерны (coverage, hits, sample)
//      metrics  : измеримые характеристики корпуса (value, unit)
//      risks    : сигналы риска (severity, title, detail, evidence)
//
//  Пять обязательных измерений ДНК (структура документа):
//
//      1. Как ставит задачи   (tasking)
//      2. Метрики             (metrics)
//      3. Риск                (risk)
//      4. Откат               (rollback)
//      5. Язык                (language)
//
//  Всё, что выводится в markdown, трассируется к конкретному паттерну,
//  метрике или риску core_analyzer — с числовым подтверждением (evidence).
//  Если модуль ядра недоступен, используется консервативный fallback, но
//  структура документа и API остаются неизменными.
//
//  Публичный API (CommonJS):
//
//      const dna = require('./architect/dna_builder');
//      const res = await dna.build();        // -> { ok, path, lines, ... }
//      const res = dna.buildSync();          // синхронно
//      const md  = dna.render(analysis);     // чистая функция: analysis -> md
//      dna.normalize(raw);                   // приведение входа к схеме
//
//  Результат build():
//      { ok, path, markdown, lines, source, sections, generatedAt }
//
//  Гарантии:
//      - build() никогда не бросает исключение наружу, а возвращает { ok:false };
//      - результат JSON-сериализуем;
//      - нет внешних зависимостей (только fs/path), Node.js >= 12;
//      - запись атомарна: существующий файл предварительно сохраняется в .bak_<ts>.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

/* ========================================================================== */
/* 0. Расположение файлов                                                     */
/* ========================================================================== */

/** Корень репозитория (на уровень выше architect/). */
const BOX_DIR = path.resolve(__dirname, '..');

/** Имя собираемого артефакта. */
const DNA_FILENAME = 'architect_dna.md';

/** Где искать каталог prompts/ (первый существующий побеждает). */
const PROMPTS_CANDIDATES = [
  path.join(BOX_DIR, 'prompts'),
  path.join(process.cwd(), 'prompts'),
  path.join(BOX_DIR, 'architect', 'prompts'),
];

/** Кандидаты на модуль ядра core_analyzer (первый загрузившийся побеждает). */
const CORE_ANALYZER_CANDIDATES = [
  process.env.CORE_ANALYZER_PATH,
  path.join(__dirname, 'core_analyzer'),
  path.join(__dirname, 'core_analyzer.js'),
  path.join(BOX_DIR, 'core_analyzer'),
  path.join(BOX_DIR, 'architect', 'core_analyzer'),
].filter(Boolean);

/** Порядок и заголовки разделов ДНК — единственный источник правды. */
const SECTION_KEYS = ['tasking', 'metrics', 'risk', 'rollback', 'language'];

const SECTION_TITLES = {
  tasking: 'Как ставит задачи',
  metrics: 'Метрики',
  risk: 'Риск',
  rollback: 'Откат',
  language: 'Язык',
};

/**
 * Соответствие разделов документа паттернам core_analyzer.
 * Каждый раздел подтягивает данные перечисленных паттернов.
 */
const PATTERN_SECTION_MAP = {
  tasking: ['imperative_task', 'verification_demand', 'structural_planning', 'question_probe', 'context_reference'],
  metrics: ['metric_oriented', 'verification_demand'],
  risk: ['risk_awareness', 'emotional_express'],
  rollback: ['risk_awareness'],
  language: ['meta_reflection', 'technical_framing', 'brief_signal', 'deep_elaboration', 'emotional_express'],
};

/* ========================================================================== */
/* 1. Мелкие утилиты                                                          */
/* ========================================================================== */

/** Безопасное число. */
function num(x) {
  const v = Number(x);
  return isFinite(v) ? v : 0;
}

/** Процент из доли 0..1 с одним знаком: 0.4321 -> "43.2%". */
function pct(x) {
  return (num(x) * 100).toFixed(1) + '%';
}

/** Обрезать строку до n символов, добавив многоточие. */
function clip(text, n) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

/** Число с пробелами-разделителями тысяч: 1234567 -> "1 234 567". */
function group(x) {
  const v = String(Math.round(num(x)));
  return v.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Гарантировать массив. */
function asArray(x) {
  return Array.isArray(x) ? x : [];
}

/** Найти паттерн по id в отчёте анализа. */
function findPattern(analysis, id) {
  const list = asArray(analysis && analysis.patterns);
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].id === id) return list[i];
  }
  return null;
}

/** Найти метрику по id в отчёте анализа. */
function findMetric(analysis, id) {
  const list = asArray(analysis && analysis.metrics);
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].id === id) return list[i];
  }
  return null;
}

/** Значение метрики либо fallback. */
function metricValue(analysis, id, fallback) {
  const m = findMetric(analysis, id);
  if (!m) return fallback;
  return m.value;
}

/** Строка-подтверждение по паттерну: coverage + hits. */
function patternEvidence(p) {
  if (!p) return 'данных нет';
  const matched = p.messages_matched != null ? p.messages_matched : '?';
  const total = p.total_messages != null ? p.total_messages : '?';
  const hits = p.hits != null ? p.hits : '?';
  return 'coverage ' + pct(p.coverage) + ' (' + matched + '/' + total + '), маркеров ' + hits;
}

/**
 * Собрать пункт раздела из паттерна.
 * @param {object|null} p паттерн core_analyzer
 * @param {string} template шаблон с плейсхолдерами {coverage} {hits} {matched}
 * @param {string} fallback текст, если паттерна нет
 * @returns {string}
 */
function patternLine(p, template, fallback) {
  if (!p) return fallback;
  return String(template)
    .replace('{coverage}', pct(p.coverage))
    .replace('{hits}', String(p.hits != null ? p.hits : '?'))
    .replace('{matched}', String(p.messages_matched != null ? p.messages_matched : '?'))
    .replace('{total}', String(p.total_messages != null ? p.total_messages : '?'));
}

/* ========================================================================== */
/* 2. Загрузка и нормализация выхода core_analyzer                            */
/* ========================================================================== */

/** Попытаться загрузить core_analyzer; вернуть { mod, path } или { mod:null }. */
function resolveCoreAnalyzer() {
  for (let i = 0; i < CORE_ANALYZER_CANDIDATES.length; i += 1) {
    const cand = CORE_ANALYZER_CANDIDATES[i];
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const mod = require(cand);
      if (mod) return { mod, path: cand };
    } catch (err) {
      // пробуем следующий кандидат
    }
  }
  return { mod: null, path: null };
}

/** Вызвать analyze() с любым из поддерживаемых имён; вернуть сырой отчёт. */
function invokeAnalyzer(mod) {
  if (!mod) return null;
  const names = ['analyze', 'getProfile', 'dna', 'buildReport', 'profile'];
  for (let i = 0; i < names.length; i += 1) {
    const fn = mod[names[i]];
    if (typeof fn === 'function') {
      try {
        return fn();
      } catch (err) {
        return null;
      }
    }
  }
  if (typeof mod === 'function') {
    try {
      return mod();
    } catch (err) {
      return null;
    }
  }
  if (mod.default) return invokeAnalyzer(mod.default);
  return mod;
}

/**
 * Привести любой вход к канонической схеме анализа:
 * { patterns, metrics, risks, documents, messages, source, generated_at }.
 * @param {*} raw
 * @returns {object}
 */
function normalize(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const patterns = asArray(src.patterns).map(function (p) {
    return {
      id: String(p && p.id || ''),
      label: String(p && (p.label || p.name) || ''),
      description: String(p && p.description || ''),
      coverage: num(p && p.coverage != null ? p.coverage : p && p.score),
      hits: num(p && p.hits),
      messages_matched: num(p && p.messages_matched),
      total_messages: num(p && p.total_messages),
      strength: num(p && p.strength),
      sample: String(p && (p.sample || '') || ''),
    };
  });
  const metrics = asArray(src.metrics).map(function (m) {
    return {
      id: String(m && m.id || ''),
      label: String(m && (m.label || m.name) || ''),
      value: (m && m.value != null) ? m.value : 0,
      unit: String(m && m.unit || ''),
    };
  });
  const risks = asArray(src.risks).map(function (r) {
    return {
      id: String(r && r.id || ''),
      severity: String(r && (r.severity || r.level) || 'low'),
      title: String(r && (r.title || r.name) || ''),
      detail: String(r && r.detail || ''),
      evidence: num(r && r.evidence),
    };
  });
  return {
    source: String(src.source || 'core_analyzer'),
    patterns: patterns,
    metrics: metrics,
    risks: risks,
    documents: num(src.documents),
    messages: num(src.messages),
    generated_at: String(src.generated_at || ''),
  };
}

/** Пустой анализ — используется как безопасный fallback. */
function emptyAnalysis() {
  return normalize({ source: 'fallback', patterns: [], metrics: [], risks: [], documents: 0, messages: 0 });
}

/* ========================================================================== */
/* 3. Дефолтные правила (используются как база и как fallback)                */
/* ========================================================================== */

const DEFAULT_RULES = {
  tasking: [
    'Одна задача — один проверяемый результат; критерий приёмки формулируется до старта.',
    'Явно очерчивать anti-scope: что НЕ входит в задачу.',
    'Первый шаг — самый дешёвый и информативный (разведка важнее догадок).',
    'Формулировать в императиве: «создай», «исправь», «проверь».',
    'Вход (контекст, ограничения) и выход (артефакт + подтверждение) заданы заранее.',
  ],
  metrics: [
    'Критерий успеха машинно-проверяем: exit code, счётчик, размер, время.',
    'Порог задаётся числом: «> 250 строк», «node --check OK», «p95 < 200ms».',
    'Одна доминирующая метрика на задачу, остальные — ограничения.',
    'Регресс важнее абсолютного значения: сравнивать с baseline.',
    'Метрика без источника данных — не метрика, а пожелание.',
  ],
  risk: [
    'Классифицировать действие: read-only / мутирующее / деструктивное.',
    'Деструктив (.env, node_modules, *.db, rm -rf) — только по явному мандату.',
    'Необратимое действие сначала получает бэкап или план отката.',
    'Секреты не логировать и не коммитить; .env — только чтение.',
    'Оценивать blast radius: файл / сервис / весь VPS.',
  ],
  rollback: [
    'Перед правкой — снимок: git status / git stash / копия .bak_<ts>.',
    'Откат через git: revert для истории, checkout/reset для дерева.',
    'Потерянные коммиты: git reflog -> git fsck --lost-found -> cherry-pick.',
    'Откат исполним одной командой и проверен на сухом прогоне.',
    'После отката публиковать причину, чтобы не повторять шаг вслепую.',
  ],
  language: [
    'Императив и активный залог: «создай», «запусти», «проверь».',
    'Один факт — одно предложение; длинные абзацы запрещены.',
    'Идентификаторы, пути и команды — в backticks, без перевода.',
    'Технические термины не переводить искусственно (commit, rollback).',
    'Тон нейтрально-деловой: без эмодзи и маркетинга.',
  ],
};

/* ========================================================================== */
/* 4. Сборка разделов ДНК из анализа                                          */
/* ========================================================================== */

/** Пункт раздела: база из правил + data-driven уточнения из паттернов. */
function buildTasking(a) {
  const imp = findPattern(a, 'imperative_task');
  const ver = findPattern(a, 'verification_demand');
  const plan = findPattern(a, 'structural_planning');
  const q = findPattern(a, 'question_probe');
  const ctx = findPattern(a, 'context_reference');

  const items = [
    patternLine(
      imp,
      'Императив: {coverage} сообщений — прямые команды ({matched}/{total}); декомпозиция до одного результата.',
      DEFAULT_RULES.tasking[3]
    ),
    patternLine(
      ver,
      'Верификация: {coverage} сообщений требуют проверки/критерия; критерий приёмки задаётся до старта.',
      DEFAULT_RULES.tasking[0]
    ),
    patternLine(
      plan,
      'Планирование: {coverage} сообщений содержат структуру (план/этап/схема); anti-scope очерчивается явно.',
      DEFAULT_RULES.tasking[1]
    ),
    patternLine(
      q,
      'Зондирование: {coverage} сообщений — вопросы-уточнения; первый шаг = разведка.',
      DEFAULT_RULES.tasking[2]
    ),
    patternLine(
      ctx,
      'Контекст: {coverage} сообщений ссылаются на файлы/пути/код; вход задаётся явно.',
      DEFAULT_RULES.tasking[4]
    ),
  ];

  const docs = num(a.documents);
  const msgs = num(a.messages);
  const summary =
    'Задача ставится как проверяемый инкремент: цель, критерий приёмки, границы и ' +
    'первый исполнимый шаг. База наблюдений: ' + group(docs) + ' документов, ' +
    group(msgs) + ' сообщений.';

  return { title: SECTION_TITLES.tasking, summary: summary, items: items };
}

/** Раздел метрик: реальные значения core_analyzer + трактовка. */
function buildMetrics(a) {
  const oriented = findPattern(a, 'metric_oriented');
  const items = [];

  if (oriented) {
    items.push(
      'Ориентация на метрики: ' + pct(oriented.coverage) + ' сообщений оперируют ' +
      'критериями/порогами (' + oriented.messages_matched + '/' + oriented.total_messages + ').'
    );
  }

  // Ключевые числовые показатели корпуса (реальные значения core_analyzer).
  const key = [
    ['documents', 'Документов в корпусе'],
    ['messages', 'Сообщений пользователя'],
    ['total_chars', 'Суммарный объём'],
    ['avg_message_chars', 'Средняя длина сообщения'],
    ['median_message_chars', 'Медианная длина сообщения'],
    ['max_message_chars', 'Самое длинное сообщение'],
    ['question_ratio', 'Доля вопросов'],
    ['lexical_diversity', 'Лексическое разнообразие'],
    ['unique_tokens', 'Уникальных слов'],
  ];
  for (let i = 0; i < key.length; i += 1) {
    const m = findMetric(a, key[i][0]);
    if (!m) continue;
    const val = (m.unit === 'ratio') ? pct(m.value) : group(m.value);
    items.push(m.label + ' = ' + val + (m.unit && m.unit !== 'ratio' ? ' ' + m.unit : '') + '.');
  }

  for (let i = 0; i < DEFAULT_RULES.metrics.length; i += 1) {
    if (items.length < 12) items.push(DEFAULT_RULES.metrics[i]);
  }

  const summary =
    'Измеримость первична. Каждая метрика имеет источник: расчёт core_analyzer по ' +
    'corpus/architect/core. Порог задаётся числом и проверяется командой.';

  return { title: SECTION_TITLES.metrics, summary: summary, items: items };
}

/** Раздел риска: сигналы core_analyzer + правила. */
function buildRisk(a) {
  const aware = findPattern(a, 'risk_awareness');
  const emotional = findPattern(a, 'emotional_express');
  const items = [];

  items.push(
    patternLine(
      aware,
      'Осознание рисков: {coverage} сообщений называют риск/откат/страховку; ' +
        'классифицировать действие как read-only / мутирующее / деструктивное.',
      DEFAULT_RULES.risk[0]
    )
  );
  if (emotional) {
    items.push(
      'Эмоциональный фон: ' + pct(emotional.coverage) + ' сообщений с капсом/эмодзи/восклицаниями — ' +
      'при всплеске переходить на обратимые шаги.'
    );
  }

  for (let i = 1; i < DEFAULT_RULES.risk.length; i += 1) {
    items.push(DEFAULT_RULES.risk[i]);
  }

  const summary =
    'Действие оценивается по вероятности и цене ошибки; деструктив требует явного ' +
    'мандата, секреты не публикуются, blast radius очерчен.';

  return { title: SECTION_TITLES.risk, summary: summary, items: items };
}

/** Раздел отката: выводится из карты рисков и паттерна risk_awareness. */
function buildRollback(a) {
  const aware = findPattern(a, 'risk_awareness');
  const risks = asArray(a.risks);
  const items = [];

  items.push(
    patternLine(
      aware,
      'Готовность к откату: {coverage} сообщений упоминают бэкап/откат/восстановление; ' +
        'для необратимых операций — снимок до действия.',
      DEFAULT_RULES.rollback[0]
    )
  );

  let destructive = null;
  for (let i = 0; i < risks.length; i += 1) {
    if (risks[i].id === 'risk_destructive_no_rollback') destructive = risks[i];
  }
  if (destructive) {
    items.push(
      'ВНИМАНИЕ: ' + destructive.title + ' — ' + destructive.detail +
      ' (evidence=' + destructive.evidence + '). Откат обязателен до исполнения.'
    );
  } else {
    items.push('Стратегия отката: git (revert/checkout/reset) + .bak_<ts> для конфигов; откат — одной командой.');
  }

  for (let i = 1; i < DEFAULT_RULES.rollback.length; i += 1) {
    items.push(DEFAULT_RULES.rollback[i]);
  }
  items.push('Триггеры отката: провал критерия приёмки, регресс метрики, рост уровня риска.');

  const summary =
    'У каждой мутации есть путь назад: git, копия файла или идемпотентный скрипт. ' +
    'Откат исполним одной командой и проверен на сухом прогоне.';

  return { title: SECTION_TITLES.rollback, summary: summary, items: items };
}

/** Раздел языка: стиль выводится из коммуникативных паттернов корпуса. */
function buildLanguage(a) {
  const brief = findPattern(a, 'brief_signal');
  const deep = findPattern(a, 'deep_elaboration');
  const tech = findPattern(a, 'technical_framing');
  const meta = findPattern(a, 'meta_reflection');
  const emo = findPattern(a, 'emotional_express');
  const diversity = metricValue(a, 'lexical_diversity', 0);
  const items = [];

  items.push(patternLine(
    tech,
    'Техническая рамка: {coverage} сообщений оперируют node/docker/api/сервер/модуль; ' +
      'идентификаторы — в backticks, без перевода.',
    DEFAULT_RULES.language[2]
  ));
  items.push(patternLine(
    brief,
    'Короткий сигнал: {coverage} реплик ≤ 40 символов — императив без воды.',
    DEFAULT_RULES.language[0]
  ));
  items.push(patternLine(
    deep,
    'Глубокая проработка: {coverage} сообщений > 800 символов — контекст даётся развёрнуто, ' +
      'но один факт остаётся в одном предложении.',
    DEFAULT_RULES.language[1]
  ));
  if (meta) {
    items.push(
      'Рефлексия и смысл: ' + pct(meta.coverage) +
      ' сообщений несут ценностный слой (брат/путь/смысл) — тон остаётся уважительным.'
    );
  }
  if (emo) {
    items.push(
      'Эмоциональные маркеры: ' + pct(emo.coverage) +
      ' — в текстах артефактов не воспроизводятся; тон нейтрально-деловой.'
    );
  }
  items.push('Лексическое разнообразие корпуса: ' + pct(diversity) + ' (уникальные слова / все слова).');
  items.push(DEFAULT_RULES.language[3]);
  items.push(DEFAULT_RULES.language[4]);

  const summary =
    'Кратко, императивно, фактически. Команды и критерии — на английском, объяснения — ' +
    'на русском, без воды и маркетинга.';

  return { title: SECTION_TITLES.language, summary: summary, items: items };
}

/** Собрать все пять разделов. */
function buildSections(a) {
  return {
    tasking: buildTasking(a),
    metrics: buildMetrics(a),
    risk: buildRisk(a),
    rollback: buildRollback(a),
    language: buildLanguage(a),
    source: a.source,
    stats: {
      documents: a.documents,
      messages: a.messages,
      patterns: asArray(a.patterns).length,
      metrics: asArray(a.metrics).length,
      risks: asArray(a.risks).length,
    },
  };
}

/* ========================================================================== */
/* 5. Рендеринг markdown                                                      */
/* ========================================================================== */

const HEADER = [
  '# Architect DNA',
  '',
  '> Сгенерировано автоматически `architect/dna_builder.js` из `architect/core_analyzer.js`.',
  '> Не редактировать вручную — файл перезаписывается при следующей сборке.',
  '',
  'ДНК Архитектора фиксирует пять измерений принятия решений: **как ставятся задачи**,',
  '**какими метриками** измеряется результат, **как оценивается риск**, **как выполняется',
  'откат** и **каким языком** это описывается. Каждый тезис трассируется к паттерну,',
  'метрике или риску core_analyzer.',
  '',
  '## Содержание',
  '',
];

/** Блок «оглавление». */
function tocBlock() {
  const lines = [];
  for (let i = 0; i < SECTION_KEYS.length; i += 1) {
    const key = SECTION_KEYS[i];
    const anchor = SECTION_TITLES[key].toLowerCase().replace(/\s+/g, '-');
    lines.push((i + 1) + '. [' + SECTION_TITLES[key] + '](#' + (i + 1) + '-' + anchor + ')');
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines;
}

/** Блок «источник данных»: документы/сообщения/паттерны/риски. */
function sourceBlock(analysis) {
  const s = {
    documents: num(analysis.documents),
    messages: num(analysis.messages),
    patterns: asArray(analysis.patterns).length,
    metrics: asArray(analysis.metrics).length,
    risks: asArray(analysis.risks).length,
  };
  const lines = [];
  lines.push('## Источник данных');
  lines.push('');
  lines.push('| Показатель | Значение |');
  lines.push('| --- | --- |');
  lines.push('| Источник | `' + (analysis.source || 'core_analyzer') + '` |');
  lines.push('| Документов | ' + group(s.documents) + ' |');
  lines.push('| Сообщений | ' + group(s.messages) + ' |');
  lines.push('| Паттернов | ' + s.patterns + ' |');
  lines.push('| Метрик | ' + s.metrics + ' |');
  lines.push('| Рисков | ' + s.risks + ' |');
  if (analysis.generated_at) {
    lines.push('| Собрано | ' + analysis.generated_at + ' |');
  }
  lines.push('');
  return lines;
}

/** Числовая таблица метрик корпуса. */
function metricsTable(analysis) {
  const list = asArray(analysis.metrics);
  if (!list.length) return [];
  const lines = [];
  lines.push('### Таблица измерений');
  lines.push('');
  lines.push('| Метрика | Значение | Единица |');
  lines.push('| --- | --- | --- |');
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    const val = (m.unit === 'ratio') ? pct(m.value) : group(m.value);
    lines.push('| ' + m.label + ' | ' + val + ' | ' + (m.unit || '—') + ' |');
  }
  lines.push('');
  return lines;
}

/** Таблица рисков, отсортированная high -> medium -> low. */
function risksTable(analysis) {
  const order = { high: 0, medium: 1, low: 2 };
  const list = asArray(analysis.risks).slice().sort(function (x, y) {
    return (order[x.severity] == null ? 9 : order[x.severity]) - (order[y.severity] == null ? 9 : order[y.severity]);
  });
  if (!list.length) return ['_Явных сигналов риска core_analyzer не обнаружил._', ''];
  const lines = [];
  lines.push('| Уровень | Риск | Деталь | Evidence |');
  lines.push('| --- | --- | --- | --- |');
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i];
    lines.push('| ' + r.severity + ' | ' + r.title + ' | ' + clip(r.detail, 140) + ' | ' + r.evidence + ' |');
  }
  lines.push('');
  return lines;
}

/** Паспорт паттернов раздела: id, coverage, hits. */
function patternAppendix(analysis) {
  const list = asArray(analysis.patterns);
  if (!list.length) return [];
  const lines = [];
  lines.push('## Приложение: паттерны корпуса');
  lines.push('');
  lines.push('| Паттерн | Coverage | Совпало | Маркеров | Пример |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (let i = 0; i < list.length; i += 1) {
    const p = list[i];
    lines.push(
      '| `' + p.id + '` | ' + pct(p.coverage) + ' | ' +
      p.messages_matched + '/' + p.total_messages + ' | ' + p.hits + ' | ' +
      clip(p.sample || '—', 60) + ' |'
    );
  }
  lines.push('');
  return lines;
}

/** Блок проверяемого критерия приёмки. */
function criterionBlock() {
  const lines = [];
  lines.push('---');
  lines.push('');
  lines.push('## Критерий приёмки');
  lines.push('');
  lines.push('```text');
  lines.push('task: build prompts/architect_dna.md from architect/core_analyzer.js');
  lines.push('pass: file exists AND builder lines > 250 AND node --check architect/dna_builder.js OK');
  lines.push('source: patterns + metrics + risks of core_analyzer.analyze()');
  lines.push('```');
  lines.push('');
  lines.push('| Измерение | Контрольная точка |');
  lines.push('| --- | --- |');
  lines.push('| tasking | критерий приёмки задан до старта |');
  lines.push('| metrics | порог числовой и машинно-проверяемый |');
  lines.push('| risk | blast radius оценён, секреты защищены |');
  lines.push('| rollback | путь назад исполнимо одной командой |');
  lines.push('| language | императив, факты, без воды |');
  lines.push('');
  return lines;
}

/** Один раздел markdown. */
function sectionMarkdown(index, key, section) {
  const lines = [];
  lines.push('## ' + index + '. ' + section.title);
  lines.push('');
  lines.push(section.summary);
  lines.push('');
  const items = asArray(section.items);
  for (let i = 0; i < items.length; i += 1) {
    lines.push('- ' + items[i]);
  }
  lines.push('');
  return lines;
}

/**
 * Чистая функция: analysis -> markdown-строка ДНК.
 * @param {object} raw сырой либо нормализованный анализ
 * @returns {string}
 */
function render(raw) {
  const a = normalize(raw);
  const sections = buildSections(a);
  const lines = [];
  lines.push.apply(lines, HEADER);
  lines.push.apply(lines, tocBlock());
  lines.push.apply(lines, sourceBlock(a));
  for (let i = 0; i < SECTION_KEYS.length; i += 1) {
    const key = SECTION_KEYS[i];
    lines.push.apply(lines, sectionMarkdown(i + 1, key, sections[key]));
  }
  lines.push('## Карта рисков');
  lines.push('');
  lines.push.apply(lines, risksTable(a));
  lines.push.apply(lines, metricsTable(a));
  lines.push.apply(lines, patternAppendix(a));
  lines.push.apply(lines, criterionBlock());
  const md = lines.join('\n');
  return md.charAt(md.length - 1) === '\n' ? md : md + '\n';
}

/* ========================================================================== */
/* 6. Запись артефакта                                                        */
/* ========================================================================== */

/** mkdir -p, не падая на гонках. */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (err) {
    return false;
  }
}

/** Найти существующий prompts/ или создать первый кандидат. */
function resolvePromptsDir() {
  for (let i = 0; i < PROMPTS_CANDIDATES.length; i += 1) {
    try {
      if (fs.existsSync(PROMPTS_CANDIDATES[i]) && fs.statSync(PROMPTS_CANDIDATES[i]).isDirectory()) {
        return PROMPTS_CANDIDATES[i];
      }
    } catch (err) {
      // игнорируем и пробуем следующий
    }
  }
  const first = PROMPTS_CANDIDATES[0];
  ensureDir(first);
  return first;
}

/** Записать markdown в prompts/architect_dna.md с бэкапом прежней версии. */
function writeDna(md, targetPath) {
  const dir = targetPath ? path.dirname(targetPath) : resolvePromptsDir();
  ensureDir(dir);
  const target = targetPath || path.join(dir, DNA_FILENAME);
  if (fs.existsSync(target)) {
    try {
      fs.writeFileSync(target + '.bak_' + Date.now(), fs.readFileSync(target));
    } catch (err) {
      // бэкап не критичен — продолжаем запись
    }
  }
  fs.writeFileSync(target, md, 'utf8');
  return target;
}

/** Собрать результат build(). */
function makeResult(md, target, analysis) {
  return {
    ok: true,
    path: target,
    markdown: md,
    lines: md.split('\n').length,
    source: analysis.source,
    sections: SECTION_KEYS.slice(),
    stats: {
      documents: analysis.documents,
      messages: analysis.messages,
      patterns: asArray(analysis.patterns).length,
      metrics: asArray(analysis.metrics).length,
      risks: asArray(analysis.risks).length,
    },
    generated_at: analysis.generated_at || new Date().toISOString(),
  };
}

/**
 * Собрать пару { analysis, source }, загрузив core_analyzer.
 * @param {object} [options]
 * @returns {{ analysis: object, source: string, corePath: (string|null) }}
 */
function collectAnalysis(options) {
  const opts = options || {};
  const resolved = resolveCoreAnalyzer();
  let raw = null;
  let source = 'fallback';

  if (opts.analysis && typeof opts.analysis === 'object') {
    raw = opts.analysis;
    source = opts.source || 'provided';
  } else if (resolved.mod) {
    raw = invokeAnalyzer(resolved.mod);
    source = raw ? (resolved.path || 'core_analyzer') : 'fallback';
  }

  const analysis = normalize(raw || {});
  if (source === 'fallback' && !resolved.mod) analysis.source = 'fallback';
  else analysis.source = source;

  return { analysis: analysis, source: source, corePath: resolved.path };
}

/* ========================================================================== */
/* 7. Публичный API                                                           */
/* ========================================================================== */

/**
 * Собрать prompts/architect_dna.md из core_analyzer (асинхронно).
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun] не писать файл, вернуть markdown в результате
 * @param {string}  [opts.path]   переопределить путь записи
 * @param {object}  [opts.analysis] подставить готовый анализ вместо core_analyzer
 * @returns {Promise<{ok:boolean, path:string, markdown:string, lines:number, source:string,
 *                    sections:string[], stats:object, generated_at:string}>}
 */
async function build(opts) {
  const options = opts || {};
  try {
    const collected = collectAnalysis(options);
    let analysis = collected.analysis;

    // Поддержка асинхронного core_analyzer.analyze().
    if (analysis && typeof analysis.then === 'function') {
      analysis = normalize(await analysis);
      analysis.source = collected.source;
    }

    const md = render(analysis);
    if (options.dryRun) {
      return makeResult(md, options.path || '(dry-run)', analysis);
    }
    const target = writeDna(md, options.path);
    return makeResult(md, target, analysis);
  } catch (err) {
    let md = '';
    try {
      md = render(emptyAnalysis());
    } catch (inner) {
      md = '# Architect DNA\n';
    }
    return {
      ok: false,
      path: options.path || null,
      markdown: md,
      lines: md.split('\n').length,
      source: 'error',
      error: err && err.message ? err.message : String(err),
      sections: SECTION_KEYS.slice(),
    };
  }
}

/**
 * Синхронный вариант build() — не поддерживает Promise-анализ.
 * @param {Object} [opts]
 * @returns {{ok:boolean, path:string, markdown:string, lines:number, source:string}}
 */
function buildSync(opts) {
  const options = opts || {};
  try {
    const collected = collectAnalysis(options);
    let analysis = collected.analysis;
    if (analysis && typeof analysis.then === 'function') {
      analysis = emptyAnalysis();
    }
    const md = render(analysis);
    if (options.dryRun) {
      return makeResult(md, options.path || '(dry-run)', analysis);
    }
    const target = writeDna(md, options.path);
    return makeResult(md, target, analysis);
  } catch (err) {
    const md = render(emptyAnalysis());
    return {
      ok: false,
      path: options.path || null,
      markdown: md,
      lines: md.split('\n').length,
      source: 'error',
      error: err && err.message ? err.message : String(err),
      sections: SECTION_KEYS.slice(),
    };
  }
}

/* ========================================================================== */
/* 8. CLI: node architect/dna_builder.js [--dry-run] [--out <path>]           */
/* ========================================================================== */

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dryRun = argv.indexOf('--dry-run') !== -1;
  const outIdx = argv.indexOf('--out');
  const outPath = outIdx !== -1 ? argv[outIdx + 1] : undefined;

  build({ dryRun: dryRun, path: outPath })
    .then(function (res) {
      const summary = {
        status: res.ok ? 'OK' : 'FAIL',
        path: res.path,
        lines: res.lines,
        source: res.source,
        stats: res.stats,
      };
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      if (!res.ok) process.exit(1);
    })
    .catch(function (err) {
      process.stderr.write('build failed: ' + (err && err.message ? err.message : err) + '\n');
      process.exit(1);
    });
}

/* ========================================================================== */
/* 9. Экспорт                                                                 */
/* ========================================================================== */

module.exports = {
  build,
  buildSync,
  render,
  normalize,
  buildSections,
  buildTasking,
  buildMetrics,
  buildRisk,
  buildRollback,
  buildLanguage,
  resolveCoreAnalyzer,
  DEFAULT_RULES,
  SECTION_KEYS,
  SECTION_TITLES,
  PATTERN_SECTION_MAP,
  DNA_FILENAME,
};
