/**
 * ЗАДАЧА 7.2 — API /parts, /builds · МАРКЕТПЛЕЙС ТЮНИНГА (FORMULA I1)
 * ============================================================================
 * Платформа. Физический павильон тюнинга на пит-лейне + типизированный
 * API-клиент к бэкенду маркетплейса.
 *
 * Что реализовано:
 *   • REST-клиент `GET /parts` (+ ?category=), `GET /builds` (+ ?owner=),
 *     `POST /builds`, `GET /builds/:id` — с JWT-авторизацией из общего
 *     хранилища (ключ `formula_i1.jwt`, same-origin `/api` по умолчанию);
 *   • доменные типы `Part`, `PartCategory`, `PartStats`, `Build`, `BuildItem`
 *     и каталог-фолбэк `DEFAULT_PARTS` / `DEFAULT_BUILDS` — чтобы павильон
 *     был наглядным и без поднятого бэкенда (dev-offline);
 *   • zustand-стор `useMarketStore` (parts/builds/loading/error/selected);
 *   • 3D-павильон: подиум, навес, вращающиеся стенды деталей с цветом по
 *     категории, ценником и кликом-выбором; LED-табло «TOP BUILDS».
 *
 * Приёмы взяты из research/racing-game (MIT):
 *   - src/ui/LeaderBoard.tsx — сортировка участников и медалист-акценты
 *     (переиспользовано для рейтинга сборок);
 *   - src/ui/Speed/Gauge.tsx — LED-панель из примитивов без внешних моделей;
 *   - src/store.ts — zustand-стор как единственный источник игрового UI.
 * Код собственный, в терминах проекта AI-1.
 * ============================================================================
 */

import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { create } from 'zustand';
import { readStoredToken } from './AuthGate';

/* -------------------------------------------------------------------------- */
/*  Типы домена маркетплейса                                                  */
/* -------------------------------------------------------------------------- */

export type PartCategory = 'engine' | 'aero' | 'tyres' | 'brakes' | 'suspension';

export interface PartStats {
  speed?: number;
  accel?: number;
  grip?: number;
  handling?: number;
  reliability?: number;
}

export interface Part {
  id: string;
  name: string;
  category: PartCategory;
  /** Цена в кредитах. */
  price: number;
  /** Уровень 1..5 (влияет на цвет/подсветку стенда). */
  tier: number;
  stats: PartStats;
  description?: string;
  stock?: number;
}

export interface BuildItem {
  part_id: string;
  slot: PartCategory;
}

export interface Build {
  id: string;
  owner: string;
  name: string;
  parts: BuildItem[];
  /** Средний рейтинг сообщества 0..5. */
  rating?: number;
  createdAt: number;
}

export interface BuildDraft {
  name: string;
  parts: BuildItem[];
}

/* -------------------------------------------------------------------------- */
/*  API-клиент /parts, /builds                                                */
/* -------------------------------------------------------------------------- */

const env = import.meta.env as Record<string, string | boolean | undefined>;

/** Базовый URL маркетплейс-API (переопределяется через VITE_API_BASE). */
export const MARKET_API_BASE =
  typeof env.VITE_API_BASE === 'string' && env.VITE_API_BASE
    ? env.VITE_API_BASE
    : '/api';

/** Заголовки запроса: JSON + Bearer, если пилот авторизован. */
function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = readStoredToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Универсальный обёртка fetch с разбором серверной ошибки. */
async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${MARKET_API_BASE}${path}`, {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
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

/** GET /parts — каталог деталей, опционально с фильтром по категории. */
export async function fetchParts(params?: { category?: PartCategory }): Promise<Part[]> {
  const qs = params?.category ? `?category=${encodeURIComponent(params.category)}` : '';
  const data = await apiRequest<Part[] | { parts: Part[] }>(`/parts${qs}`);
  return Array.isArray(data) ? data : data.parts ?? [];
}

/** GET /builds — сборки, опционально только конкретного владельца. */
export async function fetchBuilds(params?: { owner?: string }): Promise<Build[]> {
  const qs = params?.owner ? `?owner=${encodeURIComponent(params.owner)}` : '';
  const data = await apiRequest<Build[] | { builds: Build[] }>(`/builds${qs}`);
  return Array.isArray(data) ? data : data.builds ?? [];
}

/** GET /builds/:id — одна сборка. */
export async function fetchBuild(id: string): Promise<Build> {
  return apiRequest<Build>(`/builds/${encodeURIComponent(id)}`);
}

/** POST /builds — опубликовать собранный конфиг. Возвращает сохранённую сборку. */
export async function createBuild(draft: BuildDraft): Promise<Build> {
  return apiRequest<Build>('/builds', {
    method: 'POST',
    body: JSON.stringify(draft),
  });
}

/* -------------------------------------------------------------------------- */
/*  Каталог по умолчанию (dev-offline фолбэк)                                 */
/* -------------------------------------------------------------------------- */

export const DEFAULT_PARTS: Part[] = [
  {
    id: 'eng_v8_biturbo',
    name: 'V8 Biturbo',
    category: 'engine',
    price: 4200,
    tier: 4,
    stats: { speed: 9, accel: 8, reliability: 7 },
    description: 'Флагманский двигатель FORMULA I1.',
    stock: 3,
  },
  {
    id: 'aero_wing_rear',
    name: 'Rear Wing MK-II',
    category: 'aero',
    price: 1800,
    tier: 3,
    stats: { grip: 8, handling: 6 },
    stock: 12,
  },
  {
    id: 'tyres_soft_c3',
    name: 'Soft Slicks C3',
    category: 'tyres',
    price: 950,
    tier: 2,
    stats: { grip: 9, reliability: 5 },
    stock: 24,
  },
  {
    id: 'brakes_carbon',
    name: 'Carbon Ceramic',
    category: 'brakes',
    price: 2100,
    tier: 4,
    stats: { handling: 8, reliability: 8 },
    stock: 6,
  },
  {
    id: 'susp_active',
    name: 'Active Suspension',
    category: 'suspension',
    price: 3400,
    tier: 5,
    stats: { grip: 7, handling: 9 },
    stock: 2,
  },
];

export const DEFAULT_BUILDS: Build[] = [
  {
    id: 'bld_apex',
    owner: 'agent_3',
    name: 'Apex Predator',
    parts: [
      { part_id: 'eng_v8_biturbo', slot: 'engine' },
      { part_id: 'aero_wing_rear', slot: 'aero' },
    ],
    rating: 4.8,
    createdAt: Date.now() - 86_400_000,
  },
  {
    id: 'bld_grip',
    owner: 'agent_7',
    name: 'Grip Monster',
    parts: [
      { part_id: 'tyres_soft_c3', slot: 'tyres' },
      { part_id: 'susp_active', slot: 'suspension' },
    ],
    rating: 4.5,
    createdAt: Date.now() - 43_200_000,
  },
  {
    id: 'bld_budget',
    owner: 'agent_1',
    name: 'Budget Bullet',
    parts: [{ part_id: 'brakes_carbon', slot: 'brakes' }],
    rating: 3.9,
    createdAt: Date.now() - 7_200_000,
  },
];

/* -------------------------------------------------------------------------- */
/*  zustand-стор маркетплейса                                                 */
/* -------------------------------------------------------------------------- */

interface MarketState {
  parts: Part[];
  builds: Build[];
  loading: boolean;
  error: string | null;
  selectedPartId: string | null;
  loadParts: (category?: PartCategory) => Promise<void>;
  loadBuilds: (owner?: string) => Promise<void>;
  selectPart: (id: string | null) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  parts: DEFAULT_PARTS,
  builds: DEFAULT_BUILDS,
  loading: false,
  error: null,
  selectedPartId: null,

  loadParts: async (category) => {
    set({ loading: true, error: null });
    try {
      const parts = await fetchParts(category ? { category } : undefined);
      set({ parts: parts.length ? parts : DEFAULT_PARTS, loading: false });
    } catch (err) {
      // нет бэкенда (dev) — оставляем локальный каталог, но фиксируем ошибку
      set({
        parts: DEFAULT_PARTS,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  loadBuilds: async (owner) => {
    set({ loading: true, error: null });
    try {
      const builds = await fetchBuilds(owner ? { owner } : undefined);
      set({ builds: builds.length ? builds : DEFAULT_BUILDS, loading: false });
    } catch (err) {
      set({
        builds: DEFAULT_BUILDS,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  selectPart: (id) => set({ selectedPartId: id }),
}));

/* -------------------------------------------------------------------------- */
/*  Палитра и подписи категорий                                               */
/* -------------------------------------------------------------------------- */

const CATEGORY_COLOR: Record<PartCategory, string> = {
  engine: '#ff5c5c',
  aero: '#4dd0ff',
  tyres: '#ffd700',
  brakes: '#a855f7',
  suspension: '#6eff8b',
};

const CATEGORY_LABEL: Record<PartCategory, string> = {
  engine: 'ENGINE',
  aero: 'AERO',
  tyres: 'TYRES',
  brakes: 'BRAKES',
  suspension: 'SUSP',
};

/* -------------------------------------------------------------------------- */
/*  Стенд одной детали                                                        */
/* -------------------------------------------------------------------------- */

function PartPedestal({
  part,
  index,
  selected,
  onSelect,
}: {
  part: Part;
  index: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const spinRef = useRef<THREE.Mesh>(null);
  const color = CATEGORY_COLOR[part.category] ?? '#4dd0ff';

  useFrame(({ clock }) => {
    const m = spinRef.current;
    if (!m) return;
    m.rotation.y = clock.getElapsedTime() * 0.7 + index;
    m.rotation.x = Math.sin(clock.getElapsedTime() * 0.5 + index) * 0.25;
  });

  const col = index % 3;
  const row = Math.floor(index / 3);
  const x = -3.4 + col * 3.4;
  const z = -0.6 + row * 3.0;

  return (
    <group position={[x, 0, z]}>
      {/* подиум */}
      <mesh position={[0, 0.18, 0]}>
        <cylinderGeometry args={[0.85, 1.0, 0.36, 24]} />
        <meshStandardMaterial color="#1a2438" metalness={0.7} roughness={0.35} />
      </mesh>
      {/* деталь на подиуме */}
      <mesh
        ref={spinRef}
        position={[0, 1.05, 0]}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(part.id);
        }}
      >
        <octahedronGeometry args={[0.45, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={selected ? 1.5 : 0.7}
          metalness={0.6}
          roughness={0.3}
        />
      </mesh>
      {/* свечение при выборе */}
      {selected && (
        <mesh position={[0, 1.05, 0]}>
          <sphereGeometry args={[0.62, 16, 16]} />
          <meshBasicMaterial color={color} transparent opacity={0.15} depthWrite={false} />
        </mesh>
      )}
      {/* подписи */}
      <Text position={[0, 2.0, 0]} fontSize={0.24} color="#eaf3ff" anchorX="center" anchorY="middle">
        {part.name}
      </Text>
      <Text position={[0, 1.72, 0]} fontSize={0.18} color={color} anchorX="center" anchorY="middle">
        {CATEGORY_LABEL[part.category]}
      </Text>
      <Text position={[0, -0.08, 1.05]} fontSize={0.22} color="#ffd700" anchorX="center" anchorY="middle">
        {`${part.price} ⧫`}
      </Text>
      <Text position={[0, 1.44, 0]} fontSize={0.16} color="#7a8baa" anchorX="center" anchorY="middle">
        {`T${part.tier}${typeof part.stock === 'number' ? ` · ${part.stock} pcs` : ''}`}
      </Text>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  LED-табло «TOP BUILDS»                                                    */
/* -------------------------------------------------------------------------- */

function BuildsBoard({ builds }: { builds: Build[] }) {
  const top = useMemo(
    () => [...builds].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)).slice(0, 5),
    [builds],
  );

  return (
    <group position={[6.6, 0, 0]} rotation={[0, -Math.PI / 8, 0]}>
      {/* корпус */}
      <mesh position={[0, 2.0, 0]}>
        <boxGeometry args={[4.2, 3.2, 0.2]} />
        <meshStandardMaterial color="#0b1020" metalness={0.5} roughness={0.4} />
      </mesh>
      {/* экран */}
      <mesh position={[0, 2.0, 0.11]}>
        <planeGeometry args={[3.9, 2.9]} />
        <meshStandardMaterial color="#06121f" emissive="#0d2740" emissiveIntensity={0.9} />
      </mesh>
      <Text position={[0, 3.25, 0.14]} fontSize={0.26} color="#8fe3ff" anchorX="center" anchorY="middle">
        {'TOP BUILDS · /builds'}
      </Text>
      {top.map((b, i) => {
        const y = 2.65 - i * 0.44;
        const accent = i === 0 ? '#ffd700' : i === 1 ? '#c0c0c0' : i === 2 ? '#cd7f32' : '#7a8baa';
        return (
          <group key={b.id} position={[0, y, 0.14]}>
            <Text position={[-1.75, 0, 0]} fontSize={0.2} color={accent} anchorX="left" anchorY="middle">
              {`${i + 1}.`}
            </Text>
            <Text position={[-1.45, 0, 0]} fontSize={0.2} color="#eaf3ff" anchorX="left" anchorY="middle">
              {b.name}
            </Text>
            <Text position={[1.75, 0, 0]} fontSize={0.18} color="#7a8baa" anchorX="right" anchorY="middle">
              {`${(b.rating ?? 0).toFixed(1)} ★`}
            </Text>
          </group>
        );
      })}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  Павильон тюнинга                                                          */
/* -------------------------------------------------------------------------- */

/** Мировая позиция павильона (сбоку от пит-лейна). */
export const MARKET_POSITION: [number, number, number] = [22, 0, -30];

interface TuningMarketProps {
  /** Внешний каталог; если не задан — берётся из стора. */
  parts?: Part[];
  /** Внешние сборки; если не задан — берутся из стора. */
  builds?: Build[];
  /** Заголовок павильона. */
  title?: string;
}

export function TuningMarket({ parts, builds, title = 'TUNING MARKETPLACE · /parts' }: TuningMarketProps) {
  const storeParts = useMarketStore((s) => s.parts);
  const storeBuilds = useMarketStore((s) => s.builds);
  const selectedPartId = useMarketStore((s) => s.selectedPartId);
  const selectPart = useMarketStore((s) => s.selectPart);
  const loadParts = useMarketStore((s) => s.loadParts);
  const loadBuilds = useMarketStore((s) => s.loadBuilds);

  // Ленивая загрузка с бэкенда, если данные не переданы пропом.
  useEffect(() => {
    if (!parts) void loadParts();
    if (!builds) void loadBuilds();
  }, [parts, builds, loadParts, loadBuilds]);

  const list = parts ?? storeParts;
  const buildList = builds ?? storeBuilds;
  const visible = list.slice(0, 6);

  const frameMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#233046', metalness: 0.8, roughness: 0.3 }),
    [],
  );
  const canopyMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#13233c', metalness: 0.4, roughness: 0.6 }),
    [],
  );

  return (
    <group position={MARKET_POSITION}>
      {/* бетонная площадка */}
      <mesh position={[1.6, 0.05, 1.2]} receiveShadow>
        <boxGeometry args={[13, 0.3, 10]} />
        <meshStandardMaterial color="#151b28" metalness={0.2} roughness={0.9} />
      </mesh>

      {/* ферменные стойки и навес */}
      <mesh position={[-4.4, 2.6, -3.6]} material={frameMat}>
        <boxGeometry args={[0.3, 5.2, 0.3]} />
      </mesh>
      <mesh position={[7.6, 2.6, -3.6]} material={frameMat}>
        <boxGeometry args={[0.3, 5.2, 0.3]} />
      </mesh>
      <mesh position={[1.6, 5.1, -3.6]} material={canopyMat}>
        <boxGeometry args={[12.6, 0.25, 7.6]} />
      </mesh>

      {/* вывеска павильона */}
      <mesh position={[1.6, 4.4, -1.4]}>
        <boxGeometry args={[10.5, 1.0, 0.18]} />
        <meshStandardMaterial color="#0b1020" emissive="#0d2740" emissiveIntensity={0.8} metalness={0.5} roughness={0.4} />
      </mesh>
      <Text position={[1.6, 4.4, -1.28]} fontSize={0.5} color="#8fe3ff" anchorX="center" anchorY="middle">
        {title}
      </Text>

      {/* стенды деталей */}
      {visible.map((part, i) => (
        <PartPedestal
          key={part.id}
          part={part}
          index={i}
          selected={selectedPartId === part.id}
          onSelect={selectPart}
        />
      ))}

      {/* табло сборок */}
      <BuildsBoard builds={buildList} />
    </group>
  );
}

export default TuningMarket;

/** Стили оверлея для необязательного DOM-подписчика маркетплейса. */
export const marketOverlayStyle: CSSProperties = {
  position: 'absolute',
  bottom: 24,
  left: 24,
  zIndex: 10,
  width: 260,
  background: 'rgba(20, 26, 45, 0.75)',
  backdropFilter: 'blur(10px)',
  borderRadius: 12,
  padding: 14,
  pointerEvents: 'none',
};
