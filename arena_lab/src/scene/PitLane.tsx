import { useMemo, useRef } from 'react';
import type { Ref } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getTrackCurve, ROAD_WIDTH } from './Track';

/**
 * ЗАДАЧА 4.2 — Выезд на пит-лейн + механики (Cinematic Intro).
 *
 * Реализует полноценную пит-зону FORMULA I1 вдоль основной трассы:
 *  - полотно пит-лейна, идущее параллельно главной прямой (вход / выезд);
 *  - ограничитель 60 км/ч + overhead-гантри «PIT LANE»;
 *  - 6 гаражей-боксов с командными цветами и разметкой;
 *  - анимированные пит-механики (домкраты + гайковёрты + липопоп);
 *  - демо-болид, который заезжает, встаёт в бокс, обслуживается и
 *    выезжает обратно на трассу (циклическая кинематографичная сцена).
 *
 * Таймлайн цикла (CYCLE сек):
 *   0..ENTER_END     — заезд в бокс (лимитер 60 км/ч, стоп-огни);
 *   ENTER_END..RUSH  — механики сбегаются, домкраты вверх, гайковёрты;
 *   RUSH..SERVICE    — полный сервис (шины/подъём), липопоп опущен;
 *   SERVICE..RETURN  — опускание, липопоп вверх → «GO», болид стартует;
 *   RETURN..CYCLE    — выезд из бокса и слияние с трассой.
 *
 * Референс приёмов: research/racing-game (MIT) — speed-limited
 * инфраструктура трассы, instanced-инфраструктура, per-frame rig
 * без ре-рендеров (mutating refs в useFrame).
 */

export const PIT_ENTRY_T = 0.82;
export const PIT_EXIT_T = 0.05;
export const PIT_SPEED_LIMIT_KMH = 60;
export const PIT_LANE_WIDTH = 4.2;
export const PIT_BOXES = 6;

const PIT_LANE_OFFSET = ROAD_WIDTH / 2 + 0.9 + PIT_LANE_WIDTH / 2;
const PIT_BOX_OFFSET = PIT_LANE_OFFSET + PIT_LANE_WIDTH / 2 + 1.6;
const UP = new THREE.Vector3(0, 1, 0);

/** Длительность кинематографического цикла пит-стопа, сек */
const CYCLE = 9;
const ENTER_END = 2;
const RUSH_END = 3;
const SERVICE_END = 5;
const RETURN_END = 6;

interface LaneFrame {
  pos: THREE.Vector3;
  angle: number;
  t: number;
}

const laneSpan = (1 - PIT_ENTRY_T) + PIT_EXIT_T;

/** Кадр вдоль пит-лейна: s = 0 (вход) .. 1 (выезд), lateral — смещение наружу. */
function laneFrame(curve: THREE.CatmullRomCurve3, s: number, lateral: number): LaneFrame {
  const t = THREE.MathUtils.euclideanModulo(PIT_ENTRY_T + s * laneSpan, 1);
  const p = curve.getPointAt(t);
  const tan = curve.getTangentAt(t);
  const side = new THREE.Vector3().crossVectors(tan, UP).normalize();
  const pos = p.clone().addScaledVector(side, lateral);
  return { pos, angle: Math.atan2(tan.x, tan.z), t };
}

/** Лента по пит-лейну с постоянным поперечным смещением. */
function buildOffsetRibbon(
  curve: THREE.CatmullRomCurve3,
  lateral: number,
  width: number,
  y: number,
  samples = 220,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const half = width / 2;

  for (let i = 0; i <= samples; i++) {
    const s = i / samples;
    const f = laneFrame(curve, s, lateral);
    const tan = curve.getTangentAt(f.t);
    const side = new THREE.Vector3().crossVectors(tan, UP).normalize().multiplyScalar(half);
    positions.push(f.pos.x - side.x, y, f.pos.z - side.z);
    positions.push(f.pos.x + side.x, y, f.pos.z + side.z);
    uvs.push(0, s * 40, 1, s * 40);
    if (i < samples) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Жёлтая линия слияния: плавно сводит пит-лейн обратно на трассу. */
function buildBlendLine(curve: THREE.CatmullRomCurve3): THREE.BufferGeometry {
  const samples = 64;
  const from = PIT_LANE_OFFSET - PIT_LANE_WIDTH / 2;
  const to = ROAD_WIDTH / 2 + 1.2;
  const halfW = 0.18;

  const pts: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const s = 0.78 + (i / samples) * 0.22;
    const k = i / samples;
    const lateral = THREE.MathUtils.lerp(from, to, k * k);
    const f = laneFrame(curve, Math.min(s, 1), lateral);
    const tan = curve.getTangentAt(f.t);
    const side = new THREE.Vector3().crossVectors(tan, UP).normalize().multiplyScalar(halfW);
    pts.push(
      f.pos.x - side.x, 0.06, f.pos.z - side.z,
      f.pos.x + side.x, 0.06, f.pos.z + side.z,
    );
    if (i < samples) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function makeSignTexture(text: string, bg: string, fg: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = fg;
    ctx.font = 'bold 54px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 66);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

function Suit({ color }: { color: string }) {
  return (
    <>
      <mesh position={[0, 0.25, 0]} castShadow>
        <boxGeometry args={[0.26, 0.5, 0.22]} />
        <meshStandardMaterial color="#232936" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.88, 0]} castShadow>
        <boxGeometry args={[0.4, 0.58, 0.28]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh position={[0, 1.28, 0]} castShadow>
        <sphereGeometry args={[0.17, 12, 12]} />
        <meshStandardMaterial color="#e8b98a" roughness={0.9} />
      </mesh>
      <mesh position={[0, 1.42, 0]}>
        <cylinderGeometry args={[0.19, 0.19, 0.14, 12]} />
        <meshStandardMaterial color={color} roughness={0.6} />
      </mesh>
    </>
  );
}

interface CrewSpec {
  base: [number, number, number];
  work: [number, number, number];
  gun: boolean;
  phase: number;
  delay: number;
}

const GUN_SPOTS: Array<[number, number]> = [
  [-1.55, -1.5],
  [1.55, -1.5],
  [-1.55, 1.5],
  [1.55, 1.5],
];

function makeCrewSpecs(): CrewSpec[] {
  const specs: CrewSpec[] = [];
  const garageX = -3.55;
  // домкраты (передний / задний)
  specs.push({ base: [garageX, 0, -2.6], work: [0, 0, -2.6], gun: false, phase: 0, delay: 0 });
  specs.push({ base: [garageX, 0, 2.6], work: [0, 0, 2.6], gun: false, phase: 0.5, delay: 0.05 });
  // гайковёрты (4 колеса)
  GUN_SPOTS.forEach(([x, z], i) => {
    specs.push({
      base: [garageX, 0, z],
      work: [x, 0, z],
      gun: true,
      phase: i * 0.4,
      delay: 0.12 + i * 0.06,
    });
  });
  return specs;
}

const TEAM_COLORS = ['#4dd0ff', '#ff7eb6', '#a855f7', '#6eff8b', '#ffd700', '#ff5c5c'];

interface PitLaneProps {
  curve?: THREE.CatmullRomCurve3;
  boxes?: number;
  /** Демо-болид заезжает на обслуживание (для Cinematic Intro). */
  demoCar?: boolean;
}

export function PitLane({ curve, boxes = PIT_BOXES, demoCar = true }: PitLaneProps) {
  const track = curve ?? getTrackCurve();

  const roadGeo = useMemo(() => buildOffsetRibbon(track, PIT_LANE_OFFSET, PIT_LANE_WIDTH, 0.02), [track]);
  const centerGeo = useMemo(() => buildOffsetRibbon(track, PIT_LANE_OFFSET, 0.28, 0.035), [track]);
  const blendGeo = useMemo(() => buildBlendLine(track), [track]);
  const signTex = useMemo(() => makeSignTexture('PIT LANE', '#0d1220', '#4dd0ff'), []);
  const limitTex = useMemo(() => makeSignTexture(String(PIT_SPEED_LIMIT_KMH), '#ffffff', '#e10600'), []);

  const boxFrames = useMemo(() => {
    const list: LaneFrame[] = [];
    for (let i = 0; i < boxes; i++) {
      const s = 0.28 + i * 0.055;
      list.push(laneFrame(track, s, PIT_LANE_OFFSET));
    }
    return list;
  }, [track, boxes]);

  const crewSpecs = useMemo(() => makeCrewSpecs(), []);

  const carRef = useRef<THREE.Group>(null);
  const wheelRef = useRef<THREE.Group>(null);
  const brakeMat = useRef<THREE.MeshStandardMaterial>(null);
  const crewRefs = useRef<Array<THREE.Group | null>>([]);
  const gunRefs = useRef<Array<THREE.Group | null>>([]);
  const lolliRefs = useRef<Array<THREE.Group | null>>([]);

  const stopBoxS = useMemo(() => 0.28 + Math.floor(boxes / 2) * 0.055, [boxes]);

  const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime % CYCLE;
    const et = state.clock.elapsedTime; // глобальное время для loop-анимаций
    let s = 0;
    let service = 0;
    let moving = false;
    // Липопоп поднимает табличку «GO» в конце сервиса, выпуская болид.
    let signal = 0;

    if (t < ENTER_END) {
      // Заезд в бокс — водитель держит лимитер, горит стоп-сигнал.
      s = THREE.MathUtils.lerp(0, stopBoxS, easeInOut(t / ENTER_END));
      moving = true;
    } else if (t < RUSH_END) {
      s = stopBoxS;
      service = (t - ENTER_END) / (RUSH_END - ENTER_END);
    } else if (t < SERVICE_END) {
      s = stopBoxS;
      service = 1;
    } else if (t < RETURN_END) {
      s = stopBoxS;
      service = 1 - (t - SERVICE_END) / (RETURN_END - SERVICE_END);
      // в этой фазе механики отходят, липопоп поднимает знак
      signal = 1 - service;
    } else {
      // Старт из бокса: слышим, как уходят колёса, болид набирает ход.
      s = THREE.MathUtils.lerp(stopBoxS, 1, easeInOut((t - RETURN_END) / (CYCLE - RETURN_END)));
      moving = true;
    }

    // ---- демо-болид: заезд → бокс → выезд ----
    if (carRef.current) {
      const f = laneFrame(track, s, PIT_LANE_OFFSET);
      carRef.current.visible = demoCar;
      carRef.current.position.set(f.pos.x, 0.05, f.pos.z);
      carRef.current.rotation.set(0, f.angle, 0);
      // лёгкий подъём на домкратах во время сервиса
      const lift = service > 0.85 ? 0.18 : 0;
      carRef.current.position.y += lift;
      // «кивок» шасси при торможении и лёгкий скват на разгоне
      carRef.current.rotation.x = moving ? Math.sin(et * 6) * 0.008 - 0.02 : 0;
    }
    // Колёса демо-болида крутятся, пока он едет по пит-лейну.
    if (wheelRef.current && moving) {
      wheelRef.current.rotation.x += delta * 9;
    }
    // Стоп-сигналы вспыхивают при заезде в бокс (speed limiter) и гаснут в сервисе.
    if (brakeMat.current) {
      const braking = t < ENTER_END ? 1 : 0;
      brakeMat.current.emissiveIntensity = THREE.MathUtils.lerp(
        brakeMat.current.emissiveIntensity,
        0.15 + braking * 1.7,
        Math.min(1, delta * 8),
      );
    }

    // ---- механики: бег из гаража к машине и обратно ----
    const count = crewSpecs.length;
    for (let b = 0; b < boxes; b++) {
      for (let i = 0; i < count; i++) {
        const idx = b * count + i;
        const g = crewRefs.current[idx];
        const gun = gunRefs.current[idx];
        if (!g) continue;
        const spec = crewSpecs[i];
        const local = THREE.MathUtils.clamp((service - spec.delay) / 0.4, 0, 1);
        const k = easeInOut(local);
        // домкратчики «качают» машину на пит-стопе; гайковёрты мелко вибрируют
        const bob = service > 0.9 ? Math.sin(et * 14 + spec.phase) * 0.05 : 0;
        g.position.set(
          THREE.MathUtils.lerp(spec.base[0], spec.work[0], k),
          spec.base[1] + Math.abs(bob),
          THREE.MathUtils.lerp(spec.base[2], spec.work[2], k),
        );
        // небольшой наклон вперёд при обслуживании
        g.rotation.x = k * 0.25 * (spec.work[2] < 0 ? -1 : 1);
        if (gun && gun.rotation) gun.rotation.x -= delta * 40 * k;
      }
    }

    // ---- липопоп: опущен на сервисе, поднят на выпуск ----
    for (let b = 0; b < boxes; b++) {
      const ll = lolliRefs.current[b];
      if (!ll) continue;
      // target: -1.35 (знак вверх, «GO») .. 0.0 (знак опущен у колеса)
      ll.rotation.z = THREE.MathUtils.lerp(ll.rotation.z, signal * -1.35, Math.min(1, delta * 6));
    }
  });

  return (
    <group name="pit-lane">
      {/* Полотно пит-лейна */}
      <mesh geometry={roadGeo} receiveShadow>
        <meshStandardMaterial color="#141821" metalness={0.35} roughness={0.65} side={THREE.DoubleSide} />
      </mesh>

      {/* Разметка центра пит-лейна */}
      <mesh geometry={centerGeo}>
        <meshStandardMaterial color="#f5f5f5" side={THREE.DoubleSide} />
      </mesh>

      {/* Жёлтая линия выезда на трассу */}
      <mesh geometry={blendGeo}>
        <meshStandardMaterial color="#ffd400" emissive="#ffd400" emissiveIntensity={0.3} />
      </mesh>

      {/* Вход пит-лейна: жёлтая стрелка-разрыв */}
      <PitEntryMarker track={track} />

      {/* Пит-боксы, гаражи, механики */}
      {boxFrames.map((f, b) => {
        const color = TEAM_COLORS[b % TEAM_COLORS.length];
        return (
          <group key={b} position={[f.pos.x, 0, f.pos.z]} rotation={[0, f.angle, 0]}>
            {/* Гараж позади бокса */}
            <mesh position={[-3.9, 1.6, 0]} castShadow receiveShadow>
              <boxGeometry args={[3.2, 3.2, 5.6]} />
              <meshStandardMaterial color="#0d1220" metalness={0.5} roughness={0.5} />
            </mesh>
            <mesh position={[-2.32, 1.7, 0]}>
              <boxGeometry args={[0.12, 2.6, 4.6]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} />
            </mesh>
            {/* Разметка бокса на асфальте */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
              <planeGeometry args={[PIT_LANE_WIDTH - 0.4, 5.4]} />
              <meshStandardMaterial color={color} transparent opacity={0.28} />
            </mesh>
            {/* Т-образная стойка бокса */}
            <mesh position={[-2.0, 0.9, 0]}>
              <boxGeometry args={[0.4, 1.8, 0.4]} />
              <meshStandardMaterial color="#1a2130" />
            </mesh>

            {/* Запас шин */}
            {[0, 1, 2].map((k) => (
              <mesh key={k} position={[-2.1, 0.22 + k * 0.42, 2.4]} castShadow>
                <torusGeometry args={[0.28, 0.12, 10, 16]} />
                <meshStandardMaterial color="#0a0a0a" roughness={0.9} />
              </mesh>
            ))}

            {/* Механики */}
            {crewSpecs.map((spec, i) => {
              const idx = b * crewSpecs.length + i;
              return (
                <group
                  key={i}
                  ref={(el) => {
                    crewRefs.current[idx] = el;
                  }}
                  position={spec.base}
                >
                  <Suit color={color} />
                  {spec.gun && (
                    <group
                      position={[0.28, 0.72, 0]}
                      ref={(el) => {
                        gunRefs.current[idx] = el;
                      }}
                    >
                      <mesh>
                        <boxGeometry args={[0.16, 0.16, 0.4]} />
                        <meshStandardMaterial color="#c9d4e6" metalness={0.8} roughness={0.3} />
                      </mesh>
                      <mesh position={[0, 0, 0.26]} rotation={[Math.PI / 2, 0, 0]}>
                        <cylinderGeometry args={[0.1, 0.1, 0.12, 10]} />
                        <meshStandardMaterial color="#2a3040" />
                      </mesh>
                    </group>
                  )}
                </group>
              );
            })}

            {/* Липопоп (человек с табличкой) у выезда из бокса */}
            <group position={[-2.0, 0, -3.1]}>
              <Suit color="#f5f5f5" />
              <group
                ref={(el) => {
                  lolliRefs.current[b] = el;
                }}
              >
                <mesh position={[0.05, 1.15, 0]}>
                  <cylinderGeometry args={[0.04, 0.04, 1.3, 8]} />
                  <meshStandardMaterial color="#c9d4e6" metalness={0.6} roughness={0.4} />
                </mesh>
                <mesh position={[0, 1.8, 0]}>
                  <boxGeometry args={[0.36, 1.0, 0.06]} />
                  <meshStandardMaterial color="#e10600" emissive="#e10600" emissiveIntensity={0.4} />
                </mesh>
              </group>
            </group>
          </group>
        );
      })}

      {/* Overhead-гантри с надписью PIT LANE + ограничение скорости */}
      <PitGantry track={track} sign={signTex} limit={limitTex} />

      {/* Демо-болид, отрабатывающий цикл пит-стопа */}
      {demoCar && (
        <group ref={carRef}>
          <DemoCar wheels={wheelRef} brake={brakeMat} />
        </group>
      )}
    </group>
  );
}

function PitEntryMarker({ track }: { track: THREE.CatmullRomCurve3 }) {
  const frame = useMemo(() => laneFrame(track, 0.0, PIT_LANE_OFFSET), [track]);
  return (
    <group position={[frame.pos.x, 0, frame.pos.z]} rotation={[0, frame.angle, 0]}>
      {[0, 1, 2, 3, 4].map((i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[0.6 - i * 0.5, 0.05, -i * 0.9]}>
          <planeGeometry args={[0.4, 0.4]} />
          <meshStandardMaterial color="#ffd400" emissive="#ffd400" emissiveIntensity={0.4} />
        </mesh>
      ))}
    </group>
  );
}

function PitGantry({
  track,
  sign,
  limit,
}: {
  track: THREE.CatmullRomCurve3;
  sign: THREE.CanvasTexture | null;
  limit: THREE.CanvasTexture | null;
}) {
  const frame = useMemo(() => laneFrame(track, 0.05, PIT_LANE_OFFSET), [track]);
  return (
    <group position={[frame.pos.x, 0, frame.pos.z]} rotation={[0, frame.angle, 0]}>
      {[-PIT_LANE_WIDTH / 2 - 0.4, PIT_LANE_WIDTH / 2 + 0.4].map((x, i) => (
        <mesh key={i} position={[x, 2.2, 0]} castShadow>
          <boxGeometry args={[0.28, 4.4, 0.28]} />
          <meshStandardMaterial color="#2a3040" metalness={0.7} roughness={0.4} />
        </mesh>
      ))}
      <mesh position={[0, 4.2, 0]}>
        <boxGeometry args={[PIT_LANE_WIDTH + 1.1, 0.7, 0.3]} />
        <meshStandardMaterial color="#0d1220" metalness={0.6} roughness={0.4} />
      </mesh>
      {sign && (
        <mesh position={[0, 4.2, -0.18]}>
          <planeGeometry args={[PIT_LANE_WIDTH + 0.8, 0.55]} />
          <meshBasicMaterial map={sign} toneMapped={false} />
        </mesh>
      )}
      {limit && (
        <mesh position={[0, 3.3, 0.16]}>
          <planeGeometry args={[0.9, 0.9]} />
          <meshBasicMaterial map={limit} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

function DemoCar({
  wheels,
  brake,
}: {
  wheels?: Ref<THREE.Group>;
  brake?: Ref<THREE.MeshStandardMaterial>;
}) {
  return (
    <group>
      {/* Шасси */}
      <mesh position={[0, 0.32, 0]} castShadow>
        <boxGeometry args={[1.0, 0.34, 2.6]} />
        <meshStandardMaterial color="#e10600" metalness={0.6} roughness={0.3} />
      </mesh>
      {/* Нос */}
      <mesh position={[0, 0.3, -1.75]} castShadow>
        <boxGeometry args={[0.5, 0.22, 1.0]} />
        <meshStandardMaterial color="#111111" metalness={0.5} roughness={0.4} />
      </mesh>
      {/* Переднее антикрыло с закрылками */}
      <mesh position={[0, 0.16, -2.25]} castShadow>
        <boxGeometry args={[1.9, 0.06, 0.5]} />
        <meshStandardMaterial color="#111111" metalness={0.5} roughness={0.4} />
      </mesh>
      {[-0.9, 0.9].map((x) => (
        <mesh key={x} position={[x, 0.26, -2.45]}>
          <boxGeometry args={[0.06, 0.26, 0.6]} />
          <meshStandardMaterial color="#e10600" />
        </mesh>
      ))}
      {/* Кокпит + halo */}
      <mesh position={[0, 0.6, 0.2]}>
        <boxGeometry args={[0.7, 0.28, 1.0]} />
        <meshStandardMaterial color="#0d1220" />
      </mesh>
      <mesh position={[0, 0.82, -0.05]} rotation={[0, 0, 0]}>
        <torusGeometry args={[0.32, 0.045, 8, 20, Math.PI]} />
        <meshStandardMaterial color="#0d1220" metalness={0.6} roughness={0.3} />
      </mesh>
      {/* Заднее антикрыло */}
      <mesh position={[0, 0.75, 1.35]} castShadow>
        <boxGeometry args={[1.3, 0.5, 0.1]} />
        <meshStandardMaterial color="#e10600" metalness={0.6} roughness={0.3} />
      </mesh>
      {/* Стоп-сигнал (реагирует на лимитер/торможение) */}
      <mesh position={[0, 0.52, 1.42]}>
        <boxGeometry args={[1.2, 0.12, 0.06]} />
        <meshStandardMaterial
          ref={brake}
          color="#3a0000"
          emissive="#ff1a1a"
          emissiveIntensity={0.15}
        />
      </mesh>
      {/* Колёса — общий узел, чтобы крутить их на ходу по пит-лейну */}
      <group ref={wheels}>
        {[
          [-0.62, -1.4],
          [0.62, -1.4],
          [-0.62, 1.4],
          [0.62, 1.4],
        ].map(([x, z], i) => (
          <mesh key={i} position={[x, 0.36, z]} rotation={[0, 0, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[0.36, 0.36, 0.28, 16]} />
            <meshStandardMaterial color="#0a0a0a" roughness={0.9} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
