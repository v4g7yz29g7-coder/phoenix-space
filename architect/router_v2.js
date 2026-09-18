// architect/router_v2.js — Двухосевой DAS
// Ось 1: режим (engineer/philosopher/healer/crisis/strategist)
// Ось 2: ДНК (tech/style/full)
'use strict';

const path = require('path');
const { selectMode } = require('./router');

// === Матрица: режим → лучшая ДНК ===
const DNA_MATRIX = {
  engineer:    { primary: 'full',  fallback: ['tech', 'style'] },
  philosopher: { primary: 'full',  fallback: ['tech', 'style'] },
  healer:      { primary: 'style', fallback: ['full', 'tech'] },  // style тёплый
  crisis:      { primary: 'style', fallback: ['full', 'tech'] },  // style быстрый
  strategist:  { primary: 'full',  fallback: ['tech', 'style'] },
};

// === Уточнения по подтипам (из суда) ===
const REFINEMENTS = [
  { when: (text) => /шаблон|копируем|готовый|скопиро/i.test(text),
    force_dna: 'tech',  reason: 'нужен копируемый шаблон' },
  { when: (text) => /команд|проверк|curl|ожидаем/i.test(text),
    force_dna: 'style', reason: 'нужны команды с проверкой' },
];

function selectDna(mode, text) {
  // 1. Уточнения
  for (const r of REFINEMENTS) {
    if (r.when(text)) {
      return { dna: r.force_dna, source: 'refinement', reason: r.reason };
    }
  }
  // 2. Матрица
  const m = DNA_MATRIX[mode];
  if (m) return { dna: m.primary, source: 'matrix', fallback: m.fallback };
  // 3. Дефолт
  return { dna: 'full', source: 'default' };
}

function route(text, opts = {}) {
  const modeResult = selectMode({ ...opts, text });
  const dnaResult = selectDna(modeResult.mode, text);
  return {
    mode: modeResult.mode,
    dna: dnaResult.dna,
    dna_source: dnaResult.source,
    reasons: modeResult.reasons,
    dna_reason: dnaResult.reason,
  };
}

// === Пути к ДНК ===
const ROOT = path.join(__dirname, '..');
const DNA_PATHS = {
  tech:  path.join(ROOT, 'prompts', 'architect_dna_v4.md'),
  style: path.join(ROOT, 'prompts', 'architect_dna_v4_style.md'),
  full:  path.join(ROOT, 'prompts', 'architect_dna_v4_full.md'),
};

function dnaPath(dna) {
  return DNA_PATHS[dna] || DNA_PATHS.full;
}

module.exports = { route, dnaPath, DNA_MATRIX, REFINEMENTS };

// === CLI тест ===
if (require.main === module) {
  const cases = [
    'Как поставить задачу с критерием готовности?',
    'Дай готовый копируемый шаблон JWT',
    'Нужны команды с проверкой curl',
    'Устал... слепок',
    '!!! ВСЁ УПАЛО !!!',
    'Стратегия на год',
  ];
  for (const t of cases) {
    const r = route(t);
    console.log(`[${r.mode.padEnd(11)} × ${r.dna.padEnd(5)}] ${t.slice(0, 50)}`);
    console.log(`   → источник DNA: ${r.dna_source}${r.dna_reason ? ' (' + r.dna_reason + ')' : ''}`);
  }
}
