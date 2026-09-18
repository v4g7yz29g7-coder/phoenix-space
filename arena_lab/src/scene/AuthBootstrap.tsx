/**
 * ЗАДАЧА 6.1 — BOOTSTRAP JWT-СЕССИИ + ВАЛИДАЦИЯ УЧЁТНЫХ ДАННЫХ, FORMULA I1
 * ============================================================================
 * Платформа. Финальный склеивающий слой авторизации. Пока отдельные модули
 * отвечают за свои части:
 *
 *   • AuthGate.tsx   — JWT-утилиты, localStorage, zustand-стор, 3D-терминал;
 *   • AuthApi.tsx    — REST-клиент POST /register|/login, GET /me;
 *   • AuthSession.tsx— серверная верификация, logout, AuthGuard/SessionGuard;
 *   • AuthHUD.tsx    — плоский 2D-оверлей и authFetch/Bearer для REST;
 *   • web/server.js  — выпуск и подпись HS256-JWT (единственный держатель секрета),
 *
 * — этот файл добавляет недостающие три вещи, без которых поток неполон:
 *
 *   1. ВАЛИДАЦИЯ ДО СЕТИ. `validateCredentials()` повторяет правила бэкенда
 *      (e-mail по regex, пароль ≥ 6, подтверждение пароля при регистрации)
 *      и возвращает структурированные ошибки по полям. Экономит round-trip и
 *      даёт мгновенный фидбек в форме.
 *   2. ЕДИНЫЙ ХУК `useAuth()`. Сводит локальный стор (session/status/error,
 *      login/register/logout) и серверную правду (profile, verifyStatus,
 *      recheck) в один API — чтобы компоненты не импортировали три модуля.
 *   3. ЖИЗНЕННЫЙ ЦИКЛ ТОКЕНА. `useTokenExpiry()` тикает до `exp` и сообщает
 *      `expiringSoon`/`expired`, а `<AuthBootstrap>` монтирует гидратацию и
 *      SessionGuard один раз на всё приложение (самолечение протухших токенов).
 *
 * Совет Оракула соблюдён: React НИКОГДА не подписывает JWT — только хранит и
 * передаёт токен. Секрет HS256 живёт исключительно в web/server.js.
 *
 * Reference: web/server.js (POST /api/auth/register|login, GET /api/auth/me,
 * POST /api/auth/logout). Приём auth-провайдера — research/racing-game (MIT).
 * ============================================================================
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  useAuthHydration,
  useAuthStore,
  type AuthSession,
  type Credentials,
} from './AuthGate';
import { useServerSession, SessionGuard } from './AuthSession';
import type { SessionStatus } from './AuthSession';
import type { PilotProfile } from './AuthApi';

/* -------------------------------------------------------------------------- */
/*  Правила учётных данных (зеркалят web/server.js)                           */
/* -------------------------------------------------------------------------- */

/** Минимальная длина пароля — совпадает с серверной проверкой (`< 6` → 400). */
export const MIN_PASSWORD_LENGTH = 6;

/** Тот же e-mail-regex, что и в POST /api/auth/register. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type AuthMode = 'login' | 'register';

export interface CredentialErrors {
  email?: string;
  password?: string;
  confirm?: string;
}

/**
 * Чистая клиентская валидация формы. `mode === 'register'` дополнительно
 * проверяет подтверждение пароля. Пустой объект — данные валидны.
 */
export function validateCredentials(
  creds: Credentials & { confirm?: string },
  mode: AuthMode = 'login',
): CredentialErrors {
  const errors: CredentialErrors = {};
  const email = String(creds.email ?? '').trim();

  if (!email) errors.email = 'Укажите e-mail';
  else if (!EMAIL_RE.test(email)) errors.email = 'Некорректный e-mail';

  const password = String(creds.password ?? '');
  if (!password) errors.password = 'Укажите пароль';
  else if (mode === 'register' && password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Пароль минимум ${MIN_PASSWORD_LENGTH} символов`;
  }

  if (mode === 'register' && typeof creds.confirm === 'string' && creds.confirm !== password) {
    errors.confirm = 'Пароли не совпадают';
  }

  return errors;
}

/** true, если ошибок нет. */
export function isValidCredentials(
  creds: Credentials & { confirm?: string },
  mode: AuthMode = 'login',
): boolean {
  return Object.keys(validateCredentials(creds, mode)).length === 0;
}

/* -------------------------------------------------------------------------- */
/*  Единый хук авторизации                                                    */
/* -------------------------------------------------------------------------- */

export interface UseAuthResult {
  /** Локальная сессия (токен из localStorage / ответа сервера). */
  session: AuthSession | null;
  /** Профиль, подтверждённый бэкендом (GET /api/auth/me). */
  profile: PilotProfile | null;
  /** Итоговый статус: anonymous | idle | checking | valid | invalid. */
  status: SessionStatus;
  /** Идёт запрос register/login. */
  busy: boolean;
  /** Ошибка последней операции (сервер или сеть). */
  error: string | null;
  /** true — токен подтверждён сервером. */
  isAuthenticated: boolean;
  login: (creds: Credentials) => Promise<boolean>;
  register: (creds: Credentials) => Promise<boolean>;
  logout: () => Promise<void>;
  /** Повторная серверная проверка токена. */
  recheck: () => void;
}

/**
 * `useAuth()` — один источник правды для компонентов.
 * Объединяет стор (`useAuthStore`) и серверную сессию (`useServerSession`).
 */
export function useAuth(): UseAuthResult {
  const session = useAuthStore((s) => s.session);
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const storeLogin = useAuthStore((s) => s.login);
  const storeRegister = useAuthStore((s) => s.register);

  const { profile, status: serverStatus, recheck, logout } = useServerSession();

  const login = useCallback((creds: Credentials) => storeLogin(creds), [storeLogin]);
  const register = useCallback((creds: Credentials) => storeRegister(creds), [storeRegister]);

  return {
    session,
    profile,
    status: serverStatus,
    busy: status === 'loading',
    error,
    isAuthenticated: serverStatus === 'valid',
    login,
    register,
    logout,
    recheck,
  };
}

/* -------------------------------------------------------------------------- */
/*  Жизненный цикл токена                                                     */
/* -------------------------------------------------------------------------- */

export interface TokenExpiry {
  /** Секунд до истечения (0 — истёк; null — бессрочно/нет токена). */
  secondsLeft: number | null;
  /** Осталось меньше `warnBeforeSec` (по умолчанию 5 минут). */
  expiringSoon: boolean;
  /** Токен просрочен (по часам клиента). */
  expired: boolean;
}

/**
 * `useTokenExpiry(session, { warnBeforeSec, onExpire })` — тикает раз в секунду
 * и следит за `exp` из payload. `onExpire` вызывается ровно один раз.
 */
export function useTokenExpiry(
  session: AuthSession | null,
  opts: { warnBeforeSec?: number; onExpire?: () => void } = {},
): TokenExpiry {
  const { warnBeforeSec = 300, onExpire } = opts;
  const [now, setNow] = useState(() => Date.now());
  const firedRef = useRef(false);
  const cbRef = useRef(onExpire);
  cbRef.current = onExpire;

  const expiresAt = session?.expiresAt ?? 0;

  useEffect(() => {
    if (!expiresAt) {
      firedRef.current = false;
      return;
    }
    firedRef.current = false;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  const secondsLeft = useMemo(() => {
    if (!expiresAt) return null;
    return Math.max(0, Math.floor((expiresAt - now) / 1000));
  }, [expiresAt, now]);

  const expired = secondsLeft !== null && secondsLeft <= 0;
  const expiringSoon = secondsLeft !== null && secondsLeft > 0 && secondsLeft <= warnBeforeSec;

  useEffect(() => {
    if (expired && !firedRef.current) {
      firedRef.current = true;
      cbRef.current?.();
    }
  }, [expired]);

  return { secondsLeft, expiringSoon, expired };
}

/* -------------------------------------------------------------------------- */
/*  Bootstrap-провайдер                                                       */
/* -------------------------------------------------------------------------- */

export interface AuthBootstrapProps {
  children?: ReactNode;
  /** Секунд до `exp`, за сколько предупреждать (по умолчанию 300). */
  warnBeforeSec?: number;
  /**
   * Автоматический выход по истечении токена (по умолчанию — да):
   * чистит локальную сессию через стор и зовёт серверный logout.
   */
  autoLogoutOnExpire?: boolean;
  /** Монтировать SessionGuard (серверная самопроверка) — по умолчанию да. */
  guardServerSession?: boolean;
}

/**
 * `<AuthBootstrap>` — оборачивает приложение: один раз поднимает сессию из
 * localStorage, держит серверную верификацию и выкидывает просроченный токен.
 * Рендерит `children` как есть (без обёрток), т.к. соседствует с <Canvas>.
 */
export function AuthBootstrap({
  children,
  warnBeforeSec = 300,
  autoLogoutOnExpire = true,
  guardServerSession = true,
}: AuthBootstrapProps) {
  useAuthHydration();

  const session = useAuthStore((s) => s.session);
  const { logout } = useServerSession();

  useTokenExpiry(session, {
    warnBeforeSec,
    onExpire: autoLogoutOnExpire ? () => void logout() : undefined,
  });

  return (
    <>
      {guardServerSession ? <SessionGuard /> : null}
      {children}
    </>
  );
}

export default AuthBootstrap;
