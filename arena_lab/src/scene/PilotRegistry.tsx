/**
 * ЗАДАЧА 6.1 — РЕГИСТРАЦИЯ / ЛОГИН ПИЛОТА (JWT): экран реестра, FORMULA I1
 * ============================================================================
 * Платформа. Самодостаточный DOM-оверлей «Реестр пилотов»: единый экран
 * регистрации/логина, который доводит JWT-поток задачи 6.1 до конца — от
 * формы до подтверждённой сервером сессии.
 *
 * Зачем нужен отдельный файл, когда уже есть AuthGate/AuthHUD?
 *   • AuthGate.tsx  — 3D-терминал + zustand-стор + JWT-утилиты;
 *   • AuthHUD.tsx   — компактный 2D-HUD «под рукой» + authFetch;
 *   • AuthApi.tsx   — REST-клиент POST /register|/login, GET /me;
 *   • AuthSession.tsx — серверная верификация, logout, AuthGuard/SessionGuard;
 *   • AuthBootstrap.tsx — единый хук useAuth() + валидация + срок жизни токена.
 *
 * Но НИ ОДИН из них не собирал всё это в готовый экран онбординга: полосатый
 * сабмит с полями, клиентская валидация до сети, переключение login⇄register,
 * обратный отсчёт до `exp` и карточка подтверждённого пилота. Этот файл —
 * именно такой экран, Собранный ТОЛЬКО из публичных API соседних модулей:
 *
 *   useAuth()            → session / profile / status / busy / error / login /
 *                          register / logout / recheck  (AuthBootstrap)
 *   validateCredentials()→ те же правила, что и в web/server.js (AuthBootstrap)
 *   useTokenExpiry()     → секунды до истечения JWT (AuthBootstrap)
 *   useAuthHydration()   → поднять сохранённый токен после перезагрузки (AuthGate)
 *
 * Совет Оракула соблюдён: секрет HS256 и подпись JWT живут ТОЛЬКО в
 * web/server.js. Здесь нет ни строчки криптографии и ни одного секрета —
 * экран лишь показывает, валидирует и передаёт токен, который выдал сервер.
 *
 * Reference: web/server.js (POST /api/auth/register|login, GET /api/auth/me,
 * POST /api/auth/logout). Приём auth-провайдера — research/racing-game (MIT).
 * ============================================================================
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { useAuthHydration } from './AuthGate';
import {
  MIN_PASSWORD_LENGTH,
  useAuth,
  useTokenExpiry,
  validateCredentials,
  type AuthMode,
  type CredentialErrors,
} from './AuthBootstrap';
import type { PilotProfile } from './AuthApi';

/* -------------------------------------------------------------------------- */
/*  Палитра и типовые стили                                                   */
/* -------------------------------------------------------------------------- */

const C = {
  back: 'rgba(8, 12, 22, 0.82)',
  panel: 'linear-gradient(160deg, rgba(18,26,46,0.97), rgba(11,16,30,0.97))',
  border: 'rgba(77, 208, 255, 0.35)',
  borderErr: 'rgba(255, 92, 92, 0.7)',
  text: '#e0e6f0',
  dim: '#7a8baa',
  accent: '#4dd0ff',
  accent2: '#a855f7',
  ok: '#6eff8b',
  err: '#ff5c5c',
};

const label: CSSProperties = {
  display: 'block',
  fontSize: 11,
  letterSpacing: 1.4,
  textTransform: 'uppercase',
  color: C.dim,
  marginBottom: 6,
};

const input: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  fontSize: 14,
  color: C.text,
  background: 'rgba(6, 10, 20, 0.85)',
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  outline: 'none',
};

const fieldErr: CSSProperties = {
  fontSize: 11,
  color: C.err,
  marginTop: 4,
};

function tabStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: '9px 0',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    cursor: 'pointer',
    color: active ? '#04070f' : C.dim,
    background: active
      ? `linear-gradient(90deg, ${C.accent}, ${C.accent2})`
      : 'transparent',
    border: `1px solid ${active ? 'transparent' : 'rgba(122,139,170,0.4)'}`,
    borderRadius: 8,
    transition: 'all .15s ease',
  };
}

const submitStyle = (busy: boolean): CSSProperties => ({
  width: '100%',
  marginTop: 4,
  padding: '12px 0',
  fontSize: 14,
  fontWeight: 800,
  letterSpacing: 1.6,
  textTransform: 'uppercase',
  cursor: busy ? 'wait' : 'pointer',
  opacity: busy ? 0.7 : 1,
  color: '#04070f',
  background: `linear-gradient(90deg, ${C.accent}, ${C.accent2})`,
  border: 'none',
  borderRadius: 10,
});

/* -------------------------------------------------------------------------- */
/*  Хелперы                                                                   */
/* -------------------------------------------------------------------------- */

/** Секунды → «7ч 59м» / «4м 12с» / «0с». */
function formatLeft(seconds: number | null): string {
  if (seconds === null) return '∞';
  if (seconds <= 0) return '0с';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}ч ${String(m).padStart(2, '0')}м`;
  if (m) return `${m}м ${String(s).padStart(2, '0')}с`;
  return `${s}с`;
}

/* -------------------------------------------------------------------------- */
/*  Публичный интерфейс                                                       */
/* -------------------------------------------------------------------------- */

export interface PilotRegistryProps {
  /** Управляемая видимость оверлея. Если не задана — показ по внутреннему state. */
  open?: boolean;
  /** Закрыть оверлей (крестик / клик по фону / успех). */
  onClose?: () => void;
  /** Колбэк после подтверждения сессии сервером. */
  onAuthenticated?: (profile: PilotProfile) => void;
  /** Стартовая вкладка. По умолчанию «логин». */
  initialMode?: AuthMode;
}

/**
 * `<PilotRegistry>` — экран регистрации/логина пилота.
 */
export function PilotRegistry({
  open,
  onClose,
  onAuthenticated,
  initialMode = 'login',
}: PilotRegistryProps) {
  // Поднимаем сохранённый JWT один раз — экран работает автономно.
  useAuthHydration();

  const {
    session,
    profile,
    status,
    busy,
    error,
    isAuthenticated,
    login,
    register,
    logout,
    recheck,
  } = useAuth();

  const [internalOpen, setInternalOpen] = useState(true);
  const visible = open === undefined ? internalOpen : open;

  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<CredentialErrors>({});
  const [notice, setNotice] = useState<string | null>(null);

  const { secondsLeft, expiringSoon, expired } = useTokenExpiry(session);

  const close = useCallback(() => {
    if (onClose) onClose();
    else setInternalOpen(false);
  }, [onClose]);

  // Уведомляем владельца, когда сервер подтвердил сессию.
  useEffect(() => {
    if (isAuthenticated && profile) onAuthenticated?.(profile);
  }, [isAuthenticated, profile, onAuthenticated]);

  const canSubmit = useMemo(
    () => isValid(email, password, mode),
    [email, password, mode],
  );

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setNotice(null);

      const creds = { email: email.trim(), password, name: name.trim() || undefined };
      const found = validateCredentials(
        mode === 'register' ? { ...creds, confirm } : creds,
        mode,
      );
      setErrors(found);
      if (Object.keys(found).length) return;

      const ok =
        mode === 'login'
          ? await login({ email: creds.email, password })
          : await register(creds);

      if (ok) {
        setNotice(
          mode === 'login'
            ? 'Вход выполнен — проверяю токен на сервере…'
            : 'Пилот зарегистрирован — токен подписан сервером',
        );
        setPassword('');
        setConfirm('');
      }
    },
    [email, password, confirm, name, mode, login, register],
  );

  const handleLogout = useCallback(async () => {
    await logout();
    setNotice('Вы вышли из гаража');
  }, [logout]);

  if (!visible) return null;

  return (
    <div
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: C.back,
        backdropFilter: 'blur(6px)',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380,
          maxWidth: '92vw',
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 16,
          padding: 22,
          color: C.text,
          boxShadow: '0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(168,85,247,0.15)',
        }}
      >
        {/* Шапка */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 18,
                fontWeight: 900,
                letterSpacing: 2,
                background: `linear-gradient(90deg, ${C.accent}, ${C.accent2})`,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              🏁 РЕЕСТР ПИЛОТОВ
            </div>
            <div style={{ fontSize: 11, color: C.dim, marginTop: 3 }}>
              FORMULA I1 · JWT-авторизация
            </div>
          </div>
          <button
            onClick={close}
            aria-label="Закрыть"
            style={{
              background: 'transparent',
              border: 'none',
              color: C.dim,
              fontSize: 20,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {isAuthenticated && profile ? (
          /* -------------------- Уже в сессии: карточка пилота -------------------- */
          <div>
            <div style={{ fontSize: 12, color: C.ok, letterSpacing: 1.2, marginBottom: 10 }}>
              ● СЕССИЯ ПОДТВЕРЖДЕНА СЕРВЕРОМ
            </div>
            <div
              style={{
                border: `1px solid ${C.border}`,
                borderRadius: 12,
                padding: 14,
                background: 'rgba(6,10,20,0.6)',
              }}
            >
              <Row k="ПИЛОТ" v={profile.name || profile.email.split('@')[0]} />
              <Row k="ID" v={profile.id} mono />
              <Row k="E-MAIL" v={profile.email} />
              <Row
                k="ТОКЕН ДО"
                v={
                  expired
                    ? 'истёк'
                    : `${formatLeft(secondsLeft)}${expiringSoon ? ' ⚠' : ''}`
                }
                color={expired ? C.err : expiringSoon ? '#ffd400' : C.text}
              />
            </div>

            {notice && <Notice text={notice} />}

            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button onClick={recheck} style={{ ...submitStyle(false), marginTop: 0 }}>
                Проверить
              </button>
              <button
                onClick={handleLogout}
                style={{
                  ...submitStyle(false),
                  marginTop: 0,
                  background: 'rgba(255,92,92,0.15)',
                  color: C.err,
                  border: `1px solid ${C.borderErr}`,
                }}
              >
                Выйти
              </button>
            </div>
          </div>
        ) : (
          /* ------------------------ Форма входа/регистрации ---------------------- */
          <form onSubmit={handleSubmit} noValidate>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button type="button" onClick={() => setMode('login')} style={tabStyle(mode === 'login')}>
                Вход
              </button>
              <button
                type="button"
                onClick={() => setMode('register')}
                style={tabStyle(mode === 'register')}
              >
                Регистрация
              </button>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={label} htmlFor="pr-email">
                E-mail
              </label>
              <input
                id="pr-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="pilot@formula-i1.dev"
                style={{ ...input, borderColor: errors.email ? C.borderErr : C.border }}
              />
              {errors.email && <div style={fieldErr}>{errors.email}</div>}
            </div>

            {mode === 'register' && (
              <div style={{ marginBottom: 12 }}>
                <label style={label} htmlFor="pr-name">
                  Позывной (необязательно)
                </label>
                <input
                  id="pr-name"
                  type="text"
                  autoComplete="nickname"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Например, Apex"
                  style={input}
                />
              </div>
            )}

            <div style={{ marginBottom: 12 }}>
              <label style={label} htmlFor="pr-pass">
                Пароль
              </label>
              <input
                id="pr-pass"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? `минимум ${MIN_PASSWORD_LENGTH} символов` : '••••••'}
                style={{ ...input, borderColor: errors.password ? C.borderErr : C.border }}
              />
              {errors.password && <div style={fieldErr}>{errors.password}</div>}
            </div>

            {mode === 'register' && (
              <div style={{ marginBottom: 12 }}>
                <label style={label} htmlFor="pr-confirm">
                  Повтор пароля
                </label>
                <input
                  id="pr-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="••••••"
                  style={{ ...input, borderColor: errors.confirm ? C.borderErr : C.border }}
                />
                {errors.confirm && <div style={fieldErr}>{errors.confirm}</div>}
              </div>
            )}

            {error && <div style={{ ...fieldErr, fontSize: 12, marginBottom: 8 }}>⚠ {error}</div>}
            {notice && <Notice text={notice} />}

            <button type="submit" disabled={busy || !canSubmit} style={submitStyle(busy)}>
              {busy
                ? 'Секунду…'
                : mode === 'login'
                ? '▶ Войти в гараж'
                : '▶ Создать пилота'}
            </button>

            <div style={{ fontSize: 10, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
              JWT (HS256) подписывается на бэкенде <code>web/server.js</code>. Пароль
              хешируется scrypt; браузер хранит только токен.
            </div>

            {status === 'checking' && (
              <div style={{ fontSize: 10, color: C.accent, marginTop: 8 }}>
                проверяю токен через GET /api/auth/me…
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Мелкие презентационные детали                                             */
/* -------------------------------------------------------------------------- */

function Row({ k, v, mono, color }: { k: string; v: string; mono?: boolean; color?: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 12, padding: '4px 0' }}>
      <div style={{ width: 84, color: C.dim, letterSpacing: 1 }}>{k}</div>
      <div
        style={{
          flex: 1,
          color: color ?? C.text,
          fontFamily: mono ? 'ui-monospace, monospace' : undefined,
          wordBreak: 'break-all',
        }}
      >
        {v}
      </div>
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: C.ok,
        background: 'rgba(110,255,139,0.08)',
        border: '1px solid rgba(110,255,139,0.35)',
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 10,
      }}
    >
      {text}
    </div>
  );
}

/** Быстрая проверка «можно ли отправлять» без отметки ошибок (для disabled). */
function isValid(email: string, password: string, mode: AuthMode): boolean {
  const mail = email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return false;
  if (!password) return false;
  if (mode === 'register' && password.length < MIN_PASSWORD_LENGTH) return false;
  return true;
}

export default PilotRegistry;
