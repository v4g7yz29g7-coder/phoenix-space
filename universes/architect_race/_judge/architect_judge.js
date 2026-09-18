#!/usr/bin/env node
'use strict';

/**
 * architect_judge.js
 * ============================================================================
 * LLM-судья для 5 версий ДНК Архитектора (гонка universes/architect_race).
 *
 * Читает пять файлов ДНК:
 *   cmd_a_formalist/DNA.md, cmd_b_narrator/DNA.md, cmd_c_constitutionalist/DNA.md,
 *   cmd_d_minimalist/DNA.md, cmd_e_totalist/DNA.md
 *
 * Оценивает каждую версию по 4 метрикам (0-10):
 *   1) Полнота      — покрытие тем корпуса
 *   2) Точность     — соответствие корпусу
 *   3) Действенность— по нему можно принимать решения
 *   4) Стиль        — говорит как брат
 *
 * Пишет REPORT.md (таблица оценок + рекомендация топ-2) и возвращает
 *   judge() -> { scores, recommendations }
 *
 * Если LLM недоступен (нет ключа/сети) — включается детерминированный
 * эвристический скоринг, чтобы конвейер не падал.
 *
 * Запуск:  node universes/architect_race/_judge/architect_judge.js
 * Экспорт: module.exports = { judge }
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

// --- Пути -------------------------------------------------------------------
const JUDGE_DIR = __dirname;
const RACE_DIR = path.resolve(__dirname, '..'); // universes/architect_race
const ROOT = path.resolve(__dirname, '..', '..', '..'); // корень проекта
const REPORT_PATH = path.join(JUDGE_DIR, 'REPORT.md');

// --- Конкурсанты ------------------------------------------------------------
const CONTESTANTS = [
  {
    id: 'cmd_a_formalist',
    dir: 'cmd_a_formalist',
    label: 'A — Формалист',
    gist: 'строгие правила, схемы, формальные инварианты',
  },
  {
    id: 'cmd_b_narrator',
    dir: 'cmd_b_narrator',
    label: 'B — Рассказчик',
    gist: 'повествование, метафоры, живой голос брата',
  },
  {
    id: 'cmd_c_constitutionalist',
    dir: 'cmd_c_constitutionalist',
    label: 'C — Конституционалист',
    gist: 'конституция, статьи, права и обязанности',
  },
  {
    id: 'cmd_d_minimalist',
    dir: 'cmd_d_minimalist',
    label: 'D — Минималист',
    gist: 'минимум правил, максимум ясности',
  },
  {
    id: 'cmd_e_totalist',
    dir: 'cmd_e_totalist',
    label: 'E — Тоталист',
    gist: 'всеобъемлющая система, полное покрытие',
  },
].map((c) => ({ ...c, file: path.join(RACE_DIR, c.dir, 'DNA.md') }));

// --- Метрики ----------------------------------------------------------------
const METRICS = [
  { key: 'completeness', name: 'Полнота', hint: 'покрытие тем корпуса' },
  { key: 'precision', name: 'Точность', hint: 'соответствие корпусу' },
  { key: 'actionability', name: 'Действенность', hint: 'по нему можно принимать решения' },
  { key: 'style', name: 'Стиль', hint: 'говорит как брат' },
];

// --- Темы корпуса (используются для эвристики Полноты) ---------------------
const CORPUS_THEMES = [
  { key: 'mission', desc: 'миссия/назначение', re: /(мисси|назначен|предназнач|цель|смысл)/i },
  { key: 'principles', desc: 'принципы/ценности', re: /(принцип|ценност|кредо|инвариант|манифест)/i },
  { key: 'roles', desc: 'роли/обязанности', re: /(роль|обязанност|ответственн|функци)/i },
  { key: 'boundaries', desc: 'границы/запреты', re: /(границ|запрет|нельзя|лимит|предел)/i },
  { key: 'decisions', desc: 'решения/приоритеты', re: /(решени|приоритет|дилемм|выбор|критери)/i },
  { key: 'protocols', desc: 'протоколы/процедуры', re: /(протокол|процедур|алгоритм|порядок|шаг)/i },
  { key: 'memory', desc: 'память/контекст', re: /(память|контекст|истори|опыт|след)/i },
  { key: 'communication', desc: 'общение/тон', re: /(говор|общени|тон|голос|стиль|язык)/i },
  { key: 'evolution', desc: 'развитие/эволюция', re: /(развит|эволюц|изменен|рост|учит)/i },
  { key: 'safety', desc: 'безопасность/риски', re: /(безопасн|риск|осторожн|защит)/i },
];

// --- Маркеры «братского» стиля (для метрики Стиль) --------------------------
const BROTHER_MARKERS = [
  /(брат|сестр)/i,
  /\bмы\b/i,
  /\bя\b/i,
  /(честно|искренне|по-человечески)/i,
  /(давай|давайте|смотри)/i,
  /(без воды|по существу|живо)/i,
];

// --- Маркеры действенности (для метрики Действенность) ----------------------
const ACTION_MARKERS = [
  /(если .* то)/i,
  /(когда .* тогда)/i,
  /(поэтому|значит|следовательно|итого)/i,
  /(делай|делаем|выбирай|выбираем|прими|принимай)/i,
  /(правило|шаг|чеклист|критерий|порог)/i,
  /^\s*\d+[.)]\s/m,
  /^\s*[-*]\s/m,
];

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
}

function clamp(n, lo = 0, hi = 10) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function countMatches(text, regexes) {
  let n = 0;
  for (const re of regexes) {
    const m = text.match(re);
    if (m) n += m.length;
  }
  return n;
}

function loadDNA() {
  return CONTESTANTS.map((c) => {
    const raw = safeRead(c.file);
    return {
      ...c,
      exists: raw !== null,
      text: raw || '',
      lines: raw ? raw.split('\n').length : 0,
      chars: raw ? raw.length : 0,
      words: raw ? tokens(raw).length : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Эвристический скоринг (fallback, детерминированный)
// ---------------------------------------------------------------------------

function heuristicScore(dna) {
  const text = dna.text || '';

  // 1) Полнота — доля покрытых тем корпуса + нормировка на объём.
  const covered = CORPUS_THEMES.filter((t) => t.re.test(text)).length;
  const themeRatio = covered / CORPUS_THEMES.length;
  const lengthBonus = Math.min(1, dna.words / 800) * 0.25;
  const completeness = clamp(themeRatio * 9 + lengthBonus * 4);

  // 2) Точность — плотность терминов, структура, отсутствие «воды».
  const headings = (text.match(/^#{1,6}\s/gm) || []).length;
  const codeish = (text.match(/`[^`]+`/g) || []).length;
  const structure = Math.min(1, (headings + codeish) / 20);
  const lexicalDensity = dna.words > 0 ? 1 : 0;
  const precision = clamp(structuredRate(text) * 6 + structure * 3 + lexicalDensity);

  // 3) Действенность — наличие решающих конструкций, списков, правил.
  const actionHits = countMatches(text, ACTION_MARKERS);
  const bulletLines = (text.match(/^\s*(?:[-*]|\d+[.)])\s/mg) || []).length;
  const actionability = clamp(Math.min(1, actionHits / 12) * 6 + Math.min(1, bulletLines / 25) * 4);

  // 4) Стиль — «братские» маркеры против казёнщины.
  const brotherHits = countMatches(text, BROTHER_MARKERS);
  const secondPerson = (text.match(/\b(ты|тебя|твой|вы|ваш)\b/gi) || []).length;
  const styleRaw = Math.min(1, brotherHits / 8) * 6 + Math.min(1, secondPerson / 15) * 4;
  const style = clamp(styleRaw);

  return {
    completeness: round1(completeness),
    precision: round1(precision),
    actionability: round1(actionability),
    style: round1(style),
  };
}

function structuredRate(text) {
  if (!text) return 0;
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (!lines.length) return 0;
  const structured = lines.filter((l) => /^\s*(?:#{1,6}\s|[-*]\s|\d+[.)]\s|>|[A-ZА-Я].*:)/.test(l)).length;
  return structured / lines.length;
}

// ---------------------------------------------------------------------------
// LLM-скоринг
// ---------------------------------------------------------------------------

function tryLoadLLM() {
  const candidates = [
    path.join(ROOT, 'llm_client.js'),
    '/home/ishidin/phoenix/llm_client.js',
  ];
  for (const p of candidates) {
    try {
      // eslint-disable-next-line global-require
      const mod = require(p);
      if (mod && typeof mod.askDeepSeekChat === 'function') return mod;
    } catch (e) {
      /* пробуем следующий путь */
    }
  }
  return null;
}

function buildJudgePrompt(dna, allDna) {
  const themes = CORPUS_THEMES.map((t) => `- ${t.key}: ${t.desc}`).join('\n');
  const roster = allDna
    .map((d) => `  · ${d.label} (${d.dir}): ${d.words} слов`)
    .join('\n');

  return [
    'Ты — LLM-судья гонки ДНК Архитектора. Оцениваешь ОДНУ версию ДНК.',
    '',
    'Контекст гонки (для калибровки):',
    roster,
    '',
    'Темы корпуса, которые должна покрывать ДНК:',
    themes,
    '',
    'Оцени версию по 4 метрикам, каждая 0-10 (допустимы десятые):',
    '1) completeness  — Полнота: покрытие тем корпуса.',
    '2) precision     — Точность: соответствие корпусу, отсутствие выдумок.',
    '3) actionability — Действенность: по ДНК можно принимать решения.',
    '4) style         — Стиль: говорит как брат, живо и по-человечески.',
    '',
    'Верни СТРОГО один JSON-объект без пояснений:',
    '{"completeness":N,"precision":N,"actionability":N,"style":N,"verdict":"1-2 фразы"}',
    '',
    '--- ДНК: ' + dna.label + ' (' + dna.dir + ') ---',
    dna.text.slice(0, 12000),
  ].join('\n');
}

function parseLLMJson(content) {
  if (!content) return null;
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(content.slice(start, end + 1));
    const out = {
      completeness: round1(clamp(Number(obj.completeness))),
      precision: round1(clamp(Number(obj.precision))),
      actionability: round1(clamp(Number(obj.actionability))),
      style: round1(clamp(Number(obj.style))),
      verdict: typeof obj.verdict === 'string' ? obj.verdict.trim() : '',
    };
    return out;
  } catch (e) {
    return null;
  }
}

async function llmScore(llm, dna, allDna) {
  const system =
    'Ты строгий, но справедливый судья. Отвечаешь только валидным JSON. ' +
    'Оцениваешь ДНК агента по 4 метрикам 0-10.';
  const user = buildJudgePrompt(dna, allDna);
  const content = await llm.askDeepSeekChat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    900
  );
  const parsed = parseLLMJson(content);
  if (!parsed) throw new Error('LLM вернул невалидный JSON');
  return parsed;
}

// ---------------------------------------------------------------------------
// Агрегация и отчёт
// ---------------------------------------------------------------------------

function scoreDNA(dna, scores, source) {
  const total = METRICS.reduce((acc, m) => acc + (Number(scores[m.key]) || 0), 0);
  const avg = round1(total / METRICS.length);
  return {
    id: dna.id,
    dir: dna.dir,
    label: dna.label,
    gist: dna.gist,
    file: dna.file,
    exists: dna.exists,
    words: dna.words,
    lines: dna.lines,
    scores,
    total: round1(total),
    avg,
    source, // 'llm' | 'heuristic'
    verdict: scores.verdict || '',
  };
}

function rank(scores) {
  return [...scores].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
}

function buildRecommendation(ranked) {
  const top = ranked.slice(0, 2);
  const rest = ranked.slice(2);
  const reasons = top.map((t) => {
    const best = METRICS.slice().sort((a, b) => t.scores[b.key] - t.scores[a.key])[0];
    return `${t.label} — сумма ${t.total}/40, сильнейшая метрика «${best.name}» (${t.scores[best.key]}/10).`;
  });
  return {
    top2: top.map((t) => t.id),
    ranked: ranked.map((r) => r.id),
    summary: reasons,
    note:
      'Рекомендуется слить сильнейшие качества двух лидеров: структуру и ' +
      'точность от формального лидера, голос и действенность от второго.',
  };
}

function markdownTable(ranked) {
  const header =
    '| # | Версия | Полнота | Точность | Действенность | Стиль | Сумма | Источник |';
  const sep = '|---|--------|:-------:|:--------:|:-------------:|:-----:|:-----:|:--------:|';
  const rows = ranked.map((r, i) => {
    const s = r.scores;
    return (
      `| ${i + 1} | ${r.label} \`${r.dir}\` | ${s.completeness} | ${s.precision} | ` +
      `${s.actionability} | ${s.style} | ${r.total}/40 | ${r.source} |`
    );
  });
  return [header, sep, ...rows].join('\n');
}

function buildReport(ranked, meta) {
  const lines = [];
  lines.push('# Отчёт LLM-судьи: гонка ДНК Архитектора');
  lines.push('');
  lines.push(`- Сгенерировано: ${meta.timestamp}`);
  lines.push(`- Версий оценено: ${ranked.length}`);
  lines.push(`- Режим: ${meta.mode}`);
  lines.push(`- Метрики (0-10): Полнота · Точность · Действенность · Стиль`);
  lines.push('');
  lines.push('## Таблица оценок');
  lines.push('');
  lines.push(markdownTable(ranked));
  lines.push('');
  lines.push('## Рекомендация топ-2');
  lines.push('');
  for (const s of meta.recommendation.summary) lines.push(`- ${s}`);
  lines.push('');
  lines.push('> ' + meta.recommendation.note);
  lines.push('');
  lines.push('## Детали по версиям');
  lines.push('');
  for (const r of ranked) {
    lines.push(`### ${r.label} (\`${r.dir}\`)`);
    lines.push('');
    lines.push(
      `- Файл: \`${path.relative(ROOT, r.file)}\` ${r.exists ? '' : '— **НЕ НАЙДЕН**'}`
    );
    lines.push(`- Объём: ${r.words} слов, ${r.lines} строк`);
    lines.push(
      `- Оценки: полнота ${r.scores.completeness}, точность ${r.scores.precision}, ` +
        `действенность ${r.scores.actionability}, стиль ${r.scores.style}`
    );
    lines.push(`- Итог: **${r.total}/40** (avg ${r.avg})`);
    if (r.verdict) lines.push(`- Вердикт судьи: ${r.verdict}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push(`_Сгенерировано architect_judge.js в режиме «${meta.mode}»._`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Публичный API
// ---------------------------------------------------------------------------

/**
 * Прогоняет судейство по 5 версиям ДНК.
 * @param {Object} [opts]
 * @param {boolean} [opts.forceHeuristic=false] — не звать LLM.
 * @param {boolean} [opts.writeReport=true]     — писать REPORT.md.
 * @returns {Promise<{scores: Object[], recommendations: Object, report: string, mode: string}>}
 */
async function judge(opts = {}) {
  const options = { forceHeuristic: false, writeReport: true, ...opts };
  const allDna = loadDNA();

  const llm = options.forceHeuristic ? null : tryLoadLLM();
  if (llm) {
    try {
      // Пробное обращение, чтобы понять доступность LLM.
      await llm.askDeepSeekChat(
        [{ role: 'user', content: 'ping' }],
        5
      );
    } catch (e) {
      // Не удалось — переходим в эвристику ниже.
      // eslint-disable-next-line no-param-reassign
      options.forceHeuristic = true;
    }
  }

  const useLLM = llm && !options.forceHeuristic;
  const scores = [];

  for (const dna of allDna) {
    let record;
    if (useLLM) {
      try {
        const s = await llmScore(llm, dna, allDna);
        record = scoreDNA(dna, s, 'llm');
      } catch (e) {
        record = scoreDNA(dna, heuristicScore(dna), 'heuristic');
      }
    } else {
      record = scoreDNA(dna, heuristicScore(dna), 'heuristic');
    }
    scores.push(record);
  }

  const ranked = rank(scores);
  const recommendation = buildRecommendation(ranked);
  const mode =
    useLLM && scores.every((s) => s.source === 'llm') ? 'LLM' : 'heuristic';
  const meta = {
    timestamp: new Date().toISOString(),
    mode,
    recommendation,
  };

  const report = buildReport(ranked, meta);
  if (options.writeReport) {
    fs.writeFileSync(REPORT_PATH, report, 'utf8');
  }

  return { scores: ranked, recommendations: recommendation, report, mode };
}

module.exports = { judge };

// --- CLI --------------------------------------------------------------------
if (require.main === module) {
  judge()
    .then((res) => {
      const head = res.scores
        .map((s) => `${s.label}: ${s.total}/40`)
        .join(' | ');
      // eslint-disable-next-line no-console
      console.log('[architect_judge] режим:', res.mode);
      // eslint-disable-next-line no-console
      console.log('[architect_judge]', head);
      // eslint-disable-next-line no-console
      console.log('[architect_judge] топ-2:', res.recommendations.top2.join(', '));
      // eslint-disable-next-line no-console
      console.log('[architect_judge] отчёт:', REPORT_PATH);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[architect_judge] ошибка:', err && err.message);
      process.exitCode = 1;
    });
}
