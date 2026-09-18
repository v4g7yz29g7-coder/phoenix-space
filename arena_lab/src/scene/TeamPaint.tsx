/**
 * TeamPaint.tsx — Раскраска команд (задача 2.4)
 *
 * Единый источник правды для окраса болидов по командам. Каждой команде
 * соответствует фиксированная палитра: базовый цвет кузова `paint`, неоновый
 * акцент `accent` и контрастный кант `trim` (плюс стартовый `number`).
 *
 * Команда выбирается ДЕТЕРМИНИРОВАННО из имени агента (или любого `seed`):
 * один и тот же `seed` всегда даёт один и тот же окрас. Это важно, потому что
 * цвет должен быть стабилен между кадрами, реконнектами и разными клиентами
 * арены — иначе болид «перекрашивается» на глазах у зрителя.
 *
 * Адаптация под наш проект (НЕ копия референса):
 *   · в pmndrs/racing-game окрас — это один цвет `state.color` на весь гараж
 *     (`Chassis.tsx` lerp-ит его в материал кузова, `store.ts` хранит `color`);
 *   · здесь окрас разложен по командам и завязан на стабильный хеш имени,
 *     при этом цвета оставлены СОВМЕСТИМЫМИ с `Chassis.tsx`
 *     (`CHASSIS_ARGS` / `CHASSIS_MASS`, тёмный металл + яркий неон `toneMapped={false}`);
 *   · `<TeamVehicle/>` — это НЕ чистый визуал: он поднимает физическое тело
 *     `useBox` из `@react-three/cannon`, т.е. готовый окрашенный болид для
 *     `<Physics>`-сцены (в отличие от визуальной оболочки `TeamLivery.tsx`).
 *
 * Экспорты:
 *   · `TEAM_PALETTES`        — таблица палитр (readonly).
 *   · `hashSeed(seed)`       — детерминированный хеш строки (FNV-1a).
 *   · `pickTeam(seed)`       — палитра команды по `seed`.
 *   · `teamById(id)`         — прямой доступ по `id`.
 *   · `useTeamPaint(seed)`   — мемоизированная версия для React.
 *   · `teamChassisProps(seed)` / `useTeamChassisProps(seed)` — `{ color, accent }`
 *                              для существующего `<Chassis/>` / `<CyberpunkVehicle/>`.
 *   · `teamCssVars(palette)` — CSS-переменные для HTML-оверлеев.
 *   · `<TeamVehicle/>`       — окрашенный болид с физикой `useBox`.
 */
import { useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useFrame } from '@react-three/fiber';
import { useBox } from '@react-three/cannon';
import type { Group, MeshStandardMaterial } from 'three';

import { CHASSIS_ARGS, CHASSIS_MASS } from './Chassis';

/** Полное описание палитры команды. */
export interface TeamPalette {
  /** Стабильный идентификатор команды. */
  id: string;
  /** Отображаемое имя команды. */
  name: string;
  /** Стартовый номер болида (нос / балласт). */
  number: number;
  /** Цвет кузова (матовая металлическая база). */
  paint: string;
  /** Неоновый акцент — боковые полосы, подсветка днища. */
  accent: string;
  /** Контрастный кант — задний огонь, номер. */
  trim: string;
}

/**
 * Таблица команд. Порядок фиксирован — индекс в массиве используется хешем
 * `seed`, поэтому НЕ переставляй записи: это сменит окрас всех болидов.
 */
export const TEAM_PALETTES: readonly TeamPalette[] = [
  { id: 'dragon', name: 'Crimson Dragon', number: 1, paint: '#1a0d12', accent: '#ff2d55', trim: '#ffd166' },
  { id: 'cobalt', name: 'Cobalt Union', number: 8, paint: '#0d1430', accent: '#3d7bff', trim: '#a5d8ff' },
  { id: 'mint', name: 'Mint Circuit', number: 24, paint: '#0b1a14', accent: '#2affb0', trim: '#eafff5' },
  { id: 'amber', name: 'Amber Wolfpack', number: 31, paint: '#1d1405', accent: '#ffab2e', trim: '#fff3d6' },
  { id: 'orchid', name: 'Orchid Syndicate', number: 52, paint: '#170b24', accent: '#c56bff', trim: '#ffc9f0' },
  { id: 'graphite', name: 'Graphite Fang', number: 63, paint: '#0e1116', accent: '#8effc1', trim: '#d0d6e0' },
  { id: 'magma', name: 'Magma Nine', number: 77, paint: '#210c09', accent: '#ff5a1f', trim: '#ffe0b3' },
  { id: 'glacier', name: 'Glacier Drift', number: 90, paint: '#08161f', accent: '#5fe0ff', trim: '#e6faff' },
] as const;

/** Быстрый lookup `id → palette`. */
const PALETTE_BY_ID: ReadonlyMap<string, TeamPalette> = new Map(
  TEAM_PALETTES.map((p) => [p.id, p]),
);

/**
 * Детерминированный не-криптографический хеш строки (FNV-1a, 32 бита).
 * Нужен, чтобы имя агента всегда попадало в одну и ту же команду.
 */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Палитра команды, детерминированно выбранная по `seed`. */
export function pickTeam(seed: string): TeamPalette {
  return TEAM_PALETTES[hashSeed(seed) % TEAM_PALETTES.length];
}

/** Прямой доступ к палитре по `id` (ручное назначение / лидерборд). */
export function teamById(id: string): TeamPalette | undefined {
  return PALETTE_BY_ID.get(id);
}

/** Мемоизированный выбор палитры для использования внутри React-компонентов. */
export function useTeamPaint(seed: string): TeamPalette {
  return useMemo(() => pickTeam(seed), [seed]);
}

/** Маппинг палитры в пропсы `<Chassis/>` — окрас остаётся чисто визуальным. */
export function teamChassisProps(seed: string): { color: string; accent: string } {
  const team = pickTeam(seed);
  return { color: team.paint, accent: team.accent };
}

/** `{ color, accent }` для `<CyberpunkVehicle/>` одной строкой. */
export function useTeamChassisProps(seed: string): { color: string; accent: string } {
  const team = useTeamPaint(seed);
  return useMemo(() => ({ color: team.paint, accent: team.accent }), [team]);
}

/** CSS-переменные палитры — для HTML-карточек команды/пилота. */
export function teamCssVars(palette: TeamPalette): CSSProperties {
  return {
    ['--team-paint' as string]: palette.paint,
    ['--team-accent' as string]: palette.accent,
    ['--team-trim' as string]: palette.trim,
  } as CSSProperties;
}

export interface TeamVehicleProps {
  /** Имя агента/команды — источник окраса. */
  seed: string;
  /** Начальная позиция физтела. */
  position?: [number, number, number];
  /** Начальный поворот физтела. */
  rotation?: [number, number, number];
  /** Масса кузова (по умолчанию как в `CHASSIS_MASS`). */
  mass?: number;
  /** Пульсировать ли неоном (по умолчанию true). */
  pulse?: boolean;
}

/**
 * Окрашенный болид с физическим телом `useBox` (cannon-es). Геометрия
 * повторяет силуэт `ChassisVisual` из `Chassis.tsx`, но цвет кузова/неона
 * берётся из палитры команды. Пульсация неона — чисто визуальная и не
 * трогает физику, поэтому болид можно безопасно двигать силами движка.
 */
export function TeamVehicle({
  seed,
  position = [0, 1, 0],
  rotation = [0, 0, 0],
  mass = CHASSIS_MASS,
  pulse = true,
}: TeamVehicleProps) {
  const palette = useTeamPaint(seed);

  // Физический кузов: та же арка, что и у `<Chassis/>`, но независимый инстанс.
  const bodyRef = useRef<Group>(null);
  useBox<Group>(
    () => ({
      args: CHASSIS_ARGS,
      mass,
      position,
      rotation,
      allowSleep: false,
    }),
    bodyRef,
  );

  const stripMatRef = useRef<MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    if (!pulse) return;
    // «Дыхание» неона команды: 2.0 … 4.5 без скачков на старте.
    const t = clock.getElapsedTime();
    const glow = 2 + (Math.sin(t * 3) * 0.5 + 0.5) * 2.5;
    const mat = stripMatRef.current;
    if (mat) mat.emissiveIntensity = glow;
  });

  return (
    <group ref={bodyRef} dispose={null}>
      {/* кузов в цвете команды */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[1.9, 0.5, 4.3]} />
        <meshStandardMaterial color={palette.paint} roughness={0.35} metalness={0.85} />
      </mesh>

      {/* кабина — тёмное стекло */}
      <mesh castShadow position={[0, 0.45, -0.15]}>
        <boxGeometry args={[1.5, 0.55, 1.8]} />
        <meshStandardMaterial color="#05060a" roughness={0.15} metalness={0.6} />
      </mesh>

      {/* неоновые боковые полосы команды (пульсируют) */}
      {[-0.97, 0.97].map((x) => (
        <mesh key={`strip-${x}`} position={[x, 0.02, 0]}>
          <boxGeometry args={[0.05, 0.08, 4.0]} />
          <meshStandardMaterial
            ref={x < 0 ? stripMatRef : undefined}
            color="#000000"
            emissive={palette.accent}
            emissiveIntensity={3}
            toneMapped={false}
          />
        </mesh>
      ))}

      {/* фары */}
      {[-0.62, 0.62].map((x) => (
        <mesh key={`head-${x}`} position={[x, 0.14, 2.16]}>
          <boxGeometry args={[0.4, 0.12, 0.08]} />
          <meshStandardMaterial color="#ffffff" emissive="#cfe9ff" emissiveIntensity={4} toneMapped={false} />
        </mesh>
      ))}

      {/* задний огонь в цвете канта */}
      <mesh position={[0, 0.14, -2.16]}>
        <boxGeometry args={[1.5, 0.1, 0.08]} />
        <meshStandardMaterial color="#000000" emissive={palette.trim} emissiveIntensity={3} toneMapped={false} />
      </mesh>

      {/* стартовый номер на носу (кант) */}
      <mesh position={[0, 0.4, 2.16]}>
        <boxGeometry args={[0.6, 0.28, 0.06]} />
        <meshStandardMaterial color={palette.trim} emissive={palette.trim} emissiveIntensity={0.6} />
      </mesh>

      {/* подсветка днища */}
      <pointLight position={[0, -0.35, 0]} color={palette.accent} intensity={3} distance={6} />
    </group>
  );
}

export default TeamVehicle;
