/**
 * ЗАДАЧА 7.4 — КРАФТ · МАРКЕТПЛЕЙС ТЮНИНГА (FORMULA I1)
 * ============================================================================
 * Крафт-верстак: из купленных деталей пилот собирает собственный билд
 * (build) и публикует его в маркетплейс. Комиссия платформы 30% считается
 * на бэкенде, а здесь — предварительная смета для UI и локальный фолбэк
 * (dev-offline), если API недоступен.
 *
 * Что реализовано:
 *   • чистые функции крафта: `buildDraftCost` (цена + комиссия 30%),
 *     `computeBuildStats` (агрегат характеристик сборки), `validateDraft`;
 *   • zustand-стор `useCraftStore` — слот-доска (engine/aero/tyres/brakes/
 *     suspension), имя билда, preflight-смета, публикация через
 *     `POST /builds` (клиент и типы берутся из TuningMarket.tsx);
 *   • 3D-верстак: стол, пять сияющих слотов-плит, палитра деталей выбранного
 *     слота, HUD со стоимостью/комиссией и статами, кнопка «CRAFT».
 *
 * Схема данных совместима с бэкендом: parts.json → GET /api/parts,
 * builds.json → POST/GET /api/builds (см. web/server.js).
 *
 * Приёмы взяты из research/racing-game (MIT):
 *   - src/store.ts  — zustand как единый источник игрового состояния;
 *   - src/ui/Speed/Gauge.tsx — приборная панель из примитивов без моделей.
 * Код собственный, в терминах проекта AI-1 (FORMULA I1).
 * ============================================================================
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { create } from 'zustand';
import {
  createBuild,
  useMarketStore,
  DEFAULT_PARTS,
  type Build,
  type BuildDraft,
  type BuildItem,
  type Part,
  type PartCategory,
  type PartStats,
} from './TuningMarket';

/* -------------------------------------------------------------------------- */
/*  Константы крафта                                                          */
/* -------------------------------------------------------------------------- */

/** Комиссия платформы маркетплейса — 30% (считается и на бэкенде). */
export const CRAFT_COMMISSION_RATE = 0.3;

/** Порядок и набор слотов сборки. */
export const CRAFT_SLOTS: PartCategory[] = [
  'engine',
  'aero',
  'tyres',
  'brakes',
  'suspension',
];

export const SLOT_LABEL: Record<PartCategory, string> = {
  engine: 'ENGINE',
  aero: 'AERO',
  tyres: 'TYRES',
  brakes: 'BRAKES',
  suspension: 'SUSP',
};

export const SLOT_COLOR: Record<PartCategory, string> = {
  engine: '#ff5c5c',
  aero: '#4dd0ff',
  tyres: '#ffd700',
  brakes: '#a855f7',
  suspension: '#6eff8b',
};

/* -------------------------------------------------------------------------- */
/*  Чистая логика крафта                                                      */
/* -------------------------------------------------------------------------- */

const PART_INDEX = (parts: Part[]): Map<string, Part> =>
  new Map(parts.map((p) => [p.id, p]));

/** Базовая сумма цен выбранных деталей (без комиссии). */
export function buildBasePrice(items: BuildItem[], parts: Part[]): number {
  const idx = PART_INDEX(parts);
  return items.reduce((sum, it) => sum + (idx.get(it.part_id)?.price ?? 0), 0);
}

/** Комиссия платформы в кредитах. */
export function buildCommission(items: BuildItem[], parts: Part[]): number {
  return Math.round(buildBasePrice(items, parts) * CRAFT_COMMISSION_RATE);
}

/** Итоговая смета крафта: цена деталей + комиссия 30%. */
export function buildDraftCost(items: BuildItem[], parts: Part[]): number {
  return buildBasePrice(items, parts) + buildCommission(items, parts);
}

/** Агрегат характеристик: среднее по всем деталям слота (округление до 0.1). */
export function computeBuildStats(items: BuildItem[], parts: Part[]): PartStats {
  const idx = PART_INDEX(parts);
  const keys: (keyof PartStats)[] = ['speed', 'accel', 'grip', 'handling', 'reliability'];
  const out: PartStats = {};
  for (const key of keys) {
    let sum = 0;
    let n = 0;
    for (const it of items) {
      const v = idx.get(it.part_id)?.stats?.[key];
      if (typeof v === 'number') {
        sum += v;
        n += 1;
      }
    }
    if (n > 0) out[key] = Math.round((sum / n) * 10) / 10;
  }
  return out;
}

/** Проверка черновика перед публикацией. Возвращает список ошибок. */
export function validateDraft(name: string, items: BuildItem[]): string[] {
  const errors: string[] = [];
  if (!name.trim()) errors.push('Укажите имя сборки.');
  if (items.length === 0) errors.push('Установите хотя бы одну деталь.');
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.slot)) errors.push(`Слот ${SLOT_LABEL[it.slot]}: дубликат.`);
    seen.add(it.slot);
  }
  return errors;
}

/* -------------------------------------------------------------------------- */
/*  Стор крафта                                                               */
/* -------------------------------------------------------------------------- */

export type CraftSlots = Partial<Record<PartCategory, string>>;

interface CraftState {
  name: string;
  slots: CraftSlots;
  /** Результат последнего успешного крафта (для 3D-превью). */
  result: Build | null;
  crafting: boolean;
  error: string | null;
  message: string | null;

  setName: (name: string) => void;
  assign: (slot: PartCategory, partId: string) => void;
  clearSlot: (slot: PartCategory) => void;
  reset: () => void;
  /** Текущий черновик-список деталей. */
  items: () => BuildItem[];
  /** Публикация билда: POST /builds, с локальным фолбэком при offline. */
  craft: () => Promise<Build | null>;
}

export const useCraftStore = create<CraftState>((set, get) => ({
  name: 'MY-FORMULA',
  slots: {},
  result: null,
  crafting: false,
  error: null,
  message: null,

  setName: (name) => set({ name }),

  assign: (slot, partId) => {
    set((s) => ({ slots: { ...s.slots, [slot]: partId }, error: null }));
  },

  clearSlot: (slot) => {
    set((s) => {
      const next = { ...s.slots };
      delete next[slot];
      return { slots: next };
    });
  },

  reset: () => set({ slots: {}, result: null, error: null, message: null }),

  items: () => {
    const { slots } = get();
    return CRAFT_SLOTS.filter((s) => slots[s]).map((slot) => ({
      part_id: slots[slot] as string,
      slot,
    }));
  },

  craft: async () => {
    const items = get().items();
    const name = get().name;
    const errors = validateDraft(name, items);
    if (errors.length > 0) {
      set({ error: errors[0], message: null });
      return null;
    }

    set({ crafting: true, error: null, message: null });
    const draft: BuildDraft = { name: name.trim(), parts: items };

    try {
      const saved = await createBuild(draft);
      set({ crafting: false, result: saved, message: `Опубликовано: ${saved.id}` });
      void useMarketStore.getState().loadBuilds();
      return saved;
    } catch (err) {
      // dev-offline фолбэк: собираем локальный билд, чтобы верстак не «висел».
      const fallback: Build = {
        id: `local-${Date.now().toString(36)}`,
        owner: 'local-pilot',
        name: draft.name,
        parts: items,
        rating: 0,
        createdAt: Date.now(),
      };
      set({
        crafting: false,
        result: fallback,
        message: 'API недоступен — билд сохранён локально.',
        error: err instanceof Error ? err.message : String(err),
      });
      return fallback;
    }
  },
}));

/* -------------------------------------------------------------------------- */
/*  3D: плита слота                                                           */
/* -------------------------------------------------------------------------- */

function SlotPad({
  slot,
  part,
  active,
  onClick,
}: {
  slot: PartCategory;
  part: Part | null;
  active: boolean;
  onClick: (slot: PartCategory) => void;
}) {
  const color = SLOT_COLOR[slot];
  const glow = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const m = glow.current;
    if (!m) return;
    const pulse = active ? 0.35 + 0.25 * Math.sin(clock.getElapsedTime() * 4) : 0.12;
    const mat = m.material as THREE.MeshBasicMaterial;
    mat.opacity = pulse;
  });

  return (
    <group onClick={(e) => { e.stopPropagation(); onClick(slot); }}>
      {/* тело плиты */}
      <mesh position={[0, 0.09, 0]}>
        <boxGeometry args={[1.9, 0.18, 1.5]} />
        <meshStandardMaterial
          color={active ? '#1f2c46' : '#141d30'}
          emissive={color}
          emissiveIntensity={active ? 0.45 : 0.12}
          metalness={0.7}
          roughness={0.35}
        />
      </mesh>
      {/* подсветка-глоу */}
      <mesh ref={glow} position={[0, 0.19, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.75, 1.35]} />
        <meshBasicMaterial color={color} transparent opacity={0.15} depthWrite={false} />
      </mesh>
      {/* подписи */}
      <Text position={[0, 0.35, 0.42]} fontSize={0.2} color={color} anchorX="center" anchorY="middle">
        {SLOT_LABEL[slot]}
      </Text>
      <Text position={[0, 0.35, -0.02]} fontSize={0.16} color={part ? '#eaf3ff' : '#5a6a86'} anchorX="center" anchorY="middle">
        {part ? part.name : '— empty —'}
      </Text>
      <Text position={[0, 0.35, -0.5]} fontSize={0.14} color="#ffd700" anchorX="center" anchorY="middle">
        {part ? `${part.price} ⧫` : ''}
      </Text>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  3D: палитра деталей активного слота                                       */
/* -------------------------------------------------------------------------- */

function PartPalette({
  parts,
  activeSlot,
  onPick,
}: {
  parts: Part[];
  activeSlot: PartCategory;
  onPick: (partId: string) => void;
}) {
  const list = useMemo(
    () => parts.filter((p) => p.category === activeSlot).slice(0, 6),
    [parts, activeSlot],
  );
  const color = SLOT_COLOR[activeSlot];

  return (
    <group position={[0, 0, 4.4]}>
      <mesh position={[0, 1.1, 0]}>
        <boxGeometry args={[12.4, 2.2, 0.18]} />
        <meshStandardMaterial color="#0b1020" metalness={0.5} roughness={0.4} />
      </mesh>
      <Text position={[0, 2.35, 0.12]} fontSize={0.24} color={color} anchorX="center" anchorY="middle">
        {`ПАЛИТРА · ${SLOT_LABEL[activeSlot]}`}
      </Text>
      {list.length === 0 && (
        <Text position={[0, 1.1, 0.12]} fontSize={0.2} color="#5a6a86" anchorX="center" anchorY="middle">
          {'нет деталей в категории'}
        </Text>
      )}
      {list.map((p, i) => {
        const x = -5 + i * 2.0;
        return (
          <group key={p.id} position={[x, 1.05, 0.16]} onClick={(e) => { e.stopPropagation(); onPick(p.id); }}>
            <mesh>
              <boxGeometry args={[1.7, 1.7, 0.28]} />
              <meshStandardMaterial
                color="#16233a"
                emissive={color}
                emissiveIntensity={0.25}
                metalness={0.6}
                roughness={0.35}
              />
            </mesh>
            <Text position={[0, 0.12, 0.16]} fontSize={0.15} color="#eaf3ff" anchorX="center" anchorY="middle">
              {p.name}
            </Text>
            <Text position={[0, -0.28, 0.16]} fontSize={0.15} color="#ffd700" anchorX="center" anchorY="middle">
              {`${p.price} ⧫ · T${p.tier}`}
            </Text>
          </group>
        );
      })}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  3D: полоса статов                                                         */
/* -------------------------------------------------------------------------- */

const STAT_KEYS: (keyof PartStats)[] = ['speed', 'accel', 'grip', 'handling', 'reliability'];

function StatsRow({ stats }: { stats: PartStats }) {
  const max = 5.4;
  return (
    <group position={[-5.9, 0, -3.4]}>
      {STAT_KEYS.map((k, i) => {
        const v = stats[k] ?? 0;
        const w = Math.max(0.05, (v / 10) * max);
        return (
          <group key={k} position={[0, 2.6 - i * 0.36, 0]}>
            <Text position={[0, 0, 0.02]} fontSize={0.16} color="#7a8baa" anchorX="left" anchorY="middle">
              {k.toUpperCase()}
            </Text>
            <mesh position={[1.7 + w / 2, 0, 0.02]}>
              <planeGeometry args={[max, 0.12]} />
              <meshBasicMaterial color="#1a2438" />
            </mesh>
            <mesh position={[1.7 + w / 2, 0, 0.03]}>
              <planeGeometry args={[w, 0.12]} />
              <meshBasicMaterial color={v >= 7 ? '#6eff8b' : v >= 4 ? '#ffd700' : '#ff5c5c'} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  3D: кнопка CRAFT                                                          */
/* -------------------------------------------------------------------------- */

function CraftButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  const color = busy ? '#5a6a86' : '#6eff8b';
  const pulse = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const m = pulse.current;
    if (!m) return;
    const mat = m.material as THREE.MeshBasicMaterial;
    mat.opacity = busy ? 0.1 : 0.2 + 0.15 * Math.sin(clock.getElapsedTime() * 5);
  });
  return (
    <group position={[7.6, 0, -2.4]} onClick={(e) => { if (!busy) { e.stopPropagation(); onClick(); } }}>
      <mesh position={[0, 0.5, 0]}>
        <cylinderGeometry args={[1.15, 1.25, 0.35, 32]} />
        <meshStandardMaterial color="#16233a" emissive={color} emissiveIntensity={busy ? 0.2 : 0.6} metalness={0.7} roughness={0.3} />
      </mesh>
      <mesh ref={pulse} position={[0, 0.72, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.35, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.2} depthWrite={false} />
      </mesh>
      <Text position={[0, 1.55, 0]} fontSize={0.3} color={color} anchorX="center" anchorY="middle">
        {busy ? 'CRAFTING…' : 'CRAFT'}
      </Text>
      <Text position={[0, 1.18, 0]} fontSize={0.15} color="#7a8baa" anchorX="center" anchorY="middle">
        {'POST /api/builds'}
      </Text>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  Павильон крафта                                                           */
/* -------------------------------------------------------------------------- */

/** Мировая позиция верстака (рядом с маркетплейсом /parts). */
export const CRAFT_POSITION: [number, number, number] = [46, 0, -30];

interface TuningCraftProps {
  /** Каталог деталей; по умолчанию берётся из маркетплейс-стора. */
  parts?: Part[];
  title?: string;
}

export function TuningCraft({ parts, title = 'TUNING CRAFT · СБОРКА БИЛДА' }: TuningCraftProps) {
  const storeParts = useMarketStore((s) => s.parts);
  const loadParts = useMarketStore((s) => s.loadParts);

  const slots = useCraftStore((s) => s.slots);
  const name = useCraftStore((s) => s.name);
  const result = useCraftStore((s) => s.result);
  const crafting = useCraftStore((s) => s.crafting);
  const error = useCraftStore((s) => s.error);
  const message = useCraftStore((s) => s.message);
  const assign = useCraftStore((s) => s.assign);
  const setName = useCraftStore((s) => s.setName);
  const craft = useCraftStore((s) => s.craft);

  const [activeSlot, setActiveSlot] = useState<PartCategory>('engine');

  useEffect(() => {
    if (!parts) void loadParts();
  }, [parts, loadParts]);

  const list = parts && parts.length > 0 ? parts : storeParts.length > 0 ? storeParts : DEFAULT_PARTS;
  const items = useMemo<BuildItem[]>(
    () =>
      CRAFT_SLOTS.filter((s) => slots[s]).map((slot) => ({
        part_id: slots[slot] as string,
        slot,
      })),
    [slots],
  );

  const index = useMemo(() => new Map(list.map((p) => [p.id, p])), [list]);
  const cost = buildDraftCost(items, list);
  const base = buildBasePrice(items, list);
  const commission = buildCommission(items, list);
  const stats = useMemo(() => computeBuildStats(items, list), [items, list]);

  const onPick = useCallback(
    (partId: string) => {
      const p = index.get(partId);
      if (p) assign(p.category, partId);
    },
    [index, assign],
  );

  const handleCraft = useCallback(() => {
    void craft();
  }, [craft]);

  return (
    <group position={CRAFT_POSITION}>
      {/* земля-основание */}
      <mesh position={[0, -0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[26, 14]} />
        <meshStandardMaterial color="#0a1020" metalness={0.3} roughness={0.8} />
      </mesh>

      {/* стол-верстак */}
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[13, 0.2, 3.2]} />
        <meshStandardMaterial color="#121a2c" metalness={0.6} roughness={0.4} />
      </mesh>

      {/* заголовок */}
      <Text position={[0, 4.2, -3.4]} fontSize={0.42} color="#eaf3ff" anchorX="center" anchorY="middle">
        {title}
      </Text>
      <Text position={[0, 3.78, -3.4]} fontSize={0.2} color="#8fe3ff" anchorX="center" anchorY="middle">
        {`BUILD: ${name}${result ? `  ·  ${result.id}` : ''}`}
      </Text>

      {/* слоты */}
      {CRAFT_SLOTS.map((slot, i) => (
        <group key={slot} position={[-4.4 + i * 2.2, 0, -0.6]}>
          <SlotPad
            slot={slot}
            part={slots[slot] ? index.get(slots[slot] as string) ?? null : null}
            active={activeSlot === slot}
            onClick={setActiveSlot}
          />
        </group>
      ))}

      {/* палитра */}
      <PartPalette parts={list} activeSlot={activeSlot} onPick={onPick} />

      {/* HUD: смета */}
      <group position={[5.9, 0, -3.4]}>
        <Text position={[0, 3.2, 0.02]} fontSize={0.2} color="#7a8baa" anchorX="right" anchorY="middle">
          {'BASE'}
        </Text>
        <Text position={[0, 3.2, 0.02]} fontSize={0.2} color="#eaf3ff" anchorX="left" anchorY="middle">
          {`  ${base} ⧫`}
        </Text>
        <Text position={[0, 2.82, 0.02]} fontSize={0.2} color="#7a8baa" anchorX="right" anchorY="middle">
          {'FEE 30%'}
        </Text>
        <Text position={[0, 2.82, 0.02]} fontSize={0.2} color="#ff9f43" anchorX="left" anchorY="middle">
          {`  ${commission} ⧫`}
        </Text>
        <Text position={[0, 2.4, 0.02]} fontSize={0.26} color="#ffd700" anchorX="right" anchorY="middle">
          {'TOTAL'}
        </Text>
        <Text position={[0, 2.4, 0.02]} fontSize={0.26} color="#ffd700" anchorX="left" anchorY="middle">
          {`  ${cost} ⧫`}
        </Text>
        {(error || message) && (
          <Text
            position={[0, 1.95, 0.02]}
            fontSize={0.16}
            color={error ? '#ff5c5c' : '#6eff8b'}
            anchorX="center"
            anchorY="middle"
          >
            {error ?? message ?? ''}
          </Text>
        )}
      </group>

      {/* статы */}
      <StatsRow stats={stats} />

      {/* кнопка */}
      <CraftButton busy={crafting} onClick={handleCraft} />
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  DOM-HUD (опционально): заголовок + имя билда для оверлея React            */
/* -------------------------------------------------------------------------- */

export default TuningCraft;
