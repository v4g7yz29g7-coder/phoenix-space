/**
 * ЗАДАЧА 6.1 — РЕГИСТРАЦИЯ / ЛОГИН (JWT), FORMULA I1
 * ============================================================================
 * Платформа. Экран авторизации пилота, встроенный в сцену арены как
 * физический терминал «PILOT REGISTRATION» возле пит-лейна.
 *
 * Что реализовано:
 *   • JWT-утилиты: base64url-декод payload, проверка `exp`, сборка сессии;
 *     (только браузерные atob/btoa — без зависимостей и без Node-полифиллов);
 *   • безопасное хранение токена в localStorage под ключом FORMULA I1;
 *   • API-клиент `POST /api/auth/{register,login}` → { token | access_token };
 *     в dev-режиме при сетевой недоступности бэкенда выпускается локальный
 *     dev-JWT (alg:"none"), чтобы арену можно было проверять офлайн;
 *   • zustand-стор `useAuthStore` (session/status/error + hydrate/login/register/logout);
 *   • 3D-терминал: корпус, наклонный LED-экран, пульсирующий маячок и
 *     интерактивная форма через <Html transform> из @react-three/drei.
 *
 * Приёмы взяты из research/racing-game (MIT):
 *   - src/ui/Auth.tsx — экран «Want to save your score?» и паттерн auth-провайдеров
 *     (мы заменили Supabase-OAuth на собственный JWT email/password-поток);
 *   - src/ui/Intro.tsx — «Click to start»-онбординг перед стартом.
 * Код собственный, в терминах проекта AI-1.
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { create } from 'zustand';

/* -------------------------------------------------------------------------- */
/*  JWT: типы и утилиты                                                       */
/* -------------------------------------------------------------------------- */

export interface JWTPayload {
  sub?: string;
  email?: string;
  name?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

export interface AuthSession {
  token: string;
  payload: JWTPayload;
  /** Абсолютное время истечения, мс (0 — бессрочно/неизвестно). */
  expiresAt: number;
}

export interface Credentials {
  email: string;
  password: string;
  /** Только для регистрации. */
  name?: string;
}

/** Ключ хранения JWT в localStorage. */
export const AUTH_STORAGE_KEY = 'formula_i1.jwt';

/** Базовый URL auth-API (переопределяется через VITE_API_BASE). */
const env = import.meta.env as Record<string, string | boolean | undefined>;
export const AUTH_API_BASE =
  typeof env.VITE_API_BASE === 'string' && env.VITE_API_BASE
    ? env.VITE_API_BASE
    : '/api/auth';

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return atob(b64);
}

function base64UrlEncode(value: string): string {
  const b64 = btoa(unescape(encodeURIComponent(value)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Декодирует payload JWT. Возвращает null для мусора/не-JWT строк. */
export function decodeJwt(token: string): JWTPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const json = base64UrlDecode(parts[1]);
    const payload = JSON.parse(json) as JWTPayload;
    return typeof payload === 'object' && payload !== null ? payload : null;
  } catch {
    return null;
  }
}

/** Проверка срока действия (с запасом skewSec секунд). */
export function isExpired(payload: JWTPayload | null, skewSec = 5): boolean {
  if (!payload || typeof payload.exp !== 'number') return false;
  return payload.exp * 1000 <= Date.now() + skewSec * 1000;
}

/** Собирает сессию из сырого токена; null — если токен нечитаем или просрочен. */
export function buildSession(token: string, allowExpired = false): AuthSession | null {
  const payload = decodeJwt(token);
  if (!payload) return null;
  if (!allowExpired && isExpired(payload)) return null;
  return { token, payload, expiresAt: (payload.exp ?? 0) * 1000 };
}

/**
 * DEV-фолбэк: локальный невалидный (alg:"none") JWT для офлайн-проверки UI.
 * НИКОГДА не используется как продакшен-токен — только под import.meta.env.DEV.
 */
export function createDemoToken(email: string, name?: string, ttlSec = 3600): string {
  const header = { alg: 'none', typ: 'JWT', dev: true };
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    sub: email,
    email,
    name: name || email.split('@')[0],
    iat: now,
    exp: now + ttlSec,
    dev: true,
  };
  const signature = `dev_${Math.random().toString(36).slice(2, 10)}`;
  return [
    base64UrlEncode(JSON.stringify(header)),
    base64UrlEncode(JSON.stringify(payload)),
    signature,
  ].join('.');
}

/* -------------------------------------------------------------------------- */
/*  Хранилище токена                                                          */
/* -------------------------------------------------------------------------- */

export function readStoredToken(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(AUTH_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(token: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (token) localStorage.setItem(AUTH_STORAGE_KEY, token);
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    /* приватный режим / quota — игнорируем */
  }
}

/* -------------------------------------------------------------------------- */
/*  API-клиент                                                                */
/* -------------------------------------------------------------------------- */

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${AUTH_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { message?: string; error?: string };
      if (data && (data.message || data.error)) message = data.message || data.error || message;
    } catch {
      /* тело не JSON — оставляем HTTP-код */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** Запрашивает JWT у бэкенда; в dev при сетевом сбое — локальный dev-JWT. */
async function requestSession(path: '/register' | '/login', creds: Credentials): Promise<AuthSession> {
  try {
    const data = await postJson<{ token?: string; access_token?: string }>(path, creds);
    const token = data.token || data.access_token;
    if (!token) throw new Error('Сервер не вернул JWT');
    const session = buildSession(token);
    if (!session) throw new Error('Сервер вернул некорректный JWT');
    return session;
  } catch (err) {
    const isNetworkError = err instanceof TypeError; // fetch reject (нет бэкенда)
    if (isNetworkError && import.meta.env.DEV) {
      const demo = buildSession(createDemoToken(creds.email, creds.name));
      if (demo) return demo;
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*  Стор авторизации                                                          */
/* -------------------------------------------------------------------------- */

export type AuthStatus = 'idle' | 'loading' | 'error';

interface AuthState {
  session: AuthSession | null;
  status: AuthStatus;
  error: string | null;
  hydrate: () => void;
  login: (creds: Credentials) => Promise<boolean>;
  register: (creds: Credentials) => Promise<boolean>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  status: 'idle',
  error: null,

  hydrate: () => {
    const token = readStoredToken();
    if (!token) return;
    const session = buildSession(token);
    if (!session) {
      writeStoredToken(null);
      return;
    }
    set({ session });
  },

  login: async (creds) => {
    set({ status: 'loading', error: null });
    try {
      const session = await requestSession('/login', creds);
      writeStoredToken(session.token);
      set({ session, status: 'idle', error: null });
      return true;
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : 'Ошибка входа' });
      return false;
    }
  },

  register: async (creds) => {
    set({ status: 'loading', error: null });
    try {
      const session = await requestSession('/register', creds);
      writeStoredToken(session.token);
      set({ session, status: 'idle', error: null });
      return true;
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : 'Ошибка регистрации' });
      return false;
    }
  },

  logout: () => {
    writeStoredToken(null);
    set({ session: null, status: 'idle', error: null });
  },
}));

/** Хук авто-гидратации: поднять сохранённую сессию один раз при монтировании. */
export function useAuthHydration(): void {
  const hydrate = useAuthStore((s) => s.hydrate);
  useEffect(() => {
    hydrate();
  }, [hydrate]);
}

/* -------------------------------------------------------------------------- */
/*  Стили экрана терминала                                                    */
/* -------------------------------------------------------------------------- */

const C = {
  bg: 'rgba(10, 16, 32, 0.94)',
  panel: 'rgba(20, 28, 52, 0.98)',
  border: 'rgba(77, 208, 255, 0.35)',
  text: '#e0e6f0',
  dim: '#7a8baa',
  accent: '#4dd0ff',
  accent2: '#a855f7',
  ok: '#6eff8b',
  err: '#ff5c5c',
} as const;

const screenStyle: CSSProperties = {
  width: 360,
  padding: 18,
  borderRadius: 14,
  background: C.bg,
  border: `1px solid ${C.border}`,
  boxShadow: '0 0 40px rgba(77, 208, 255, 0.25)',
  fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
  color: C.text,
  userSelect: 'none',
};

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  marginTop: 6,
  marginBottom: 12,
  padding: '9px 11px',
  borderRadius: 8,
  border: '1px solid rgba(122, 139, 170, 0.4)',
  background: 'rgba(8, 12, 24, 0.9)',
  color: C.text,
  fontSize: 13,
  outline: 'none',
};

const labelStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: 1.5,
  color: C.dim,
  textTransform: 'uppercase',
};

const tabBase: CSSProperties = {
  flex: 1,
  padding: '8px 0',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 1,
  cursor: 'pointer',
  border: 'none',
  borderRadius: 8,
  transition: 'background 0.15s',
};

const buttonStyle: CSSProperties = {
  width: '100%',
  padding: '11px 0',
  marginTop: 4,
  borderRadius: 9,
  border: 'none',
  cursor: 'pointer',
  fontWeight: 800,
  letterSpacing: 1.2,
  fontSize: 12,
  color: '#06121f',
  background: `linear-gradient(90deg, ${C.accent}, ${C.accent2})`,
};

/* -------------------------------------------------------------------------- */
/*  Форма авторизации (внутри <Html>)                                         */
/* -------------------------------------------------------------------------- */

type AuthMode = 'login' | 'register';

export function AuthForm() {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const session = useAuthStore((s) => s.session);
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const logout = useAuthStore((s) => s.logout);

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setLocalError(null);
      if (!email.includes('@')) {
        setLocalError('Введите корректный e-mail');
        return;
      }
      if (password.length < 6) {
        setLocalError('Пароль минимум 6 символов');
        return;
      }
      if (mode === 'register') await register({ email, password, name: name || undefined });
      else await login({ email, password });
    },
    [email, password, name, mode, login, register],
  );

  if (session) {
    const pilot = session.payload.name || session.payload.email || 'пилот';
    return (
      <div style={screenStyle}>
        <div style={{ fontSize: 10, letterSpacing: 2, color: C.accent }}>FORMULA I1 · ACCESS GRANTED</div>
        <div style={{ marginTop: 12, fontSize: 18, fontWeight: 800, color: C.ok }}>
          ● {String(pilot)}
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: C.dim }}>
          {String(session.payload.email || '—')}
        </div>
        <div style={{ marginTop: 4, fontSize: 10, color: C.dim }}>
          JWT до: {session.expiresAt ? new Date(session.expiresAt).toLocaleTimeString('ru-RU') : '—'}
        </div>
        <button type="button" style={{ ...buttonStyle, marginTop: 16 }} onClick={logout}>
          ВЫЙТИ
        </button>
      </div>
    );
  }

  return (
    <form style={screenStyle} onSubmit={onSubmit}>
      <div style={{ fontSize: 10, letterSpacing: 2, color: C.accent }}>PILOT REGISTRATION</div>
      <div style={{ fontSize: 16, fontWeight: 800, marginTop: 6, marginBottom: 12 }}>FORMULA I1</div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {(['login', 'register'] as AuthMode[]).map((m) => (
          <button
            key={m}
            type="button"
            style={{
              ...tabBase,
              color: mode === m ? '#06121f' : C.dim,
              background: mode === m ? `linear-gradient(90deg, ${C.accent}, ${C.accent2})` : 'rgba(122,139,170,0.12)',
            }}
            onClick={() => {
              setMode(m);
              setLocalError(null);
            }}
          >
            {m === 'login' ? 'ВХОД' : 'РЕГИСТРАЦИЯ'}
          </button>
        ))}
      </div>

      {mode === 'register' && (
        <>
          <label style={labelStyle} htmlFor="auth-name">Позывной</label>
          <input
            id="auth-name"
            style={inputStyle}
            value={name}
            placeholder="agent_1"
            autoComplete="nickname"
            onChange={(e) => setName(e.target.value)}
          />
        </>
      )}

      <label style={labelStyle} htmlFor="auth-email">E-mail</label>
      <input
        id="auth-email"
        style={inputStyle}
        type="email"
        value={email}
        placeholder="pilot@formula-i1.dev"
        autoComplete="email"
        onChange={(e) => setEmail(e.target.value)}
      />

      <label style={labelStyle} htmlFor="auth-password">Пароль</label>
      <input
        id="auth-password"
        style={inputStyle}
        type="password"
        value={password}
        placeholder="••••••"
        autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
        onChange={(e) => setPassword(e.target.value)}
      />

      {(localError || error) && (
        <div style={{ color: C.err, fontSize: 11, marginBottom: 10 }}>
          {localError || error}
        </div>
      )}

      <button type="submit" style={buttonStyle} disabled={status === 'loading'}>
        {status === 'loading' ? 'СОЕДИНЕНИЕ…' : mode === 'login' ? 'ВОЙТИ НА ТРАССУ' : 'СОЗДАТЬ ПИЛОТА'}
      </button>

      <div style={{ marginTop: 10, fontSize: 10, color: C.dim, lineHeight: 1.4 }}>
        Токен подписанного JWT хранится локально и подставляется в REST/Socket-запросы.
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*  3D-терминал                                                               */
/* -------------------------------------------------------------------------- */

export interface AuthGateProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
}

/** Пульсирующий маячок «терминал свободен/занят». */
function Beacon({ active }: { active: boolean }) {
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (!mat.current) return;
    const speed = active ? 1.5 : 4;
    mat.current.emissiveIntensity = 0.6 + Math.sin(clock.getElapsedTime() * speed) * 0.5;
  });
  const color = active ? '#6eff8b' : '#4dd0ff';
  return (
    <mesh position={[0, 3.05, 0]}>
      <sphereGeometry args={[0.16, 16, 16]} />
      <meshStandardMaterial ref={mat} color={color} emissive={color} emissiveIntensity={1} />
    </mesh>
  );
}

/**
 * Физический терминал регистрации пилота: корпус, наклонный экран и
 * интерактивная DOM-форма (drei <Html transform>), проецируемая в сцену.
 * Размещается в мире; читает/пишет JWT-сессию через useAuthStore.
 */
export function AuthGate({ position = [0, 0, 0], rotation = [0, 0, 0] }: AuthGateProps) {
  const session = useAuthStore((s) => s.session);
  useAuthHydration();

  return (
    <group position={position} rotation={rotation}>
      {/* основание */}
      <mesh position={[0, 0.25, 0]} receiveShadow castShadow>
        <boxGeometry args={[2.4, 0.5, 1.4]} />
        <meshStandardMaterial color="#22283c" metalness={0.6} roughness={0.4} />
      </mesh>
      {/* стойка */}
      <mesh position={[0, 1.4, 0]} castShadow>
        <boxGeometry args={[0.5, 1.8, 0.5]} />
        <meshStandardMaterial color="#2c3550" metalness={0.7} roughness={0.35} />
      </mesh>
      {/* корпус экрана (наклонён к подходящему пилоту) */}
      <mesh position={[0, 2.25, 0.05]} rotation={[-Math.PI / 14, 0, 0]} castShadow>
        <boxGeometry args={[2.0, 1.3, 0.14]} />
        <meshStandardMaterial color="#151c30" metalness={0.5} roughness={0.5} />
      </mesh>
      {/* светящаяся рамка экрана */}
      <mesh position={[0, 2.25, 0.13]} rotation={[-Math.PI / 14, 0, 0]}>
        <planeGeometry args={[1.86, 1.16]} />
        <meshStandardMaterial color="#0a1020" emissive="#4dd0ff" emissiveIntensity={0.25} />
      </mesh>
      <Beacon active={!!session} />

      {/* интерактивная форма */}
      <Html
        transform
        occlude
        position={[0, 2.25, 0.16]}
        rotation={[-Math.PI / 14, 0, 0]}
        distanceFactor={2.2}
        pointerEvents="auto"
      >
        <AuthForm />
      </Html>
    </group>
  );
}

export default AuthGate;
