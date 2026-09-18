// architect/router_v3.js — Шестиосевой DAS
// Ось 1: режим    (engineer/philosopher/healer/crisis/strategist)
// Ось 2: ДНК      (tech/style/full)
// Ось 3: язык     (ru/en/code)
// Ось 4: длина    (brief/normal/full)
// Ось 5: итератив (oneshot/iterative)
// Ось 6: вериф.   (code/brother/metric)
'use strict';

const { selectMode } = require('./router');

// ============ ОСЬ 2: ДНК ============
const DNA_MATRIX = {
  engineer:    { primary: 'full',  fallback: ['tech', 'style'] },
  philosopher: { primary: 'full',  fallback: ['tech', 'style'] },
  healer:      { primary: 'style', fallback: ['full', 'tech'] },
  crisis:      { primary: 'style', fallback: ['full', 'tech'] },
  strategist:  { primary: 'full',  fallback: ['tech', 'style'] },
};

const DNA_REFINEMENTS = [
  { when: (t) => /шаблон|копируем|готовый|скопиро/i.test(t),
    force: 'tech', reason: 'нужен копируемый шаблон' },
  { when: (t) => /команд|проверк|curl|ожидаем/i.test(t),
    force: 'style', reason: 'нужны команды с проверкой' },
];

function selectDna(mode, text) {
  for (const r of DNA_REFINEMENTS) {
    if (r.when(text)) return { dna: r.force, source: 'refinement', reason: r.reason };
  }
  const m = DNA_MATRIX[mode];
  if (m) return { dna: m.primary, source: 'matrix', fallback: m.fallback };
  return { dna: 'full', source: 'default' };
}

// ============ ОСЬ 3: ЯЗЫК ============
function selectLang(text) {
  // EN — если больше латиницы чем кириллицы
  const cyr = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  const lat = (text.match(/[a-zA-Z]/g) || []).length;
  // Код — если есть блоки ```, много $, {} или ключевые слова
  const codeMarkers = (text.match(/```|\$\s|=>|function\s|const\s|npm\s|git\s|curl\s/g) || []).length;
  if (codeMarkers >= 3) return { lang: 'code', source: 'code_markers', markers: codeMarkers };
  if (lat > cyr * 2 && lat > 20) return { lang: 'en', source: 'latin_dominant' };
  return { lang: 'ru', source: 'default' };
}

// ============ ОСЬ 4: ДЛИНА ============
function selectLength(text) {
  if (/(кратко|короче|1 строк|одной строк|минимум|телеграф|без воды|tl;dr)/i.test(text)) {
    return { length: 'brief', source: 'brief_marker' };
  }
  if (/(полно|всё|картин\w+ целиком|до последней детали|без заглушек|подробно|развёрнуто|исчерпывающ)/i.test(text)) {
    return { length: 'full', source: 'full_marker' };
  }
  if (/(важно видеть|мне важно|дай всё|тотально|энциклопеди)/i.test(text)) {
    return { length: 'full', source: 'importance_marker' };
  }
  return { length: 'normal', source: 'default' };
}

// ============ ОСЬ 5: ИТЕРАТИВНОСТЬ ============
function selectIter(text) {
  if (/(давай обсудим|разберём|поговорим|порассужда|подумай|что думаешь|как тебе|интересно)/i.test(text)) {
    return { iter: 'iterative', source: 'dialogue_marker' };
  }
  if (/(финал|окончательн|итоговое решение|дай ответ|закрывай|финальное)/i.test(text)) {
    return { iter: 'oneshot', source: 'final_marker' };
  }
  if (/(продолжай|размышление|продолжай размышление)/i.test(text)) {
    return { iter: 'iterative', source: 'continue_marker' };
  }
  return { iter: 'normal', source: 'default' };
}

// ============ ОСЬ 6: ВЕРИФИКАЦИЯ ============
function selectVerify(text) {
  if (/(пришли вывод|покажи команду|дословно|exit\s*code|node --check|curl|лог)/i.test(text)) {
    return { verify: 'code', source: 'explicit_code' };
  }
  if (/(метрик|число|порог|%|ratio|score)/i.test(text)) {
    return { verify: 'metric', source: 'metric_marker' };
  }
  if (/(на твоё усмотрение|как считаешь|решай сам|брат решит)/i.test(text)) {
    return { verify: 'brother', source: 'brother_delegation' };
  }
  return { verify: 'code', source: 'default' };
}

// ============ ГЛАВНЫЙ ROUTE ============
function route(text, opts = {}) {
  const modeResult = selectMode({ ...opts, text });
  const dnaResult = selectDna(modeResult.mode, text);
  const langResult = selectLang(text);
  const lengthResult = selectLength(text);
  const iterResult = selectIter(text);
  const verifyResult = selectVerify(text);

  return {
    // Ось 1
    mode: modeResult.mode,
    modeReasons: modeResult.reasons,
    // Ось 2
    dna: dnaResult.dna,
    dnaSource: dnaResult.source,
    dnaReason: dnaResult.reason,
    // Ось 3
    lang: langResult.lang,
    langSource: langResult.source,
    // Ось 4
    length: lengthResult.length,
    lengthSource: lengthResult.source,
    // Ось 5
    iter: iterResult.iter,
    iterSource: iterResult.source,
    // Ось 6
    verify: verifyResult.verify,
    verifySource: verifyResult.source,
  };
}

// ============ ПУТИ К ДНК ============
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DNA_PATHS = {
  tech:  path.join(ROOT, 'prompts', 'architect_dna_v4.md'),
  style: path.join(ROOT, 'prompts', 'architect_dna_v4_style.md'),
  full:  path.join(ROOT, 'prompts', 'architect_dna_v4_full.md'),
};
function dnaPath(dna) { return DNA_PATHS[dna] || DNA_PATHS.full; }

// ============ МОДИФИКАТОРЫ ДЛЯ SYSTEM ============
function modifiers(routeResult) {
  const lines = [];
  // Язык
  if (routeResult.lang === 'en') lines.push('**Язык ответа:** английский (English).');
  else if (routeResult.lang === 'code') lines.push('**Язык ответа:** технический — код + минимум прозы.');
  else lines.push('**Язык ответа:** русский (основной), технические идентификаторы — латиницей.');
  // Длина
  if (routeResult.length === 'brief') lines.push('**Длина:** кратко. Один шаг. Без воды.');
  else if (routeResult.length === 'full') lines.push('**Длина:** полно. Все детали, примеры, таблицы.');
  else lines.push('**Длина:** сбалансированно — структура + ключевые детали.');
  // Итеративность
  if (routeResult.iter === 'iterative') lines.push('**Формат:** оставь пространство для диалога — заверши уточняющим вопросом или приглашением продолжить.');
  else if (routeResult.iter === 'oneshot') lines.push('**Формат:** дай финальный ответ и заверши. Без открытых вопросов.');
  // Верификация
  if (routeResult.verify === 'code') lines.push('**Верификация:** каждое утверждение — с командой и ожидаемым выводом.');
  else if (routeResult.verify === 'metric') lines.push('**Верификация:** каждое утверждение — с числом/порогом/единицей.');
  else if (routeResult.verify === 'brother') lines.push('**Верификация:** на усмотрение Архитектора. Доверяй его суждению.');
  return lines.join('\n');
}

module.exports = { route, dnaPath, modifiers, DNA_MATRIX, DNA_REFINEMENTS };

// ============ CLI ТЕСТ ============
if (require.main === module) {
  const cases = [
    'как поставить задачу с критерием готовности?',
    'дай готовый копируемый шаблон JWT',
    'кратко: что такое ИРПС?',
    'полно: картина целиком, без заглушек',
    'давай обсудим мультивселенную',
    'финальное решение по 5 мирам',
    'Брат, пришли вывод curl',
    'на твоё усмотрение',
    '!!! ВСЁ УПАЛО !!!',
  ];
  for (const t of cases) {
    const r = route(t);
    console.log(`[${r.mode.padEnd(11)}×${r.dna.padEnd(5)}×${r.lang.padEnd(4)}×${r.length.padEnd(6)}×${r.iter.padEnd(9)}×${r.verify.padEnd(7)}] ${t.slice(0, 45)}`);
  }
}
