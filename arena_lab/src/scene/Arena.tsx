import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Stars } from '@react-three/drei';
import type { PointLight } from 'three';
import { useArena } from '../store/arena';
import { AgentCube } from './AgentCube';

/* ============================================================================
 * ГЕОМЕТРИЯ СТАРТОВОЙ РЕШЁТКИ — единый источник правды.
 * ----------------------------------------------------------------------------
 * Болиды (AgentCube) едут по ПРЯМОЙ вдоль +X:
 *     x = CAR_START_X .. CAR_START_X + CAR_RUN_LENGTH,
 * а поперёк (ось Z) выстроены по полосам с шагом LANE_SPACING.
 * Эти же функции использует TV Director (useTVDirector.ts), чтобы камеры
 * фреймили реальные болиды, а не абстрактную кривую.
 * ========================================================================== */

export const CAR_START_X = -20;
export const CAR_RUN_LENGTH = 40;
export const CAR_Y = 0.3;
export const LANE_SPACING = 1.8;

/** Z-координата полосы болида с индексом `index` (всего `count` болидов). */
export function laneZ(index: number, count: number): number {
  const startLane = -((count - 1) * LANE_SPACING) / 2;
  return startLane + index * LANE_SPACING;
}

/** Мировая позиция болида — совпадает с той, что выводит AgentCube. */
export function carWorldPosition(
  progress: number,
  index: number,
  count: number,
): { x: number; y: number; z: number } {
  const p = Math.max(0, Math.min(1, progress));
  return { x: CAR_START_X + p * CAR_RUN_LENGTH, y: CAR_Y, z: laneZ(index, count) };
}

/** Мировая точка финиша (шахматка) — конец прямой. */
export function finishWorldPosition(): { x: number; y: number; z: number } {
  return { x: CAR_START_X + CAR_RUN_LENGTH, y: CAR_Y, z: 0 };
}

/** Количество болидов в текущем заезде (нужно камерам для расчёта полос). */
export function agentCount(): number {
  return Object.keys(useArena.getState().agents).length;
}

export function Arena() {
  const agents = useArena((s) => s.agents);
  const list = Object.values(agents);
  const count = list.length;

  const lightA = useRef<PointLight>(null);
  const lightB = useRef<PointLight>(null);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (lightA.current) lightA.current.intensity = 3 + Math.sin(t * 1.5) * 1.2;
    if (lightB.current) lightB.current.intensity = 3 + Math.sin(t * 1.5 + Math.PI) * 1.2;
  });

  return (
    <>
      <ambientLight intensity={0.3} />
      <directionalLight position={[10, 20, 10]} intensity={1} castShadow />

      <pointLight ref={lightA} position={[-15, 8, 0]} color="#4dd0ff" intensity={3} distance={40} />
      <pointLight ref={lightB} position={[15, 8, 0]} color="#a855f7" intensity={3} distance={40} />

      <fog attach="fog" args={['#0a0e1a', 10, 60]} />

      <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />

      {/* Пол с сеткой — gridHelper встроенный */}
      <gridHelper args={[100, 100, '#4dd0ff', '#1e2a4a']} position={[0, 0, 0]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[100, 100]} />
        <meshStandardMaterial color="#050810" />
      </mesh>

      {list.map((a, i) => (
        <AgentCube
          key={a.name}
          name={a.name}
          color={a.color}
          lane={laneZ(i, count)}
          progress={a.progress}
          status={a.status}
        />
      ))}
    </>
  );
}
