// architect/router_v4.js — Восьмиосевой DAS
// Ось 1: режим      (engineer/philosopher/healer/crisis/strategist)
// Ось 2: ДНК        (tech/style/full)
// Ось 3: язык       (ru/en/code)
// Ось 4: длина      (brief/normal/full)
// Ось 5: итератив   (oneshot/iterative/normal)
// Ось 6: верифик.   (code/brother/metric)
// Ось 7: творчество (conventional/hybrid/experimental)
// Ось 8: команда    (solo/pair/team)
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
  { when: (t) => /шаблон|копируем|готовый|скопиро/i.test(t), force: 'tech', reason: 'нужен копируемый шаблон' },
  { when: (t) => /команд|проверк|curl|ожидаем/i.test(t), force: 'style', reason: 'нужны команды с проверкой' },
];
function selectDna(mode, text) {
  for (const r of DNA_REFINEMENTS) if (r.when(text)) return { dna: r.force, source: 'refinement', reason: r.reason };
  const m = DNA_MATRIX[mode];
  if (m) return { dna: m.primary, source: 'matrix' };
  return { dna: 'full', source: 'default' };
}

// ============ ОСЬ 3: ЯЗЫК ============
function selectLang(text) {
  const cyr = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
  const lat = (text.match(/[a-zA-Z]/g) || []).length;
  const code = (text.match(/```|\$\s|=>|function\s|const\s|npm\s|git\s|curl\s/g) || []).length;
  if (code >= 3) return { lang: 'code', source: 'code_markers' };
  if (lat > cyr * 2 && lat > 20) return { lang: 'en', source: 'latin_dominant' };
  return { lang: 'ru', source: 'default' };
}

// ============ ОСЬ 4: ДЛИНА ============
function selectLength(text) {
  if (/(кратко|короче|1 строк|одной строк|минимум|телеграф|без воды|tl;dr)/i.test(text))
    return { length: 'brief', source: 'brief_marker' };
  if (/(полно|картин\w+ целиком|до последней детали|без заглушек|подробно|развёрнуто|исчерпывающ)/i.test(text))
    return { length: 'full', source: 'full_marker' };
  if (/(важно видеть|мне важно|дай всё|тотально|энциклопеди)/i.test(text))
    return { length: 'full', source: 'importance_marker' };
  return { length: 'normal', source: 'default' };
}

// ============ ОСЬ 5: ИТЕРАТИВНОСТЬ ============
function selectIter(text) {
  if (/(давай обсудим|разберём|поговорим|порассужда|подумай|что думаешь|как тебе|интересно|продолжай)/i.test(text))
    return { iter: 'iterative', source: 'dialogue_marker' };
  if (/(финал|окончательн|итоговое решение|закрывай|финальное)/i.test(text))
    return { iter: 'oneshot', source: 'final_marker' };
  return { iter: 'normal', source: 'default' };
}

// ============ ОСЬ 6: ВЕРИФИКАЦИЯ ============
function selectVerify(text) {
  if (/(пришли вывод|покажи команду|дословно|exit\s*code|node --check|curl|лог)/i.test(text))
    return { verify: 'code', source: 'explicit_code' };
  if (/(метрик|число|порог|%|ratio|score)/i.test(text))
    return { verify: 'metric', source: 'metric_marker' };
  if (/(на твоё усмотрение|как считаешь|решай сам|брат решит)/i.test(text))
    return { verify: 'brother', source: 'brother_delegation' };
  return { verify: 'code', source: 'default' };
}

// ============ ОСЬ 7: ТВОРЧЕСТВО ============
function selectCreativity(text) {
  if (/(новое|экспериментальн|прорывн|инновацион|мультивселенн|не как у всех|диверсант|хаос|прорыв)/i.test(text))
    return { creativity: 'experimental', source: 'experimental_marker' };
  if (/(проверенн|классическ|стандартн|как у всех|надёжн|безопасн|копируем)/i.test(text))
    return { creativity: 'conventional', source: 'conventional_marker' };
  if (/(изучив опыт|свой путь|адаптируй|гибрид|синтез|смешай)/i.test(text))
    return { creativity: 'hybrid', source: 'hybrid_marker' };
  return { creativity: 'hybrid', source: 'default' };
}

// ============ ОСЬ 8: КОМАНДА ============
function selectTeam(text) {
  if (/(командой|коллектив|роем|собери группу|5 экспертов|3 агента|биолог|химик|дендролог|миколог)/i.test(text))
    return { team: 'team', source: 'team_marker' };
  if (/(парой|вдвоём|2 агента|два голоса|напарник|peer)/i.test(text))
    return { team: 'pair', source: 'pair_marker' };
  if (/(сам|один|лично|только ты|без помощник)/i.test(text))
    return { team: 'solo', source: 'solo_marker' };
  return { team: 'solo', source: 'default' };
}

// ============ ГЛАВНЫЙ ROUTE ============
function route(text, opts = {}) {
  const modeResult = selectMode({ ...opts, text });
  const d = selectDna(modeResult.mode, text);
  const l = selectLang(text);
  const len = selectLength(text);
  const iter = selectIter(text);
  const ver = selectVerify(text);
  const cre = selectCreativity(text);
  const tm = selectTeam(text);

  return {
    mode: modeResult.mode, modeReasons: modeResult.reasons,
    dna: d.dna, dnaSource: d.source, dnaReason: d.reason,
    lang: l.lang, langSource: l.source,
    length: len.length, lengthSource: len.source,
    iter: iter.iter, iterSource: iter.source,
    verify: ver.verify, verifySource: ver.source,
    creativity: cre.creativity, creativitySource: cre.source,
    team: tm.team, teamSource: tm.source,
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

// ============ МОДИФИКАТОРЫ ============
function modifiers(r) {
  const lines = [];
  // Язык
  if (r.lang === 'en') lines.push('**Язык:** English.');
  else if (r.lang === 'code') lines.push('**Язык:** технический — код + минимум прозы.');
  else lines.push('**Язык:** русский, идентификаторы латиницей.');
  // Длина
  if (r.length === 'brief') lines.push('**Длина:** кратко. Один шаг. Без воды.');
  else if (r.length === 'full') lines.push('**Длина:** полно. Детали, примеры, таблицы.');
  else lines.push('**Длина:** сбалансированно.');
  // Итеративность
  if (r.iter === 'iterative') lines.push('**Формат:** оставь пространство для диалога. Заверши уточняющим вопросом.');
  else if (r.iter === 'oneshot') lines.push('**Формат:** финальный ответ. Без открытых вопросов.');
  // Верификация
  if (r.verify === 'code') lines.push('**Верификация:** каждое утверждение — с командой и ожидаемым выводом.');
  else if (r.verify === 'metric') lines.push('**Верификация:** каждое утверждение — с числом/порогом.');
  else if (r.verify === 'brother') lines.push('**Верификация:** на усмотрение Архитектора.');
  // Творчество
  if (r.creativity === 'experimental') lines.push('**Творчество:** экспериментально. Ищи нестандартное. Диверсант в помощь.');
  else if (r.creativity === 'conventional') lines.push('**Творчество:** проверенное. Стандартные паттерны, надёжность.');
  else lines.push('**Творчество:** гибрид. Проверенное + своя адаптация.');
  // Команда
  if (r.team === 'team') lines.push('**Команда:** собери роли (Биолог/Химик/Дендролог/Миколог). Мысли как институт.');
  else if (r.team === 'pair') lines.push('**Команда:** 2 голоса. Один быстрый + один вдумчивый.');
  else lines.push('**Команда:** solo. Один голос Архитектора.');
  return lines.join('\n');
}

module.exports = { route, dnaPath, modifiers };

// ============ CLI ТЕСТ ============
if (require.main === module) {
  const cases = [
    'как поставить задачу с критерием готовности?',
    'дай проверенный шаблон JWT',
    'придумай мультивселенную по-новому',
    'собери команду: биолог + химик + дендролог',
    'вдвоём обсудим архитектуру',
    'сам реши, что делать',
    '!!! ВСЁ УПАЛО !!!',
  ];
  for (const t of cases) {
    const r = route(t);
    console.log(`[${r.mode.padEnd(11)}|${r.dna.padEnd(5)}|${r.lang.padEnd(4)}|${r.length.padEnd(6)}|${r.iter.padEnd(9)}|${r.verify.padEnd(7)}|${r.creativity.padEnd(12)}|${r.team.padEnd(4)}] ${t.slice(0, 42)}`);
  }
}
