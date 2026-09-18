/**
 * ЗАДАЧА 6.1 — ЖИЗНЕННЫЙ ЦИКЛ JWT-СЕССИИ, FORMULA I1
 * ============================================================================
 * Платформа. Связующее звено между хранилищем токена (AuthGate), REST-клиентом
 * авторизации (AuthApi) и бэкендом (web/server.js). Закрывает три дыры:
 *
 *   1. СЕРВЕРНАЯ ВЕРИФИКАЦИЯ. Токен из localStorage проверяется на бэкенде
 *      через GET /api/auth/me (подпись HS256 + срок). Если сервер отверг
 *      токен (401) — «самолечение»: локальная сессия сбрасывается, UI больше
 *      не показывает фантомного пилота.
 *   2. ВЫХОД. POST /api/auth/logout (Bearer) + очистка localStorage — выход
 *      закрывает и серверную, и клиентскую сторону.
 *   3. ГЕЙТ ДОСТУПА. <AuthGuard> рендерит защищённое поддерево только для
 *      пилота с подтверждённой сессией; иначе — fallback.
 *
 * Архитектурный принцип (совет Оракула): секрет и подпись JWT живут только на
 * бэкенде web/server.js. Здесь нет ни одного секрета — только Bearer-токен,
 * который выдал сервер.
 *
 * Reference: web/server.js (POST /api/auth/register|login, GET /api/auth/me,
 * POST /api/auth/logout). Приём auth-провайдера — research/racing-game (MIT).
 * ============================================================================
 */

import { createElement, useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { AUTH_API_BASE, useAuthStore } from './AuthGate';
import type { AuthSession } from './AuthGate';
import { useVerifySession } from './AuthApi';
import type { PilotProfile, VerifyStatus } from './AuthApi';

/* -------------------------------------------------------------------------- */
/*  Выход: сервер + клиент                                                    */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/auth/logout с Bearer-токеном. Сервер stateless (JWT), но эндпоинт
 * существует — вызываем его ради аудита/совместимости. Сетевые ошибки
 * игнорируются: выйти локально важно в любом случае.
 */
export async function logoutOnServer(token: string | null): Promise<void> {
  if (!token) return;
  try {
    await fetch(`${AUTH_API_BASE}/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* нет сети — всё равно выходим локально */
  }
}

/* -------------------------------------------------------------------------- */
/*  Хук: подтверждённая сервером сессия                                       */
/* -------------------------------------------------------------------------- */

export type SessionStatus = 'anonymous' | VerifyStatus;

export interface ServerSession {
  /** Локальная сессия (есть токен) либо null. */
  session: AuthSession | null;
  /** Профиль, подтверждённый бэкендом (GET /api/auth/me). */
  profile: PilotProfile | null;
  /** Итоговый статус: anonymous | idle | checking | valid | invalid. */
  status: SessionStatus;
  /** Текст ошибки верификации, если сервер отверг токен. */
  error: string | null;
  /** Повторная проверка на сервере (без перезагрузки). */
  recheck: () => void;
  /** Полный выход: сервер + локальная очистка. */
  logout: () => Promise<void>;
}

/**
 * `useServerSession()` — источник правды о том, действительно ли пилот
 * авторизован. Пока идёт `checking`, доверять локальному токену нельзя.
 * При `invalid` сессия сбрасывается автоматически (самолечение).
 */
export function useServerSession(): ServerSession {
  const session = useAuthStore((s) => s.session);
  const clearLocal = useAuthStore((s) => s.logout);
  const { status: verifyStatus, verified, resync } = useVerifySession(session);

  // Самолечение: сервер отверг токен → убираем его из стора и localStorage.
  useEffect(() => {
    if (session && verifyStatus === 'invalid') clearLocal();
  }, [session, verifyStatus, clearLocal]);

  const logout = useCallback(async () => {
    await logoutOnServer(session?.token ?? null);
    clearLocal();
  }, [session, clearLocal]);

  const status: SessionStatus = session ? verifyStatus : 'anonymous';
  const error =
    verifyStatus === 'invalid' ? 'Сессия недействительна — войдите снова' : null;

  return { session, profile: verified, status, error, recheck: resync, logout };
}

/* -------------------------------------------------------------------------- */
/*  SessionGuard — невидимый компонент самолечения                            */
/* -------------------------------------------------------------------------- */

/**
 * Монтируется один раз рядом с `useAuthHydration()`. Ничего не рисует —
 * только держит серверную верификацию активной на протяжении всей сессии
 * и сбрасывает протухший/поддельный токен.
 */
export function SessionGuard({ onInvalid }: { onInvalid?: () => void } = {}): null {
  const { status } = useServerSession();

  useEffect(() => {
    if (status === 'invalid') onInvalid?.();
  }, [status, onInvalid]);

  return null;
}

/* -------------------------------------------------------------------------- */
/*  AuthGuard — защита поддерева                                              */
/* -------------------------------------------------------------------------- */

export interface AuthGuardProps {
  children: ReactNode;
  /** Что показать, пока сессия не подтверждена (или её нет). */
  fallback?: ReactNode;
  /** Показывать fallback во время серверной проверки (по умолчанию — да). */
  gateWhileChecking?: boolean;
}

const guardNote: CSSProperties = {
  position: 'absolute',
  left: 24,
  bottom: 24,
  zIndex: 15,
  maxWidth: 320,
  padding: '12px 14px',
  borderRadius: 12,
  border: '1px solid rgba(255, 209, 102, 0.45)',
  background: 'rgba(20, 28, 52, 0.92)',
  color: '#e0e6f0',
  fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
  fontSize: 12,
  lineHeight: 1.45,
};

/**
 * Рендерит `children` только для пилота с серверно подтверждённой сессией
 * (`status === 'valid'`). Иначе показывает `fallback` (по умолчанию — плашку
 * «нужен вход»). Пока идёт проверка — тоже fallback (если не отключено).
 */
export function AuthGuard({
  children,
  fallback,
  gateWhileChecking = true,
}: AuthGuardProps) {
  const { status } = useServerSession();

  const allowed = status === 'valid';
  const pending = status === 'checking';

  if (allowed) return createElement('div', null, children);
  if (pending && !gateWhileChecking) return createElement('div', null, children);

  return createElement(
    'div',
    { style: guardNote, role: 'status', 'aria-live': 'polite' },
    fallback ??
      (pending && !gateWhileChecking
        ? 'Проверка сессии…'
        : '🔒 Требуется вход пилота — используйте терминал PILOT REGISTRATION или панель авторизации.'),
  );
}

/* -------------------------------------------------------------------------- */
/*  SessionBadge — компактный индикатор подтверждённой сессии                 */
/* -------------------------------------------------------------------------- */

const badge: CSSProperties = {
  position: 'absolute',
  top: 20,
  left: 24,
  zIndex: 20,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 12px',
  borderRadius: 20,
  border: '1px solid rgba(110, 255, 139, 0.35)',
  background: 'rgba(20, 28, 52, 0.9)',
  color: '#e0e6f0',
  fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
  fontSize: 11,
  letterSpacing: 0.6,
};

const dot = (color: string): CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: color,
  boxShadow: `0 0 10px ${color}`,
});

const DOT = {
  valid: '#6eff8b',
  checking: '#ffd166',
  invalid: '#ff5c5c',
  idle: '#7a8baa',
} as const;

/**
 * Плоский бейдж «SEAT: <позывной>» с цветовым статусом серверной проверки.
 * Показывает только подтверждённого пилота; в остальных состояниях — null,
 * чтобы не занимать экран во время гонки.
 */
export function SessionBadge(): ReturnType<typeof createElement> | null {
  const { session, profile, status } = useServerSession();

  const label = useMemo(() => {
    if (status === 'valid') return profile?.name || profile?.email || session?.payload.email || 'PILOT';
    if (status === 'checking') return 'ПРОВЕРКА СЕССИИ…';
    return null;
  }, [status, profile, session]);

  if (!label) return null;

  return createElement(
    'div',
    { style: badge, title: profile?.email || undefined },
    createElement('span', { style: dot(DOT[status === 'valid' ? 'valid' : 'checking']) }),
    createElement('span', null, `${status === 'valid' ? 'SEAT' : 'AUTH'}: ${label}`),
  );
}

export default { useServerSession, SessionGuard, AuthGuard, SessionBadge, logoutOnServer };
