/**
 * voice_analyzer.js — Текстовый анализ "голоса" брата: просодия через письмо.
 *
 * Идея: в письменной речи интонация, темп и эмоции кодируются иначе, чем в
 * звуке. Мы восстанавливаем просодический профиль по метрикам текста:
 *
 *   1) avgLen       — средняя длина сообщения (сколько "воздуха" в реплике);
 *   2) rhythm       — интервалы между сообщениями по timestamp (темп диалога);
 *   3) punctuation  — пунктуационные паттерны (… , !!!, ???, CAPS LOCK) —
 *                     это эмоциональная интонация: паузы, вспышки, крик;
 *   4) emoji        — частоты эмодзи: какие и когда (позиция/роль, density);
 *   5) moodMarkers  — слова-маркеры настроения (брат, давай, стоп, устал).
 *
 * Читает corpus/architect/dialogues/*.json — массив пар { user, assistant, ts }.
 *
 * Публичный API: analyze(options?) -> {
 *     avgLen, rhythm, punctuation, emoji, moodMarkers
 * }
 *
 * Опции:
 *   dir        — путь к каталогу диалогов (по умолчанию corpus/architect/dialogues)
 *   side       — 'both' | 'user' | 'assistant' — чью просодию измеряем
 *   files      — явный список файлов (если нужно ограничить корпус)
 *   maxFiles   — верхняя граница числа файлов
 *   moods      — переопределить список слов-маркеров
 *
 * Запуск как CLI: node architect/voice_analyzer.js [--json] [--side=user]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'corpus', 'architect', 'dialogues');

/**
 * Базовый словарь слов-маркеров настроения.
 * Ключ — каноническая нормальная форма, значение — массив вариантов
 * написания / словоформ (в нижнем регистре, без ё → е).
 */
const DEFAULT_MOOD_MARKERS = {
  'брат': ['брат', 'братишка', 'братец', 'братан', 'братья', 'братик'],
  'давай': ['давай', 'давай-ка', 'давайте', 'давй'],
  'стоп': ['стоп', 'стопэ', 'стоп-стоп', 'остановись', 'хватит'],
  'устал': ['устал', 'устала', 'устали', 'усталость', 'уставший', 'вымотался', 'заебался', 'выдохся'],
};

/**
 * Расширенный набор эмодзи-диапазонов не нужен: мы извлекаем символы через
 * Unicode property escapes (Extended_Pictographic) + variation selectors.
 * Это даёт корректную работу с составными эмодзи (ZWJ-последовательности).
 */
const EMOJI_RE = /(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/gu;
const ZWJ = '\u200D';
const VS16 = '\uFE0F';

/* ------------------------------------------------------------------ */
/* Чтение и нормализация корпуса                                      */
/* ------------------------------------------------------------------ */

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function safeParseJSON(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Перечисляет json-файлы диалогов. Пропускает служебные (с "_" в начале).
 */
function listDialogueFiles(dir) {
  const d = dir || DEFAULT_DIR;
  if (!fs.existsSync(d)) return [];
  let entries;
  try {
    entries = fs.readdirSync(d);
  } catch (e) {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => path.join(d, f))
    .sort();
}

/**
 * Разбирает один файл-массив в плоский список "ходов" (turns).
 * Каждый ход: { side: 'user'|'assistant', text, ts }
 */
function parseDialogueFile(filePath, sideFilter) {
  const raw = safeRead(filePath);
  const arr = safeParseJSON(raw);
  const turns = [];
  if (!Array.isArray(arr)) return turns;

  for (const pair of arr) {
    if (!pair || typeof pair !== 'object') continue;
    if ((sideFilter === 'both' || sideFilter === 'user') && typeof pair.user === 'string') {
      turns.push({ side: 'user', text: pair.user, ts: pair.ts || null });
    }
    if ((sideFilter === 'both' || sideFilter === 'assistant') && typeof pair.assistant === 'string') {
      turns.push({ side: 'assistant', text: pair.assistant, ts: pair.ts || null });
    }
  }
  return turns;
}

/**
 * Собирает все ходы из корпуса.
 */
function collectTurns(options) {
  const opts = options || {};
  const side = opts.side || 'both';
  let files = Array.isArray(opts.files) && opts.files.length
    ? opts.files.slice()
    : listDialogueFiles(opts.dir);

  if (typeof opts.maxFiles === 'number' && opts.maxFiles > 0) {
    files = files.slice(0, opts.maxFiles);
  }

  const all = [];
  for (const f of files) {
    const turns = parseDialogueFile(f, side);
    for (const t of turns) {
      t.file = path.basename(f);
      all.push(t);
    }
  }
  return all;
}

/* ------------------------------------------------------------------ */
/* 1) Длина сообщений                                                 */
/* ------------------------------------------------------------------ */

function wordCount(text) {
  const m = String(text).trim().match(/[^\s]+/g);
  return m ? m.length : 0;
}

function mean(nums) {
  if (!nums.length) return 0;
  let s = 0;
  for (const n of nums) s += n;
  return s / nums.length;
}

function median(nums) {
  if (!nums.length) return 0;
  const a = nums.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function stdev(nums) {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  let acc = 0;
  for (const n of nums) acc += (n - m) * (n - m);
  return Math.sqrt(acc / (nums.length - 1));
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

/**
 * Метрика 1: длина сообщения в символах и словах.
 * Возвращает распределение + самые длинные/короткие реплики.
 */
function analyzeLength(turns) {
  const chars = turns.map((t) => t.text.length);
  const words = turns.map((t) => wordCount(t.text));
  const sortedChars = chars.slice().sort((a, b) => a - b);

  let longest = null;
  let shortest = null;
  for (const t of turns) {
    if (!longest || t.text.length > longest.len) {
      longest = { len: t.text.length, side: t.side, preview: t.text.slice(0, 80) };
    }
    if (!shortest || t.text.length < shortest.len) {
      shortest = { len: t.text.length, side: t.side, preview: t.text.slice(0, 80) };
    }
  }

  const bySide = {};
  for (const sideName of ['user', 'assistant']) {
    const subset = turns.filter((t) => t.side === sideName);
    if (subset.length) {
      bySide[sideName] = {
        count: subset.length,
        avgChars: round(mean(subset.map((t) => t.text.length))),
        avgWords: round(mean(subset.map((t) => wordCount(t.text)))),
      };
    }
  }

  return {
    count: turns.length,
    avgChars: round(mean(chars)),
    medianChars: round(median(chars)),
    stdevChars: round(stdev(chars)),
    p90Chars: round(quantile(sortedChars, 0.9)),
    avgWords: round(mean(words)),
    medianWords: round(median(words)),
    avgLen: round(mean(chars)), // ключевое поле API (символы)
    bySide,
    longest: longest || null,
    shortest: shortest || null,
  };
}

/* ------------------------------------------------------------------ */
/* 2) Ритм — интервалы между сообщениями                              */
/* ------------------------------------------------------------------ */

function toMillis(ts) {
  if (ts == null) return NaN;
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? NaN : t;
}

/**
 * Метрика 2: ритм. Считаем промежутки между последовательными репликами
 * (в секундах) по timestamp. Классифицируем темп: всплеск / размеренный ход /
 * долгая пауза. Это аналог просодического "темпа речи".
 */
function analyzeRhythm(turns) {
  const gaps = [];
  const gapDetails = [];
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1];
    const cur = turns[i];
    // Считаем интервал только между разными сторонами (ответ на реплику)
    if (prev.side === cur.side) continue;
    const a = toMillis(prev.ts);
    const b = toMillis(cur.ts);
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    const dt = (b - a) / 1000;
    if (dt < 0) continue;
    gaps.push(dt);
    gapDetails.push({ from: prev.side, to: cur.side, sec: round(dt) });
  }

  const sorted = gaps.slice().sort((x, y) => x - y);
  const burst = gaps.filter((g) => g <= 5).length;      // стремительный обмен
  const steady = gaps.filter((g) => g > 5 && g <= 120).length;
  const pause = gaps.filter((g) => g > 120).length;      // раздумье / пауза

  let tempo = 'unknown';
  if (gaps.length) {
    const med = median(gaps);
    if (med <= 10) tempo = 'fast';
    else if (med <= 120) tempo = 'steady';
    else tempo = 'slow';
  }

  // Пики "вспышек" — самые короткие интервалы, и "провалы" — длинные паузы.
  const fastest = gapDetails.slice().sort((a, b) => a.sec - b.sec).slice(0, 5);
  const slowest = gapDetails.slice().sort((a, b) => b.sec - a.sec).slice(0, 5);

  return {
    intervals: gaps.length,
    avgSec: round(mean(gaps)),
    medianSec: round(median(gaps)),
    stdevSec: round(stdev(gaps)),
    p10Sec: round(quantile(sorted, 0.1)),
    p90Sec: round(quantile(sorted, 0.9)),
    tempo,
    burst,
    steady,
    pause,
    fastest,
    slowest,
  };
}

/* ------------------------------------------------------------------ */
/* 3) Пунктуация — эмоциональная интонация                            */
/* ------------------------------------------------------------------ */

/**
 * Метрика 3: пунктуационные паттерны как просодия.
 *   - "..." / "…"  — задумчивость, незавершённость, шёпот;
 *   - "!!!" / "!!" — крик, вспышка;
 *   - "???" / "??" — растерянность, нажим;
 *   - "?! / !?"    — риторический сарказм;
 *   - CAPS LOCK    — повышение громкости / нажим (доля заглавных букв);
 *   - тире "—"     — пауза-дыхание;
 *   - скобки "(...)" — вставное бормотание.
 */
function analyzePunctuation(turns) {
  const per1k = (n, chars) => (chars > 0 ? round((n / chars) * 1000, 3) : 0);

  let totalChars = 0;
  let ellipsis = 0;
  let ellipsisUnicode = 0;
  let exclam = 0;      // одиночные !
  let exclamRuns = 0;  // !!! (>=2)
  let exclamMaxRun = 0;
  let question = 0;
  let questionRuns = 0;
  let interro = 0;     // ?! и !?
  let dashes = 0;
  let parens = 0;
  let capsWords = 0;
  let capsChars = 0;
  let letters = 0;
  let totalMarks = 0;

  for (const t of turns) {
    const s = t.text;
    totalChars += s.length;

    const ell = s.match(/\.\.\.|…/g);
    if (ell) {
      ellipsis += ell.length;
      ellipsisUnicode += ell.filter((x) => x === '…').length;
    }

    const ex = s.match(/!+/g);
    if (ex) {
      for (const run of ex) {
        exclam += 1; // считаем "восклицательное событие" (серию)
        totalMarks += run.length;
        if (run.length >= 2) exclamRuns++;
        if (run.length > exclamMaxRun) exclamMaxRun = run.length;
      }
    }

    const qu = s.match(/\?+/g);
    if (qu) {
      for (const run of qu) {
        question += 1;
        totalMarks += run.length;
        if (run.length >= 2) questionRuns++;
      }
    }

    const int = s.match(/[?!]{2,}|!\?|\?!/g);
    if (int) interro += int.length;

    const d = s.match(/[—–-]/g);
    if (d) dashes += d.length;

    const par = s.match(/\([^)]*\)|«[^»]*»|"[^"]*"/g);
    if (par) parens += par.length;

    // CAPS: слова целиком из заглавных (>=2 букв), исключая аббревиатуры цифр.
    const capWords = s.match(/\b[А-ЯЁA-Z]{2,}\b/g);
    if (capWords) capsWords += capWords.length;

    for (const ch of s) {
      if (/[A-Za-zА-Яа-яЁё]/.test(ch)) {
        letters++;
        if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) capsChars++;
      }
    }
  }

  const capsRatio = letters > 0 ? round(capsChars / letters, 4) : 0;
  const emotionalIntensity = round(
    exclamRuns * 3 + questionRuns * 2 + interro * 2 + capsRatio * 100,
    2
  );

  let intonation = 'calm';
  if (capsRatio > 0.04 || exclamRuns > turns.length * 0.15) intonation = 'intense';
  else if (ellipsis > turns.length * 0.3) intonation = 'contemplative';
  else if (exclamRuns + questionRuns > 0) intonation = 'animated';

  return {
    totalChars,
    ellipsis,
    ellipsisUnicode,
    ellipsisPer1k: per1k(ellipsis, totalChars),
    exclamEvents: exclam,
    exclamRuns,
    exclamMaxRun,
    questionEvents: question,
    questionRuns,
    interrobang: interro,
    dashes,
    parentheticals: parens,
    capsWords,
    capsRatio,
    emotionalIntensity,
    intonation,
    marksPer1k: per1k(totalMarks, totalChars),
  };
}

/* ------------------------------------------------------------------ */
/* 4) Эмодзи — какие и когда                                          */
/* ------------------------------------------------------------------ */

function extractEmojis(text) {
  const found = [];
  let m;
  EMOJI_RE.lastIndex = 0;
  while ((m = EMOJI_RE.exec(text)) !== null) {
    let e = m[0];
    // нормализуем: убираем variation selector для стабильного ключа,
    // но сохраняем ZWJ-последовательности как единый эмодзи.
    if (e.endsWith(VS16) && !e.includes(ZWJ)) e = e.slice(0, -VS16.length);
    found.push({ emoji: e, index: m.index });
  }
  return found;
}

/**
 * Метрика 4: эмодзи. Какие (по частоте), когда (позиция в сообщении:
 * начало / середина / конец), и как плотно (на сообщение, на 1k символов).
 * "Когда" дополнительно агрегируется по эмоциональному контексту:
 * рядом ли восклицания, многоточия, CAPS.
 */
function analyzeEmoji(turns) {
  const freq = Object.create(null);
  let total = 0;
  const perSide = { user: 0, assistant: 0 };
  const positions = { start: 0, middle: 0, end: 0 };
  const contexts = { exclam: 0, ellipsis: 0, caps: 0, neutral: 0 };
  const timelines = [];

  for (const t of turns) {
    const s = t.text;
    const emojis = extractEmojis(s);
    if (!emojis.length) continue;

    const hasExclam = /!/.test(s);
    const hasEll = /\.\.\.|…/.test(s);
    const hasCaps = /\b[А-ЯЁA-Z]{2,}\b/.test(s);

    for (const { emoji, index } of emojis) {
      total++;
      freq[emoji] = (freq[emoji] || 0) + 1;
      if (perSide[t.side] !== undefined) perSide[t.side]++;

      const before = s.slice(0, index);
      const after = s.slice(index + emoji.length);
      const atStart = before.trim().length === 0;
      const atEnd = after.trim().length === 0;
      if (atStart && atEnd) positions.middle++;
      else if (atStart) positions.start++;
      else if (atEnd) positions.end++;
      else positions.middle++;

      if (hasExclam) contexts.exclam++;
      else if (hasEll) contexts.ellipsis++;
      else if (hasCaps) contexts.caps++;
      else contexts.neutral++;

      timelines.push({ emoji, side: t.side, ts: t.ts || null, file: t.file || null });
    }
  }

  const top = Object.keys(freq)
    .map((e) => ({ emoji: e, count: freq[e] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const messagesWithEmoji = turns.filter((t) => extractEmojis(t.text).length > 0).length;

  return {
    total,
    unique: Object.keys(freq).length,
    frequency: freq,
    top,
    perSide,
    positions,
    contexts,
    messagesWithEmoji,
    emojiPerMessage: turns.length ? round(total / turns.length, 3) : 0,
    emojiPer1k:
      turns.reduce((a, t) => a + t.text.length, 0) > 0
        ? round((total / turns.reduce((a, t) => a + t.text.length, 0)) * 1000, 3)
        : 0,
    timelineSample: timelines.slice(0, 30),
  };
}

/* ------------------------------------------------------------------ */
/* 5) Слова-маркеры настроения                                        */
/* ------------------------------------------------------------------ */

function normalizeText(s) {
  return String(s).toLowerCase().replace(/ё/g, 'е');
}

/**
 * Достаёт слова (Unicode-aware) для поиска маркеров.
 * Держим дефисные формы ("давай-ка") как единый токен.
 */
function tokenize(s) {
  const m = normalizeText(s).match(/[a-zа-я0-9]+(?:-[a-zа-я0-9]+)*/g);
  return m || [];
}

/**
 * Метрика 5: слова-маркеры настроения (брат, давай, стоп, устал).
 * Для каждого маркера: общая частота, частота по сторонам, где встречается
 * чаще (в начале/середине/конце), и ближайшее окружение (примеры).
 */
function analyzeMoodMarkers(turns, markerDefs) {
  const defs = markerDefs || DEFAULT_MOOD_MARKERS;
  const result = Object.create(null);

  for (const canon of Object.keys(defs)) {
    result[canon] = {
      count: 0,
      per1kWords: 0,
      bySide: { user: 0, assistant: 0 },
      positions: { start: 0, middle: 0, end: 0 },
      examples: [],
    };
  }

  let totalWords = 0;
  for (const t of turns) {
    const tokens = tokenize(t.text);
    totalWords += tokens.length;
    const lower = normalizeText(t.text);

    for (const canon of Object.keys(defs)) {
      const variants = defs[canon];
      let hits = 0;
      for (const v of variants) {
        // точное совпадение токена или вхождение части слова
        const tokHits = tokens.filter((tok) => tok === v).length;
        let count = tokHits;
        if (count === 0) {
          // мягкий поиск по корню (например "устал" внутри "усталость")
          const idx = lower.indexOf(v);
          if (idx >= 0) {
            count = 1;
            while ((idx = lower.indexOf(v, idx + v.length)) >= 0) count++;
          }
        }
        hits += count;
      }
      if (hits > 0) {
        const cell = result[canon];
        cell.count += hits;
        if (cell.bySide[t.side] !== undefined) cell.bySide[t.side] += hits;

        // позиция первого вхождения в сообщении
        const firstIdx = Math.max(0, lower.indexOf(canon));
        const rel = t.text.length ? firstIdx / t.text.length : 0;
        if (rel < 0.15) cell.positions.start++;
        else if (rel > 0.85) cell.positions.end++;
        else cell.positions.middle++;

        if (cell.examples.length < 3) {
          cell.examples.push({
            side: t.side,
            text: t.text.replace(/\s+/g, ' ').slice(0, 120),
          });
        }
      }
    }
  }

  for (const canon of Object.keys(result)) {
    const cell = result[canon];
    cell.per1kWords = totalWords > 0 ? round((cell.count / totalWords) * 1000, 3) : 0;
    delete cell._;
  }

  const sorted = Object.keys(result)
    .map((k) => ({ marker: k, count: result[k].count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalWords,
    markers: result,
    ranking: sorted,
    dominant: sorted.length && sorted[0].count > 0 ? sorted[0].marker : null,
  };
}

/* ------------------------------------------------------------------ */
/* Утилиты                                                            */
/* ------------------------------------------------------------------ */

function round(n, digits) {
  const d = typeof digits === 'number' ? digits : 2;
  if (!isFinite(n)) return 0;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function clamp01(x) {
  if (!isFinite(x) || x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Композитный "просодический профиль" — сводная интерпретация пяти метрик.
 * Не часть обязательного API, но помогает потребителю (dna_builder и т.п.).
 */
function buildProfile(metrics) {
  const v = clamp01((metrics.avgLen.avgChars || 0) / 400);
  const energy = clamp01((metrics.punctuation.emotionalIntensity || 0) / 12);
  const warmth = clamp01(
    ((metrics.emoji.total || 0) / Math.max(1, metrics.avgLen.count)) * 3
  );
  const tempo = metrics.rhythm.tempo;

  return {
    verbosity: round(v, 3),
    energy: round(energy, 3),
    warmth: round(warmth, 3),
    tempo,
    intonation: metrics.punctuation.intonation,
    dominantMood: metrics.moodMarkers.dominant,
  };
}

/* ------------------------------------------------------------------ */
/* Публичный API                                                      */
/* ------------------------------------------------------------------ */

/**
 * Основная функция анализа.
 * @param {object} [options]
 * @param {string} [options.dir]      каталог диалогов
 * @param {string} [options.side]     'both' | 'user' | 'assistant'
 * @param {string[]} [options.files]  явный список файлов
 * @param {number} [options.maxFiles] ограничение
 * @param {object} [options.moods]    свои маркеры настроения
 * @param {boolean} [options.withProfile] добавить composite profile
 * @returns {object} { avgLen, rhythm, punctuation, emoji, moodMarkers, meta }
 */
function analyze(options) {
  const opts = options || {};
  const turns = collectTurns(opts);

  const avgLen = analyzeLength(turns);
  const rhythm = analyzeRhythm(turns);
  const punctuation = analyzePunctuation(turns);
  const emoji = analyzeEmoji(turns);
  const moodMarkers = analyzeMoodMarkers(turns, opts.moods);

  const result = {
    avgLen,
    rhythm,
    punctuation,
    emoji,
    moodMarkers,
    meta: {
      generatedAt: new Date().toISOString(),
      side: opts.side || 'both',
      messages: turns.length,
      sides: {
        user: turns.filter((t) => t.side === 'user').length,
        assistant: turns.filter((t) => t.side === 'assistant').length,
      },
    },
  };

  if (opts.withProfile) {
    result.profile = buildProfile(result);
  }

  return result;
}

/**
 * Человекочитаемая сводка — удобно для логов и Telegram.
 */
function summarize(metrics) {
  const m = metrics || analyze();
  const lines = [];
  lines.push('🎙️ Просодия "голоса" (текстовый анализ)');
  lines.push(`Сообщений: ${m.meta.messages} (user=${m.meta.sides.user}, asst=${m.meta.sides.assistant})`);
  lines.push(`Длина: avg=${m.avgLen.avgChars} симв / ${m.avgLen.avgWords} слов, median=${m.avgLen.medianChars}`);
  lines.push(`Ритм: ${m.rhythm.tempo}, median=${m.rhythm.medianSec}s, всплески=${m.rhythm.burst}, паузы=${m.rhythm.pause}`);
  lines.push(`Интонация: ${m.punctuation.intonation} (энергия=${m.punctuation.emotionalIntensity}), CAPS=${m.punctuation.capsRatio}`);
  lines.push(`Многоточий: ${m.punctuation.ellipsis}, !!!-серий: ${m.punctuation.exclamRuns}, ?!-событий: ${m.punctuation.interrobang}`);
  lines.push(`Эмодзи: ${m.emoji.total} шт / ${m.emoji.unique} уник, ${m.emoji.emojiPerMessage}/сообщение`);
  const topEmoji = m.emoji.top.slice(0, 5).map((e) => `${e.emoji}(${e.count})`).join(' ');
  if (topEmoji) lines.push(`Топ: ${topEmoji}`);
  lines.push(`Маркеры: ${m.moodMarkers.ranking.map((r) => `${r.marker}:${r.count}`).join(', ')}`);
  return lines.join('\n');
}

module.exports = {
  analyze,
  // вспомогательные экспорты для тонкой настройки и тестов
  collectTurns,
  parseDialogueFile,
  listDialogueFiles,
  analyzeLength,
  analyzeRhythm,
  analyzePunctuation,
  analyzeEmoji,
  analyzeMoodMarkers,
  buildProfile,
  summarize,
  DEFAULT_MOOD_MARKERS,
};

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const sideArg = args.find((a) => a.startsWith('--side='));
  const dirArg = args.find((a) => a.startsWith('--dir='));
  const side = sideArg ? sideArg.split('=')[1] : 'both';
  const dir = dirArg ? dirArg.split('=')[1] : undefined;

  const metrics = analyze({ side, dir, withProfile: true });
  if (asJson) {
    process.stdout.write(JSON.stringify(metrics, null, 2) + '\n');
  } else {
    process.stdout.write(summarize(metrics) + '\n');
    process.stdout.write('\nПрофиль: ' + JSON.stringify(metrics.profile) + '\n');
  }
}
