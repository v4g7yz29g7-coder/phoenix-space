/**
 * ЗАДАЧА 6.4 — СОЗДАНИЕ АГЕНТА  (FORMULA I1 · Platform)
 * ============================================================================
 * Платформа. Физический «АГЕНТНЫЙ ЦЕХ» (AGENT FOUNDRY) в паддоке — станция,
 * где пилот конфигурирует и регистрирует нового агента команды.
 *
 * Что реализовано:
 *   • доменные типы `AgentDraft` / `AgentRecord`, роли `AgentRole`, навыки и
 *     палитра командных цветов (без внешних ассетов);
 *   • zustand-стор `useAgentCreator` (draft + roster + loading/saving/online/error)
 *     с операциями `setName/setColor/setRole/toggleSkill/resetDraft/loadRoster/createAgent`;
 *   • REST-клиент с JWT-авторизацией из общего хранилища AuthGate
 *     (ключ `formula_i1.jwt`, same-origin `/api` по умолчанию, см. web/server.js):
 *       - GET  /api/boxes    → roster существующих агентов (реальный endpoint);
 *       - POST /api/agents   → создание агента (контракт; при offline/404 в dev
 *         выпускается локальный агент, чтобы цех оставался интерактивным);
 *   • 3D-цех: приподнятый подиум, навес на стойках, наклонное LED-табло с
 *     интерактивной DOM-формой (drei <Html transform>), вращающийся макет
 *     агента (`AgentAvatar`) на стенде-подиуме, кольцо цветовых образцов и
 *     LED-борд с roster команды.
 *
 * Приёмы взяты из research/racing-game (MIT):
 *   - src/ui/PickColor.tsx — палитра цветов как отдельный интерактивный узел;
 *   - src/ui/Intro.tsx     — «Click to start»-онбординг перед стартом;
 *   - src/store.ts         — zustand-стор как единственный источник UI-состояния;
 *   - src/models/vehicle   — анимация кадра через мутацию ref'ов, без ререндеров.
 * Код собственный, в терминах проекта AI-1.
 * ============================================================================
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { useFrame } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { Html, Text } from '@react-three/drei';
import * as THREE from 'three';
import { create } from 'zustand';
import { readStoredToken } from './AuthGate';
import { AgentAvatar } from './AgentAvatar';

/* -------------------------------------------------------------------------- */
/*  Домен агента                                                              */
/* -------------------------------------------------------------------------- */

/** Роль агента в команде — влияет на подпись, глиф и стартовый набор навыков. */
export type AgentRole = 'scout' | 'builder' | 'analyst' | 'fixer' | 'racer';

export interface AgentRoleDef {
  id: AgentRole;
  label: string;
  glyph: string;
  hint: string;
}

/** Роли агентов (как в research/racing-game src/ui/PickColor — пресеты выбора). */
export const AGENT_ROLES: AgentRoleDef[] = [
  { id: 'scout', label: 'Разведчик', glyph: '🛰', hint: 'поиск данных и источников' },
  { id: 'builder', label: 'Инженер', glyph: '🛠', hint: 'код и пайплайны' },
  { id: 'analyst', label: 'Аналитик', glyph: '📊', hint: 'метрики и гипотезы' },
  { id: 'fixer', label: 'Фиксер', glyph: '⚡', hint: 'хотфиксы и стабилизация' },
  { id: 'racer', label: 'Гонщик', glyph: '🏎', hint: 'максимум скорости на трассе' },
];

export interface SkillDef {
  id: string;
  label: string;
}

/** Доступные навыки агента (чипы в форме). */
export const AGENT_SKILLS: SkillDef[] = [
  { id: 'python', label: 'Python' },
  { id: 'sql', label: 'SQL' },
  { id: 'rag', label: 'RAG' },
  { id: 'vision', label: 'Vision' },
  { id: 'ops', label: 'DevOps' },
  { id: 'radio', label: 'Радио' },
];

/** Командная палитра (совпадает с цветами агентов в store/arena.ts). */
export const AGENT_COLOR_PALETTE = [
  '#4dd0ff',
  '#ff7eb6',
  '#a855f7',
  '#6eff8b',
  '#ffd700',
  '#ff5c5c',
  '#7dd3fc',
  '#fb923c',
] as const;

/** Черновик нового агента, редактируемый в форме цеха. */
export interface AgentDraft {
  name: string;
  color: string;
  role: AgentRole;
  skills: string[];
}

/** Зарегистрированный агент — как его отдаём в roster и в стор гонки. */
export interface AgentRecord {
  id: string;
  name: string;
  color: string;
  role: AgentRole;
  skills: string[];
  createdAt: number;
  owner?: string;
  /** Откуда пришла запись: с бэкенда или создана локально (dev-offline). */
  origin: 'server' | 'local';
  /** Кол-во навыков, известное от бэкенда (boxes/skillsCount). */
  skillCount?: number;
}

/** Версия модуля «Агентный цех» (задача 6.4) — для телеметрии/диагностики. */
export const AGENT_CREATOR_VERSION = '1.0.0';

/** Серверный контракт имени агента (совпадает с проверкой в web/server.js). */
export const AGENT_NAME_RE = /^[a-zA-Z0-9_\-.]+$/;

/** Максимальная длина имени агента, принимаемая цехом. */
export const AGENT_NAME_MAX = 32;

/** Пресеты-шаблоны быстрого старта: применяются кнопкой «Шаблон». */
export const AGENT_PRESETS: ReadonlyArray<{ label: string; draft: AgentDraft }> = [
  { label: 'Скаут', draft: { name: 'scout_1', color: '#4dd0ff', role: 'scout', skills: ['rag', 'radio'] } },
  { label: 'Инженер', draft: { name: 'builder_1', color: '#a855f7', role: 'builder', skills: ['python', 'ops'] } },
  { label: 'Аналитик', draft: { name: 'analyst_1', color: '#6eff8b', role: 'analyst', skills: ['sql', 'python'] } },
];

/**
 * Валидирует имя агента перед отправкой в `/api/agents`.
 * Возвращает `{ ok }` либо `{ ok:false, reason }` с человекочитаемой причиной
 * — используется и формой цеха, и стором при генерации дефолтного имени.
 */
export function validateAgentName(name: string): { ok: boolean; reason?: string } {
  const trimmed = (name || '').trim();
  if (!trimmed) return { ok: false, reason: 'Имя не может быть пустым' };
  if (trimmed.length > AGENT_NAME_MAX) {
    return { ok: false, reason: `Имя: максимум ${AGENT_NAME_MAX} символа` };
  }
  if (!AGENT_NAME_RE.test(trimmed)) {
    return { ok: false, reason: 'Имя: латиница/цифры, _ - .' };
  }
  return { ok: true };
}

/** Первые два символа имени — для глифа на бирке агента. */
export function agentInitials(name: string): string {
  return (name || '??').replace(/[^a-zA-Z0-9_\-.]/g, '').slice(0, 2).toUpperCase() || '??';
}

/* -------------------------------------------------------------------------- */
/*  API-клиент (JWT из AuthGate, контракт web/server.js)                      */
/* -------------------------------------------------------------------------- */

const env = import.meta.env as Record<string, string | boolean | undefined>;

/** База агент-API: `VITE_AGENT_API_BASE` либо same-origin `/api`. */
export const AGENT_API_BASE =
  typeof env.VITE_AGENT_API_BASE === 'string' && env.VITE_AGENT_API_BASE
    ? env.VITE_AGENT_API_BASE
    : '/api';

/** Заголовок `Authorization: Bearer <jwt>` из общего хранилища сессии. */
export function authHeaders(): Record<string, string> {
  const token = readStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface ServerBox {
  box?: string;
  meta?: { name?: string; strategy?: string; created_by?: string; created_at?: string } | null;
  skillsCount?: number;
}

/** Угадывает роль агента по строке стратегии из BOX_META. */
function roleFromStrategy(strategy?: string): AgentRole {
  const s = (strategy || '').toLowerCase();
  if (s.includes('adversar') || s.includes('devil') || s.includes('critic')) return 'analyst';
  if (s.includes('fix') || s.includes('hot')) return 'fixer';
  if (s.includes('fast') || s.includes('racing') || s.includes('speed')) return 'racer';
  if (s.includes('search') || s.includes('scout')) return 'scout';
  return 'builder';
}

/** Детерминированный цвет по имени (совпадает по духу с COLORS в store). */
function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AGENT_COLOR_PALETTE[h % AGENT_COLOR_PALETTE.length];
}

/** Нормализует запись `/api/boxes` в доменный AgentRecord. */
function normalizeBox(box: ServerBox): AgentRecord {
  const name = box.box || box.meta?.name || 'agent_?';
  return {
    id: name,
    name,
    color: colorForName(name),
    role: roleFromStrategy(box.meta?.strategy),
    skills: [],
    createdAt: box.meta?.created_at ? Date.parse(box.meta.created_at) || Date.now() : Date.now(),
    owner: box.meta?.created_by,
    origin: 'server',
    skillCount: box.skillsCount,
  };
}

/** GET /api/boxes — список существующих агентов (без падения при офлайне). */
export async function fetchRoster(): Promise<AgentRecord[]> {
  const res = await fetch(`${AGENT_API_BASE}/boxes`, { headers: { ...authHeaders() } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as ServerBox[] | { boxes?: ServerBox[] };
  const list = Array.isArray(data) ? data : data.boxes || [];
  return list.map(normalizeBox);
}

/** POST /api/agents — создание агента; возвращает запись либо null при офлайне. */
export async function postAgent(draft: AgentDraft): Promise<AgentRecord | null> {
  const res = await fetch(`${AGENT_API_BASE}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      name: draft.name.trim(),
      color: draft.color,
      role: draft.role,
      skills: draft.skills,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Partial<AgentRecord>;
  return {
    id: data.id || draft.name.trim(),
    name: data.name || draft.name.trim(),
    color: data.color || draft.color,
    role: (data.role as AgentRole) || draft.role,
    skills: data.skills || draft.skills,
    createdAt: data.createdAt || Date.now(),
    owner: data.owner,
    origin: 'server',
  };
}

/* -------------------------------------------------------------------------- */
/*  Стор «Агентный цех»                                                       */
/* -------------------------------------------------------------------------- */

const DEFAULT_DRAFT: AgentDraft = {
  name: '',
  color: AGENT_COLOR_PALETTE[0],
  role: 'builder',
  skills: [],
};

export interface AgentCreatorState {
  draft: AgentDraft;
  roster: AgentRecord[];
  loading: boolean;
  saving: boolean;
  /** null — ещё не проверяли, true/false — доступен ли бэкенд. */
  online: boolean | null;
  error: string | null;
  justCreated: AgentRecord | null;
  setName: (v: string) => void;
  setColor: (v: string) => void;
  setRole: (v: AgentRole) => void;
  toggleSkill: (id: string) => void;
  applyPreset: (draft: AgentDraft) => void;
  resetDraft: () => void;
  clearJustCreated: () => void;
  loadRoster: () => Promise<void>;
  createAgent: () => Promise<AgentRecord | null>;
}

export const useAgentCreator = create<AgentCreatorState>((set, get) => ({
  draft: { ...DEFAULT_DRAFT },
  roster: [],
  loading: false,
  saving: false,
  online: null,
  error: null,
  justCreated: null,

  setName: (v) => set((s) => ({ draft: { ...s.draft, name: v }, error: null })),
  setColor: (v) => set((s) => ({ draft: { ...s.draft, color: v } })),
  setRole: (v) => set((s) => ({ draft: { ...s.draft, role: v } })),
  toggleSkill: (id) =>
    set((s) => {
      const has = s.draft.skills.includes(id);
      const skills = has ? s.draft.skills.filter((x) => x !== id) : [...s.draft.skills, id];
      return { draft: { ...s.draft, skills } };
    }),
  applyPreset: (draft) => set({ draft: { ...draft, skills: [...draft.skills] }, error: null }),
  resetDraft: () => set({ draft: { ...DEFAULT_DRAFT }, error: null, justCreated: null }),
  clearJustCreated: () => set({ justCreated: null }),

  loadRoster: async () => {
    set({ loading: true, error: null });
    try {
      const roster = await fetchRoster();
      set({ roster, loading: false, online: true });
    } catch (err) {
      set({
        loading: false,
        online: false,
        error: err instanceof Error ? err.message : 'Не удалось загрузить roster',
      });
    }
  },

  createAgent: async () => {
    const { draft, roster } = get();
    const check = validateAgentName(draft.name);
    if (!check.ok) {
      set({ error: check.reason || 'Некорректное имя' });
      return null;
    }
    if (roster.some((a) => a.name === draft.name.trim())) {
      set({ error: 'Агент с таким именем уже существует' });
      return null;
    }
    set({ saving: true, error: null });
    try {
      const record = await postAgent(draft);
      if (!record) throw new Error('Пустой ответ сервера');
      set({ saving: false, online: true, justCreated: record, roster: [...roster, record] });
      return record;
    } catch (err) {
      if (env.DEV) {
        // DEV-офлайн: локальный агент, чтобы цех оставался интерактивным.
        const record: AgentRecord = {
          id: draft.name.trim(),
          name: draft.name.trim(),
          color: draft.color,
          role: draft.role,
          skills: [...draft.skills],
          createdAt: Date.now(),
          origin: 'local',
        };
        set({ saving: false, online: false, justCreated: record, roster: [...roster, record] });
        return record;
      }
      set({
        saving: false,
        online: false,
        error: err instanceof Error ? err.message : 'Не удалось создать агента',
      });
      return null;
    }
  },
}));

/* -------------------------------------------------------------------------- */
/*  DOM-форма цеха (живёт внутри drei <Html transform>)                       */
/* -------------------------------------------------------------------------- */

const panelStyle: CSSProperties = {
  width: 340,
  padding: '16px 18px 18px',
  borderRadius: 14,
  background: 'linear-gradient(180deg, rgba(9,16,30,0.96), rgba(6,10,20,0.96))',
  border: '1px solid rgba(110,255,139,0.35)',
  boxShadow: '0 18px 48px rgba(0,0,0,0.6), inset 0 0 24px rgba(77,208,255,0.08)',
  color: '#e0e6f0',
  fontFamily: 'Inter, system-ui, sans-serif',
  fontSize: 13,
  userSelect: 'none',
};

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 11px',
  borderRadius: 9,
  border: '1px solid rgba(120,140,180,0.35)',
  background: 'rgba(3,7,15,0.9)',
  color: '#eaf2ff',
  outline: 'none',
  fontFamily: 'inherit',
  fontSize: 14,
  letterSpacing: 1,
};

const chipStyle = (active: boolean, color?: string): CSSProperties => ({
  padding: '5px 10px',
  borderRadius: 999,
  border: `1px solid ${active ? color || '#6eff8b' : 'rgba(120,140,180,0.3)'}`,
  background: active ? `${color || '#6eff8b'}22` : 'rgba(255,255,255,0.03)',
  color: active ? color || '#eaf2ff' : '#9fb0cc',
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: 1,
});

const submitStyle = (busy: boolean): CSSProperties => ({
  width: '100%',
  marginTop: 14,
  padding: '11px 12px',
  borderRadius: 10,
  border: 'none',
  cursor: busy ? 'progress' : 'pointer',
  fontWeight: 700,
  letterSpacing: 1.5,
  fontSize: 13,
  color: '#04121f',
  background: busy
    ? 'linear-gradient(90deg,#2b6f86,#2b6f86)'
    : 'linear-gradient(90deg,#4dd0ff,#6eff8b)',
});

export interface AgentCreatorFormProps {
  /** Колбэк на успешно созданного агента (для интеграции с ареной). */
  onCreated?: (agent: AgentRecord) => void;
}

/**
 * Интерактивная форма нового агента. Читает/пишет `useAgentCreator`,
 * поэтому может жить и как DOM-оверлей, и внутри `<Html transform>`.
 */
export function AgentCreatorForm({ onCreated }: AgentCreatorFormProps) {
  const draft = useAgentCreator((s) => s.draft);
  const roster = useAgentCreator((s) => s.roster);
  const saving = useAgentCreator((s) => s.saving);
  const online = useAgentCreator((s) => s.online);
  const error = useAgentCreator((s) => s.error);
  const justCreated = useAgentCreator((s) => s.justCreated);
  const setName = useAgentCreator((s) => s.setName);
  const setColor = useAgentCreator((s) => s.setColor);
  const setRole = useAgentCreator((s) => s.setRole);
  const toggleSkill = useAgentCreator((s) => s.toggleSkill);
  const applyPreset = useAgentCreator((s) => s.applyPreset);
  const resetDraft = useAgentCreator((s) => s.resetDraft);
  const createAgent = useAgentCreator((s) => s.createAgent);

  const check = useMemo(() => validateAgentName(draft.name), [draft.name]);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const record = await createAgent();
      if (record) {
        onCreated?.(record);
        resetDraft();
      }
    },
    [createAgent, onCreated, resetDraft],
  );

  const statusColor = online === false ? '#ffb020' : online ? '#6eff8b' : '#7a8baa';
  const statusText = online === false ? 'OFFLINE · DEV' : online ? 'ONLINE' : '…';

  return (
    <form onSubmit={submit} style={panelStyle} onPointerDown={(e) => e.stopPropagation()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontWeight: 800, letterSpacing: 2, color: '#4dd0ff' }}>AGENT FOUNDRY</div>
        <div style={{ fontSize: 11, color: statusColor }}>● {statusText}</div>
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: '#7a8baa' }}>
        задача 6.4 · регистрация агента команды
      </div>

      <div style={{ marginTop: 14, fontSize: 11, color: '#9fb0cc', letterSpacing: 1 }}>ИМЯ</div>
      <input
        style={inputStyle}
        value={draft.name}
        maxLength={AGENT_NAME_MAX}
        placeholder="agent_1"
        onChange={(e) => setName(e.target.value)}
      />
      {!check.ok && draft.name.length > 0 && (
        <div style={{ marginTop: 5, fontSize: 11, color: '#ff8f8f' }}>{check.reason}</div>
      )}

      <div style={{ marginTop: 12, fontSize: 11, color: '#9fb0cc', letterSpacing: 1 }}>РОЛЬ</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
        {AGENT_ROLES.map((r) => (
          <button
            key={r.id}
            type="button"
            title={r.hint}
            onClick={() => setRole(r.id)}
            style={chipStyle(draft.role === r.id)}
          >
            {r.glyph} {r.label}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: '#9fb0cc', letterSpacing: 1 }}>НАВЫКИ</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
        {AGENT_SKILLS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => toggleSkill(s.id)}
            style={chipStyle(draft.skills.includes(s.id), draft.color)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: '#9fb0cc', letterSpacing: 1 }}>ЦВЕТ</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        {AGENT_COLOR_PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            onClick={() => setColor(c)}
            style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              border: draft.color === c ? '2px solid #fff' : '2px solid rgba(255,255,255,0.12)',
              background: c,
              cursor: 'pointer',
              padding: 0,
            }}
          />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        {AGENT_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => applyPreset(p.draft)}
            style={{ ...chipStyle(false), cursor: 'pointer' }}
          >
            ⚙ {p.label}
          </button>
        ))}
      </div>

      <button type="submit" style={submitStyle(saving)} disabled={saving || !check.ok}>
        {saving ? 'ПЕЧАТЬ АГЕНТА…' : '▶ СОЗДАТЬ АГЕНТА'}
      </button>

      {error && <div style={{ marginTop: 8, fontSize: 11, color: '#ff8f8f' }}>⚠ {error}</div>}
      {justCreated && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#6eff8b' }}>
          ✔ Создан «{justCreated.name}» ({justCreated.origin})
        </div>
      )}
      <div style={{ marginTop: 6, fontSize: 10, color: '#5b6b8a' }}>
        в цеху: {roster.length}
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*  3D-цех                                                                    */
/* -------------------------------------------------------------------------- */

interface SwatchProps {
  color: string;
  angle: number;
  radius: number;
  active: boolean;
  onSelect: (color: string) => void;
}

/** Цветовой образец на кольце подиума (кликается, как PickColor в research). */
function Swatch({ color, angle, radius, active, onSelect }: SwatchProps) {
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  const ref = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * (active ? 2.2 : 0.6);
  });
  const click = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      onSelect(color);
    },
    [color, onSelect],
  );
  return (
    <group position={[x, 0.24, z]}>
      <mesh ref={ref} castShadow onClick={click}>
        <icosahedronGeometry args={[active ? 0.17 : 0.13, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={active ? 1.1 : 0.45}
          metalness={0.3}
          roughness={0.35}
        />
      </mesh>
      {active && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.16, 0]}>
          <ringGeometry args={[0.18, 0.22, 32]} />
          <meshBasicMaterial color={color} transparent opacity={0.7} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

export interface AgentCreatorProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
  /** Масштаб всей станции. */
  scale?: number;
  /** Колбэк на создание агента (проброс в форму). */
  onCreated?: (agent: AgentRecord) => void;
  /** Автозагрузка roster при монтировании (GET /api/boxes). */
  autoLoad?: boolean;
}

/**
 * Станция «Агентный цех» в паддоке: подиум, навес, LED-табло с формой,
 * макет агента на стенде, кольцо цветов и борд roster.
 */
export function AgentCreator({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  onCreated,
  autoLoad = true,
}: AgentCreatorProps) {
  const draft = useAgentCreator((s) => s.draft);
  const roster = useAgentCreator((s) => s.roster);
  const saving = useAgentCreator((s) => s.saving);
  const loadRoster = useAgentCreator((s) => s.loadRoster);
  const setColor = useAgentCreator((s) => s.setColor);
  const justCreated = useAgentCreator((s) => s.justCreated);

  useEffect(() => {
    if (autoLoad) void loadRoster();
  }, [autoLoad, loadRoster]);

  const scan = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (scan.current) scan.current.rotation.z += dt * 1.4;
  });

  const swatches = useMemo(
    () =>
      AGENT_COLOR_PALETTE.map((color, i) => ({
        color,
        angle: (i / AGENT_COLOR_PALETTE.length) * Math.PI * 2,
      })),
    [],
  );

  const board = roster.slice(0, 6);
  const preview = justCreated || roster[roster.length - 1] || null;

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* подиум */}
      <mesh position={[0, 0.05, 0]} receiveShadow castShadow>
        <boxGeometry args={[3.2, 0.1, 2.4]} />
        <meshStandardMaterial color="#121a2b" metalness={0.5} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.14, 0]}>
        <boxGeometry args={[1.9, 0.08, 1.5]} />
        <meshStandardMaterial color="#1b2540" emissive="#4dd0ff" emissiveIntensity={0.15} />
      </mesh>

      {/* навес на стойках */}
      {[-1.5, 1.5].map((x) => (
        <mesh key={x} position={[x, 1.2, -1.05]} castShadow>
          <cylinderGeometry args={[0.04, 0.04, 2.4, 10]} />
          <meshStandardMaterial color="#324056" metalness={0.7} roughness={0.3} />
        </mesh>
      ))}
      <mesh position={[0, 2.4, -1.05]} castShadow>
        <boxGeometry args={[3.3, 0.08, 1.2]} />
        <meshStandardMaterial color="#243149" metalness={0.6} roughness={0.4} />
      </mesh>

      {/* наклонное LED-табло с DOM-формой */}
      <group position={[0, 1.5, 0.95]} rotation={[-Math.PI / 9, 0, 0]}>
        <mesh position={[0, 0, -0.05]} castShadow>
          <boxGeometry args={[1.5, 1.5, 0.08]} />
          <meshStandardMaterial color="#070d19" metalness={0.4} roughness={0.5} />
        </mesh>
        <Html transform occlude distanceFactor={1.35} position={[0, 0, 0.06]}>
          <AgentCreatorForm onCreated={onCreated} />
        </Html>
      </group>

      {/* макет агента на стенде */}
      <group position={[0, 0.18, -0.25]}>
        <AgentAvatar
          name={preview?.name || draft.name || 'agent_?'}
          color={preview?.color || draft.color}
          status={saving ? 'running' : justCreated ? 'done' : 'idle'}
          progress={saving ? 0.6 : 0.15}
          scale={0.82}
          showTag={false}
        />
        {/* сканирующий луч «печати» агента */}
        <mesh ref={scan} position={[0, 1.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.7, 0.78, 48]} />
          <meshBasicMaterial
            color={draft.color}
            transparent
            opacity={0.2}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      </group>

      {/* кольцо образцов цвета (кликабельно) */}
      {swatches.map((s) => (
        <Swatch
          key={s.color}
          color={s.color}
          angle={s.angle}
          radius={0.92}
          active={draft.color === s.color}
          onSelect={setColor}
        />
      ))}

      {/* LED-борд roster команды */}
      <group position={[-1.85, 1.35, 0.6]} rotation={[0, Math.PI / 10, 0]}>
        <mesh castShadow>
          <boxGeometry args={[2.5, 2.2, 0.1]} />
          <meshStandardMaterial color="#0b1322" metalness={0.4} roughness={0.6} />
        </mesh>
        <Text
          position={[0, 0.92, 0.08]}
          fontSize={0.13}
          color="#6eff8b"
          anchorX="center"
          anchorY="middle"
        >
          {`ROSTER · ${roster.length}`}
        </Text>
        {board.map((a, i) => {
          const y = 0.62 - i * 0.24;
          const isNew = justCreated?.name === a.name;
          return (
            <group key={`${a.name}-${i}`} position={[0, y, 0.08]}>
              <mesh position={[-1.05, 0, 0]}>
                <boxGeometry args={[0.14, 0.14, 0.05]} />
                <meshStandardMaterial
                  color={a.color}
                  emissive={a.color}
                  emissiveIntensity={isNew ? 1.4 : 0.7}
                />
              </mesh>
              <Text
                position={[-0.9, 0, 0]}
                fontSize={0.11}
                color="#e0e6f0"
                anchorX="left"
                anchorY="middle"
              >
                {a.name}
              </Text>
              <Text
                position={[1.18, 0, 0]}
                fontSize={0.09}
                color={isNew ? '#6eff8b' : '#7a8baa'}
                anchorX="right"
                anchorY="middle"
              >
                {`${a.role}${a.skillCount ? ` · ${a.skillCount}` : ''}`}
              </Text>
            </group>
          );
        })}
        {board.length === 0 && (
          <Text
            position={[0, 0, 0.08]}
            fontSize={0.11}
            color="#4a5570"
            anchorX="center"
            anchorY="middle"
          >
            ЗАГРУЗКА…
          </Text>
        )}
      </group>
    </group>
  );
}

export default AgentCreator;
