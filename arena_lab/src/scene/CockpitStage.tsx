/**
 * CockpitStage.tsx — «Пилот за стеклом» / Pilot behind the glass · LIVE RIG
 * ============================================================================
 * FORMULA I1 · STAGE «Киберпанк-кар» · TASK 2.5 (integration layer)
 *
 * `PilotCockpit.tsx` ships the physical cockpit kit + onboard camera, but it is
 * authored as a child of a chassis group and expects *someone* to move that
 * chassis. This file is that someone: a fully self-contained, asset-free rig
 * that
 *
 *   1. carries a procedural cyberpunk car along a closed CatmullRom circuit
 *      (banked turns, elevation, constant ground speed);
 *   2. mounts `<PilotCockpit />` on the chassis anchor so the pilot sits behind
 *      the tinted bubble wearing a glowing visor;
 *   3. switches the onboard camera between EXTERNAL chase / COCKPIT POV /
 *      GLASS nose-cam with the `C` key, mirroring the three-mode camera of
 *      `research/racing-game/src/effects/Cameras.tsx` (MIT © 2021 pmndrs,
 *      audit.md TOP-3 #2).
 *
 * Drop it straight into the arena Canvas:
 *
 *   <CockpitStage accent="#12f7ff" />
 *
 * Zero GLTF, zero physics coupling, zero per-frame allocations.
 * ============================================================================
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { PilotCockpit } from './PilotCockpit';
import type { CockpitView } from './PilotCockpit';

const { clamp, damp } = THREE.MathUtils;

/* -------------------------------------------------------------------------- */
/* Track                                                                      */
/* -------------------------------------------------------------------------- */

const TRACK_POINTS: [number, number, number][] = [
  [0, 0, 62],
  [56, 1.5, 56],
  [82, 5, 0],
  [56, 1.5, -56],
  [0, 7, -82],
  [-56, 1.5, -56],
  [-82, 5, 0],
  [-56, 1.5, 56],
];

/** Scene-unit ground speed of the rig (≈ 108 km/h at car scale). */
const RIG_SPEED = 32;

const PYLON_COUNT = 48;

const VIEW_CYCLE: CockpitView[] = ['external', 'cockpit', 'glass'];

/* -------------------------------------------------------------------------- */
/* Vehicle shell (procedural, no assets)                                      */
/* -------------------------------------------------------------------------- */

function ChassisShell({ accent }: { accent: string }) {
  return (
    <group name="chassis-shell">
      {/* main tub */}
      <mesh position={[0, 0.45, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.9, 0.5, 4.6]} />
        <meshStandardMaterial color="#12151f" roughness={0.45} metalness={0.75} />
      </mesh>
      {/* nose wedge */}
      <mesh position={[0, 0.34, 2.6]} rotation={[0.18, 0, 0]} castShadow>
        <boxGeometry args={[1.7, 0.28, 1.0]} />
        <meshStandardMaterial color="#0b0e16" roughness={0.5} metalness={0.7} />
      </mesh>
      {/* rear diffuser */}
      <mesh position={[0, 0.32, -2.45]} castShadow>
        <boxGeometry args={[1.85, 0.34, 0.5]} />
        <meshStandardMaterial color="#0b0e16" roughness={0.55} metalness={0.65} />
      </mesh>
      {/* side neon sills */}
      {[-0.98, 0.98].map((x) => (
        <mesh key={`sill-${x}`} position={[x, 0.28, 0]}>
          <boxGeometry args={[0.04, 0.05, 4.0]} />
          <meshStandardMaterial color="#000000" emissive={accent} emissiveIntensity={2.2} toneMapped={false} />
        </mesh>
      ))}
      {/* wheels */}
      {(
        [
          [-0.95, 0.36, 1.45],
          [0.95, 0.36, 1.45],
          [-0.95, 0.36, -1.45],
          [0.95, 0.36, -1.45],
        ] as [number, number, number][]
      ).map((p, i) => (
        <mesh key={`wheel-${i}`} position={p} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[0.36, 0.36, 0.26, 20]} />
          <meshStandardMaterial color="#05070c" roughness={0.7} metalness={0.3} emissive={accent} emissiveIntensity={0.25} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Stage                                                                      */
/* -------------------------------------------------------------------------- */

export interface CockpitStageProps {
  /** Neon accent shared by car, cockpit and pylons. */
  accent?: string;
  /** Initial view mode. Defaults to `cockpit` (task 2.5 focus). */
  view?: CockpitView;
  /** Enable the `C` key to cycle views. Defaults to true. */
  interactive?: boolean;
}

export function CockpitStage({
  accent = '#12f7ff',
  view: initialView = 'cockpit',
  interactive = true,
}: CockpitStageProps) {
  const [view, setView] = useState<CockpitView>(initialView);
  const viewRef = useRef<CockpitView>(view);
  viewRef.current = view;

  const carrierRef = useRef<THREE.Group>(null);
  const progress = useRef(0);
  const bank = useRef(0);

  /* ---- circuit ---- */
  const curve = useMemo(
    () =>
      new THREE.CatmullRomCurve3(
        TRACK_POINTS.map((p) => new THREE.Vector3(...p)),
        true,
        'centripetal',
        0.5,
      ),
    [],
  );

  const trackLength = useMemo(() => curve.getLength(), [curve]);

  /* ---- pylon field for parallax / speed read ---- */
  const pylons = useMemo(() => {
    const list: { pos: THREE.Vector3; side: number }[] = [];
    for (let i = 0; i < PYLON_COUNT; i++) {
      const t = i / PYLON_COUNT;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t);
      const side = new THREE.Vector3(0, 1, 0).cross(tan).normalize();
      const sign = i % 2 === 0 ? 1 : -1;
      list.push({ pos: p.clone().addScaledVector(side, 5.4 * sign), side: sign });
    }
    return list;
  }, [curve]);

  const scratch = useMemo(
    () => ({
      pos: new THREE.Vector3(),
      ahead: new THREE.Vector3(),
      behind: new THREE.Vector3(),
      tangent: new THREE.Vector3(),
      prevTangent: new THREE.Vector3(0, 0, 1),
      up: new THREE.Vector3(0, 1, 0),
      xAxis: new THREE.Vector3(),
      yAxis: new THREE.Vector3(),
      zAxis: new THREE.Vector3(),
      mat: new THREE.Matrix4(),
      turn: new THREE.Vector3(),
      chasePos: new THREE.Vector3(),
      chaseLook: new THREE.Vector3(),
      offset: new THREE.Vector3(),
    }),
    [],
  );

  /* ---- keyboard: cycle views ---- */
  useEffect(() => {
    if (!interactive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyC') return;
      setView((v) => VIEW_CYCLE[(VIEW_CYCLE.indexOf(v) + 1) % VIEW_CYCLE.length]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [interactive]);

  /* ---- drive the carrier + external chase camera ---- */
  useFrame((state, delta) => {
    const carrier = carrierRef.current;
    if (!carrier) return;
    const dt = Math.min(delta, 0.05);

    // constant ground speed along the closed spline
    progress.current = (progress.current + (RIG_SPEED * dt) / trackLength) % 1;

    const t = progress.current;
    const eps = 0.0025;
    curve.getPointAt(t, scratch.pos);
    curve.getPointAt((t + eps) % 1, scratch.ahead);
    curve.getPointAt((t - eps + 1) % 1, scratch.behind);
    scratch.tangent.subVectors(scratch.ahead, scratch.behind).normalize();

    // orthonormal basis: +Z = forward (matches PilotCockpit.anchorForward)
    scratch.zAxis.copy(scratch.tangent);
    scratch.xAxis.crossVectors(scratch.up, scratch.zAxis).normalize();
    scratch.yAxis.crossVectors(scratch.zAxis, scratch.xAxis).normalize();
    scratch.mat.makeBasis(scratch.xAxis, scratch.yAxis, scratch.zAxis);

    carrier.position.copy(scratch.pos);
    carrier.quaternion.setFromRotationMatrix(scratch.mat);

    // bank into the turn (signed yaw rate from consecutive tangents)
    scratch.turn.crossVectors(scratch.prevTangent, scratch.tangent);
    const yawRate = scratch.turn.y / Math.max(dt, 1e-4);
    const targetBank = clamp(-yawRate * 0.09, -0.5, 0.5);
    bank.current = damp(bank.current, targetBank, 3, dt);
    carrier.rotateZ(bank.current);
    scratch.prevTangent.copy(scratch.tangent);

    // external chase camera (only while the onboard rig is detached)
    if (viewRef.current !== 'external') return;
    const cam = state.camera as THREE.PerspectiveCamera;
    scratch.offset.set(0, 2.6, -8.5); // local: behind (-Z) & above
    scratch.chasePos.copy(scratch.offset).applyQuaternion(carrier.quaternion).add(carrier.position);
    cam.position.lerp(scratch.chasePos, clamp(dt * 4, 0, 1));
    scratch.chaseLook.copy(scratch.pos).addScaledVector(scratch.zAxis, 8).setY(scratch.pos.y + 1);
    cam.lookAt(scratch.chaseLook);
  });

  return (
    <group name="cockpit-stage">
      {/* neon ground grid suggestion */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[320, 320]} />
        <meshStandardMaterial color="#05070d" roughness={1} metalness={0} />
      </mesh>

      {/* parallax pylons */}
      {pylons.map((p, i) => (
        <mesh key={`pylon-${i}`} position={[p.pos.x, p.pos.y + 2.2, p.pos.z]}>
          <boxGeometry args={[0.18, 4.4, 0.18]} />
          <meshStandardMaterial
            color="#000000"
            emissive={i % 3 === 0 ? '#ff2d6f' : accent}
            emissiveIntensity={2}
            toneMapped={false}
          />
        </mesh>
      ))}

      {/* the car: chassis shell + onboard cockpit rig */}
      <group ref={carrierRef} name="rig-carrier">
        <ChassisShell accent={accent} />
        <PilotCockpit view={view} accent={accent} driver="left" maxSpeed={RIG_SPEED * 1.15} />
      </group>
    </group>
  );
}

export default CockpitStage;
