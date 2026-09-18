/**
 * Vehicle.tsx — Cyberpunk racing car (cannon-es RaycastVehicle)
 *
 * Ported & re-themed from pmndrs/racing-game (`src/models/vehicle/Vehicle.tsx`,
 * MIT © 2021 pmndrs/contributors — see research/racing-game/LICENSE.md).
 *
 * Differences from the reference port:
 *  - self-contained: no zustand store, no audio, no GLTF assets required;
 *  - fully procedural "cyberpunk" body + neon wheels (drop-in, zero assets);
 *  - keyboard controls (WASD / arrows / Space / Shift) with an optional
 *    externally controlled `VehicleInput` ref;
 *  - optional speed-scaled chase camera (`chaseCamera`) that lerps the default
 *    camera behind the chassis and adds sway/vibration — this is the
 *    "camera feel" technique recommended by research/audit.md (TOP-3 #2).
 *
 * Drop it inside a <Physics> tree (cannon-es):
 *   <Physics><CyberpunkVehicle position={[0, 1, 0]} /></Physics>
 */
import { createRef, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { MutableRefObject, Ref } from 'react';
import { MathUtils, Vector3, type Group } from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useBox, useRaycastVehicle } from '@react-three/cannon';
import type { RaycastVehicleProps, Triplet, WheelInfoOptions } from '@react-three/cannon';

import { ChassisVisual, CHASSIS_ARGS, CHASSIS_MASS } from './Chassis';
import { Wheel, WHEEL_INFO } from './Wheel';

// Single source of truth lives in `./Chassis` and `./Wheel`. Re-export here so
// historical imports of `Wheel` / `WHEEL_INFO` / `CHASSIS_ARGS` / `CHASSIS_MASS`
// from this module keep working.
export { Wheel, WHEEL_INFO, CHASSIS_ARGS, CHASSIS_MASS };

const { lerp } = MathUtils;

/* -------------------------------------------------------------------------- */
/* Tunables (mirrors research/racing-game/src/store.ts)                       */
/* -------------------------------------------------------------------------- */

export const VEHICLE_CONFIG = {
  /** half-track (lateral wheel offset) */
  width: 1.7,
  /** vertical wheel connection point relative to chassis origin */
  height: -0.3,
  /** forward axle offset */
  front: 1.35,
  /** rear axle offset */
  back: -1.3,
  /** max steer angle (rad) */
  steer: 0.3,
  /** engine force */
  force: 1800,
  /** max braking force */
  maxBrake: 65,
  /** soft speed cap used to cut engine force */
  maxSpeed: 88,
} as const;

/** Length of the boost tank (units consumed per frame while boosting). */
export const MAX_BOOST = 100;

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

export interface VehicleInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  brake: boolean;
  boost: boolean;
}

const NEUTRAL_INPUT: VehicleInput = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  brake: false,
  boost: false,
};

const KEY_MAP: Record<string, keyof VehicleInput> = {
  arrowup: 'forward',
  w: 'forward',
  z: 'forward',
  arrowdown: 'backward',
  s: 'backward',
  arrowleft: 'left',
  a: 'left',
  q: 'left',
  arrowright: 'right',
  d: 'right',
  e: 'right',
  ' ': 'brake',
  shift: 'boost',
};

/** Reads the keyboard and writes into `target` (WASD / arrows / Space / Shift). */
export function useVehicleKeyboard(target: MutableRefObject<VehicleInput>): void {
  useEffect(() => {
    const set = (e: KeyboardEvent, value: boolean) => {
      const action = KEY_MAP[e.key.toLowerCase()];
      if (!action) return;
      target.current[action] = value;
      // Avoid scrolling the page with arrows / space while driving.
      if (action !== 'boost') e.preventDefault();
    };
    const onDown = (e: KeyboardEvent) => set(e, true);
    const onUp = (e: KeyboardEvent) => set(e, false);
    const onBlur = () => Object.assign(target.current, NEUTRAL_INPUT);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [target]);
}

/* -------------------------------------------------------------------------- */
/* Vehicle                                                                     */
/* -------------------------------------------------------------------------- */

// `Wheel` is the ported component from `./Wheel` (imported above and re-exported
// for backwards compatibility). Do not redefine it here — the local duplicate
// used to clash with the import (TS2440 / TS2323).

/** Live telemetry pushed out every frame (for HUD / minimap consumers). */
export interface VehicleTelemetry {
  speed: number;
  boost: number;
  sliding: boolean;
}

export interface CyberpunkVehicleProps {
  position?: Triplet;
  rotation?: Triplet;
  angularVelocity?: Triplet;
  /** Body paint color. */
  color?: string;
  /** Neon accent used for underglow / strips / wheels. */
  accent?: string;
  /**
   * Optional external input ref. If omitted the vehicle reads the keyboard
   * itself (WASD / arrows / Space / Shift).
   */
  controlsRef?: MutableRefObject<VehicleInput>;
  /**
   * When true, drives the default R3F camera as a speed-scaled chase cam
   * (lerp + sway + vibration, ported from the reference Vehicle.tsx).
   * Defaults to false so it never fights a scene-level camera director.
   */
  chaseCamera?: boolean;
  /** Optional per-frame telemetry callback. */
  onTelemetry?: (t: VehicleTelemetry) => void;
}

export function CyberpunkVehicle({
  position = [0, 0.75, 0],
  rotation = [0, 0, 0],
  angularVelocity = [0, 0, 0],
  color = '#1b1f2e',
  accent = '#12f7ff',
  controlsRef,
  chaseCamera = false,
  onTelemetry,
}: CyberpunkVehicleProps) {
  const { width, height, front, back, steer, force, maxBrake, maxSpeed } = VEHICLE_CONFIG;
  const defaultCamera = useThree((state) => state.camera);

  /* -------- input ------------------------------------------------------- */
  const localInput = useRef<VehicleInput>({ ...NEUTRAL_INPUT });
  useVehicleKeyboard(localInput);
  const input = controlsRef ?? localInput;

  /* -------- physics bodies --------------------------------------------- */
  const [chassisBody, chassisApi] = useBox<Group>(
    () => ({
      mass: CHASSIS_MASS,
      args: CHASSIS_ARGS,
      position,
      rotation,
      angularVelocity,
      allowSleep: false,
    }),
    undefined,
    [],
  );

  const wheels = useMemo(
    () => [createRef<Group>(), createRef<Group>(), createRef<Group>(), createRef<Group>()],
    [],
  );

  const wheelInfos = useMemo<WheelInfoOptions[]>(
    () =>
      wheels.map((_, index) => {
        const isFrontWheel = index < 2;
        const sideMulti = index % 2 === 0 ? -0.5 : 0.5;
        return {
          ...WHEEL_INFO,
          chassisConnectionPointLocal: [width * sideMulti, height, isFrontWheel ? front : back] as Triplet,
          isFrontWheel,
        };
      }),
    [wheels, width, height, front, back],
  );

  const raycast = useMemo<RaycastVehicleProps>(
    () => ({ chassisBody, wheels, wheelInfos }),
    [chassisBody, wheels, wheelInfos],
  );

  const [, vehicleApi] = useRaycastVehicle(() => raycast, undefined, [raycast]);

  /* -------- telemetry --------------------------------------------------- */
  const speed = useRef(0);
  const sliding = useRef(false);
  const bodyVisual = useRef<Group>(null);

  // Scratch vectors reused every frame (no per-frame allocations).
  const cameraOffset = useRef(new Vector3());
  const cameraLookAt = useRef(new Vector3());

  useLayoutEffect(
    () => chassisApi.velocity.subscribe((v) => (speed.current = Math.hypot(v[0], v[1], v[2]))),
    [chassisApi],
  );
  useLayoutEffect(() => vehicleApi.sliding.subscribe((s) => (sliding.current = s)), [vehicleApi]);

  /* -------- per-frame driving ------------------------------------------- */
  const engineValue = useRef(0);
  const steeringValue = useRef(0);
  const boost = useRef(MAX_BOOST);

  useFrame((state, delta) => {
    const controls = input.current;
    const isBoosting = controls.boost && boost.current > 0;
    if (isBoosting) boost.current = Math.max(boost.current - 1, 0);
    else boost.current = Math.min(boost.current + 0.35, MAX_BOOST);

    const throttle =
      controls.forward || controls.backward
        ? force * (controls.forward && !controls.backward ? (isBoosting ? -1.5 : -1) : 1)
        : 0;
    engineValue.current = lerp(engineValue.current, throttle, delta * 20);
    steeringValue.current = lerp(
      steeringValue.current,
      controls.left || controls.right ? steer * (controls.left && !controls.right ? 1 : -1) : 0,
      delta * 20,
    );

    const capped = speed.current < maxSpeed ? engineValue.current : 0;
    for (let i = 2; i < 4; i++) vehicleApi.applyEngineForce(capped, i);
    for (let i = 0; i < 2; i++) vehicleApi.setSteeringValue(steeringValue.current, i);
    for (let i = 2; i < 4; i++) vehicleApi.setBrake(controls.brake ? maxBrake : 0, i);

    const t = state.clock.elapsedTime;
    const ratio = Math.min(speed.current / maxSpeed, 1);

    // Cyberpunk feel: chassis leans in corners + subtle vibration.
    if (bodyVisual.current) {
      bodyVisual.current.rotation.z = lerp(
        bodyVisual.current.rotation.z,
        (-steeringValue.current * speed.current) / 200,
        delta * 4,
      );
      bodyVisual.current.rotation.x = (Math.sin(t * 20) * ratio) / 100;
      bodyVisual.current.rotation.y = Math.cos(t * 20) * ratio * 0.01;
    }

    // Optional speed-scaled chase camera (reference Vehicle.tsx camera block).
    if (chaseCamera && chassisBody.current) {
      cameraOffset.current.set(
        (Math.sin(steeringValue.current) * speed.current) / 2.5,
        1.25 + (engineValue.current / 1000) * -0.5,
        -5 - speed.current / 15 + (controls.brake ? 1 : 0),
      );
      chassisBody.current.localToWorld(cameraOffset.current);
      defaultCamera.position.lerp(cameraOffset.current, Math.min(delta * 4, 1));

      // Aim slightly ahead of the car so the horizon stays stable.
      cameraLookAt.current.set(0, 0.4, 2.5);
      chassisBody.current.localToWorld(cameraLookAt.current);
      defaultCamera.lookAt(cameraLookAt.current);

      // Camera sway / vibration (scaled by speed, stronger while boosting).
      const swaySpeed = isBoosting ? 60 : 30;
      const swayValue = (isBoosting ? ratio + 0.25 : ratio) * (isBoosting ? 30 : 2);
      defaultCamera.rotation.z += (Math.sin(t * swaySpeed * 0.9) / 1000) * swayValue;
      defaultCamera.rotation.x += (Math.sin(t * swaySpeed) / 1000) * swayValue;
    }

    onTelemetry?.({ speed: speed.current, boost: boost.current, sliding: sliding.current });
  });

  /* -------- render ------------------------------------------------------ */
  return (
    <group>
      <group ref={chassisBody as unknown as Ref<Group>} dispose={null}>
        <group ref={bodyVisual} position={[0, -0.2, -0.2]}>
          {/* Ported cyberpunk body (see ./Chassis.tsx). Authored at the origin;
              `bodyVisual` owns the lean/vibration transform applied in useFrame. */}
          <ChassisVisual color={color} accent={accent} />
        </group>
      </group>

      {wheels.map((wheel, index) => (
        <Wheel key={index} ref={wheel} leftSide={index % 2 === 0} radius={WHEEL_INFO.radius ?? 0.38} accent={accent} />
      ))}

      {/* telemetry marker for debugging / HUD consumers */}
      <group userData={{ sliding: sliding.current, accent }} />
    </group>
  );
}

export default CyberpunkVehicle;
