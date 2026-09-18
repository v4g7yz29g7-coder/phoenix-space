/**
 * ЗАДАЧА 6.1 — КАЧЕСТВО ПАРОЛЯ ПИЛОТА (+ генератор), FORMULA I1
 * ============================================================================
 * Платформа. UI-модуль для формы регистрации/логина (PilotRegistry, AuthGate,
 * AuthHUD): показывает «силу» пароля в реальном времени и подсказывает, что
 * улучшить — прямо под полем ввода, до отправки на бэкенд.
 *
 * Зачем отдельный файл:
 *   • AuthGate/AuthBootstrap валидируют пароль формально (e-mail по regex,
 *     длина ≥ 6), но не дают пилоту понять, НАСКОЛЬКО он слабый;
 *   • research/password.md прямо рекомендует: длина — главный фактор,
 *     разнообразие классов символов, блок-лист частых паролей, штраф за
 *     повторы/последовательности, оценка энтропии;
 *   • пароль НИКОГДА не уходит в этот модуль по сети — расчёт чисто локальный,
 *     без зависимостей (только React + libWebCrypto). Секреты JWT и хеш
 *     остаются на бэкенде web/server.js (совет Оракула).
 *
 * Что экспортируется:
 *   • MIN_PASSWORD_LENGTH   — общий минимум (совпадает с AuthBootstrap/server);
 *   • assessPassword(pw)    — структурированная оценка (score 0..4, энтропия,
 *                             список конкретных подсказок);
 *   • usePasswordStrength() — хук: возвращает оценку (мемоизированно);
 *   • generatePassword(opts)— криптостойкий генератор (crypto.getRandomValues);
 *   • <PasswordStrengthMeter value=… /> — индикатор-полоска с подсказками.
 *
 * Reference: research/password.md (Argon2id/bcrypt, «длина важнее сложности»,
 * blocklist частых паролей). Код собственный, в терминах проекта AI-1.
 * ============================================================================
 */

import { useMemo } from 'react';
import type { CSSProperties } from 'react';

/* -------------------------------------------------------------------------- */
/*  Константы                                                                 */
/* -------------------------------------------------------------------------- */

/** Минимальная длина пароля — как в AuthBootstrap.MIN_PASSWORD_LENGTH и web/server.js. */
export const MIN_PASSWORD_LENGTH = 6;

/** Рекомендуемая длина, которую подсвечиваем зелёным. */
export const STRONG_LENGTH = 12;

/** Частые/слитые пароли (beginner-эшелон; бэкенд дополнительно проверяет свои). */
const COMMON_PASSWORDS = new Set<string>([
  'password', 'password1', 'password123', '123456', '1234567', '12345678',
  '123456789', '1234567890', 'qwerty', 'qwerty123', 'qwertyuiop', '111111',
  '123123', 'abc123', 'letmein', 'iloveyou', 'monkey', 'dragon', 'admin',
  'welcome', 'login', 'master', 'sunshine', 'football', 'princess', 'фарма',
  'йцукен', 'qazwsx', '1q2w3e4r', 'passw0rd', 'police', 'formula1', 'racing',
]);

/** Последовательности, которые легко угадываются подстановкой. */
const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiopasdfghjklzxcvbnm',
  '0123456789',
];

/* -------------------------------------------------------------------------- */
/*  Типы                                                                      */
/* -------------------------------------------------------------------------- */

export type PasswordScore = 0 | 1 | 2 | 3 | 4;

export interface PasswordAssessment {
  /** 0 — пусто/совсем плохо … 4 — отлично. */
  score: PasswordScore;
  /** Человекочитаемая метка на русском. */
  label: string;
  /** Приблизительная энтропия в битах (log2(алфавит^длина) с поправками). */
  entropyBits: number;
  /** Проходит ли серверный минимум (длина ≥ MIN_PASSWORD_LENGTH). */
  acceptable: boolean;
  /** Конкретные советы: что добавить/убрать. */
  suggestions: string[];
}

/* -------------------------------------------------------------------------- */
/*  Оценка                                                                    */
/* -------------------------------------------------------------------------- */

function hasLower(s: string): boolean {
  return /[a-zа-яё]/.test(s);
}
function hasUpper(s: string): boolean {
  return /[A-ZА-ЯЁ]/.test(s);
}
function hasDigit(s: string): boolean {
  return /\d/.test(s);
}
function hasSymbol(s: string): boolean {
  return /[^\p{L}\p{N}]/u.test(s);
}

/** Уникальных символов и «повторяемость» подряд идущих знаков. */
function repetitionInfo(s: string): { uniqueRatio: number; hasRun: boolean } {
  if (!s) return { uniqueRatio: 0, hasRun: false };
  const uniq = new Set(s.split('')).size;
  let hasRun = false;
  for (let i = 1; i < s.length; i += 1) {
    if (s[i] === s[i - 1]) {
      hasRun = true;
      break;
    }
  }
  return { uniqueRatio: uniq / s.length, hasRun };
}

/** true, если пароль содержит узнаваемую последовательность (abc, 123, qwerty). */
function hasSequence(s: string): boolean {
  const low = s.toLowerCase();
  for (const base of SEQUENCES) {
    let run = 1;
    for (let i = 1; i < low.length; i += 1) {
      const prev = base.indexOf(low[i - 1]);
      const cur = base.indexOf(low[i]);
      if (prev !== -1 && cur === prev + 1) {
        run += 1;
        if (run >= 3) return true;
      } else {
        run = 1;
      }
    }
  }
  return false;
}

/** Размер алфавита по используемым классам символов. */
function alphabetSize(s: string): number {
  let size = 0;
  if (hasLower(s)) size += 26;
  if (hasUpper(s)) size += 26;
  if (hasDigit(s)) size += 10;
  if (hasSymbol(s)) size += 33;
  return size || 1;
}

/**
 * Оценивает пароль без обращения к сети. Чистая функция — удобно тестировать.
 */
export function assessPassword(password: string): PasswordAssessment {
  const pw = password ?? '';
  const len = pw.length;
  const suggestions: string[] = [];

  if (len === 0) {
    return {
      score: 0,
      label: 'Пусто',
      entropyBits: 0,
      acceptable: false,
      suggestions: [`Введите пароль (минимум ${MIN_PASSWORD_LENGTH} символов)`],
    };
  }

  const lower = hasLower(pw);
  const upper = hasUpper(pw);
  const digit = hasDigit(pw);
  const symbol = hasSymbol(pw);
  const classes = [lower, upper, digit, symbol].filter(Boolean).length;
  const { uniqueRatio, hasRun } = repetitionInfo(pw);
  const seq = hasSequence(pw);
  const isCommon = COMMON_PASSWORDS.has(pw.toLowerCase());

  // Базовая энтропия: log2(алфавит^длина) = длина * log2(алфавит).
  let entropyBits = len * Math.log2(alphabetSize(pw));

  // Штрафы за предсказуемость (не ниже нуля).
  if (uniqueRatio < 0.5) entropyBits *= 0.6;
  if (hasRun) entropyBits *= 0.8;
  if (seq) entropyBits *= 0.7;
  if (isCommon) entropyBits = Math.min(entropyBits, 8);
  entropyBits = Math.max(0, Math.round(entropyBits));

  // Баллы складываются из длины и разнообразия, вычитаются за слабости.
  let score = 0;
  if (len >= MIN_PASSWORD_LENGTH) score += 1;
  if (len >= 8) score += 1;
  if (len >= STRONG_LENGTH) score += 1;
  if (classes >= 3) score += 1;
  if (isCommon) score = Math.min(score, 1);
  if (hasRun && score > 0) score -= 1;
  if (seq && score > 0) score -= 1;
  if (entropyBits >= 80 && score < 3) score = 3;
  score = Math.max(0, Math.min(4, score)) as PasswordScore;

  // Подсказки — ровно то, чего не хватает.
  if (len < MIN_PASSWORD_LENGTH) {
    suggestions.push(`Увеличьте длину до ${MIN_PASSWORD_LENGTH}+ символов (лучше ${STRONG_LENGTH}+)`);
  } else if (len < STRONG_LENGTH) {
    suggestions.push(`Длина ${len} — приемлемо; ${STRONG_LENGTH}+ надёжнее (длина важнее спецсимволов)`);
  }
  if (!lower || !upper) suggestions.push('Смешайте строчные и ЗАГЛАВНЫЕ буквы');
  if (!digit) suggestions.push('Добавьте хотя бы одну цифру');
  if (!symbol) suggestions.push('Добавьте символ (например, ! ? # %)');
  if (hasRun) suggestions.push('Уберите повторяющиеся символы подряд (aa, 11)');
  if (seq) suggestions.push('Уберите последовательности (abc, 123, qwerty)');
  if (isCommon) suggestions.push('Этот пароль есть в списках утечек — выберите другой');
  if (!suggestions.length) suggestions.push('Отличный пароль — брутфорс займёт годы');

  const labels: Record<PasswordScore, string> = {
    0: 'Очень слабый',
    1: 'Слабый',
    2: 'Средний',
    3: 'Хороший',
    4: 'Отличный',
  };

  return {
    score: score as PasswordScore,
    label: labels[score as PasswordScore],
    entropyBits,
    acceptable: len >= MIN_PASSWORD_LENGTH && !isCommon,
    suggestions,
  };
}

/** Хук-обёртка: мемоизирует оценку по значению пароля. */
export function usePasswordStrength(password: string): PasswordAssessment {
  return useMemo(() => assessPassword(password), [password]);
}

/* -------------------------------------------------------------------------- */
/*  Генератор                                                                 */
/* -------------------------------------------------------------------------- */

export interface GenerateOptions {
  length?: number;
  lower?: boolean;
  upper?: boolean;
  digits?: boolean;
  symbols?: boolean;
}

/**
 * Криптостойкий генератор пароля на crypto.getRandomValues (без Math.random).
 * Гарантирует минимум по одному символу каждого выбранного класса.
 */
export function generatePassword(opts: GenerateOptions = {}): string {
  const length = Math.max(8, Math.min(128, opts.length ?? 16));
  const useLower = opts.lower ?? true;
  const useUpper = opts.upper ?? true;
  const useDigits = opts.digits ?? true;
  const useSymbols = opts.symbols ?? true;

  const pools: string[] = [];
  if (useLower) pools.push('abcdefghijkmnopqrstuvwxyz'); // без l
  if (useUpper) pools.push('ABCDEFGHJKLMNPQRSTUVWXYZ'); // без I, O
  if (useDigits) pools.push('23456789'); // без 0, 1
  if (useSymbols) pools.push('!@#$%^&*()-_=+[]{}');
  if (!pools.length) pools.push('abcdefghijkmnopqrstuvwxyz23456789');

  const alphabet = pools.join('');
  const rand = (max: number): number => {
    // Отбраковка значений за пределами max, чтобы убрать модульный сдвиг.
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    let x = 0;
    do {
      crypto.getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return x % max;
  };

  const chars: string[] = [];
  // По одному обязательному символу из каждого выбранного пула.
  for (const pool of pools) chars.push(pool[rand(pool.length)]);
  while (chars.length < length) chars.push(alphabet[rand(alphabet.length)]);

  // Перемешивание Фишера–Йетса на тех же криптослучайных числах.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = rand(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/* -------------------------------------------------------------------------- */
/*  Презентационный индикатор                                                 */
/* -------------------------------------------------------------------------- */

const SCORE_COLORS: Record<PasswordScore, string> = {
  0: '#ff5c5c',
  1: '#ff5c5c',
  2: '#ffb020',
  3: '#3ddc84',
  4: '#6eff8b',
};

export interface PasswordStrengthMeterProps {
  value: string;
  /** Показывать список подсказок (по умолчанию true). */
  showSuggestions?: boolean;
  /** Показывать кнопку «Сгенерировать». */
  withGenerator?: boolean;
  /** Колбэк генератора: родитель подставляет пароль в своё поле. */
  onGenerate?: (password: string) => void;
  style?: CSSProperties;
}

export function PasswordStrengthMeter({
  value,
  showSuggestions = true,
  withGenerator = false,
  onGenerate,
  style,
}: PasswordStrengthMeterProps) {
  const { score, label, entropyBits, acceptable, suggestions } = usePasswordStrength(value);
  const color = SCORE_COLORS[score];
  const filled = score === 0 && value.length === 0 ? 0 : score + 1;

  return (
    <div style={{ marginTop: 6, ...style }}>
      {/* Полоска из 5 сегментов */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 5,
              borderRadius: 3,
              background: i < filled ? color : 'rgba(122,139,170,0.25)',
              transition: 'background .15s ease',
            }}
          />
        ))}
        <span
          style={{
            width: 92,
            textAlign: 'right',
            fontSize: 10,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: value ? color : '#7a8baa',
          }}
        >
          {value ? label : '—'}
        </span>
      </div>

      {value.length > 0 && (
        <div style={{ fontSize: 10, color: '#7a8baa', marginTop: 4 }}>
          ≈ {entropyBits} бит энтропии ·{' '}
          <span style={{ color: acceptable ? '#6eff8b' : '#ff5c5c' }}>
            {acceptable ? 'проходит минимум' : `нужно ≥ ${MIN_PASSWORD_LENGTH} симв.`}
          </span>
        </div>
      )}

      {showSuggestions && value.length > 0 && (
        <ul
          style={{
            margin: '6px 0 0',
            padding: '0 0 0 16px',
            listStyle: 'disc',
            fontSize: 10.5,
            lineHeight: 1.5,
            color: score >= 3 ? '#6eff8b' : '#9fb0cf',
          }}
        >
          {suggestions.slice(0, 3).map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}

      {withGenerator && onGenerate && (
        <button
          type="button"
          onClick={() => onGenerate(generatePassword({ length: STRONG_LENGTH }))}
          style={{
            marginTop: 6,
            padding: '6px 10px',
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: 1,
            textTransform: 'uppercase',
            cursor: 'pointer',
            color: '#4dd0ff',
            background: 'transparent',
            border: '1px solid rgba(77,208,255,0.4)',
            borderRadius: 6,
          }}
        >
          ⚙ Сгенерировать надёжный
        </button>
      )}
    </div>
  );
}

export default PasswordStrengthMeter;
