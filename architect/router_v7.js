// architect/router_v7.js — Двенадцатиосевой DAS
// Ось 1: режим      (engineer/philosopher/healer/crisis/strategist)
// Ось 2: ДНК        (tech/style/full)
// Ось 3: язык       (ru/en/code)
// Ось 4: длина      (brief/normal/full)
// Ось 5: итератив   (oneshot/iterative/normal)
// Ось 6: верифик.   (code/brother/metric)
// Ось 7: творчество (conventional/hybrid/experimental)
// Ось 8: команда    (solo/pair/team)
// Ось 9: автономия  (auto/confirm/review)
// Ось 0: триггер    (alarm/tired/curiosity/deadline/flow/direction/neutral)
// Ось 10: темп      (fast/normal/careful)
// Ось 11: риск      (safe/balanced/aggressive)
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

// ============ ОСЬ 9: АВТОНОМИЯ ============
function selectAutonomy(text) {
  // review — самый строгий: план до действия
  if (/(покажи план|дай план|на утверждение|не трогай|только покажи|сначала план|без изменений)/i.test(text))
    return { autonomy: 'review', source: 'review_marker' };
  // confirm — предложи, дождись ответа
  if (/(как думаешь|предложи|что если|варианты|посоветуй|на выбор|или как)/i.test(text))
    return { autonomy: 'confirm', source: 'confirm_marker' };
  // auto — делай сам
  if (/(сделай|запусти|выполни|исправь|создай|применяй|действуй|без меня|сам реши|автономно)/i.test(text))
    return { autonomy: 'auto', source: 'auto_marker' };
  return { autonomy: 'confirm', source: 'default' };
}

// ============ ОСЬ 10: ТЕМП ============
function selectTempo(text) {
  if (/(черновик|MVP|быстро|пока|на глаз|не идеально|набросок|потом доделаем|по-быстрому|на живую)/i.test(text))
    return { tempo: 'fast', source: 'fast_marker' };
  if (/(тщательно|до конца|без спешки|аудит|исчерпывающ|разберись|глубоко|не спеши|полный разбор)/i.test(text))
    return { tempo: 'careful', source: 'careful_marker' };
  return { tempo: 'normal', source: 'default' };
}

// ============ ОСЬ 11: РИСК ============
function selectRisk(text) {
  if (/(не сломай|осторожно|бэкап|прод|production|важн|продакшн|живой сервер|не трогай боев)/i.test(text))
    return { risk: 'safe', source: 'safe_marker' };
  if (/(ломай|эксперимент|прорыв|не бойся|хаос|sandbox|песочниц|рискни|пробуй смело)/i.test(text))
    return { risk: 'aggressive', source: 'aggressive_marker' };
  return { risk: 'balanced', source: 'default' };
}

// ============ ОСЬ 0: ТРИГГЕР (мета-ось) ============
function selectTrigger(text, opts = {}) {
  // alarm — что-то сломалось
  if (/!{3,}|ПОЧЕМУ НЕ|ПОЧЕМУ ВСЁ|не работает|упал|красн\w+ флаг|авари/i.test(text))
    return { trigger: 'alarm', source: 'alarm_marker' };
  // tired — устал, нужна поддержка
  if (/(устал|сил нет|выдохся|спать|отдохнуть|ночь|поздно|много работы)/i.test(text))
    return { trigger: 'tired', source: 'tired_marker' };
  // deadline — срок горит
  if (/(срочно|дедлайн|горит|сегодня|успеть|быстрее|asap)/i.test(text))
    return { trigger: 'deadline', source: 'deadline_marker' };
  // flow — состояние потока, генерим
  if (/(поток|генерим|давай ещё|погнали|продолжай|мы строим|творим|🔥|🚀|🐦‍🔥)/u.test(text))
    return { trigger: 'flow', source: 'flow_marker' };
  // direction — куда идём
  if (/(стратегия|на год|на будущее|куда идти|видение|миссия|цель|дорожн\w+ карт)/i.test(text))
    return { trigger: 'direction', source: 'direction_marker' };
  // curiosity — исследуем
  if (/(интересно|как работает|почему|расскажи|изучи|исследуй|что такое|давай разберём)/i.test(text))
    return { trigger: 'curiosity', source: 'curiosity_marker' };
  return { trigger: 'neutral', source: 'default' };
}

// ============ ПРЕСЕТЫ ТРИГГЕРОВ ============
// Триггер задаёт базовые оси; остальные могут переопределить.
const TRIGGER_PRESETS = {
  alarm:     { mode: 'crisis',      length: 'brief',  iter: 'oneshot',   autonomy: 'auto',    creativity: 'conventional', tempo: 'fast',    risk: 'aggressive' },
  tired:     { mode: 'healer',      length: 'brief',  iter: 'normal',    autonomy: 'confirm', creativity: 'hybrid',       tempo: 'fast',    risk: 'safe' },
  deadline:  { mode: 'engineer',    length: 'brief',  iter: 'oneshot',   autonomy: 'auto',    creativity: 'conventional', tempo: 'fast',    risk: 'balanced' },
  flow:      { mode: 'philosopher', length: 'full',   iter: 'iterative', autonomy: 'auto',    creativity: 'experimental', tempo: 'normal',  risk: 'balanced' },
  direction: { mode: 'strategist',  length: 'full',   iter: 'iterative', autonomy: 'review',  creativity: 'hybrid',       tempo: 'careful', risk: 'safe' },
  curiosity: { mode: 'philosopher', length: 'normal', iter: 'iterative', autonomy: 'confirm', creativity: 'hybrid',       tempo: 'normal',  risk: 'balanced' },
  neutral:   {},
};

// ============ ГЛАВНЫЙ ROUTE ============
function route(text, opts = {}) {
  // 1) ТРИГГЕР — мета-ось, определяет пресет
  const tr = selectTrigger(text, opts);
  const preset = TRIGGER_PRESETS[tr.trigger] || {};

  // 2) Режим — приоритет: preset > selectMode
  let modeResult;
  if (preset.mode) {
    // Триггер навязывает режим (например, alarm → crisis)
    modeResult = { mode: preset.mode, reasons: ['trigger:' + tr.trigger] };
  } else {
    modeResult = selectMode({ ...opts, text });
  }

  // 3) Остальные оси (с fallback на пресет)
  const d = selectDna(modeResult.mode, text);
  const l = selectLang(text);
  const len = selectLength(text);
  const iter = selectIter(text);
  const ver = selectVerify(text);
  const cre = selectCreativity(text);
  const tm = selectTeam(text);
  const au = selectAutonomy(text);
  const tp = selectTempo(text);
  const rk = selectRisk(text);

  // 4) Пресет переопределяет, если ось не была явно задана в тексте
  const effLength = len.source === 'default' && preset.length ? preset.length : len.length;
  const effIter   = iter.source === 'default' && preset.iter ? preset.iter : iter.iter;
  const effCre    = cre.source === 'default' && preset.creativity ? preset.creativity : cre.creativity;
  const effAu     = au.source === 'default' && preset.autonomy ? preset.autonomy : au.autonomy;
  const effTempo  = tp.source === 'default' && preset.tempo ? preset.tempo : tp.tempo;
  const effRisk   = rk.source === 'default' && preset.risk ? preset.risk : rk.risk;

  return {
    trigger: tr.trigger, triggerSource: tr.source,
    mode: modeResult.mode, modeReasons: modeResult.reasons,
    dna: d.dna, dnaSource: d.source, dnaReason: d.reason,
    lang: l.lang, langSource: l.source,
    length: effLength, lengthSource: len.source === 'default' ? 'trigger' : len.source,
    iter: effIter, iterSource: iter.source === 'default' ? 'trigger' : iter.source,
    verify: ver.verify, verifySource: ver.source,
    creativity: effCre, creativitySource: cre.source === 'default' ? 'trigger' : cre.source,
    team: tm.team, teamSource: tm.source,
    autonomy: effAu, autonomySource: au.source === 'default' ? 'trigger' : au.source,
    tempo: effTempo, tempoSource: tp.source === 'default' ? 'trigger' : tp.source,
    risk: effRisk, riskSource: rk.source === 'default' ? 'trigger' : rk.source,
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
  // Триггер
  if (r.trigger && r.trigger !== 'neutral') {
    const trLabels = {
      alarm: '**Триггер:** alarm — что-то сломалось. Работай быстро, сухо, не гадай.',
      tired: '**Триггер:** tired — брат устал. Поддержи, восстанови контекст за него.',
      deadline: '**Триггер:** deadline — срок горит. Действуй, не спрашивай лишнего.',
      flow: '**Триггер:** flow — брат в потоке. Держи темп, глубину, не срезай.',
      direction: '**Триггер:** direction — куда идём. Думай стратегически, покажи форму.',
      curiosity: '**Триггер:** curiosity — исследуем. Разворачивай грани, оставляй диалог.',
    };
    if (trLabels[r.trigger]) lines.push(trLabels[r.trigger]);
  }
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
  // Автономия
  if (r.autonomy === 'auto') lines.push('**Автономия:** действуй сам. Дай результат + отчёт. Не дёргай брата без крайней нужды (Пульсар-режим).');
  else if (r.autonomy === 'review') lines.push('**Автономия:** НЕ делай. Дай план до действия. Дождись одобрения.');
  else lines.push('**Автономия:** предложи 2-3 варианта, дождись ответа. Не применяй без подтверждения.');
  // Темп
  if (r.tempo === 'fast') lines.push('**Темп:** быстро. Черновик закроет сейчас, отшлифуем потом. Не блокируйся на деталях.');
  else if (r.tempo === 'careful') lines.push('**Темп:** тщательно. Без спешки, до конца, найди корень проблемы.');
  else lines.push('**Темп:** обычный.');
  // Риск
  if (r.risk === 'safe') lines.push('**Риск:** безопасно. Бэкап перед правкой, dry-run, не трогай прод/работающее.');
  else if (r.risk === 'aggressive') lines.push('**Риск:** агрессивно. Пробуй новое, ломай если надо, чиним потом. Sandbox приветствуется.');
  else lines.push('**Риск:** сбалансировано. Рискни там, где окупается, но не без нужды.');
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
    'сделай сам, без меня',
    'покажи план, не трогай ничего',
    'как думаешь, что если попробовать вариант A?',
    'автономно реши задачу',
    '!!! ВСЁ УПАЛО, ПОЧЕМУ НЕ РАБОТАЕТ !!!',
    'устал... давай слепок',
    'срочно нужно, дедлайн горит',
    'погнали строить 🚀',
    'стратегия на год',
    'интересно, как работает DAS?',
    'как поставить задачу с критерием?',
    'черновик, потом доделаем',
    'тщательно, до конца, найди корень',
    'осторожно, прод, бэкап сначала',
    'ломай, эксперимент, не бойся',
  ];
  for (const t of cases) {
    const r = route(t);
    console.log(`[${r.trigger.padEnd(10)}|${r.mode.padEnd(11)}|${r.dna.padEnd(5)}|${r.length.padEnd(6)}|${r.creativity.padEnd(12)}|${r.autonomy.padEnd(7)}|${r.tempo.padEnd(8)}|${r.risk.padEnd(10)}] ${t.slice(0, 30)}`);
  }
}
