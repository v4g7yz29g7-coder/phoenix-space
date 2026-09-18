/**
 * ЗАДАЧА 6.1 — РЕГИСТРАЦИЯ / ЛОГИН (JWT): REST-клиент, FORMULA I1
 * ============================================================================
 * Платформа. Тонкий типизированный клиент к бэкенд-эндпоинтам авторизации
 * (`web/server.js`): POST /api/auth/register, POST /api/auth/login,
 * GET /api/auth/me. Дополняет терминал `AuthGate` и HUD `AuthHUD`, которые
 * отвечают за UI/сессию; здесь — чистая работа с network-слоем и проверка
 * токена на сервере.
 *
 * Совет Оракула: выпуск/подпись JWT живёт на бэкенде — React только
 * запрашивает, хранит и подставляет токен. Никаких секретов в браузере.
 *
 * Приёмы из research/racing-game (MIT, src/ui/Auth.tsx): провайдер-подход
 * к аутентификации; реализация собственного email/password JWT-потока
 * вместо стороннего OAuth. Код собственный, в терминах проекта AI-1.
 * ============================================================================
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AUTH_API_BASE,
  AUTH_STORAGE_KEY,
  buildSession,
  decodeJwt,
  type AuthSession,
  type Credentials,
} from './AuthGate';

/* -------------------------------------------------------------------------- */
/*  Публичные типы                                                            */
/* -------------------------------------------------------------------------- */

export interface PilotProfile {
  id: string;
  email: string;
  name?: string;
  createdAt?: number;
}

/** Нормализованная ошибка auth-API с HTTP-кодом (0 — сетевой сбой). */
export class AuthApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'AuthApiError';
    this.status = status;
  }
}

interface AuthResponse {
  token?: string;
  access_token?: string;
  user?: PilotProfile;
}

/* -------------------------------------------------------------------------- */
/*  Низкоуровневый HTTP                                                       */
/* -------------------------------------------------------------------------- */

function storedToken(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(AUTH_STORAGE_KEY);
  } catch {
    return null;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${AUTH_API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
  } catch (err) {
    throw new AuthApiError(err instanceof Error ? err.message : 'Сеть недоступна', 0);
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { message?: string; error?: string };
      if (data && (data.message || data.error)) message = data.message || data.error || message;
    } catch {
      /* тело не JSON — оставляем код */
    }
    throw new AuthApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* -------------------------------------------------------------------------- */
/*  Операции                                                                  */
/* -------------------------------------------------------------------------- */

/** После успешного ответа собирает валидную сессию из токена. */
function sessionFrom(data: AuthResponse): AuthSession {
  const token = data.token || data.access_token;
  if (!token) throw new AuthApiError('Сервер не вернул JWT', 500);
  const session = buildSession(token);
  if (!session) throw new AuthApiError('Сервер вернул некорректный JWT', 500);
  return session;
}

/** POST /api/auth/register — создать пилота, вернуть JWT-сессию. */
export async function registerPilot(creds: Credentials): Promise<AuthSession> {
  const data = await call<AuthResponse>('/register', {
    method: 'POST',
    body: JSON.stringify(creds),
  });
  return sessionFrom(data);
}

/** POST /api/auth/login — вход, вернуть JWT-сессию. */
export async function loginPilot(creds: Credentials): Promise<AuthSession> {
  const data = await call<AuthResponse>('/login', {
    method: 'POST',
    body: JSON.stringify(creds),
  });
  return sessionFrom(data);
}

/**
 * GET /api/auth/me — серверная проверка токена (подпись + срок).
 * Бросает AuthApiError(401), если токен недействителен.
 */
export async function fetchMe(token?: string | null): Promise<PilotProfile> {
  const jwt = token ?? storedToken();
  if (!jwt) throw new AuthApiError('Нет сохранённого JWT', 401);
  const data = await call<{ user: PilotProfile }>('/me', {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return data.user;
}

/* -------------------------------------------------------------------------- */
/*  Хук: верификация текущей сессии на сервере                                */
/* -------------------------------------------------------------------------- */

export type VerifyStatus = 'idle' | 'checking' | 'valid' | 'invalid';

/**
 * `useVerifySession(session)` — проверяет сессию через GET /api/auth/me.
 * Возвращает `verified` (профиль с бэкенда) и текущий `status`.
 * Полезно, чтобы отсеять локально живые, но серверно невалидные токены.
 */
export function useVerifySession(session: AuthSession | null): {
  status: VerifyStatus;
  verified: PilotProfile | null;
  resync: () => void;
} {
  const [status, setStatus] = useState<VerifyStatus>('idle');
  const [verified, setVerified] = useState<PilotProfile | null>(null);
  const [nonce, setNonce] = useState(0);

  const resync = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!session) {
      setStatus('idle');
      setVerified(null);
      return;
    }
    let alive = true;
    setStatus('checking');
    fetchMe(session.token)
      .then((user) => {
        if (!alive) return;
        setVerified(user);
        setStatus('valid');
      })
      .catch(() => {
        if (!alive) return;
        setVerified(null);
        setStatus('invalid');
      });
    return () => {
      alive = false;
    };
  }, [session, nonce]);

  return { status, verified, resync };
}

/**
 * Хелпер для отладки: локальная проверка payload без обращения к серверу.
 * `expired` — токен просрочен по часам клиента.
 */
export function inspectToken(token: string | null): { payload: ReturnType<typeof decodeJwt>; expired: boolean } {
  const payload = token ? decodeJwt(token) : null;
  const expired = !!payload && typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now();
  return { payload, expired };
}

export default { registerPilot, loginPilot, fetchMe, useVerifySession, inspectToken };
