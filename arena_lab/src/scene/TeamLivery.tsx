/**
 * TeamLivery.tsx — Раскраска команд (Задача 2.4, стадия «Киберпанк-кар»)
 *
 * Модуль задаёт ЕДИНЫЙ источник правды для окраса болидов по командам:
 * каждой команде соответствует фиксированная ливрея (цвет кузова `paint`,
 * неоновый акцент `accent`, контрастный кант `trim`, стартовый номер `number`).
 * Команда выбирается ДЕТЕРМИНИРОВАННО из имени агента/команды — один и тот же
 * `seed` всегда даёт один и тот же окрас, поэтому цвет стабилен между тиками,
 * реконнектами и разными клиентами арены.
 *
 * Стиль палитры согласован с `Chassis.tsx` (CHASSIS_COLOR / CHASSIS_ACCENT):
 * тёмный металлический кузов + яркий неон `toneMapped={false}`.
 *
 * Референсы (research/audit.md): приём «PickColor» из pmndrs/racing-game
 * (`src/ui/PickColor.tsx`, MIT) — там цвет один на весь гараж; здесь он
 * разложен по командам и завязан на стабильный хеш имени агента.
 *
 * Экспорты:
 *   · `TEAM_LIVERIES`          — таблица ливрей (readonly).
 *   · `getTeamLivery(seed)`    — детерминированный выбор ливреи по строке.
 *   · `useTeamLivery(seed)`    — мемоизированная версия для React.
 *   · `getLiveryById(id)`      — прямой доступ по идентификатору команды.
 *   · `useTeamChassisProps`    — `{ color, accent }` для `<CyberpunkVehicle/>`.
 *   · `liveryToChassisProps`   — маппинг ливреи в пропсы `<Chassis/>`.
 *   · `liveryGradient`/`liveryCssVars` — палитра для HTML-оверлеев (leaderboard).
 *   · `<TeamCarShell/>`        — процедурный окрас кузова с пульсирующим неоном.
 *   · `<TeamNameplate/>`       — подпись команды/агента на nose болида.
 *   · `<TeamLiveryRoster/>`    — ряд болидов всех команд (витрина палитры).
 */
import { useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group, MeshStandardMaterial } from 'three';

/** Полное описание ливреи команды. */
export interface TeamLivery {
  /** Стабильный идентификатор команды. */
  id: string;
  /** Отображаемое имя команды. */
  name: string;
  /** Стартовый номер болида (для носа/балласта). */
  number: number;
  /** Цвет кузова (матовый металл, база). */
  paint: string;
  /** Неоновый акцент — боковые полосы, подсветка днища. */
  accent: string;
  /** Контрастный кант — крыло / номер. */
  trim: string;
}

/**
 * Таблица команд. Порядок фиксирован — индекс используется хешем `seed`,
 * поэтому НЕ переставлять записи без необходимости (сменит окрасы всех).
 */
export const TEAM_LIVERIES: readonly TeamLivery[] = [
  { id: 'vipers', name: 'Neon Vipers', number: 7, paint: '#12151f', accent: '#12f7ff', trim: '#ff2e88' },
  { id: 'ronin', name: 'Chrome Ronin', number: 13, paint: '#1b1030', accent: '#a855f7', trim: '#f5d90a' },
  { id: 'kitsune', name: 'Kitsune Blaze', number: 3, paint: '#241216', accent: '#ff5c5c', trim: '#ffd166' },
  { id: 'glacier', name: 'Glacier Syndicate', number: 21, paint: '#0e1a24', accent: '#7dd3fc', trim: '#e0f2fe' },
  { id: 'carbon', name: 'Carbon Fangs', number: 44, paint: '#0c0f14', accent: '#6eff8b', trim: '#00ffa3' },
  { id: 'solstice', name: 'Solstice Motors', number: 9, paint: '#241c07', accent: '#ffd700', trim: '#ff8c42' },
  { id: 'phantom', name: 'Phantom Circuit', number: 66, paint: '#160f22', accent: '#ff7eb6', trim: '#c084fc' },
  { id: 'vortex', name: 'Vortex Nine', number: 88, paint: '#0b1620', accent: '#4dd0ff', trim: '#fb923c' },
] as const;

/** Быстрый lookup `id → livery`. */
const LIVERY_BY_ID: ReadonlyMap<string, TeamLivery> = new Map(
  TEAM_LIVERIES.map((l) => [l.id, l]),
);

/**
 * Детерминированный не-криптографический хеш строки (djb2).
 * Нужен, чтобы имя агента всегда попадало в одну и ту же команду.
 */
export function hashSeed(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h) ^ seed.charCodeAt(i);
    h >>>= 0;
  }
  return h >>> 0;
}

/** Возвращает ливрею команды, детерминированно выбранную по `seed`. */
export function getTeamLivery(seed: string): TeamLivery {
  const idx = hashSeed(seed) % TEAM_LIVERIES.length;
  return TEAM_LIVERIES[idx];
}

/** Прямой доступ к ливрее по `id` (для лидерборда/ручного назначения). */
export function getLiveryById(id: string): TeamLivery | undefined {
  return LIVERY_BY_ID.get(id);
}

/** Мемоизированный выбор ливреи для использования внутри React-компонентов. */
export function useTeamLivery(seed: string): TeamLivery {
  return useMemo(() => getTeamLivery(seed), [seed]);
}

/**
 * Маппинг ливреи в пропсы `<Chassis/>` (см. `Chassis.tsx`).
 * Держим окрас и физику развязанными: окрас — только визуальный слой.
 */
export function liveryToChassisProps(livery: TeamLivery): { color: string; accent: string } {
  return { color: livery.paint, accent: livery.accent };
}

/**
 * Готовые пропсы для `<CyberpunkVehicle color accent>` (см. `Vehicle.tsx`).
 * Позволяет окрасить болид агента одной строкой:
 *   const livery = useTeamChassisProps(agentName);
 *   <CyberpunkVehicle {...livery} />
 */
export function useTeamChassisProps(seed: string): { color: string; accent: string } {
  const livery = useTeamLivery(seed);
  return useMemo(() => liveryToChassisProps(livery), [livery]);
}

/** CSS-градиент ливреи — для карточек пилотов и оверлеев (не WebGL). */
export function liveryGradient(livery: TeamLivery): string {
  return `linear-gradient(135deg, ${livery.trim} 0%, ${livery.accent} 45%, ${livery.paint} 100%)`;
}

/** CSS-переменные ливреи для стилизации HTML-элементов команды. */
export function liveryCssVars(livery: TeamLivery): CSSProperties {
  return {
    ['--livery-paint' as string]: livery.paint,
    ['--livery-accent' as string]: livery.accent,
    ['--livery-trim' as string]: livery.trim,
  } as CSSProperties;
}

export interface TeamCarShellProps {
  /** Имя агента/команды — источник окраса. */
  seed: string;
  /** Общий масштаб оболочки (по умолчанию 1). */
  scale?: number;
  /** Рисовать ли кант на антикрыле (по умолчанию true). */
  showTrim?: boolean;
}

/**
 * Процедурная оболочка болида в цветах команды. Авторская геометрия повторяет
 * силуэт из `Chassis.tsx` (hull + кабина + неоновые боковые полосы + подсветка),
 * но без физики — её можно класть поверх любого кузова или собрать витрину.
 */
export function TeamCarShell({ seed, scale = 1, showTrim = true }: TeamCarShellProps) {
  const livery = useTeamLivery(seed);
  const groupRef = useRef<Group>(null);
  const stripMatRef = useRef<MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    // Мягкая пульсация неона — «дышит» независимо от скорости болида.
    const pulse = 0.6 + (Math.sin(t * 2.4) * 0.5 + 0.5) * 0.4;
    const mat = stripMatRef.current;
    if (mat) mat.emissiveIntensity = 3 * pulse;
    const group = groupRef.current;
    if (group) group.rotation.y = Math.sin(t * 0.4) * 0.03;
  });

  return (
    <group ref={groupRef} scale={scale} dispose={null}>
      {/* Кузов в цвете команды */}
      <mesh castShadow receiveShadow position={[0, 0.4, 0]}>
        <boxGeometry args={[1.9, 0.5, 4.3]} />
        <meshStandardMaterial color={livery.paint} roughness={0.35} metalness={0.85} />
      </mesh>

      {/* Кабина — тёмное стекло */}
      <mesh castShadow position={[0, 0.85, -0.15]}>
        <boxGeometry args={[1.5, 0.55, 1.8]} />
        <meshStandardMaterial color="#05060a" roughness={0.15} metalness={0.6} />
      </mesh>

      {/* Неоновая боковая полоса команды (пульсирует) */}
      {[-0.97, 0.97].map((x) => (
        <mesh key={`strip-${x}`} position={[x, 0.42, 0]}>
          <boxGeometry args={[0.05, 0.08, 4.0]} />
          <meshStandardMaterial
            {...(x < 0 ? { ref: stripMatRef } : {})}
            color="#000000"
            emissive={livery.accent}
            emissiveIntensity={3}
            toneMapped={false}
          />
        </mesh>
      ))}

      {/* Кант на антикрыле — контрастный `trim` */}
      {showTrim && (
        <mesh position={[0, 0.85, -2.0]} castShadow>
          <boxGeometry args={[1.6, 0.1, 0.35]} />
          <meshStandardMaterial color={livery.trim} emissive={livery.trim} emissiveIntensity={1.2} metalness={0.6} />
        </mesh>
      )}

      {/* Подсветка днища в акценте команды */}
      <pointLight position={[0, 0.05, 0]} color={livery.accent} intensity={2.5} distance={6} />
    </group>
  );
}

export interface TeamNameplateProps {
  /** Имя агента/команды — источник окраса и подписи. */
  seed: string;
  /** Дополнительный текст (например, «P1»). */
  label?: string;
}

/**
 * Носовая табличка команды: контрастная плашка `trim` с номером `number`.
 * Дёшево (2 бокса), но визуально закрепляет «командность» окраса.
 */
export function TeamNameplate({ seed, label }: TeamNameplateProps) {
  const livery = useTeamLivery(seed);
  return (
    <group position={[0, 0.52, 2.2]} dispose={null}>
      <mesh castShadow>
        <boxGeometry args={[0.7, 0.34, 0.06]} />
        <meshStandardMaterial color={livery.trim} emissive={livery.trim} emissiveIntensity={0.9} metalness={0.6} />
      </mesh>
      {/* Крупный стартовый номер команды поверх канта */}
      <mesh position={[0, 0, 0.035]}>
        <boxGeometry args={[0.42, 0.2, 0.02]} />
        <meshStandardMaterial color={livery.paint} roughness={0.4} metalness={0.5} />
      </mesh>
      {label ? <group name={label} userData={{ team: livery.id }} /> : null}
    </group>
  );
}

export interface TeamLiveryRosterProps {
  /** Список сидов (агентов/команд). Пусто → вся таблица `TEAM_LIVERIES`. */
  seeds?: readonly string[];
  /** Шаг между болидами по X (по умолчанию 3.2). */
  spacing?: number;
  /** Рисовать носовую табличку (по умолчанию true). */
  nameplates?: boolean;
}

/**
 * Витрина палитры: ряд болидов по одному на каждую команду. Годится для
 * пит-лейна/интро — самодостаточна, без физики и внешних ассетов.
 */
export function TeamLiveryRoster({ seeds, spacing = 3.2, nameplates = true }: TeamLiveryRosterProps) {
  const list = useMemo(
    () => (seeds && seeds.length > 0 ? seeds : TEAM_LIVERIES.map((l) => l.name)),
    [seeds],
  );
  const offset = ((list.length - 1) * spacing) / 2;

  return (
    <group dispose={null}>
      {list.map((seed, i) => (
        <group key={`${seed}-${i}`} position={[i * spacing - offset, 0, 0]}>
          <TeamCarShell seed={seed} />
          {nameplates && <TeamNameplate seed={seed} />}
        </group>
      ))}
    </group>
  );
}

export default TeamCarShell;
