/**
 * PilotCockpit.tsx — «Пилот за стеклом» / Pilot behind the glass
 * ============================================================================
 * FORMULA I1 · STAGE «Киберпанк-кар» · TASK 2.5
 *
 * Onboard cockpit kit for the cyberpunk car (`src/scene/Vehicle.tsx`).
 *
 *   · `PilotCockpit`   — composite: open-cockpit tub (cowl + side pods), tinted
 *                        bubble windscreen with neon frame, seated pilot
 *                        (helmet / visor / arms) and a neon HUD. Authored at the
 *                        chassis origin, so it is dropped as a CHILD of the
 *                        physics chassis group and inherits the car transform
 *                        for free.
 *   · `CockpitCamera`  — drives the default R3F camera in two onboard modes:
 *                          `cockpit` — pilot POV, sitting BEHIND the glass;
 *                          `glass`   — nose cam, looking THROUGH the glass.
 *                        Speed is derived from the anchor's world-matrix delta,
 *                        so no external telemetry plumbing is required.
 *   · `CockpitHUD`     — additive RPM ring + speed bars above the cowl.
 *
 * Techniques borrowed from `research/racing-game` (MIT © 2021 pmndrs):
 *   · `src/effects/Cameras.tsx`        — switching the default camera per mode;
 *   · `src/models/vehicle/Vehicle.tsx` — the FIRST_PERSON offset (0.3, 0.4, -0.1)
 *     plus speed-scaled sway / vibration and banked roll (TOP-3 #2 in
 *     `research/audit.md`).
 *
 * All geometry / materials are procedural — zero GLTF assets, zero store
 * coupling, no per-frame allocations.
 * ============================================================================
 */
import { useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const { clamp, damp, degToRad } = THREE.MathUtils;

const DEG = Math.PI / 180;

/* -------------------------------------------------------------------------- */
/* Public model                                                               */
/* -------------------------------------------------------------------------- */

export type CockpitView = 'external' | 'cockpit' | 'glass';

export type CockpitDriver = 'left' | 'right' | 'center';

/** Per-frame telemetry published by the cockpit for HUD / external consumers. */
export interface CockpitTelemetry {
  /** Smoothed chassis speed in world units / second. */
  speed: number;
  /** Reserved boost level 0..1 (fed by the vehicle if wired). */
  boost: number;
  /** Reserved steering value -1..1 (fed by the vehicle if wired). */
  steer: number;
}

/** Driver head offset from the chassis origin (default left-hand seat). */
export const COCKPIT_HEAD: [number, number, number] = [0.34, 0.97, -0.44];

/** Windscreen plane in chassis space (its bottom edge sits on the cowl). */
export const COCKPIT_GLASS_Z = 0.34;

/** Horizontal offsets applied for the three seat options. */
const DRIVER_X: Record<CockpitDriver, number> = { left: 0.34, right: -0.34, center: 0 };

export interface PilotCockpitProps {
  /** `external` renders the pilot+cockpit only (chase / TV cams keep control). */
  view?: CockpitView;
  /** Neon accent (frame, visor, HUD, strips). */
  accent?: string;
  /** Windscreen tint. */
  glassTint?: string;
  /** Seating side. Defaults to `left`. */
  driver?: CockpitDriver;
  /** Speed used to normalise HUD / camera feel. */
  maxSpeed?: number;
  /** Base vertical field of view for the onboard cameras. */
  fov?: number;
  /** Hide the HUD (e.g. for the external showcase). */
  showHud?: boolean;
  /** Optional telemetry sink for HUD / socket wiring. */
  onTelemetry?: (t: CockpitTelemetry) => void;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported — easy to test / reuse)                             */
/* -------------------------------------------------------------------------- */

const _scale = new THREE.Vector3();

/** Decompose the anchor world matrix into position + quaternion. */
export function readAnchorWorld(
  object: THREE.Object3D,
  outPosition: THREE.Vector3,
  outQuaternion: THREE.Quaternion,
): void {
  object.updateWorldMatrix(true, false);
  object.matrixWorld.decompose(outPosition, outQuaternion, _scale);
}

/** World position of a local offset attached to the anchor. */
export function localToWorldOffset(
  anchorPosition: THREE.Vector3,
  anchorQuaternion: THREE.Quaternion,
  local: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  return out.copy(local).applyQuaternion(anchorQuaternion).add(anchorPosition);
}

/** Chassis local +Z axis (this port drives forward along +Z). */
export function anchorForward(
  anchorQuaternion: THREE.Quaternion,
  out: THREE.Vector3,
): THREE.Vector3 {
  return out.set(0, 0, 1).applyQuaternion(anchorQuaternion);
}

/** Chassis local +Y axis (banked-track "up"). */
export function anchorUp(
  anchorQuaternion: THREE.Quaternion,
  out: THREE.Vector3,
): THREE.Vector3 {
  return out.set(0, 1, 0).applyQuaternion(anchorQuaternion);
}

/* -------------------------------------------------------------------------- */
/* Cockpit visuals                                                            */
/* -------------------------------------------------------------------------- */

interface TintProps {
  accent: string;
  glassTint: string;
}

/** Open-cockpit tub: cowl, side pods, rear deck and neon rim. */
function CockpitTub({ accent }: { accent: string }) {
  return (
    <group name="cockpit-tub">
      {/* front cowl / dashboard shelf */}
      <mesh position={[0, 0.84, 0.22]} rotation={[degToRad(-12), 0, 0]} castShadow>
        <boxGeometry args={[1.5, 0.16, 0.36]} />
        <meshStandardMaterial color="#0b0e16" roughness={0.4} metalness={0.7} />
      </mesh>
      {/* cowl neon strip */}
      <mesh position={[0, 0.925, 0.36]} rotation={[degToRad(-12), 0, 0]}>
        <boxGeometry args={[1.4, 0.02, 0.02]} />
        <meshStandardMaterial color="#000000" emissive={accent} emissiveIntensity={3} toneMapped={false} />
      </mesh>

      {/* side pods */}
      {[-0.8, 0.8].map((x) => (
        <group key={`pod-${x}`} position={[x, 0.78, -0.35]}>
          <mesh castShadow>
            <boxGeometry args={[0.16, 0.24, 1.5]} />
            <meshStandardMaterial color="#0b0e16" roughness={0.45} metalness={0.65} />
          </mesh>
          <mesh position={[0, 0.14, 0]}>
            <boxGeometry args={[0.05, 0.02, 1.4]} />
            <meshStandardMaterial color="#000000" emissive={accent} emissiveIntensity={2.4} toneMapped={false} />
          </mesh>
        </group>
      ))}

      {/* rear deck */}
      <mesh position={[0, 0.82, -1.35]} castShadow>
        <boxGeometry args={[1.7, 0.14, 0.7]} />
        <meshStandardMaterial color="#0b0e16" roughness={0.45} metalness={0.7} />
      </mesh>

      {/* roll hoop behind the driver */}
      <mesh position={[0, 1.12, -0.92]} rotation={[0, 0, 0]} castShadow>
        <torusGeometry args={[0.38, 0.035, 12, 28, Math.PI]} />
        <meshStandardMaterial color="#04060a" emissive={accent} emissiveIntensity={1.6} roughness={0.3} metalness={0.8} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Tinted bubble windscreen with neon frame and holographic reflections. */
function CockpitCanopy({ accent, glassTint }: TintProps) {
  const tilt = degToRad(-20);
  return (
    <group name="cockpit-canopy">
      {/* glass */}
      <mesh position={[0, 0.98, COCKPIT_GLASS_Z]} rotation={[tilt, 0, 0]}>
        <boxGeometry args={[1.42, 0.46, 0.03]} />
        <meshPhysicalMaterial
          color={glassTint}
          transparent
          opacity={0.32}
          roughness={0.05}
          metalness={0}
          transmission={0.9}
          thickness={0.08}
          ior={1.45}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* neon frame: top bar + pillars */}
      <mesh position={[0, 1.2, COCKPIT_GLASS_Z - 0.16]} rotation={[tilt, 0, 0]}>
        <boxGeometry args={[1.46, 0.05, 0.05]} />
        <meshStandardMaterial color="#000000" emissive={accent} emissiveIntensity={2.6} toneMapped={false} />
      </mesh>
      {[-0.72, 0.72].map((x) => (
        <mesh key={`pillar-${x}`} position={[x, 0.98, COCKPIT_GLASS_Z - 0.08]} rotation={[tilt, 0, 0]}>
          <boxGeometry args={[0.05, 0.5, 0.05]} />
          <meshStandardMaterial color="#000000" emissive={accent} emissiveIntensity={1.8} toneMapped={false} />
        </mesh>
      ))}

      {/* holographic reflection streaks (cheap fake fresnel) */}
      {[
        { x: -0.42, rz: 30, o: 0.28 },
        { x: 0.4, rz: -34, o: 0.2 },
        { x: 0.06, rz: 12, o: 0.14 },
      ].map((r, i) => (
        <mesh key={`refl-${i}`} position={[r.x, 0.98, COCKPIT_GLASS_Z - 0.03]} rotation={[tilt, 0, degToRad(r.rz)]}>
          <planeGeometry args={[0.02, 0.42]} />
          <meshBasicMaterial
            color={accent}
            transparent
            opacity={r.o}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}

/** Seated pilot: seat, torso, arms, helmet and glowing visor. */
function PilotFigure({ accent }: { accent: string }) {
  return (
    <group name="pilot">
      {/* seat base + backrest */}
      <mesh position={[0, 0.5, -0.82]} castShadow>
        <boxGeometry args={[0.55, 0.12, 0.48]} />
        <meshStandardMaterial color="#0d1119" roughness={0.8} metalness={0.1} />
      </mesh>
      <mesh position={[0, 0.74, -1.02]} rotation={[degToRad(10), 0, 0]} castShadow>
        <boxGeometry args={[0.55, 0.5, 0.12]} />
        <meshStandardMaterial color="#0d1119" roughness={0.8} metalness={0.1} />
      </mesh>

      {/* torso + shoulders + neck */}
      <mesh position={[0, 0.7, -0.68]} castShadow>
        <boxGeometry args={[0.46, 0.42, 0.28]} />
        <meshStandardMaterial color="#121826" roughness={0.65} metalness={0.2} />
      </mesh>
      <mesh position={[0, 0.84, -0.6]} castShadow>
        <boxGeometry args={[0.5, 0.16, 0.26]} />
        <meshStandardMaterial color="#101420" roughness={0.6} metalness={0.25} />
      </mesh>
      <mesh position={[0, 0.9, -0.52]}>
        <cylinderGeometry args={[0.06, 0.07, 0.1, 12]} />
        <meshStandardMaterial color="#05070c" roughness={0.7} metalness={0.2} />
      </mesh>

      {/* helmet + visor */}
      <mesh position={[0, 0.97, -0.44]} castShadow>
        <sphereGeometry args={[0.15, 24, 16]} />
        <meshStandardMaterial color="#0d1016" roughness={0.25} metalness={0.7} />
      </mesh>
      <mesh position={[0, 0.965, -0.33]} scale={[0.95, 0.72, 0.5]}>
        <sphereGeometry args={[0.15, 24, 16]} />
        <meshStandardMaterial
          color="#04060a"
          emissive={accent}
          emissiveIntensity={1.5}
          roughness={0.08}
          metalness={0.9}
          toneMapped={false}
        />
      </mesh>

      {/* arms reaching for the yoke */}
      {[-0.22, 0.22].map((x) => (
        <mesh key={`arm-${x}`} position={[x, 0.82, -0.26]} rotation={[degToRad(38), 0, 0]} castShadow>
          <boxGeometry args={[0.1, 0.1, 0.52]} />
          <meshStandardMaterial color="#101420" roughness={0.65} metalness={0.2} />
        </mesh>
      ))}
      {[-0.16, 0.16].map((x) => (
        <mesh key={`hand-${x}`} position={[x, 0.78, -0.02]}>
          <sphereGeometry args={[0.055, 12, 10]} />
          <meshStandardMaterial color="#05070c" roughness={0.6} metalness={0.3} />
        </mesh>
      ))}

      {/* steering yoke */}
      <group position={[0, 0.79, 0.0]} rotation={[degToRad(-32), 0, 0]}>
        <mesh>
          <torusGeometry args={[0.15, 0.022, 10, 26]} />
          <meshStandardMaterial color="#04060a" emissive={accent} emissiveIntensity={1.2} roughness={0.35} metalness={0.85} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0, -0.05]}>
          <boxGeometry args={[0.3, 0.04, 0.03]} />
          <meshStandardMaterial color="#0b0e16" roughness={0.5} metalness={0.7} />
        </mesh>
      </group>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* HUD                                                                        */
/* -------------------------------------------------------------------------- */

const HUD_BARS = 6;

function CockpitHUD({
  accent,
  telemetry,
  maxSpeed,
}: {
  accent: string;
  telemetry: MutableRefObject<CockpitTelemetry>;
  maxSpeed: number;
}) {
  const ring = useRef<THREE.Mesh>(null);
  const bars = useRef<Array<THREE.Mesh | null>>([]);

  useFrame(() => {
    const t = telemetry.current;
    const ratio = clamp(t.speed / maxSpeed, 0, 1);
    if (ring.current) ring.current.rotation.z = Math.PI * 0.25 - ratio * Math.PI * 1.6;
    for (let i = 0; i < bars.current.length; i++) {
      const m = bars.current[i];
      if (!m) continue;
      const lit = clamp(ratio * HUD_BARS - i, 0, 1);
      m.scale.x = 0.15 + 0.85 * lit;
      m.scale.y = 0.6 + 0.4 * lit;
    }
  });

  return (
    <group name="cockpit-hud">
      {/* RPM ring */}
      <mesh ref={ring} position={[0, 1.0, 0.26]}>
        <ringGeometry args={[0.1, 0.117, 40, 1, 0, Math.PI * 1.6]} />
        <meshBasicMaterial
          color={accent}
          transparent
          opacity={0.9}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* speed / boost bars */}
      {Array.from({ length: HUD_BARS }, (_, i) => (
        <mesh
          key={`bar-${i}`}
          ref={(m) => {
            bars.current[i] = m;
          }}
          position={[-0.25 + i * 0.1, 0.87, 0.26]}
        >
          <boxGeometry args={[0.07, 0.022, 0.005]} />
          <meshBasicMaterial
            color={i > 3 ? '#ff2d6f' : accent}
            transparent
            opacity={0.85}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Camera rig                                                                 */
/* -------------------------------------------------------------------------- */

export interface CockpitCameraProps {
  /** Group whose world transform the camera follows (the seat anchor). */
  anchorRef: MutableRefObject<THREE.Group | null>;
  /** `cockpit` = pilot POV behind the glass, `glass` = nose cam through it. */
  view: Exclude<CockpitView, 'external'>;
  /** Driver head offset in anchor space. */
  headLocal?: THREE.Vector3;
  /** Speed used to normalise sway / FOV. */
  maxSpeed?: number;
  /** Base vertical FOV. */
  fov?: number;
  /** Shared telemetry sink (read by the HUD). */
  telemetry?: MutableRefObject<CockpitTelemetry>;
  /** Speed smoothing rate. */
  smooth?: number;
}

/**
 * Drives the default R3F camera from the anchor transform. Kept allocation-free
 * and independent from the vehicle's own chase camera (callers must not enable
 * both at once — see the guard in `Vehicle.tsx`).
 */
export function CockpitCamera({
  anchorRef,
  view,
  headLocal,
  maxSpeed = 88,
  fov = 68,
  telemetry,
  smooth = 5,
}: CockpitCameraProps) {
  const scratch = useMemo(
    () => ({
      anchorPos: new THREE.Vector3(),
      anchorQuat: new THREE.Quaternion(),
      headWorld: new THREE.Vector3(),
      forward: new THREE.Vector3(),
      up: new THREE.Vector3(),
      look: new THREE.Vector3(),
      lookMat: new THREE.Matrix4(),
      desired: new THREE.Quaternion(),
      prev: new THREE.Vector3(),
      cockpitHead: headLocal ? headLocal.clone() : new THREE.Vector3(...COCKPIT_HEAD),
      glassHead: new THREE.Vector3(0, 1.03, COCKPIT_GLASS_Z + 0.08),
    }),
    [headLocal],
  );

  const speed = useRef(0);
  const hasPrev = useRef(false);
  const localTelemetry = useRef<CockpitTelemetry>({ speed: 0, boost: 0, steer: 0 });
  const sink = telemetry ?? localTelemetry;

  useFrame((state, delta) => {
    const anchor = anchorRef.current;
    const cam = state.camera as THREE.PerspectiveCamera;
    if (!anchor || !cam) return;

    readAnchorWorld(anchor, scratch.anchorPos, scratch.anchorQuat);

    // ---- speed estimated from the chassis world-matrix delta ----
    if (hasPrev.current && delta > 0) {
      const inst = scratch.anchorPos.distanceTo(scratch.prev) / delta;
      speed.current = damp(speed.current, inst, smooth, delta);
    }
    scratch.prev.copy(scratch.anchorPos);
    hasPrev.current = true;

    const ratio = clamp(speed.current / maxSpeed, 0, 1);

    // ---- position ----
    const head = view === 'glass' ? scratch.glassHead : scratch.cockpitHead;
    localToWorldOffset(scratch.anchorPos, scratch.anchorQuat, head, scratch.headWorld);
    cam.position.lerp(scratch.headWorld, clamp(delta * 9, 0, 1));

    // ---- orientation (bank with the chassis up-vector) ----
    anchorForward(scratch.anchorQuat, scratch.forward);
    anchorUp(scratch.anchorQuat, scratch.up);
    scratch.look.copy(scratch.headWorld).addScaledVector(scratch.forward, 12);
    scratch.lookMat.lookAt(scratch.headWorld, scratch.look, scratch.up);
    scratch.desired.setFromRotationMatrix(scratch.lookMat);
    cam.quaternion.slerp(scratch.desired, clamp(delta * 9, 0, 1));

    // ---- speed feel: banked roll + vibration (reference Vehicle.tsx) ----
    const t = state.clock.elapsedTime;
    cam.rotateZ(Math.sin(t * 24) * ratio * 0.006 - ratio * 0.01);
    cam.rotateX(Math.sin(t * 31) * ratio * 0.0035);

    // ---- dynamic FOV on speed ----
    if (cam.isPerspectiveCamera) {
      cam.fov = damp(cam.fov, fov + ratio * 12, 4, delta);
      cam.updateProjectionMatrix();
    }

    // ---- publish ----
    sink.current.speed = speed.current;
  });

  return null;
}

/* -------------------------------------------------------------------------- */
/* Composite                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Drop-in cockpit. Render it as a child of the vehicle chassis group:
 *
 *   <group ref={chassisBody}>
 *     <ChassisVisual />
 *     <PilotCockpit view="cockpit" accent={accent} />
 *   </group>
 */
export function PilotCockpit({
  view = 'external',
  accent = '#12f7ff',
  glassTint = '#0a1a2a',
  driver = 'left',
  maxSpeed = 88,
  fov = 68,
  showHud = true,
  onTelemetry,
}: PilotCockpitProps) {
  const anchorRef = useRef<THREE.Group>(null);
  const telemetry = useRef<CockpitTelemetry>({ speed: 0, boost: 0, steer: 0 });
  const seatX = DRIVER_X[driver];

  // Mirror the shared telemetry ref into the optional external callback.
  useFrame(() => {
    if (onTelemetry) onTelemetry(telemetry.current);
  });

  return (
    <group name="pilot-cockpit">
      <CockpitTub accent={accent} />
      <CockpitCanopy accent={accent} glassTint={glassTint} />

      {/* Seat anchor: everything seated/aimed lives here, offset by the seat. */}
      <group ref={anchorRef} position={[seatX, 0, 0]} name="cockpit-seat">
        <PilotFigure accent={accent} />
        {showHud && <CockpitHUD accent={accent} telemetry={telemetry} maxSpeed={maxSpeed} />}
        {view !== 'external' && (
          <CockpitCamera
            anchorRef={anchorRef}
            view={view}
            maxSpeed={maxSpeed}
            fov={fov}
            telemetry={telemetry}
          />
        )}
      </group>
    </group>
  );
}

export default PilotCockpit;
