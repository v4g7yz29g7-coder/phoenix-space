// architect/router.js — DAS (Dual Axis Steering) для Архитектора
// Читает контекст сообщения → выбирает режим.
// Режимы: engineer | strategist | philosopher | healer | crisis
'use strict';

const fs = require('fs');
const path = require('path');

const MODES_DIR = path.join(__dirname, 'modes');

const MODES = {
  engineer:    { file: 'engineer.md',    label: '🔧 Инженер' },
  strategist:  { file: 'strategist.md',  label: '🎯 Стратег' },
  philosopher: { file: 'philosopher.md', label: '🌀 Философ' },
  healer:      { file: 'healer.md',      label: '🌙 Поддержка' },
  crisis:      { file: 'crisis.md',      label: '🔥 Кризис' },
};

// === МАРКЕРЫ (из v3 §3) ===
const MARKERS = {
  tired: [
    /(устал|устала|сил нет|выдохся)/i,
    /\.{3,}/,
    /(спать|отдохнуть|передохнуть)/i,
    /брат[,!]?\s+(восстанови|сделай слепок|найди контекст)/i,
  ],
  angry: [
    /!{3,}/,
    /[А-ЯA-Z]{6,}/,
    /(сколько можно|почему не|опять|задрал)/i,
    /(блин|чёрт|хрен|капец)/i,
  ],
  flow: [
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    /(наша теория|мы строим|представь что ты)/i,
    /(гениальн|мощно|получилось|вот это|огонь)/i,
  ],
  philosophical: [
    /(смысл|микро|макро|мультивселенн|сознани|дух|ИРПС|эволюц|философ|космос|пустот|вселенн)/i,
    /(зачем|почему мы|что если)/i,
    /(теори|парадигм|сознани|душ)/i,
    /представь\s+что\s+ты/i,
    /(миссия|призвание|высшая цель)/i,
  ],
  complex: [
    /(архитектур|стратег|план|дизайн|схем|дорожн\w+\s+карт)/i,
    /(на будущее|на годы|на год|на месяцы)/i,
    /(мультивселенн|институт|биосфер|экосистем)/i,
  ],
};

function countHits(text, patterns) {
  let n = 0;
  for (const re of patterns) {
    if (re.test(text)) n++;
  }
  return n;
}

// === ОСНОВНАЯ ФУНКЦИЯ ===
function selectMode(context) {
  const text = (context && context.text) || '';
  const errorRate = context && typeof context.errorRate === 'number' ? context.errorRate : 0;
  const taskComplexity = context && typeof context.taskComplexity === 'number' ? context.taskComplexity : 0;
  const timeOfDay = context && context.timeOfDay; // 'morning' | 'day' | 'evening' | 'night'

  const hits = {
    tired:        countHits(text, MARKERS.tired),
    angry:        countHits(text, MARKERS.angry),
    flow:         countHits(text, MARKERS.flow),
    philosophical:countHits(text, MARKERS.philosophical),
    complex:      countHits(text, MARKERS.complex),
  };

  const reasons = [];
  const tripleBang = /!{3,}/.test(text);
  const capsBurst = /[А-ЯA-Z]{6,}/.test(text);

  // 1. КРИЗИС — приоритет №1
  if (errorRate > 0.3) {
    reasons.push(`errorRate=${errorRate.toFixed(2)} > 0.3`);
    return { mode: 'crisis', hits, reasons };
  }
  if (tripleBang && (hits.angry >= 1 || capsBurst)) {
    reasons.push(`triple bang + angry/caps`);
    return { mode: 'crisis', hits, reasons };
  }
  if (hits.angry >= 2) {
    reasons.push(`angry markers: ${hits.angry}`);
    return { mode: 'crisis', hits, reasons };
  }

  // 2. ПОДДЕРЖКА — приоритет №2
  if (hits.tired >= 2 || (timeOfDay === 'night' && hits.tired >= 1)) {
    reasons.push(`tired markers: ${hits.tired}${timeOfDay === 'night' ? ' + night' : ''}`);
    return { mode: 'healer', hits, reasons };
  }

  // 3. ФИЛОСОФ — приоритет №3 (philosophical или сильный flow)
  if (hits.philosophical >= 2 || (hits.flow >= 2 && hits.philosophical >= 1) || hits.flow >= 3) {
    reasons.push(`philosophical: ${hits.philosophical}, flow: ${hits.flow}`);
    return { mode: 'philosopher', hits, reasons };
  }

  // 4. СТРАТЕГ — приоритет №4
  if (taskComplexity > 7 || hits.complex >= 2) {
    reasons.push(`complex: ${hits.complex}, complexity=${taskComplexity}`);
    return { mode: 'strategist', hits, reasons };
  }

  // 5. ИНЖЕНЕР — по умолчанию
  reasons.push('default');
  return { mode: 'engineer', hits, reasons };
}

function loadMode(modeName) {
  const m = MODES[modeName];
  if (!m) throw new Error('unknown mode: ' + modeName);
  const file = path.join(MODES_DIR, m.file);
  if (!fs.existsSync(file)) throw new Error('mode file not found: ' + file);
  return { name: modeName, label: m.label, prompt: fs.readFileSync(file, 'utf8') };
}

module.exports = { selectMode, loadMode, MODES, MARKERS };
