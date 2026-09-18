// replay/task_synthesizer.js — Модуль синтеза задач Архитектора из паттернов.
//
// Выделен из replay_worker.js, чтобы генерацию задач можно было переиспользовать
// и тестировать отдельно от ночного прогона.
//
// API:
//   synthesize(patterns, n = 5) -> Array<{id, group, file, min_lines, prompt, status}>
//
// Гарантии:
//   * в результате ровно n задач (n по умолчанию 5);
//   * id уникальны в пределах вызова (и коллизионно-устойчивы между вызовами);
//   * group всегда 'replay_worker', status всегда 'pending';
//   * каждый prompt содержит маркер 'КРИТЕРИЙ:'.
//   * частичные/битые patterns не приводят к падению.
//
// КРИТЕРИЙ: node --check OK; synthesize({avgScore:8.62, topSequences:[]}, 5)
//           возвращает ровно 5 задач с уникальными id.
'use strict';

const GROUP = 'replay_worker';
const DEFAULT_N = 5;
const DEFAULT_SEQ = 'старт -> сдача';

// Глобальный счётчик — страхует от совпадения id при вызовах в одну и ту же мс.
let _seqCounter = 0;

function makeStamp() {
  _seqCounter = (_seqCounter + 1) % 0xffffff;
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xffffff).toString(36);
  const c = _seqCounter.toString(36);
  return `${t}${c}${r}`;
}

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// Нормализует произвольные (в т.ч. частичные) patterns в стабильный контекст.
function buildContext(patterns) {
  const p = patterns && typeof patterns === 'object' ? patterns : {};

  const actions = Array.isArray(p.actions) ? p.actions : [];
  const topSequences = Array.isArray(p.topSequences) ? p.topSequences : [];

  let avgScore = num(p.avgScore, null);
  if (avgScore == null && actions.length) {
    const s = actions.reduce((acc, a) => acc + num(a && a.avgScore, 0), 0);
    avgScore = +(s / actions.length).toFixed(2);
  }
  if (avgScore == null) avgScore = 0;

  const trajectories = num(p.trajectories, actions.length);

  const successRate = num(p.successRate, null);

  const first = topSequences[0];
  const seq =
    (first && (first.seq || first.sequence || first.name)) ||
    (typeof p.topSequence === 'string' ? p.topSequence : DEFAULT_SEQ);

  const slow = p.slowestAction
    ? `${p.slowestAction.action || 'unknown'} (${num(p.slowestAction.avgMs, '?')}ms)`
    : '—';

  return { avgScore, trajectories, successRate, seq, slow, actions };
}

// 5 базовых шаблонов. Каждый возвращает {file, min_lines, prompt}.
// variant > 0 — повтор шаблона при n > 5: делаем задачу отличимой.
const TEMPLATES = [
  function replayReport(ctx, variant) {
    const extra = variant ? ` (итерация ${variant + 1})` : '';
    return {
      file: variant ? `tools/replay_report_${variant + 1}.js` : 'tools/replay_report.js',
      min_lines: 120,
      prompt:
        `CLI-отчёт по реплею траекторий${extra}. Читает memory/replay_worker_report.json ` +
        `(сейчас ${ctx.trajectories} траекторий, avgScore ${ctx.avgScore}). ` +
        `Печатает агрегат {trajectories, avg_score, success_rate, ` +
        `top_actions:[{action,count,avgScore}], top_sequence}. Поддержать флаги --last и --json. ` +
        `Топ-последовательность на данных: "${ctx.seq}". ` +
        `КРИТЕРИЙ: node --check OK; node tools/replay_report.js --last печатает валидный JSON ` +
        `с полем trajectories > 0.`,
    };
  },
  function patternMiner(ctx, variant) {
    const extra = variant ? ` (расширение ${variant + 1})` : '';
    return {
      file: variant ? `replay/pattern_miner_${variant + 1}.js` : 'replay/pattern_miner.js',
      min_lines: 150,
      prompt:
        `Вынеси извлечение паттернов из replay_worker.js в переиспользуемый модуль ` +
        `replay/pattern_miner.js${extra}. API: mine(dirOrFiles) -> ` +
        `{trajectories, avgScore, successRate, actions, topSequences}. ` +
        `Битые/пустые файлы игнорировать без падения. Самый медленный шаг в данных: ${ctx.slow}. ` +
        `КРИТЕРИЙ: node --check OK; ` +
        `require('./replay/pattern_miner').mine('memory/trajectories') возвращает объект, ` +
        `где Array.isArray(actions) === true и actions.length > 0.`,
    };
  },
  function contractTests(ctx, variant) {
    const extra = variant ? ` (набор ${variant + 1})` : '';
    return {
      file: variant ? `test/replay_worker.${variant + 1}.test.js` : 'test/replay_worker.test.js',
      min_lines: 150,
      prompt:
        `Контрактные тесты replay_worker${extra}: ранжирование top-N по score (невозрастание), ` +
        `извлечение паттернов на синтетических траекториях, синтез ровно 5 задач с уникальными id. ` +
        `КРИТЕРИЙ: node --check OK; тест ассертит rankTrajectories(100).length <= 100, ` +
        `extractPatterns([...]).actions.length > 0 и synthesizeTasks(patterns).length === 5.`,
    };
  },
  function taskSynthesizer(ctx, variant) {
    const extra = variant ? ` (вариант ${variant + 1})` : '';
    return {
      file: variant ? `replay/task_synthesizer_${variant + 1}.js` : 'replay/task_synthesizer.js',
      min_lines: 130,
      prompt:
        `Модуль синтеза задач Архитектора из паттернов${extra}. API: ` +
        `synthesize(patterns, n=5) -> массив ` +
        `{id, group:'replay_worker', file, min_lines, prompt, status:'pending'}. ` +
        `Уникальные id, каждый prompt содержит 'КРИТЕРИЙ:'. ` +
        `КРИТЕРИЙ: node --check OK; synthesize({avgScore:${ctx.avgScore}, topSequences:[]}, 5) ` +
        `даёт ровно 5 уникальных id.`,
    };
  },
  function cronCheck(ctx, variant) {
    const extra = variant ? ` (проверка ${variant + 1})` : '';
    return {
      file: variant ? `tools/replay_cron_check_${variant + 1}.js` : 'tools/replay_cron_check.js',
      min_lines: 100,
      prompt:
        `Проверка расписания реплея${extra}: pm2-процесс replay_worker online + ` +
        `cron-строка '0 2 * * *' запускает replay_worker.js --once. ` +
        `Читает crontab и ecosystem/pm2, печатает JSON {pm2:bool, cron:bool, state_last}. ` +
        `Дневной guard держит state в memory/replay_worker_state.json. ` +
        `КРИТЕРИЙ: node --check OK; запуск печатает JSON с полями pm2, cron, state_last.`,
    };
  },
];

function ensureCriterion(prompt) {
  const s = String(prompt == null ? '' : prompt);
  return s.includes('КРИТЕРИЙ:') ? s : `${s} КРИТЕРИЙ: node --check OK.`;
}

/**
 * Синтезирует задачи Архитектора из паттернов реплея.
 * @param {object} patterns — {avgScore, trajectories, successRate, topSequences, actions, slowestAction}
 * @param {number} [n=5] — сколько задач вернуть.
 * @returns {Array<{id:string, group:string, file:string, min_lines:number, prompt:string, status:string}>}
 */
function synthesize(patterns, n) {
  const ctx = buildContext(patterns);

  let count = num(n, DEFAULT_N);
  if (!Number.isInteger(count) || count < 0) count = DEFAULT_N;
  if (count === 0) return [];

  const stamp = makeStamp();
  const used = new Set();
  const tasks = [];

  for (let i = 0; i < count; i++) {
    const tplIndex = i % TEMPLATES.length;
    const variant = Math.floor(i / TEMPLATES.length);
    const spec = TEMPLATES[tplIndex](ctx, variant);

    let id = `RP-${stamp}-${tplIndex + 1}`;
    while (used.has(id)) id += 'x';
    used.add(id);

    tasks.push({
      id,
      group: GROUP,
      file: spec.file,
      min_lines: num(spec.min_lines, 100) || 100,
      prompt: ensureCriterion(spec.prompt),
      status: 'pending',
    });
  }

  return tasks;
}

module.exports = { synthesize };
module.exports.synthesize = synthesize;
module.exports.buildContext = buildContext;
module.exports.GROUP = GROUP;
