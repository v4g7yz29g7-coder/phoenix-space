/**
 * Wheel.tsx — Cyberpunk wheel for the cannon-es RaycastVehicle
 *
 * Port of pmndrs/racing-game `src/models/vehicle/Wheel.tsx`
 * (MIT © 2021 pmndrs/contributors — see research/racing-game/LICENSE.md).
 *
 * The reference wheel is a CC-BY/CC0 GLTF tyre+rim bolted onto a *Kinematic*
 * cylinder body with `collisionFilterGroup: 0` (it must not collide — the
 * RaycastVehicle drives it purely through raycasts) and mass 50. This port
 * keeps the *physics contract byte-for-byte identical* and swaps the GLTF for
 * procedural geometry (dark tyre + emissive neon rim + neon bolts), so it is
 * zero-dependency and drops into any scene.
 *
 * Physics contract
 *   mass 50 · type 'Kinematic' · material 'wheel' · collisionFilterGroup 0 ·
 *   Cylinder(radius, radius, 0.5, 16) rotated [0, 0, -π/2] to lie on its side.
 * `WHEEL_INFO` (below) is the single source of truth for the RaycastVehicle
 * wheel tuning and is consumed by `./Vehicle.tsx`.
 *
 * Exports:
 *   · `WHEEL_INFO`   — tuning passed to `useRaycastVehicle` (shared with Vehicle).
 *   · `WheelVisual`  — body-only visuals (forwardRef<Group>) authored at the
 *     origin so callers own the transform/animation.
 *   · `Wheel`        — reference-shaped component that owns the kinematic
 *     cylinder body and renders `<WheelVisual>` inside it.
 */
import { forwardRef } from 'react';
import type { Group } from 'three';
import { useCompoundBody } from '@react-three/cannon';
import type { CylinderProps, Triplet, WheelInfoOptions } from '@react-three/cannon';

/* -------------------------------------------------------------------------- */
/* Tuning (single source of truth — mirrors research/racing-game store.ts)     */
/* -------------------------------------------------------------------------- */

/** Authored wheel radius — shared by physics, visuals and the vehicle. */
export const WHEEL_RADIUS = 0.38;
/** Wheel body mass (reference value — must stay Kinematic). */
export const WHEEL_MASS = 50;
/** Physics/visual cylinder length (reference: 0.5). */
export const WHEEL_LENGTH = 0.5;
/** Visual tyre width (slightly narrower than the collider). */
export const WHEEL_WIDTH = 0.42;
/** Cyberpunk neon cyan (default rim accent). */
export const WHEEL_ACCENT = '#12f7ff';

/**
 * RaycastVehicle wheel info. Values are lifted from the reference
 * `wheelInfo` preset (suspensionStiffness 30, frictionSlip 1.5, radius 0.38).
 * Import this in `Vehicle.tsx` instead of re-declaring it.
 */
export const WHEEL_INFO: WheelInfoOptions = {
  axleLocal: [-1, 0, 0],
  customSlidingRotationalSpeed: -0.01,
  directionLocal: [0, -1, 0],
  frictionSlip: 1.5,
  radius: WHEEL_RADIUS,
  rollInfluence: 0,
  sideAcceleration: 3,
  suspensionRestLength: 0.35,
  suspensionStiffness: 30,
  useCustomSlidingRotationalSpeed: true,
};

/* -------------------------------------------------------------------------- */
/* Visuals                                                                     */
/* -------------------------------------------------------------------------- */

export interface WheelVisualProps {
  /** Wheel radius (defaults to `WHEEL_RADIUS`). */
  radius?: number;
  /** Visual width (defaults to `WHEEL_WIDTH`). */
  width?: number;
  /** Mirror the rim so left/right wheels face outward. */
  leftSide?: boolean;
  /** Neon rim color (defaults to the cyberpunk cyan). */
  accent?: string;
}

/**
 * Procedural cyberpunk wheel, authored at the origin. No transform of its own,
 * so callers (or the RaycastVehicle) own the pose.
 */
export const WheelVisual = forwardRef<Group, WheelVisualProps>(
  ({ radius = WHEEL_RADIUS, width = WHEEL_WIDTH, leftSide = false, accent = WHEEL_ACCENT }, ref) => (
    <group ref={ref} dispose={null}>
      <group scale={leftSide ? -1 : 1}>
        {/* tyre */}
        <mesh castShadow rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[radius, radius, width, 20]} />
          <meshStandardMaterial color="#0b0b12" roughness={0.85} metalness={0.4} />
        </mesh>
        {/* neon hub / rim */}
        <mesh rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[radius * 0.58, radius * 0.58, width + 0.02, 12]} />
          <meshStandardMaterial
            color="#101018"
            emissive={accent}
            emissiveIntensity={2.4}
            roughness={0.3}
            metalness={0.9}
            toneMapped={false}
          />
        </mesh>
        {/* neon rim bolts (cheap rotating accent) */}
        {Array.from({ length: 5 }, (_, i) => {
          const a = (i / 5) * Math.PI * 2;
          return (
            <mesh key={`bolt-${i}`} position={[Math.cos(a) * radius * 0.74, Math.sin(a) * radius * 0.74, width / 2 + 0.01]}>
              <boxGeometry args={[0.05, 0.05, 0.02]} />
              <meshStandardMaterial color="#000000" emissive={accent} emissiveIntensity={3} toneMapped={false} />
            </mesh>
          );
        })}
      </group>
    </group>
  ),
);
WheelVisual.displayName = 'WheelVisual';

/* -------------------------------------------------------------------------- */
/* Physics body                                                                */
/* -------------------------------------------------------------------------- */

export interface WheelProps extends CylinderProps {
  /** Wheel radius (defaults to `WHEEL_RADIUS`). */
  radius?: number;
  /** Visual width (defaults to `WHEEL_WIDTH`). */
  width?: number;
  /** Mirror the rim so left/right wheels face outward. */
  leftSide?: boolean;
  /** Neon rim color (defaults to the cyberpunk cyan). */
  accent?: string;
}

/**
 * Kinematic cylinder body driven by the RaycastVehicle (exactly like the
 * reference `Wheel.tsx`). Renders the procedural `<WheelVisual>`.
 */
export const Wheel = forwardRef<Group, WheelProps>(
  ({ radius = WHEEL_RADIUS, width = WHEEL_WIDTH, leftSide = false, accent = WHEEL_ACCENT, ...props }, ref) => {
    useCompoundBody(
      () => ({
        mass: WHEEL_MASS,
        type: 'Kinematic',
        material: 'wheel',
        collisionFilterGroup: 0,
        shapes: [
          {
            args: [radius, radius, WHEEL_LENGTH, 16],
            rotation: [0, 0, -Math.PI / 2] as Triplet,
            type: 'Cylinder',
          },
        ],
        ...props,
      }),
      ref,
      [radius],
    );

    return <WheelVisual ref={ref} radius={radius} width={width} leftSide={leftSide} accent={accent} />;
  },
);
Wheel.displayName = 'Wheel';

export default Wheel;
