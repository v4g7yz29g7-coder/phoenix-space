/**
 * PitBoxes.tsx — «Сцена в боксах» (Cinematic Intro)
 * ============================================================================
 * FORMULA I1 · STAGE Cinematic Intro · ЗАДАЧА 4.1
 *
 * Открывающий кинематографический сет: ряд командных гаражей-боксов вдоль
 * пит-стены. По таймлайну боксы «оживают» постановочно, с эффектом
 * последовательного зажигания (stagger), ровно как в реальной стартовой
 * церемонии:
 *
 *   1. DARK      — боксы закрыты, свет не горит;
 *   2. LIGHTS    — под потолком зажигаются лампы, по стене бежит команда;
 *   3. OPEN      — секционные ворота поднимаются;
 *   4. ROLLOUT   — болиды выкатываются из боксов на пит-лейн;
 *   5. GRID      — болиды выстроены, стартовая гантри мигает красным;
 *   6. RESET     — болиды заезжают, ворота закрываются — цикл замыкается.
 *
 * Файл атомарный и asset-free: никакого GLTF, физики и текстур — только
 * процедурная геометрия, эмиссивные материалы и per-frame мутация refs без
 * единого аллока в кадре (приём из `research/racing-game`, MIT © 2021 pmndrs,
 * см. research/audit.md §1 — store с мутируемым `mutation`-объектом и
 * instanced-инфраструктура).
 *
 * Публичный API:
 *   • createBox(index, overrides)  — собрать один бокс с детальной структурой;
 *   • listBoxes(count)             — получить весь ряд боксов (по умолчанию 7);
 *   • <PitBoxesStage />            — сама сцена (drop-in в <Canvas/>).
 * ============================================================================
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Типы: детальная структура бокса                                            */
/* -------------------------------------------------------------------------- */

export type BoxPhase = 'closed' | 'lights' | 'open' | 'rollout' | 'grid' | 'reset';

export interface PitBoxLights {
  /** ферма освещения смонтирована */
  rig: boolean;
  /** текущая яркость (0..1, мутируется в кадре) */
  intensity: number;
  color: string;
}

export interface PitBoxCar {
  present: boolean;
  /** гоночный номер болида */
  number: number;
  /** ливрея (основной цвет кузова) */
  livery: string;
}

export interface PitBox {
  /** стабильный идентификатор */
  id: string;
  /** порядковый номер в ряду (с 0) */
  index: number;
  /** команда-владелец */
  team: string;
  /** командный цвет */
  color: string;
  /** светлый акцент (подсветка, кант) */
  accent: string;
  /** центр бокса в мировых координатах */
  position: [number, number, number];
  /** разворот бокса (лицом к пит-лейну) */
  rotationY: number;
  /** габариты гаража: ширина × высота × глубина */
  size: { width: number; height: number; depth: number };
  /** секционные ворота */
  door: { width: number; height: number; lift: number };
  car: PitBoxCar;
  lights: PitBoxLights;
  /** фаза цикла (мутируется в кадре) */
  phase: BoxPhase;
  status: 'empty' | 'ready' | 'busy';
  /** подпись на табло бокса */
  label: string;
}

/* -------------------------------------------------------------------------- */
/* Данные команд                                                              */
/* -------------------------------------------------------------------------- */

const TEAMS: Array<{ team: string; color: string; accent: string }> = [
  { team: 'AURORA', color: '#4dd0ff', accent: '#bff3ff' },
  { team: 'NOVA', color: '#ff7eb6', accent: '#ffd6ea' },
  { team: 'NEBULA', color: '#a855f7', accent: '#e2ccff' },
  { team: 'VOLT', color: '#6eff8b', accent: '#d3ffdd' },
  { team: 'SOLARIS', color: '#ffd700', accent: '#fff2b0' },
  { team: 'INFERNO', color: '#ff5c5c', accent: '#ffd0d0' },
  { team: 'CYAN', color: '#7dd3fc', accent: '#dff4ff' },
];

const DEFAULT_WIDTH = 7.4;
const DEFAULT_HEIGHT = 4.6;
const DEFAULT_DEPTH = 9.2;

/** Заводской конструктор бокса: index + частичные переопределения. */
export function createBox(index: number, overrides: Partial<PitBox> = {}): PitBox {
  const team = TEAMS[((index % TEAMS.length) + TEAMS.length) % TEAMS.length];
  const size = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, depth: DEFAULT_DEPTH };
  const door = { width: size.width - 0.7, height: size.height - 1.0, lift: 0 };
  const car = { present: true, number: index + 1, livery: team.color };
  const lights = { rig: true, intensity: 0, color: team.accent };

  const base: PitBox = {
    id: `box-${index + 1}`,
    index,
    team: team.team,
    color: team.color,
    accent: team.accent,
    position: [index * (size.width + 1.1), 0, 0],
    rotationY: 0,
    size,
    door,
    car,
    lights,
    phase: 'closed',
    status: 'ready',
    label: `${team.team} · BOX ${index + 1}`,
  };

  return {
    ...base,
    ...overrides,
    size: { ...base.size, ...(overrides.size ?? {}) },
    door: { ...base.door, ...(overrides.door ?? {}) },
    car: { ...base.car, ...(overrides.car ?? {}) },
    lights: { ...base.lights, ...(overrides.lights ?? {}) },
  };
}

/** Весь ряд боксов. По умолчанию 7 — по числу боксов в RACE-арене. */
export function listBoxes(count = 7): PitBox[] {
  return Array.from({ length: Math.max(1, count) }, (_, i) => createBox(i));
}

/* -------------------------------------------------------------------------- */
/* Утилиты кадра                                                              */
/* -------------------------------------------------------------------------- */

const smooth = (x: number): number => {
  const c = THREE.MathUtils.clamp(x, 0, 1);
  return c * c * (3 - 2 * c);
};

/** Нормированный прогресс отрезка [a,b] с плавным входом/выходом. */
const span = (x: number, a: number, b: number): number => smooth((x - a) / (b - a));

/* -------------------------------------------------------------------------- */
/* Процедурный болид бокса                                                    */
/* -------------------------------------------------------------------------- */

function PitCar({ color, accent }: { color: string; accent: string }) {
  const wheel = useMemo(() => {
    const g = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 16);
    g.rotateZ(Math.PI / 2);
    return g;
  }, []);

  return (
    <group>
      {/* днище / корпус */}
      <mesh position={[0, 0.42, 0]} castShadow>
        <boxGeometry args={[0.92, 0.34, 2.5]} />
        <meshStandardMaterial color={color} metalness={0.6} roughness={0.35} />
      </mesh>
      {/* носовой обтекатель */}
      <mesh position={[0, 0.4, 1.7]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <coneGeometry args={[0.28, 1.1, 16]} />
        <meshStandardMaterial color={color} metalness={0.6} roughness={0.3} />
      </mesh>
      {/* кабина-кокпит */}
      <mesh position={[0, 0.66, -0.1]} castShadow>
        <boxGeometry args={[0.6, 0.3, 1.05]} />
        <meshStandardMaterial color="#10141f" metalness={0.5} roughness={0.4} />
      </mesh>
      {/* воздухозаборник / halo */}
      <mesh position={[0, 0.92, -0.2]}>
        <cylinderGeometry args={[0.16, 0.2, 0.35, 14]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.4} />
      </mesh>
      {/* заднее антикрыло */}
      <mesh position={[0, 0.95, -1.28]} castShadow>
        <boxGeometry args={[1.0, 0.1, 0.42]} />
        <meshStandardMaterial color={color} metalness={0.7} roughness={0.3} />
      </mesh>
      <mesh position={[0, 1.25, -1.28]}>
        <boxGeometry args={[0.9, 0.08, 0.3]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.5} />
      </mesh>
      {/* колёса */}
      <mesh geometry={wheel} position={[0.62, 0.34, 0.95]} castShadow>
        <meshStandardMaterial color="#15171d" roughness={0.9} />
      </mesh>
      <mesh geometry={wheel} position={[-0.62, 0.34, 0.95]} castShadow>
        <meshStandardMaterial color="#15171d" roughness={0.9} />
      </mesh>
      <mesh geometry={wheel} position={[0.66, 0.36, -0.95]} castShadow>
        <meshStandardMaterial color="#15171d" roughness={0.9} />
      </mesh>
      <mesh geometry={wheel} position={[-0.66, 0.36, -0.95]} castShadow>
        <meshStandardMaterial color="#15171d" roughness={0.9} />
      </mesh>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Стайка покрышек                                                            */
/* -------------------------------------------------------------------------- */

function TyreStack({ x, z, color }: { x: number; z: number; color: string }) {
  return (
    <group position={[x, 0, z]}>
      {[0.18, 0.52, 0.86].map((y, i) => (
        <mesh key={i} position={[0, y, 0]} rotation={[0, i * 0.6, 0]} castShadow>
          <cylinderGeometry args={[0.34, 0.34, 0.32, 14]} />
          <meshStandardMaterial color={i === 1 ? color : '#1b1e27'} roughness={0.95} />
        </mesh>
      ))}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Стартовая гантри над рядом боксов                                          */
/* -------------------------------------------------------------------------- */

function StartGantry({ count }: { count: number }) {
  const bulbs = useRef<Array<THREE.Mesh | null>>([]);

  useFrame((state) => {
    const t = state.clock.elapsedTime % 12;
    // 0..7 red countdown, 7..8 green, 8..12 off
    const level = t < 7 ? Math.floor(t) : t < 8 ? 5 : 0;
    const green = t >= 7 && t < 8;
    for (let i = 0; i < 5; i++) {
      const m = bulbs.current[i];
      if (!m) continue;
      const mat = m.material as THREE.MeshStandardMaterial;
      const on = green ? true : i < level;
      mat.emissiveIntensity = on ? 1.6 : 0.05;
      mat.color.set(green ? '#3dff7a' : '#ff2b2b');
      mat.emissive.set(green ? '#3dff7a' : '#ff2b2b');
    }
  });

  const width = count * 7.4 + (count - 1) * 1.1;

  return (
    <group position={[0, 0, 0]} name="start-gantry">
      {/* стойки */}
      <mesh position={[-width / 2 - 1.2, 3, 0]} castShadow>
        <boxGeometry args={[0.25, 6, 0.25]} />
        <meshStandardMaterial color="#20263a" metalness={0.6} roughness={0.5} />
      </mesh>
      <mesh position={[width / 2 + 1.2, 3, 0]} castShadow>
        <boxGeometry args={[0.25, 6, 0.25]} />
        <meshStandardMaterial color="#20263a" metalness={0.6} roughness={0.5} />
      </mesh>
      {/* перекладина */}
      <mesh position={[0, 5.7, 0]} castShadow>
        <boxGeometry args={[width + 2.7, 0.45, 0.6]} />
        <meshStandardMaterial color="#161b2b" metalness={0.5} roughness={0.6} />
      </mesh>
      {/* пять стартовых огней */}
      {Array.from({ length: 5 }, (_, i) => (
        <mesh
          key={i}
          ref={(el) => {
            bulbs.current[i] = el;
          }}
          position={[(i - 2) * 0.95, 5.7, 0.36]}
        >
          <sphereGeometry args={[0.32, 16, 16]} />
          <meshStandardMaterial color="#ff2b2b" emissive="#ff2b2b" emissiveIntensity={0.1} />
        </mesh>
      ))}
      <mesh position={[0, 5.7, -0.36]}>
        <boxGeometry args={[width + 2.7, 0.16, 0.16]} />
        <meshStandardMaterial color="#4dd0ff" emissive="#4dd0ff" emissiveIntensity={0.6} />
      </mesh>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Сцена                                                                      */
/* -------------------------------------------------------------------------- */

export interface PitBoxesStageProps {
  /** готовые боксы (иначе строятся через listBoxes) */
  boxes?: PitBox[];
  /** сколько боксов, если не передан boxes */
  count?: number;
  /** сдвиг всей сцены в мире */
  position?: [number, number, number];
  /** запускать цикл (иначе статичный DARK-кадр) */
  autoPlay?: boolean;
  /** длительность полного цикла, сек */
  duration?: number;
  /** задержка между боксами при зажигании, сек */
  stagger?: number;
  /** колбэк смены фазы бокса (дёргается только на переходе) */
  onPhaseChange?: (id: string, phase: BoxPhase) => void;
}

export function PitBoxesStage({
  boxes,
  count = 7,
  position = [0, 0, 0],
  autoPlay = true,
  duration = 12,
  stagger = 0.35,
  onPhaseChange,
}: PitBoxesStageProps) {
  const list = useMemo(() => boxes ?? listBoxes(count), [boxes, count]);

  const doorRefs = useRef<Array<THREE.Group | null>>([]);
  const carRefs = useRef<Array<THREE.Group | null>>([]);
  const lampRefs = useRef<Array<THREE.PointLight | null>>([]);
  const stripRefs = useRef<Array<THREE.Mesh | null>>([]);
  const prevPhase = useRef<Array<BoxPhase>>([]);

  useFrame((state) => {
    const g = state.clock.elapsedTime;
    const total = Math.max(1, duration);

    for (let i = 0; i < list.length; i++) {
      const box = list[i];
      const lt = (((g - i * stagger) % total) + total) % total / total;

      // --- отрезки таймлайна ---
      const lightsOn = span(lt, 0.0, 0.12);
      const doorOpen = span(lt, 0.12, 0.3);
      const out = span(lt, 0.3, 0.55);
      const back = span(lt, 0.8, 0.92);
      const doorClose = span(lt, 0.92, 0.99);

      const travel = THREE.MathUtils.clamp(out - back, 0, 1);
      const doorLift = Math.max(0, doorOpen - doorClose) * box.door.height;

      // пульс на решётке (фаза GRID)
      const gridPulse = lt > 0.55 && lt < 0.8 ? 0.5 + 0.5 * Math.sin(g * 16 + i) : 0;
      const lightI = THREE.MathUtils.clamp(lightsOn * 1.6 + gridPulse * 0.8, 0, 2.2);

      // --- фаза ---
      let phase: BoxPhase = 'closed';
      if (lt >= 0.99) phase = 'reset';
      else if (lt >= 0.92) phase = 'reset';
      else if (lt >= 0.8) phase = 'grid';
      else if (lt >= 0.55) phase = 'grid';
      else if (lt >= 0.3) phase = 'rollout';
      else if (lt >= 0.12) phase = 'open';
      else if (lt >= 0.0) phase = 'lights';

      // --- мутация объектов ---
      const door = doorRefs.current[i];
      if (door) door.position.y = doorLift;

      const car = carRefs.current[i];
      if (car) {
        const insideZ = -box.size.depth * 0.12;
        const laneZ = box.size.depth * 0.5 + 2.4;
        car.position.z = THREE.MathUtils.lerp(insideZ, laneZ, travel);
        car.visible = box.car.present && (lt < 0.98 || autoPlay);
      }

      const lamp = lampRefs.current[i];
      if (lamp) lamp.intensity = box.lights.rig ? lightI : 0;

      const strip = stripRefs.current[i];
      if (strip) {
        const mat = strip.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = 0.25 + lightI * 0.9;
      }

      // --- колбэк смены фазы ---
      if (prevPhase.current[i] !== phase) {
        prevPhase.current[i] = phase;
        box.phase = phase;
        onPhaseChange?.(box.id, phase);
      }
    }
  });

  const rowWidth = list.length * 7.4 + (list.length - 1) * 1.1;

  return (
    <group name="pit-boxes" position={position}>
      {/* бетонная площадка под всеми боксами */}
      <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[rowWidth + 16, 30]} />
        <meshStandardMaterial color="#0d111c" metalness={0.3} roughness={0.85} />
      </mesh>

      {/* разметка пит-лейна перед рядом */}
      <mesh position={[0, 0.02, 7.4]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[rowWidth + 14, 0.28]} />
        <meshStandardMaterial color="#f5f5f5" />
      </mesh>

      {list.map((box, i) => {
        const { width, height, depth } = box.size;
        return (
          <group
            key={box.id}
            name={box.id}
            position={box.position}
            rotation={[0, box.rotationY, 0]}
          >
            {/* пол бокса */}
            <mesh position={[0, 0.05, 0]} receiveShadow>
              <boxGeometry args={[width, 0.1, depth]} />
              <meshStandardMaterial color="#1a1f2e" metalness={0.35} roughness={0.7} />
            </mesh>
            {/* командная полоса на полу */}
            <mesh position={[0, 0.11, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[width * 0.92, 0.5]} />
              <meshStandardMaterial color={box.color} emissive={box.color} emissiveIntensity={0.25} />
            </mesh>

            {/* задняя стена */}
            <mesh position={[0, height / 2, -depth / 2]} castShadow receiveShadow>
              <boxGeometry args={[width, height, 0.24]} />
              <meshStandardMaterial color="#141a28" metalness={0.3} roughness={0.8} />
            </mesh>
            {/* боковые стены */}
            <mesh position={[-width / 2, height / 2, 0]} castShadow receiveShadow>
              <boxGeometry args={[0.22, height, depth]} />
              <meshStandardMaterial color="#11161f" metalness={0.3} roughness={0.85} />
            </mesh>
            <mesh position={[width / 2, height / 2, 0]} castShadow receiveShadow>
              <boxGeometry args={[0.22, height, depth]} />
              <meshStandardMaterial color="#11161f" metalness={0.3} roughness={0.85} />
            </mesh>
            {/* крыша */}
            <mesh position={[0, height, 0]} castShadow>
              <boxGeometry args={[width, 0.24, depth]} />
              <meshStandardMaterial color="#0f1420" metalness={0.4} roughness={0.75} />
            </mesh>
            {/* наддверная перемычка */}
            <mesh position={[0, box.door.height + (height - box.door.height) / 2, depth / 2 - 0.1]} castShadow>
              <boxGeometry args={[width, height - box.door.height, 0.3]} />
              <meshStandardMaterial color={box.color} metalness={0.5} roughness={0.5} />
            </mesh>

            {/* табло команды над боксом */}
            <mesh position={[0, height + 0.55, depth / 2 - 0.4]}>
              <boxGeometry args={[width * 0.8, 0.7, 0.16]} />
              <meshStandardMaterial color="#0a0e18" emissive={box.color} emissiveIntensity={0.35} />
            </mesh>

            {/* ферма освещения */}
            <mesh
              ref={(el) => {
                stripRefs.current[i] = el;
              }}
              position={[0, height - 0.4, 0.6]}
            >
              <boxGeometry args={[box.door.width * 0.85, 0.14, 0.5]} />
              <meshStandardMaterial
                color={box.accent}
                emissive={box.accent}
                emissiveIntensity={0.3}
              />
            </mesh>
            <pointLight
              ref={(el) => {
                lampRefs.current[i] = el;
              }}
              position={[0, height - 1.1, 0.4]}
              color={box.accent}
              intensity={0}
              distance={16}
              decay={2}
            />

            {/* секционные ворота (уезжают вверх) */}
            <group
              ref={(el) => {
                doorRefs.current[i] = el;
              }}
              position={[0, 0, depth / 2 + 0.02]}
            >
              <mesh position={[0, box.door.height / 2, 0]} castShadow>
                <boxGeometry args={[box.door.width, box.door.height, 0.16]} />
                <meshStandardMaterial color={box.color} metalness={0.45} roughness={0.55} />
              </mesh>
              {[0.25, 0.5, 0.75].map((k) => (
                <mesh key={k} position={[0, box.door.height * k, 0.09]}>
                  <boxGeometry args={[box.door.width, 0.06, 0.02]} />
                  <meshStandardMaterial color={box.accent} emissive={box.accent} emissiveIntensity={0.3} />
                </mesh>
              ))}
            </group>

            {/* болид */}
            <group
              ref={(el) => {
                carRefs.current[i] = el;
              }}
            >
              <PitCar color={box.car.livery} accent={box.accent} />
            </group>

            {/* покрышки у входа */}
            <TyreStack x={-width / 2 + 0.7} z={depth / 2 - 1.1} color={box.color} />
            <TyreStack x={width / 2 - 0.7} z={depth / 2 - 1.1} color={box.color} />
          </group>
        );
      })}

      <StartGantry count={list.length} />
    </group>
  );
}

export default PitBoxesStage;
