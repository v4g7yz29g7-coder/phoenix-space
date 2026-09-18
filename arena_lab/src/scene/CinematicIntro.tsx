/**
 * CinematicIntro.tsx — открывающий проход над «Сценой в боксах»
 * ============================================================================
 * FORMULA I1 · STAGE Cinematic Intro · ЗАДАЧА 4.1 (надстройка над PitBoxes)
 *
 * Композитит ряд боксов (<PitBoxesStage/>) и ведёт виртуальную кинокамеру по
 * таймлайну-раскадровке shot-list'а. Переходы между ракурсами — не «щелчок», а
 * сглаживание через `useFrame` + экспоненциальный демпфер (`THREE.MathUtils.damp`,
 * тот же 1-e^{-λ·dt} приём, что и time.lerp в референсе `research/racing-game`,
 * MIT © 2021 pmndrs — см. research/audit.md §1, «speed-scaled camera (lerp/sway)»).
 *
 * Раскадровка (доли цикла 0..1):
 *   0.00  HERO     — общий проход с высоты над всей пит-стеной;
 *   0.35  TRACK    — спуск к уровню пит-лейна, взгляд вдоль ряда боксов;
 *   0.70  CLOSE    — въезд на «тележке» с фланга, крупный план боксов;
 *   1.00  REVEAL   — подъём и сброс в общий план (бесшовно в HERO).
 *
 * Камера — opt-in (`driveCamera`): по умолчанию выключена, чтобы не спорить с
 * TV-режиссёром / CameraShake из других задач STAGE.
 * ============================================================================
 */
import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { PitBoxesStage } from './PitBoxes';
import type { BoxPhase, PitBox } from './PitBoxes';

interface Shot {
  /** доля таймлайна, где ракурс «в силе» */
  at: number;
  pos: [number, number, number];
  look: [number, number, number];
}

/** Раскадровка интро над рядом из 7 боксов (ряд ≈ 59 м по X). */
const SHOTS: Shot[] = [
  { at: 0.0, pos: [-30, 17, 30], look: [0, 2.0, 0] },
  { at: 0.35, pos: [0, 2.3, 16], look: [0, 1.2, 0] },
  { at: 0.7, pos: [26, 3.2, 13], look: [6, 1.4, 0] },
  { at: 1.0, pos: [-6, 10, 34], look: [0, 1.6, 0] },
];

const lam = 3.2; // жёсткость демпфера (1/сек)

/* -------------------------------------------------------------------------- */
/* Hero-болид: «выезд» из боксов на пит-лейн                                   */
/* -------------------------------------------------------------------------- */

/**
 * Отдельный геройский болид, который по таймлайну выкатывается от крайнего
 * бокса и уходит вдоль пит-стены — тот самый «выезд», который Oracle советует
 * добавлять вторым шагом после статичной сцены в боксах.
 *
 * Живёт целиком на refs и мутируется в useFrame: ноль ре-рендеров React и ноль
 * аллокаций на кадр (приём с мутируемым `mutation`-объектом из
 * `research/racing-game`, MIT © 2021 pmndrs — см. research/audit.md §1).
 */
function PitExitCar({ from = -9, to = 62, z = 6.6 }: { from?: number; to?: number; z?: number }) {
  const car = useRef<THREE.Group>(null);
  const wheels = useRef<Array<THREE.Mesh | null>>([]);
  const wheelGeo = useMemo(() => {
    const g = new THREE.CylinderGeometry(0.36, 0.36, 0.34, 16);
    g.rotateZ(Math.PI / 2); // ось колеса — вдоль X
    return g;
  }, []);

  useFrame((state) => {
    const period = 16;
    const t = (state.clock.elapsedTime % period) / period;
    const root = car.current;
    if (!root) return;

    // 0..0.10 — стоит в боксе; 0.10..0.72 — выезд; дальше ушёл из кадра.
    const drive = THREE.MathUtils.clamp((t - 0.1) / 0.62, 0, 1);
    const ease = drive * drive * (3 - 2 * drive);
    root.position.set(
      THREE.MathUtils.lerp(from, to, ease),
      0,
      z + Math.sin(ease * Math.PI) * -1.1, // лёгкая S-траектория при выходе
    );
    root.rotation.y = -Math.sin(ease * Math.PI) * 0.5;
    root.visible = t > 0.08 && t < 0.86;

    const spin = ease * 42;
    for (const w of wheels.current) if (w) w.rotation.x = spin;
  });

  const shell = '#e8eef8';
  const wheelPos: Array<[number, number]> = [
    [-0.64, 0.95],
    [0.66, 0.95],
    [-0.66, -0.95],
    [0.66, -0.95],
  ];

  return (
    <group ref={car} name="pit-exit-car">
      <mesh position={[0, 0.42, 0]} castShadow>
        <boxGeometry args={[0.94, 0.34, 2.6]} />
        <meshStandardMaterial color={shell} metalness={0.55} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.4, 1.75]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <coneGeometry args={[0.28, 1.2, 16]} />
        <meshStandardMaterial color={shell} metalness={0.55} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.68, -0.15]} castShadow>
        <boxGeometry args={[0.6, 0.32, 1.05]} />
        <meshStandardMaterial color="#10141f" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.98, -1.3]} castShadow>
        <boxGeometry args={[1.04, 0.1, 0.44]} />
        <meshStandardMaterial color="#4dd0ff" emissive="#4dd0ff" emissiveIntensity={0.4} />
      </mesh>
      {wheelPos.map(([x, wz], i) => (
        <mesh
          key={i}
          ref={(el) => {
            wheels.current[i] = el;
          }}
          geometry={wheelGeo}
          position={[x, 0.36, wz]}
          castShadow
        >
          <meshStandardMaterial color="#15171d" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

export interface CinematicIntroProps {
  boxes?: PitBox[];
  count?: number;
  position?: [number, number, number];
  autoPlay?: boolean;
  duration?: number;
  /** вести камеру по раскадровке (по умолчанию — НЕТ, чтобы не мешать TV-режиссёру) */
  driveCamera?: boolean;
  onPhaseChange?: (id: string, phase: BoxPhase) => void;
}

export function CinematicIntro({
  boxes,
  count = 7,
  position = [0, 0, 0],
  autoPlay = true,
  duration = 12,
  driveCamera = false,
  onPhaseChange,
}: CinematicIntroProps) {
  const camera = useThree((s) => s.camera);

  const goalPos = useRef(new THREE.Vector3(SHOTS[0].pos[0], SHOTS[0].pos[1], SHOTS[0].pos[2]));
  const goalLook = useRef(new THREE.Vector3(SHOTS[0].look[0], SHOTS[0].look[1], SHOTS[0].look[2]));
  const lookAt = useRef(new THREE.Vector3().copy(goalLook.current));
  const phaseRef = useRef<BoxPhase>('closed');

  const center = useMemo(() => {
    const n = Math.max(1, boxes?.length ?? count);
    const span = n * 7.4 + (n - 1) * 1.1;
    return span / 2 - 3.7; // ~центр ряда
  }, [boxes, count]);

  useFrame((state, dt) => {
    const g = state.clock.elapsedTime;
    const total = Math.max(1, duration);
    const t = (g % total) / total;

    // найти текущий сегмент раскадровки и локальный прогресс k∈[0,1]
    let a = SHOTS[0];
    let b = SHOTS[SHOTS.length - 1];
    for (let i = 0; i < SHOTS.length - 1; i++) {
      if (t >= SHOTS[i].at && t <= SHOTS[i + 1].at) {
        a = SHOTS[i];
        b = SHOTS[i + 1];
        break;
      }
    }
    const k = a === b ? 0 : THREE.MathUtils.smoothstep((t - a.at) / (b.at - a.at), 0, 1);

    goalPos.current.set(
      THREE.MathUtils.lerp(a.pos[0], b.pos[0], k),
      THREE.MathUtils.lerp(a.pos[1], b.pos[1], k),
      THREE.MathUtils.lerp(a.pos[2], b.pos[2], k),
    );
    goalLook.current.set(
      THREE.MathUtils.lerp(a.look[0], b.look[0], k) + center * 0.0,
      THREE.MathUtils.lerp(a.look[1], b.look[1], k),
      THREE.MathUtils.lerp(a.look[2], b.look[2], k),
    );

    if (!driveCamera) return;

    const c = camera.position;
    c.x = THREE.MathUtils.damp(c.x, goalPos.current.x, lam, dt);
    c.y = THREE.MathUtils.damp(c.y, goalPos.current.y, lam, dt);
    c.z = THREE.MathUtils.damp(c.z, goalPos.current.z, lam, dt);
    lookAt.current.x = THREE.MathUtils.damp(lookAt.current.x, goalLook.current.x, lam, dt);
    lookAt.current.y = THREE.MathUtils.damp(lookAt.current.y, goalLook.current.y, lam, dt);
    lookAt.current.z = THREE.MathUtils.damp(lookAt.current.z, goalLook.current.z, lam, dt);
    camera.lookAt(lookAt.current);
  });

  return (
    <group name="cinematic-intro" position={position}>
      <PitBoxesStage
        boxes={boxes}
        count={count}
        autoPlay={autoPlay}
        duration={duration}
        onPhaseChange={(id, p) => {
          phaseRef.current = p;
          onPhaseChange?.(id, p);
        }}
      />

      {/* «выезд»: геройский болид покидает боксы и уходит по пит-лейну */}
      <PitExitCar />

      {/* заливающий «стадионный» свет на пит-стену */}
      <hemisphereLight args={['#8fb6ff', '#0a0e18', 0.45]} />
      <directionalLight
        position={[-18, 24, 18]}
        intensity={1.15}
        color="#dbe7ff"
        castShadow
      />
      <pointLight position={[-12, 6, 14]} intensity={28} distance={60} color="#4dd0ff" />
      <pointLight position={[12, 6, 14]} intensity={20} distance={55} color="#ff7eb6" />
    </group>
  );
}

export default CinematicIntro;
