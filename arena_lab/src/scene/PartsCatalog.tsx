/**
 * ЗАДАЧА 7.3 — КАТАЛОГ ЗАПЧАСТЕЙ UI · МАРКЕТПЛЕЙС ТЮНИНГА (FORMULA I1)
 * ============================================================================
 * Платформа. Интерактивный каталог запчастей, смонтированный в сцене арены
 * как физический стенд «PARTS CATALOG» на пит-лейне. Углубляет задачу 7.2
 * (TuningMarket.tsx): тот дал API /parts, /builds и 3D-павильон, этот —
 * полноценный UI-каталог: поиск, фильтры по категории, сортировка, тумблер
 * «в наличии», карточка детали со стат-барами и корзина сборки.
 *
 * Контракты бэкенда (см. research/catalog.md):
 *   GET  /api/parts   → Part[] | { parts: Part[] }
 *   GET  /api/builds  → Build[] (обрабатывается в 7.2)
 * Комиссия платформы 30 % (3000 bps) — источник истины НА БЭКЕНДЕ; здесь
 * только честный предпоказ разбивки (floor-правило), финальный расчёт при
 * покупке выполняет сервер задачи 7.1.
 *
 * Приёмы из research/racing-game (MIT):
 *   - src/ui/LeaderBoard.tsx — сортировка коллекции и акценты по рангу
 *     (здесь — сортировка деталей, подсветка топ-тира);
 *   - src/ui/PickColor.tsx — поповер-выбор, рулимый отдельным zustand-стором
 *     (здесь — панель каталога и корзина сборки);
 *   - src/ui/Speed/Gauge.tsx — «LED»-полоски из примитивов без атласов
 *     (здесь — stat-бары чистым CSS внутри <Html>).
 * Код собственный, в терминах проекта AI-1.
 * ============================================================================
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Html, Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { create } from 'zustand';
import {
  DEFAULT_PARTS,
  useMarketStore,
  type Part,
  type PartCategory,
  type PartStats,
} from './TuningMarket';

/* -------------------------------------------------------------------------- */
/*  Палитра и подписи                                                          */
/* -------------------------------------------------------------------------- */

export const CATEGORY_ORDER: ReadonlyArray<PartCategory> = [
  'engine',
  'aero',
  'tyres',
  'brakes',
  'suspension',
];

export const CATEGORY_COLOR: Record<PartCategory, string> = {
  engine: '#ff5c5c',
  aero: '#4dd0ff',
  tyres: '#ffd700',
  brakes: '#a855f7',
  suspension: '#6eff8b',
};

export const CATEGORY_LABEL: Record<PartCategory, string> = {
  engine: 'ENGINE',
  aero: 'AERO',
  tyres: 'TYRES',
  brakes: 'BRAKES',
  suspension: 'SUSP',
};

export const STAT_ORDER: ReadonlyArray<keyof PartStats> = [
  'speed',
  'accel',
  'grip',
  'handling',
  'reliability',
];

export const STAT_LABEL: Record<keyof PartStats, string> = {
  speed: 'SPD',
  accel: 'ACC',
  grip: 'GRP',
  handling: 'HDL',
  reliability: 'REL',
};

/* -------------------------------------------------------------------------- */
/*  Чистые утилиты каталога (тестируемы без DOM)                              */
/* -------------------------------------------------------------------------- */

export type CatalogSort = 'name' | 'price-asc' | 'price-desc' | 'tier-desc' | 'value';

/** Средний балл детали по заданным характеристикам (0..10). */
export function partScore(stats: PartStats): number {
  const values = Object.values(stats).filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Ценность: средний балл на 1000 кредитов (больше — выгоднее). */
export function partValue(part: Part): number {
  return (partScore(part.stats) / Math.max(1, part.price)) * 1000;
}

/** Формат цены: разделитель разрядов + валюта проекта. */
export function formatPrice(price: number): string {
  return `${Math.round(price).toLocaleString('en-US')} ⧫`;
}

/** Сорт сравнения по «ценности» — для режима value. */
function byValue(a: Part, b: Part): number {
  return partValue(b) - partValue(a);
}

export interface CatalogFilterOptions {
  query?: string;
  category?: PartCategory | 'all';
  sort?: CatalogSort;
  inStockOnly?: boolean;
}

/**
 * Фильтрация + сортировка каталога. Чистая функция, пригодная для юнит-тестов
 * и мемоизации в компоненте.
 */
export function filterParts(parts: Part[], options: CatalogFilterOptions = {}): Part[] {
  const { query = '', category = 'all', sort = 'tier-desc', inStockOnly = false } = options;
  const needle = query.trim().toLowerCase();

  const result = parts.filter((part) => {
    if (category !== 'all' && part.category !== category) return false;
    if (inStockOnly && typeof part.stock === 'number' && part.stock <= 0) return false;
    if (!needle) return true;
    const haystack = `${part.name} ${part.description ?? ''} ${part.category} ${part.id}`;
    return haystack.toLowerCase().includes(needle);
  });

  switch (sort) {
    case 'name':
      return [...result].sort((a, b) => a.name.localeCompare(b.name));
    case 'price-asc':
      return [...result].sort((a, b) => a.price - b.price);
    case 'price-desc':
      return [...result].sort((a, b) => b.price - a.price);
    case 'value':
      return [...result].sort(byValue);
    case 'tier-desc':
    default:
      return [...result].sort((a, b) => b.tier - a.tier || b.price - a.price);
  }
}

/* -------------------------------------------------------------------------- */
/*  Экономика сборки (комиссия 30 % — начисляет ТОЛЬКО бэкенд)                */
/* -------------------------------------------------------------------------- */

/** Комиссия платформы. Совпадает с MARKET_COMMISSION_RATE из 7.1/7.2. */
export const MARKET_COMMISSION_RATE = 0.3;

/** 30.00 % = 3000 bps. Источник истины — research/catalog.md §3.2. */
export const MARKET_COMMISSION_BPS = 3000;

/** Комиссия в целых кредитах строго по floor-правилу каталога. */
export function calcCommission(gross: number, bps: number = MARKET_COMMISSION_BPS): number {
  const amount = Math.round(Math.max(0, gross));
  return Math.floor((amount * bps) / 10000);
}

export interface BuildPricing {
  subtotal: number;
  commission: number;
  /** Что получает продавец: subtotal − commission. */
  net: number;
  /** Что платит покупатель (комиссия удерживается из доли продавца). */
  total: number;
}

/** Предпоказ разбивки цены сборки. Финальные суммы считает бэкенд. */
export function priceBuild(parts: Part[]): BuildPricing {
  const subtotal = parts.reduce((sum, p) => sum + Math.max(0, p.price), 0);
  const commission = calcCommission(subtotal);
  return { subtotal, commission, net: subtotal - commission, total: subtotal };
}

/** Средние характеристики набора деталей по каждой шкале (0..10). */
export function aggregateStats(parts: Part[]): PartStats {
  const out: PartStats = {};
  for (const key of STAT_ORDER) {
    const vals = parts
      .map((p) => p.stats[key])
      .filter((v): v is number => typeof v === 'number');
    if (vals.length) out[key] = vals.reduce((s, v) => s + v, 0) / vals.length;
  }
  return out;
}

/**
 * Слот сборки = категория детали. В корректной сборке занят максимум один
 * слот каждой категории, поэтому дубли (например, два «engine») считаются
 * конфликтом. Чистая функция — используется в карточке сборки и тестах.
 */
export function findSlotConflicts(parts: Array<Pick<Part, 'category'>>): PartCategory[] {
  const seen = new Set<PartCategory>();
  const conflicts: PartCategory[] = [];
  for (const { category } of parts) {
    if (seen.has(category)) {
      if (!conflicts.includes(category)) conflicts.push(category);
    } else {
      seen.add(category);
    }
  }
  return conflicts;
}

/** true, если сборка валидна по слотам (нет дублей категорий). */
export function isBuildValid(parts: Array<Pick<Part, 'category'>>): boolean {
  return findSlotConflicts(parts).length === 0;
}

/* -------------------------------------------------------------------------- */
/*  Загрузка каталога с бэкенда (offline-safe)                                */
/* -------------------------------------------------------------------------- */

export const PARTS_API_PATH = '/api/parts';
export const BUILDS_API_PATH = '/api/builds';

export interface CatalogDataState {
  parts: Part[];
  loading: boolean;
  error: string | null;
  /** false, если работаем на локальном seed (бэкенд недоступен). */
  online: boolean;
}

/**
 * Тянет каталог из `GET /api/parts`. Если сеть/API недоступны — бесшовно
 * отдаёт DEFAULT_PARTS, чтобы стенд арены не пустовал (dev-offline).
 */
export function useCatalogData(enabled = true): CatalogDataState {
  const [state, setState] = useState<CatalogDataState>({
    parts: DEFAULT_PARTS,
    loading: enabled,
    error: null,
    online: false,
  });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const controller = new AbortController();

    fetch(PARTS_API_PATH, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Part[] | { parts?: Part[] };
        const list = Array.isArray(data) ? data : data.parts ?? [];
        if (!alive) return;
        setState({
          parts: list.length ? list : DEFAULT_PARTS,
          loading: false,
          error: null,
          online: list.length > 0,
        });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setState({
          parts: DEFAULT_PARTS,
          loading: false,
          error: err instanceof Error ? err.message : 'fetch failed',
          online: false,
        });
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [enabled]);

  return state;
}

/* -------------------------------------------------------------------------- */
/*  zustand-стор каталога (поиск / фильтры / корзина сборки)                  */
/* -------------------------------------------------------------------------- */

interface CatalogState {
  query: string;
  category: PartCategory | 'all';
  sort: CatalogSort;
  inStockOnly: boolean;
  /** id деталей, добавленных в текущую сборку. */
  cart: string[];
  setQuery: (q: string) => void;
  setCategory: (c: PartCategory | 'all') => void;
  setSort: (s: CatalogSort) => void;
  toggleInStock: () => void;
  toggleCart: (id: string) => void;
  clearCart: () => void;
}

export const useCatalogStore = create<CatalogState>((set) => ({
  query: '',
  category: 'all',
  sort: 'tier-desc',
  inStockOnly: false,
  cart: [],

  setQuery: (query) => set({ query }),
  setCategory: (category) => set({ category }),
  setSort: (sort) => set({ sort }),
  toggleInStock: () => set((s) => ({ inStockOnly: !s.inStockOnly })),
  toggleCart: (id) =>
    set((s) => ({
      cart: s.cart.includes(id) ? s.cart.filter((x) => x !== id) : [...s.cart, id],
    })),
  clearCart: () => set({ cart: [] }),
}));

/* -------------------------------------------------------------------------- */
/*  Мелкие UI-элементы (обычный DOM внутри <Html>)                            */
/* -------------------------------------------------------------------------- */

const PANEL_BG = '#070b16';
const PANEL_BORDER = '1px solid #1d2b45';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function StatBar({ stat, value }: { stat: keyof PartStats; value?: number }) {
  const v = typeof value === 'number' ? Math.max(0, Math.min(10, value)) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
      <span style={{ width: 30, fontSize: 9, color: '#7a8baa', fontFamily: MONO }}>
        {STAT_LABEL[stat]}
      </span>
      <span
        style={{
          position: 'relative',
          flex: 1,
          height: 6,
          background: '#0d1526',
          borderRadius: 3,
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            position: 'absolute',
            inset: 0,
            width: `${v * 10}%`,
            background: 'linear-gradient(90deg, #4dd0ff, #6eff8b)',
          }}
        />
      </span>
      <span style={{ width: 24, fontSize: 9, color: '#cfe6ff', textAlign: 'right', fontFamily: MONO }}>
        {typeof value === 'number' ? value.toFixed(1) : '—'}
      </span>
    </div>
  );
}

function CategoryChip({ category }: { category: PartCategory }) {
  const c = CATEGORY_COLOR[category];
  return (
    <span
      style={{
        fontSize: 8,
        fontWeight: 700,
        letterSpacing: 1,
        color: c,
        border: `1px solid ${c}`,
        borderRadius: 4,
        padding: '1px 4px',
        fontFamily: MONO,
      }}
    >
      {CATEGORY_LABEL[category]}
    </span>
  );
}

interface PartRowProps {
  part: Part;
  active: boolean;
  inCart: boolean;
  onSelect: (id: string) => void;
  onToggleCart: (id: string) => void;
}

function PartRow({ part, active, inCart, onSelect, onToggleCart }: PartRowProps) {
  const accent = CATEGORY_COLOR[part.category];
  return (
    <div
      onClick={() => onSelect(part.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        marginBottom: 4,
        cursor: 'pointer',
        borderRadius: 6,
        background: active ? '#122036' : '#0a1120',
        borderLeft: `3px solid ${part.tier >= 4 ? accent : '#1d2b45'}`,
        opacity: part.stock === 0 ? 0.45 : 1,
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 5,
          background: accent,
          boxShadow: `0 0 8px ${accent}80`,
          flexShrink: 0,
        }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 11, color: '#e6f0ff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {part.name}
        </span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
          <CategoryChip category={part.category} />
          <span style={{ fontSize: 9, color: '#7a8baa', fontFamily: MONO }}>T{part.tier}</span>
        </span>
      </span>
      <span style={{ textAlign: 'right' }}>
        <span style={{ display: 'block', fontSize: 11, color: '#ffd700', fontFamily: MONO }}>
          {formatPrice(part.price)}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleCart(part.id);
          }}
          style={{
            marginTop: 2,
            fontSize: 9,
            cursor: 'pointer',
            borderRadius: 4,
            padding: '1px 6px',
            color: inCart ? '#04120a' : '#6eff8b',
            background: inCart ? '#6eff8b' : 'transparent',
            border: '1px solid #6eff8b',
            fontFamily: MONO,
          }}
        >
          {inCart ? '✓ IN BUILD' : '+ BUILD'}
        </button>
      </span>
    </div>
  );
}

function PartDetail({ part }: { part: Part | null }) {
  if (!part) {
    return (
      <div style={{ fontSize: 10, color: '#556', fontFamily: MONO, padding: 12 }}>
        SELECT A PART TO INSPECT
      </div>
    );
  }
  return (
    <div style={{ padding: '8px 6px' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#e6f0ff', marginBottom: 2 }}>
        {part.name}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <CategoryChip category={part.category} />
        <span style={{ fontSize: 9, color: '#ffd700', fontFamily: MONO }}>
          {formatPrice(part.price)}
        </span>
        <span style={{ fontSize: 9, color: '#7a8baa', fontFamily: MONO }}>TIER {part.tier}</span>
      </div>
      {part.description && (
        <div style={{ fontSize: 9, color: '#8fa3c0', marginBottom: 8, lineHeight: 1.4 }}>
          {part.description}
        </div>
      )}
      {STAT_ORDER.map((s) => (
        <StatBar key={s} stat={s} value={part.stats[s]} />
      ))}
    </div>
  );
}

function CartSummary({ cartParts }: { cartParts: Part[] }) {
  const pricing = useMemo(() => priceBuild(cartParts), [cartParts]);
  const avg = aggregateStats(cartParts);
  const conflicts = useMemo(() => findSlotConflicts(cartParts), [cartParts]);

  return (
    <div style={{ borderTop: PANEL_BORDER, marginTop: 6, paddingTop: 6 }}>
      {conflicts.length > 0 && (
        <div
          style={{
            fontSize: 9,
            color: '#ff9d5c',
            fontFamily: MONO,
            marginBottom: 4,
            lineHeight: 1.4,
          }}
        >
          ⚠ SLOT CONFLICT: {conflicts.map((c) => CATEGORY_LABEL[c]).join(', ')} ×2
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#cfe6ff', fontFamily: MONO }}>
        <span>BUILD ({cartParts.length})</span>
        <span style={{ color: '#ffd700' }}>{formatPrice(pricing.subtotal)}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#7a8baa', marginTop: 2, fontFamily: MONO }}>
        <span>platform fee 30%</span>
        <span>−{formatPrice(pricing.commission)}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#6eff8b', marginTop: 2, fontFamily: MONO }}>
        <span>seller net</span>
        <span>{formatPrice(pricing.net)}</span>
      </div>
      {cartParts.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {STAT_ORDER.map((s) => (
            <StatBar key={s} stat={s} value={avg[s]} />
          ))}
        </div>
      )}
    </div>
  );
}

interface CatalogPanelProps {
  parts: Part[];
  loading: boolean;
  error: string | null;
  online: boolean;
  selected: Part | null;
  onSelect: (id: string) => void;
}

function CatalogPanel({ parts, loading, error, online, selected, onSelect }: CatalogPanelProps) {
  const query = useCatalogStore((s) => s.query);
  const category = useCatalogStore((s) => s.category);
  const sort = useCatalogStore((s) => s.sort);
  const inStockOnly = useCatalogStore((s) => s.inStockOnly);
  const cart = useCatalogStore((s) => s.cart);
  const setQuery = useCatalogStore((s) => s.setQuery);
  const setCategory = useCatalogStore((s) => s.setCategory);
  const setSort = useCatalogStore((s) => s.setSort);
  const toggleInStock = useCatalogStore((s) => s.toggleInStock);
  const toggleCart = useCatalogStore((s) => s.toggleCart);
  const clearCart = useCatalogStore((s) => s.clearCart);

  const visible = useMemo(
    () => filterParts(parts, { query, category, sort, inStockOnly }),
    [parts, query, category, sort, inStockOnly],
  );
  const cartParts = useMemo(
    () => cart.map((id) => parts.find((p) => p.id === id)).filter((p): p is Part => Boolean(p)),
    [cart, parts],
  );

  return (
    <div
      style={{
        width: 620,
        height: 400,
        display: 'flex',
        flexDirection: 'column',
        background: PANEL_BG,
        border: PANEL_BORDER,
        borderRadius: 10,
        boxShadow: '0 0 40px #0d274080',
        fontFamily: 'system-ui, sans-serif',
        color: '#cfe6ff',
        overflow: 'hidden',
      }}
    >
      {/* Шапка: статус + поиск */}
      <div style={{ padding: 8, borderBottom: PANEL_BORDER }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 2, color: '#8fe3ff' }}>
            ⚙ PARTS CATALOG
          </span>
          <span style={{ fontSize: 9, color: online ? '#6eff8b' : '#ff9d5c', fontFamily: MONO }}>
            {online ? '● API' : '● SEED'}
          </span>
          {loading && <span style={{ fontSize: 9, color: '#7a8baa', fontFamily: MONO }}>loading…</span>}
          {error && <span style={{ fontSize: 9, color: '#ff5c5c', fontFamily: MONO }}>{error}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search parts…"
            style={{
              flex: 1,
              padding: '4px 8px',
              fontSize: 11,
              color: '#e6f0ff',
              background: '#0a1120',
              border: PANEL_BORDER,
              borderRadius: 5,
              outline: 'none',
              fontFamily: MONO,
            }}
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as CatalogSort)}
            style={{
              fontSize: 10,
              padding: '4px 6px',
              color: '#cfe6ff',
              background: '#0a1120',
              border: PANEL_BORDER,
              borderRadius: 5,
              fontFamily: MONO,
            }}
          >
            <option value="tier-desc">TIER ↓</option>
            <option value="value">VALUE</option>
            <option value="price-asc">PRICE ↑</option>
            <option value="price-desc">PRICE ↓</option>
            <option value="name">NAME</option>
          </select>
          <button
            onClick={toggleInStock}
            style={chipBtn(inStockOnly)}
            title="Только в наличии"
          >
            IN STOCK
          </button>
        </div>
        {/* Табы категорий */}
        <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
          <button onClick={() => setCategory('all')} style={chipBtn(category === 'all')}>
            ALL
          </button>
          {CATEGORY_ORDER.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              style={chipBtn(category === c, CATEGORY_COLOR[c])}
            >
              {CATEGORY_LABEL[c]}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 9, color: '#7a8baa', alignSelf: 'center', fontFamily: MONO }}>
            {visible.length} / {parts.length}
          </span>
        </div>
      </div>

      {/* Тело: список + карточка + корзина */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1.2, overflowY: 'auto', padding: 8, borderRight: PANEL_BORDER }}>
          {visible.length === 0 ? (
            <div style={{ fontSize: 10, color: '#556', fontFamily: MONO, padding: 12 }}>
              NO PARTS MATCH FILTER
            </div>
          ) : (
            visible.map((p) => (
              <PartRow
                key={p.id}
                part={p}
                active={selected?.id === p.id}
                inCart={cart.includes(p.id)}
                onSelect={onSelect}
                onToggleCart={toggleCart}
              />
            ))
          )}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <PartDetail part={selected} />
          </div>
          <div style={{ padding: 8 }}>
            <CartSummary cartParts={cartParts} />
            {cart.length > 0 && (
              <button
                onClick={clearCart}
                style={{ ...chipBtn(false), marginTop: 6, width: '100%' }}
              >
                CLEAR BUILD
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Кнопка-чип панели. */
function chipBtn(active: boolean, accent = '#4dd0ff'): CSSProperties {
  return {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 1,
    padding: '3px 8px',
    cursor: 'pointer',
    borderRadius: 5,
    fontFamily: MONO,
    color: active ? '#04120a' : accent,
    background: active ? accent : 'transparent',
    border: `1px solid ${accent}`,
  };
}

/* -------------------------------------------------------------------------- */
/*  3D-витрина выбранной детали                                               */
/* -------------------------------------------------------------------------- */

function PartShowcase({ part }: { part: Part | null }) {
  const groupRef = useRef<THREE.Group>(null);

  // Простая CRT-подобная форма по категории — без внешних моделей.
  const geometry = useMemo(() => {
    switch (part?.category) {
      case 'engine':
        return new THREE.BoxGeometry(1.1, 1.1, 1.1);
      case 'aero':
        return new THREE.ConeGeometry(0.75, 1.5, 4);
      case 'tyres':
        return new THREE.TorusGeometry(0.7, 0.26, 16, 32);
      case 'brakes':
        return new THREE.CylinderGeometry(0.75, 0.75, 0.28, 32);
      case 'suspension':
        return new THREE.OctahedronGeometry(0.85);
      default:
        return new THREE.IcosahedronGeometry(0.8, 0);
    }
  }, [part?.category]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame((_state, delta) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y += delta * 0.8;
    groupRef.current.rotation.x += delta * 0.25;
  });

  const accent = part ? CATEGORY_COLOR[part.category] : '#4dd0ff';
  const intensity = part ? 0.6 + part.tier * 0.18 : 0.4;

  return (
    <group position={[0, 1.1, 1.6]}>
      {/* Подиум */}
      <mesh position={[0, -0.55, 0]}>
        <cylinderGeometry args={[1.5, 1.7, 0.3, 32]} />
        <meshStandardMaterial color="#0b1020" metalness={0.7} roughness={0.3} />
      </mesh>
      <mesh position={[0, -0.38, 0]}>
        <cylinderGeometry args={[1.45, 1.45, 0.04, 32]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.9} />
      </mesh>

      {/* Вращающаяся деталь */}
      <group ref={groupRef}>
        <mesh geometry={geometry}>
          <meshStandardMaterial
            color={accent}
            metalness={0.75}
            roughness={0.25}
            emissive={accent}
            emissiveIntensity={intensity}
          />
        </mesh>
      </group>

      {/* Подпись детали */}
      {part && (
        <Text
          position={[0, -1.0, 0]}
          fontSize={0.22}
          color="#cfe6ff"
          anchorX="center"
          anchorY="middle"
        >
          {part.name}
        </Text>
      )}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  Публичный компонент: стенд «PARTS CATALOG»                                */
/* -------------------------------------------------------------------------- */

/** Мировая позиция стенда каталога (с другой стороны пит-лейна, чем 7.2). */
export const PARTS_CATALOG_POSITION: [number, number, number] = [7, 0, -30];

interface PartsCatalogProps {
  /** Внешний каталог; если не задан — стор 7.2, иначе самостоятельный fetch. */
  parts?: Part[];
  position?: [number, number, number];
}

export function PartsCatalog({ parts, position = PARTS_CATALOG_POSITION }: PartsCatalogProps) {
  const storeParts = useMarketStore((s) => s.parts);
  const storeLoading = useMarketStore((s) => s.loading);
  const storeError = useMarketStore((s) => s.error);
  const selectedPartId = useMarketStore((s) => s.selectedPartId);
  const selectPart = useMarketStore((s) => s.selectPart);

  // Тянем /api/parts сами, только если каталог не передан и стор 7.2 пуст.
  const remote = useCatalogData(!parts && !(storeParts && storeParts.length));
  const source = parts ?? (storeParts && storeParts.length ? storeParts : remote.parts);
  const loading = storeLoading || (remote.loading && !parts);
  const error = storeError ?? remote.error;
  const online = Array.isArray(parts) ? true : storeParts.length > 0 || remote.online;

  const selected = useMemo(
    () => source.find((p) => p.id === selectedPartId) ?? null,
    [source, selectedPartId],
  );

  // Автовыбор первой детали, чтобы карточка не пустовала.
  const autoRef = useRef(false);
  if (!autoRef.current && !selectedPartId && source.length > 0) {
    autoRef.current = true;
    selectPart(source[0].id);
  }

  return (
    <group position={position}>
      {/* Рама стенда */}
      <mesh position={[0, 2.6, -0.4]}>
        <boxGeometry args={[9.6, 6.4, 0.24]} />
        <meshStandardMaterial color="#0b1020" metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0, 2.6, -0.26]}>
        <planeGeometry args={[9.2, 6.0]} />
        <meshStandardMaterial color="#06121f" emissive="#0d2740" emissiveIntensity={0.7} />
      </mesh>
      {/* Неоновая кромка */}
      <mesh position={[0, 5.85, -0.26]}>
        <boxGeometry args={[9.2, 0.06, 0.06]} />
        <meshStandardMaterial color="#4dd0ff" emissive="#4dd0ff" emissiveIntensity={1.4} />
      </mesh>

      {/* LED-заголовок над стендом */}
      <Text
        position={[0, 6.2, -0.2]}
        fontSize={0.34}
        color="#8fe3ff"
        anchorX="center"
        anchorY="middle"
      >
        {'PARTS CATALOG · FORMULA I1'}
      </Text>

      {/* UI-панель */}
      <Html
        position={[0, 2.55, -0.1]}
        transform
        distanceFactor={8}
        zIndexRange={[20, 0]}
        style={{ pointerEvents: 'auto' }}
      >
        <CatalogPanel
          parts={source}
          loading={loading}
          error={error}
          online={online}
          selected={selected}
          onSelect={selectPart}
        />
      </Html>

      {/* 3D-витрина выбранной детали */}
      <PartShowcase part={selected} />
    </group>
  );
}

export default PartsCatalog;
