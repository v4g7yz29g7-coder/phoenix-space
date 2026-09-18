import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useArena } from '../store/arena';
import { carWorldPosition, finishWorldPosition } from './Arena';
import { TV_CAMERAS } from '../hooks/useTVDirector';
import type { TVCameraId } from '../hooks/useTVDirector';

/* ============================================================================
 * TV BROADCAST — 6 физических камер авто-режиссуры  (FORMULA I1 / AI-1)
 * ----------------------------------------------------------------------------
 * scene-компонент, который материализует шесть планов из useTVDirector.ts:
 *
 *   onboard · chase · wide · helicam · trackside · finishline
 *
 * Каждая камера — реальный риг в сцене: корпус + объектив + конус кадра
 * (FOV-пирамида) + TALLY-лампа (красная у камеры «в эфире», серые — стендбай).
 * Позы камер пересчитываются каждый кадр из реальной геометрии болидов
 * (Arena.carWorldPosition / finishWorldPosition), поэтому риги всегда
 * смотрят на лидера/финиш, а не на абстрактную точку.
 *
 * Приёмы вдохновлены research/racing-game (MIT): src/effects/Cameras.tsx —
 * переключение планов; кинематика в useFrame без React-ререндеров.
 *
 * Использование:
 *   const { activeId } = useTVDirector();
 *   <TVBroadcast activeId={activeId} />
 * ========================================================================== */

const ORBIT_SPEED = 0.35; // рад/сек — синхронно с useTVDirector
const LERP_RATE = 4; // сглаживание перемещения рига
const FRUSTUM_LEN = 7; // длина пирамиды кадра

const vec = (p: { x: number; y: number; z: number }) =>
  new THREE.Vector3(p.x, p.y, p.z);

/** Один физический риг: корпус, объектив, конус кадра и tally-лампа. */
function CameraRig() {
  return (
    <group>
      {/* корпус камеры */}
      <mesh castShadow>
        <boxGeometry args={[0.5, 0.45, 0.9]} />
        <meshStandardMaterial color="#20263a" metalness={0.6} roughness={0.4} />
      </mesh>
      {/* объектив (смотрит в -Z — «вперёд» группы) */}
      <mesh position={[0, 0, -0.6]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.16, 0.2, 0.5, 20]} />
        <meshStandardMaterial color="#0b0e16" metalness={0.9} roughness={0.2} />
      </mesh>
      {/* стекло объектива */}
      <mesh position={[0, 0, -0.86]}>
        <circleGeometry args={[0.15, 20]} />
        <meshStandardMaterial
          color="#3fd0ff"
          emissive="#3fd0ff"
          emissiveIntensity={0.6}
          transparent
          opacity={0.85}
        />
      </mesh>
      {/* tally-лампа — обновляется снаружи через материал */}
      <mesh position={[0, 0.4, 0.2]}>
        <sphereGeometry args={[0.09, 12, 12]} />
        <meshStandardMaterial color="#3a4256" emissive="#ff2d2d" emissiveIntensity={0.15} />
      </mesh>
    </group>
  );
}

export interface TVBroadcastProps {
  /** Камера, находящаяся сейчас «в эфире» (подсвечивает TALLY). */
  activeId: TVCameraId;
}

export function TVBroadcast({ activeId }: TVBroadcastProps) {
  const groupRefs = useRef<Array<THREE.Group | null>>([]);
  const tallyRefs = useRef<Array<THREE.Mesh | null>>([]);
  const orbitRef = useRef(0);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    orbitRef.current += dt * ORBIT_SPEED;

    // --- Лидер заезда (та же логика, что в useTVDirector) ---
    const list = Object.values(useArena.getState().agents);
    const count = list.length;
    let leader = list[0];
    let leaderIdx = 0;
    for (let i = 0; i < count; i++) {
      if (!leader || list[i].progress > leader.progress) {
        leader = list[i];
        leaderIdx = i;
      }
    }
    const lp = THREE.MathUtils.clamp(leader?.progress ?? 0, 0, 1);
    const leaderPos = leader
      ? vec(carWorldPosition(lp, leaderIdx, count))
      : new THREE.Vector3(0, 0.3, 0);
    const aheadPos = leader
      ? vec(carWorldPosition(Math.min(1, lp + 0.02), leaderIdx, count))
      : leaderPos.clone();
    const finishPos = vec(finishWorldPosition());
    const trackCenter = new THREE.Vector3(0, 1, 0);

    const desired = new THREE.Vector3();
    const look = new THREE.Vector3();

    TV_CAMERAS.forEach((def, i) => {
      const g = groupRefs.current[i];
      if (!g) return;

      if (def.mode === 'chase') {
        const [ox, oy, oz] = def.offset ?? [-4, 2, 0];
        desired.set(leaderPos.x + ox, leaderPos.y + oy, leaderPos.z + oz);
        look.copy(def.id === 'onboard' ? aheadPos : leaderPos);
      } else if (def.mode === 'orbit') {
        const c = def.center === 'leader' ? leaderPos : trackCenter;
        const r = def.radius ?? 48;
        const h = def.height ?? 26;
        desired.set(
          c.x + Math.cos(orbitRef.current) * r,
          h,
          c.z + Math.sin(orbitRef.current) * r,
        );
        look.copy(c);
      } else {
        const p = def.position ?? [0, 3, 0];
        desired.set(p[0], p[1], p[2]);
        look.copy(def.lookAt === 'finish' ? finishPos : leaderPos);
      }

      g.position.lerp(desired, Math.min(1, dt * LERP_RATE));
      g.lookAt(look);

      // --- TALLY: красный у активной камеры, приглушённый у остальных ---
      const tally = tallyRefs.current[i];
      if (tally) {
        const mat = tally.material as THREE.MeshStandardMaterial;
        const onAir = def.id === activeId;
        mat.color.set(onAir ? '#ff2d2d' : '#3a4256');
        mat.emissiveIntensity = onAir ? 3 : 0.15;
      }
    });
  });

  return (
    <>
      {TV_CAMERAS.map((def, i) => (
        <group
          key={def.id}
          ref={(el) => {
            groupRefs.current[i] = el;
          }}
        >
          <CameraRig />
          {/* Конус кадра (FOV-пирамида), указывает вперёд по -Z */}
          <mesh position={[0, 0, -FRUSTUM_LEN / 2]} rotation={[Math.PI / 2, 0, 0]}>
            <coneGeometry args={[2.2, FRUSTUM_LEN, 4, 1, true]} />
            <meshBasicMaterial
              color="#4dd0ff"
              transparent
              opacity={0.06}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
          {/* Отдельный ref для tally-лампы (5-й ребёнок рига) */}
          <mesh
            position={[0, 0.4, 0.2]}
            ref={(el) => {
              tallyRefs.current[i] = el;
            }}
          >
            <sphereGeometry args={[0.1, 12, 12]} />
            <meshStandardMaterial color="#3a4256" emissive="#ff2d2d" emissiveIntensity={0.15} />
          </mesh>
          {/* Нимб-индикатор «в эфире» */}
          <pointLight
            color="#ff2d2d"
            intensity={def.id === activeId ? 6 : 0}
            distance={6}
            position={[0, 0.5, 0]}
          />
        </group>
      ))}
    </>
  );
}

export default TVBroadcast;
