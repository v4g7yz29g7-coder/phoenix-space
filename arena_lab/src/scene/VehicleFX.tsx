/**
 * VehicleFX.tsx — Dust / Skid / Boost particle VFX for the cyberpunk car
 *
 * Port of the three instancedMesh effect modules from pmndrs/racing-game
 * (`src/effects/Dust.tsx`, `src/effects/Skid.tsx`, `src/effects/Boost.tsx`,
 * MIT © 2021 pmndrs/contributors — see research/racing-game/LICENSE.md).
 * This is the "cheap instanced VFX (trail pool in a single buffer)" technique
 * called out as TOP-3 #3 in research/audit.md.
 *
 * Design notes (differences from the reference port):
 *  - self-contained: no zustand store. The vehicle writes a single mutable
 *    `FXState` object (a ref) once per frame and every emitter reads it — zero
 *    React re-renders, exactly like the reference's `mutation` object;
 *  - strongly typed for `npx tsc --noEmit` (the upstream files are plain JS);
 *  - emitters are decoupled: they take wheel / anchor refs via props, so they
 *    can be dropped under any `useRaycastVehicle` chassis;
 *  - all instance buffers are zero-scaled on mount, so no effect flashes at
 *    the scene origin before its first emit;
 *  - cyberpunk tuning: neon-white dust, near-black skid rubber, cyan exhaust
 *    sparks that fade toward ember-orange at high boost pressure.
 *
 * Exports:
 *   · `FXState` / `createVehicleFXState()` — the per-frame telemetry contract.
 *   · `Dust`  — white spheres kicked up while sliding / braking.
 *   · `Skid`  — dark quads laid down under the rear wheels while drifting.
 *   · `Boost` — cyan sparks trailing the exhaust while boosting.
 *   · `VehicleFX` — mounts all three with sensible cyberpunk defaults.
 */
import { useLayoutEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { MathUtils, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { InstancedMesh } from 'three';
import { useFrame } from '@react-three/fiber';

/* -------------------------------------------------------------------------- */
/* Shared per-frame telemetry contract                                         */
/* -------------------------------------------------------------------------- */

/**
 * Mutable snapshot the vehicle writes every frame (no React state, no
 * re-renders). Emitters only ever read from this object.
 */
export interface FXState {
  /** Absolute speed in m/s (drive units). */
  speed: number;
  /** Remaining boost tank, normalised to 0..1. */
  boost: number;
  /** True while the raycast vehicle reports a slide. */
  sliding: boolean;
  /** True while the brake is held. */
  braking: boolean;
  /** True while the boost key is held AND the tank has charge. */
  boosting: boolean;
}

/** Neutral telemetry — safe default for `useRef(createVehicleFXState())`. */
export function createVehicleFXState(): FXState {
  return { speed: 0, boost: 0, sliding: false, braking: false, boosting: false };
}

/* -------------------------------------------------------------------------- */
/* Scratch objects (allocated once, reused every frame — no GC churn)          */
/* -------------------------------------------------------------------------- */

const v = new Vector3();
const q = new Quaternion();
const m = new Matrix4();
const tmp = new Matrix4();
const o = new Object3D();

/** Dust shrinks by this much each frame → ~200-frame lifetime at 60 fps. */
const DUST_SHRINK = 0.005;
/** Minimum speed (drive units) before skid marks are laid down. */
const SKID_MIN_SPEED = 10;
/** Seconds between dust emissions (reference: 0.02). */
const DUST_INTERVAL = 0.02;

/** Zero every instance so nothing renders before the first emit. */
function zeroInstances(mesh: InstancedMesh | null): void {
  if (!mesh) return;
  m.makeScale(0, 0, 0);
  for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, m);
  mesh.instanceMatrix.needsUpdate = true;
}

/** Fade every instance by `amount` (uniform scale decrement). */
function shrinkInstances(mesh: InstancedMesh, amount: number): void {
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    m.decompose(o.position, q, v);
    o.scale.setScalar(Math.max(0, v.x - amount));
    o.updateMatrix();
    mesh.setMatrixAt(i, o.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

/** Commit the current scratch transform of `o` at `index`. */
function commit(mesh: InstancedMesh, index: number): void {
  o.updateMatrix();
  mesh.setMatrixAt(index, o.matrix);
  mesh.instanceMatrix.needsUpdate = true;
}

/** Resolve the emitter list: explicit wheels, else the single anchor. */
function resolveSources(
  wheels: ReadonlyArray<RefObject<Object3D>> | undefined,
  anchor: RefObject<Object3D> | undefined,
): ReadonlyArray<RefObject<Object3D>> {
  if (wheels && wheels.length > 0) return wheels;
  if (anchor) return [anchor];
  return [];
}

/* -------------------------------------------------------------------------- */
/* Dust                                                                        */
/* -------------------------------------------------------------------------- */

export interface DustProps {
  /** Instance count (reference: 200). */
  count?: number;
  /** Material opacity (reference: 0.1). */
  opacity?: number;
  /** Sphere radius (reference: 1). */
  size?: number;
  /** Particle color. */
  color?: string;
  /** Shared telemetry, written by the vehicle each frame. */
  state: MutableRefObject<FXState>;
  /** Emitters — typically the two rear wheels (world positions). */
  wheels?: ReadonlyArray<RefObject<Object3D>>;
  /** Fallback emitter when no wheels are provided. */
  anchor?: RefObject<Object3D>;
}

/**
 * Instanced dust puffs kicked up from the rear wheels. Emission intensity is
 * `(sliding || braking) * speed` (reference formula), lerped for smoothness.
 */
export function Dust({
  count = 200,
  opacity = 0.12,
  size = 1,
  color = '#c8d4e6',
  state,
  wheels,
  anchor,
}: DustProps) {
  const ref = useRef<InstancedMesh>(null);
  const intensity = useRef(0);
  const index = useRef(0);
  const timer = useRef(0);

  useLayoutEffect(() => {
    zeroInstances(ref.current);
  }, []);

  useFrame((_frame, delta) => {
    const mesh = ref.current;
    if (!mesh) return;

    const st = state.current;
    const emit = st.sliding || st.braking ? st.speed : 0;
    intensity.current = MathUtils.lerp(intensity.current, emit / 40, Math.min(delta * 8, 1));

    // Fade the existing trail first, so fresh puffs stay full-size.
    shrinkInstances(mesh, DUST_SHRINK);

    const sources = resolveSources(wheels, anchor);
    if (sources.length === 0) return;

    timer.current += delta;
    if (timer.current < DUST_INTERVAL) return;
    timer.current = 0;

    for (const source of sources) {
      if (!source.current) continue;
      source.current.getWorldPosition(v);
      const n = MathUtils.randFloatSpread(0.25);
      o.position.set(v.x + n, v.y - 0.4, v.z + n);
      o.scale.setScalar(Math.random() * intensity.current);
      commit(mesh, index.current);
      index.current = (index.current + 1) % mesh.count;
    }
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} frustumCulled={false}>
      <sphereGeometry args={[size, 10, 10]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
    </instancedMesh>
  );
}

/* -------------------------------------------------------------------------- */
/* Skid                                                                        */
/* -------------------------------------------------------------------------- */

export interface SkidProps {
  /** Instance count (reference: 500). */
  count?: number;
  /** Material opacity (reference: 0.5). */
  opacity?: number;
  /** Mark length (quad is `size` wide × `2 * size` long). */
  size?: number;
  /** Mark color. */
  color?: string;
  /** Shared telemetry, written by the vehicle each frame. */
  state: MutableRefObject<FXState>;
  /** Mark emitters — typically the two rear wheels. */
  wheels?: ReadonlyArray<RefObject<Object3D>>;
  /**
   * Chassis body used for mark orientation (reference copies the chassis
   * rotation matrix). Without it marks are laid flat facing +Z.
   */
  anchor?: RefObject<Object3D>;
}

/**
 * Instanced rubber quads dropped under the rear wheels. Emits while the tyres
 * are slipping — i.e. braking above `SKID_MIN_SPEED` OR drifting (sliding),
 * which is what actually paints a cyberpunk drift line in a corner.
 */
export function Skid({
  count = 500,
  opacity = 0.5,
  size = 0.4,
  color = '#05060a',
  state,
  wheels,
  anchor,
}: SkidProps) {
  const ref = useRef<InstancedMesh>(null);
  const index = useRef(0);
  const rotation = useRef(new Quaternion());

  // Lay the quad flat on the ground plane (reference useLayoutEffect).
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.geometry.rotateX(-Math.PI / 2);
    zeroInstances(mesh);
    return () => {
      mesh.geometry.rotateX(Math.PI / 2);
    };
  }, []);

  useFrame(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const st = state.current;
    const slipping = st.braking || st.sliding;
    if (!slipping || st.speed <= SKID_MIN_SPEED) return;

    const sources = resolveSources(wheels, anchor);
    if (sources.length === 0) return;

    // Keep the marks aligned with the chassis heading (reference behaviour).
    if (anchor?.current) {
      anchor.current.updateWorldMatrix(true, false);
      anchor.current.getWorldQuaternion(rotation.current);
    } else {
      rotation.current.identity();
    }

    for (const source of sources) {
      if (!source.current) continue;
      source.current.getWorldPosition(v);
      o.position.copy(v);
      o.quaternion.copy(rotation.current);
      o.scale.setScalar(1);
      commit(mesh, index.current);
      index.current = (index.current + 1) % mesh.count;
    }
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} frustumCulled={false}>
      <planeGeometry args={[size, size * 2]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
    </instancedMesh>
  );
}

/* -------------------------------------------------------------------------- */
/* Boost                                                                       */
/* -------------------------------------------------------------------------- */

/** Exhaust-local spawn points (reference values). */
const BOOST_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [-0.4, -0.5, -1.8],
  [0.4, -0.5, -1.8],
];

export interface BoostProps {
  /** Instance count (reference: 12; kept even so pairs animate in lockstep). */
  count?: number;
  /** Material opacity (reference: 0.5). */
  opacity?: number;
  /** Spark half-size (reference: 0.1). */
  size?: number;
  /** Cold spark color (idle / low pressure). */
  color?: string;
  /** Hot spark color (mixed in at full boost pressure) — ember exhaust. */
  hotColor?: string;
  /** Shared telemetry, written by the vehicle each frame. */
  state: MutableRefObject<FXState>;
  /** Chassis body whose local space defines the exhaust. */
  anchor?: RefObject<Object3D>;
}

/**
 * Instanced sparks streaming back from the exhaust while boosting. Each spark
 * loops from the pipe towards the rear (`progress`), scaling to 0 as it dies.
 * The material shifts toward `hotColor` as the boost tank drains (pressure drop).
 */
export function Boost({
  count = 12,
  opacity = 0.6,
  size = 0.1,
  color = '#5ecfff',
  hotColor = '#ff7a1a',
  state,
  anchor,
}: BoostProps) {
  const ref = useRef<InstancedMesh>(null);
  const material = useRef<null | { color: { setRGB: (r: number, g: number, b: number) => void } }>(null);

  useLayoutEffect(() => {
    zeroInstances(ref.current);
  }, []);

  useFrame((frame) => {
    const mesh = ref.current;
    if (!mesh) return;
    const st = state.current;
    const boosting = st.boosting && st.boost > 0;
    const t = frame.clock.elapsedTime;

    // Ember shift: cold cyan when full, hot orange as the tank empties.
    const heat = boosting ? MathUtils.clamp(1 - st.boost, 0, 1) : 0;
    const mat = material.current;
    if (mat) {
      mat.color.setRGB(
        MathUtils.lerp(0.37, 1, heat),
        MathUtils.lerp(0.81, 0.48, heat),
        MathUtils.lerp(1, 0.1, heat),
      );
    }

    if (anchor?.current) anchor.current.updateWorldMatrix(true, false);

    const pairs = Math.max(1, Math.floor(mesh.count / BOOST_POSITIONS.length));
    for (let i = 0; i < pairs; i++) {
      const n = MathUtils.randFloatSpread(0.05);
      for (let j = 0; j < BOOST_POSITIONS.length; j++) {
        const progress = (t + (i + j) * 0.2) % 1;
        const p = BOOST_POSITIONS[j];
        o.position.set(p[0] + n, p[1], p[2] - progress * 0.75);
        o.rotation.set(0, 0, progress / 2);
        o.scale.setScalar(boosting ? (1 - progress) * 2 : 0);
        o.updateMatrix();

        if (anchor?.current) {
          tmp.multiplyMatrices(anchor.current.matrixWorld, o.matrix);
          mesh.setMatrixAt(i * BOOST_POSITIONS.length + j, tmp);
        } else {
          mesh.setMatrixAt(i * BOOST_POSITIONS.length + j, o.matrix);
        }
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} frustumCulled={false}>
      <boxGeometry args={[size, size, size]} />
      {/* `color` seeds the material; the per-frame RGB shift above overrides it. */}
      <meshBasicMaterial
        ref={material as never}
        color={color}
        transparent
        opacity={opacity}
        depthWrite={false}
        toneMapped={false}
      />
    </instancedMesh>
  );
}

/* -------------------------------------------------------------------------- */
/* Combined rig                                                                */
/* -------------------------------------------------------------------------- */

export interface VehicleFXProps {
  /** Shared telemetry (write `speed` / `boost` / `sliding` from the vehicle). */
  state: MutableRefObject<FXState>;
  /** Chassis / rear-axle anchor. Used for skid heading + boost exhaust space. */
  anchor?: RefObject<Object3D>;
  /** Wheel refs. The last pair is treated as the rear (dust + skid emitters). */
  wheels?: ReadonlyArray<RefObject<Object3D>>;
  dustProps?: Omit<DustProps, 'state' | 'wheels' | 'anchor'>;
  skidProps?: Omit<SkidProps, 'state' | 'wheels' | 'anchor'>;
  boostProps?: Omit<BoostProps, 'state' | 'anchor'>;
}

/**
 * Drop-in cyberpunk VFX rig mounting Dust + Skid + Boost. Put it next to the
 * `<CyberpunkVehicle>` inside the same `<Physics>` tree and share the chassis
 * group ref as `anchor`, plus the vehicle's wheel refs.
 */
export function VehicleFX({ state, anchor, wheels, dustProps, skidProps, boostProps }: VehicleFXProps) {
  return (
    <>
      <Dust state={state} anchor={anchor} wheels={wheels} {...dustProps} />
      <Skid state={state} anchor={anchor} wheels={wheels} {...skidProps} />
      <Boost state={state} anchor={anchor} {...boostProps} />
    </>
  );
}

export default VehicleFX;
