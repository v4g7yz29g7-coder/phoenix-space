/**
 * Chassis.tsx — Cyberpunk chassis for the cannon-es RaycastVehicle
 *
 * Port of pmndrs/racing-game `src/models/vehicle/Chassis.tsx`
 * (MIT © 2021 pmndrs/contributors — see research/racing-game/LICENSE.md).
 *
 * The reference chassis is a CC-BY-4.0 "Classic Muscle car" GLTF bolted onto a
 * `useBox` body (mass 500, args [2, 1.1, 4.7], allowSleep:false) with heavy
 * store/audio/camera coupling. This port keeps the *physics contract* identical
 * and replaces the asset with a procedural cyberpunk silhouette (hull, cabin,
 * neon strips, lights, underglow) — zero assets, zero store coupling.
 *
 * Exports:
 *   · `ChassisVisual` — body-only visuals (forwardRef<Group>) authored at the
 *     origin so callers own the transform/animation. Drop it inside an existing
 *     `useBox` body (see `Vehicle.tsx`).
 *   · `Chassis`       — reference-shaped component that owns the `useBox`
 *     physics body and renders `<ChassisVisual>` inside it.
 */
import { forwardRef } from 'react';
import type { PropsWithChildren, Ref } from 'react';
import type { Group } from 'three';
import { useBox } from '@react-three/cannon';
import type { BoxProps } from '@react-three/cannon';

/** Reference chassis half-extents. */
export const CHASSIS_ARGS: [number, number, number] = [2, 1.1, 4.7];
/** Reference chassis mass. */
export const CHASSIS_MASS = 500;
/** Vertical offset applied to the visuals inside the physics box. */
export const CHASSIS_VISUAL_OFFSET: [number, number, number] = [0, -0.2, -0.2];

/** Cyberpunk default palette (body paint + neon accent). */
export const CHASSIS_COLOR = '#1b1f2e';
export const CHASSIS_ACCENT = '#12f7ff';

export interface ChassisVisualProps {
  /** Body paint color. */
  color?: string;
  /** Neon accent used for side strips + underglow. */
  accent?: string;
  /** Toggle the neon underglow point light (default true). */
  underglow?: boolean;
}

/**
 * Procedural cyberpunk body, authored at the origin. It has no transform of its
 * own so callers can offset/animate it freely (see the lean/vibration animation
 * in `Vehicle.tsx`).
 */
export const ChassisVisual = forwardRef<Group, ChassisVisualProps>(
  ({ color = CHASSIS_COLOR, accent = CHASSIS_ACCENT, underglow = true }, ref) => (
    <group ref={ref} dispose={null}>
      {/* main hull */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[1.9, 0.5, 4.3]} />
        <meshStandardMaterial color={color} roughness={0.35} metalness={0.85} />
      </mesh>
      {/* cabin */}
      <mesh castShadow position={[0, 0.45, -0.15]}>
        <boxGeometry args={[1.5, 0.55, 1.8]} />
        <meshStandardMaterial color="#05060a" roughness={0.15} metalness={0.6} />
      </mesh>
      {/* neon side strips */}
      {[-0.97, 0.97].map((x) => (
        <mesh key={`strip-${x}`} position={[x, 0.02, 0]}>
          <boxGeometry args={[0.05, 0.08, 4.0]} />
          <meshStandardMaterial color="#000000" emissive={accent} emissiveIntensity={3} toneMapped={false} />
        </mesh>
      ))}
      {/* headlights */}
      {[-0.62, 0.62].map((x) => (
        <mesh key={`head-${x}`} position={[x, 0.14, 2.16]}>
          <boxGeometry args={[0.4, 0.12, 0.08]} />
          <meshStandardMaterial color="#ffffff" emissive="#cfe9ff" emissiveIntensity={4} toneMapped={false} />
        </mesh>
      ))}
      {/* tail-light bar */}
      <mesh position={[0, 0.14, -2.16]}>
        <boxGeometry args={[1.5, 0.1, 0.08]} />
        <meshStandardMaterial color="#330000" emissive="#ff1e56" emissiveIntensity={3} toneMapped={false} />
      </mesh>
      {/* underglow */}
      {underglow && <pointLight position={[0, -0.35, 0]} color={accent} intensity={3} distance={6} />}
    </group>
  ),
);
ChassisVisual.displayName = 'ChassisVisual';

export type ChassisProps = PropsWithChildren<
  BoxProps & {
    /** Body paint color forwarded to the visuals. */
    color?: string;
    /** Neon accent forwarded to the visuals. */
    accent?: string;
    /** Toggle the underglow forwarded to the visuals. */
    underglow?: boolean;
  }
>;

/**
 * Reference-shaped chassis: owns the `useBox` physics body and renders the
 * procedural visuals inside it. Use `ref` to receive the cannon body group
 * (this is what `useRaycastVehicle` needs).
 */
export const Chassis = forwardRef<Group, ChassisProps>(
  (
    {
      args = CHASSIS_ARGS,
      mass = CHASSIS_MASS,
      color = CHASSIS_COLOR,
      accent = CHASSIS_ACCENT,
      underglow = true,
      children,
      ...props
    },
    ref,
  ) => {
    const [, api] = useBox<Group>(() => ({ mass, args, allowSleep: false, ...props }), ref as Ref<Group>);

    return (
      <group ref={ref as unknown as Ref<Group>} dispose={null} userData={{ api }}>
        <group position={CHASSIS_VISUAL_OFFSET}>
          <ChassisVisual color={color} accent={accent} underglow={underglow} />
        </group>
        {children}
      </group>
    );
  },
);
Chassis.displayName = 'Chassis';

export default Chassis;
