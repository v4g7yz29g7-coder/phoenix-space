/**
 * ЗАДАЧА 6.1 — HUD АВТОРИЗАЦИИ (JWT), FORMULA I1
 * ============================================================================
 * Платформа. Плоский 2D-оверлей авторизации поверх 3D-арены — «панель
 * пилота» в правом верхнем углу. Дополняет физический терминал AuthGate
 * (arena_lab/src/scene/AuthGate.tsx): если терминал стоит в мире и его
 * трудно найти/навести камерой, тот же JWT-поток доступен всегда — прямо
 * в HUD, не выходя из гонки.
 *
 * Что реализовано:
 *   • переиспользует единый zustand-стор `useAuthStore` и форму `AuthForm`
 *     из AuthGate (никакой второй логики авторизации — один источник правды);
 *   • ограниченный по высоте сворачиваемый контейнер (гарантированно не
 *     перекрывает лидерборд/радио во время заезда);
 *   • состояние пилота: позывной, e-mail, обратный отсчёт до истечения JWT;
 *   • утилиты для РЕСТ-запросов: `getAuthToken()` и `authFetch()` —
 *     автоматически подставляют `Authorization: Bearer <jwt>`;
 *   • экспорт `useAuthToken()` для socket.io / подписчиков.
 *
 * Совет Оракула учтён: сам выпуск/подпись JWT живёт на бэкенде
 * (web/server.js, эндпоинты POST /api/auth/register|login, GET /api/auth/me);
 * React только хранит и передаёт токен.
 * ============================================================================
 */

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  AUTH_STORAGE_KEY,
  AuthForm,
  useAuthHydration,
  useAuthStore,
} from './AuthGate';

/* -------------------------------------------------------------------------- */
/*  Утилиты: доступ к токену для внешних сервисов (REST / socket)             */
/* -------------------------------------------------------------------------- */

/** Возвращает сырой JWT из localStorage (или null). */
export function getAuthToken(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(AUTH_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * fetch-обёртка с автоматической подстановкой `Authorization: Bearer <jwt>`.
 * Если токена нет — запрос уходит как обычно (эндпоинт сам решит, публичный он).
 */
export async function authFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

/** Реактивная подписка на токен текущей сессии (для socket.io и др.). */
export function useAuthToken(): string | null {
  const session = useAuthStore((s) => s.session);
  return session?.token ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Обратный отсчёт до истечения токена                                       */
/* -------------------------------------------------------------------------- */

function useCountdown(expiresAt: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [expiresAt]);

  if (!expiresAt) return '∞';
  const left = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------- */
/*  HUD                                                                       */
/* -------------------------------------------------------------------------- */

const C = {
  panel: 'rgba(20, 28, 52, 0.92)',
  border: 'rgba(77, 208, 255, 0.35)',
  text: '#e0e6f0',
  dim: '#7a8baa',
  accent: '#4dd0ff',
  accent2: '#a855f7',
  ok: '#6eff8b',
  err: '#ff5c5c',
} as const;

const fab: CSSProperties = {
  position: 'absolute',
  top: 20,
  right: 24,
  zIndex: 20,
  padding: '8px 14px',
  borderRadius: 20,
  border: `1px solid ${C.border}`,
  background: 'linear-gradient(90deg, #4dd0ff, #a855f7)',
  color: '#06121f',
  fontWeight: 800,
  fontSize: 11,
  letterSpacing: 1.2,
  cursor: 'pointer',
  boxShadow: '0 0 24px rgba(77, 208, 255, 0.35)',
};

const shell: CSSProperties = {
  position: 'absolute',
  top: 20,
  right: 24,
  zIndex: 20,
  width: 380,
  maxHeight: 'calc(100vh - 160px)',
  overflowY: 'auto',
  borderRadius: 16,
  padding: 14,
  background: C.panel,
  border: `1px solid ${C.border}`,
  backdropFilter: 'blur(12px)',
  boxShadow: '0 0 40px rgba(10, 16, 32, 0.6)',
  fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
  color: C.text,
};

const headerRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 10,
};

const title: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 2,
  color: C.accent,
};

const collapseBtn: CSSProperties = {
  border: 'none',
  background: 'rgba(122,139,170,0.15)',
  color: C.dim,
  borderRadius: 8,
  width: 26,
  height: 26,
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
};

const badge: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '12px 14px',
  borderRadius: 12,
  background: 'rgba(8, 12, 24, 0.9)',
  border: `1px solid rgba(110, 255, 139, 0.35)`,
};

const logoutBtn: CSSProperties = {
  width: '100%',
  marginTop: 12,
  padding: '9px 0',
  borderRadius: 9,
  border: `1px solid rgba(255, 92, 92, 0.5)`,
  background: 'rgba(255, 92, 92, 0.12)',
  color: C.err,
  fontWeight: 800,
  letterSpacing: 1.2,
  fontSize: 11,
  cursor: 'pointer',
};

/**
 * Плоская панель пилота. Свёрнута по умолчанию — показывает кнопку
 * «PILOT LOGIN», разворачивается в полную форму AuthForm.
 */
export function AuthHUD({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const session = useAuthStore((s) => s.session);
  const logout = useAuthStore((s) => s.logout);
  useAuthHydration();

  const pilot = useMemo(
    () => (session ? String(session.payload.name || session.payload.email || 'пилот') : null),
    [session],
  );
  const countdown = useCountdown(session?.expiresAt ?? 0);

  if (!open) {
    return (
      <button type="button" style={fab} onClick={() => setOpen(true)}>
        {session ? `● ${pilot}` : '🔑 PILOT LOGIN'}
      </button>
    );
  }

  return (
    <div style={shell}>
      <div style={headerRow}>
        <span style={title}>PILOT SESSION · JWT</span>
        <button type="button" style={collapseBtn} onClick={() => setOpen(false)} title="Свернуть">
          –
        </button>
      </div>

      {session ? (
        <>
          <div style={badge}>
            <span style={{ fontSize: 16, fontWeight: 800, color: C.ok }}>● {pilot}</span>
            <span style={{ fontSize: 11, color: C.dim }}>
              {String(session.payload.email || '—')}
            </span>
            <span style={{ fontSize: 10, color: countdown === '0:00' ? C.err : C.dim }}>
              Токен истекает через {countdown}
            </span>
          </div>
          <button type="button" style={logoutBtn} onClick={logout}>
            ВЫЙТИ ИЗ СЕССИИ
          </button>
        </>
      ) : (
        <AuthForm />
      )}
    </div>
  );
}

export default AuthHUD;
