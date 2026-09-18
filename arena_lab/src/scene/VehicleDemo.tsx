/**
 * VehicleDemo.tsx — drop-in showcase for the cyberpunk cannon-es vehicle.
 *
 * Pairs with `./Vehicle.tsx` (ported from pmndrs/racing-game, MIT) and proves
 * the port is usable end-to-end: a <Physics> world, a static ground plane, the
 * <CyberpunkVehicle /> raycast vehicle and a live telemetry HUD.
 *
 * Usage anywhere:
 *   <VehicleDemo />                       // full Canvas + world (batteries included)
 *   <VehicleScene />                      // world only — put inside your own Canvas
 */
import { useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import type { Mesh } from 'three';
import { Physics, usePlane } from '@react-three/cannon';
import { CyberpunkVehicle, type VehicleInput, type VehicleTelemetry } from './Vehicle';

/* -------------------------------------------------------------------------- */
/* Static ground                                                               */
/* -------------------------------------------------------------------------- */

function Ground() {
  const [ref] = usePlane<Mesh>(() => ({ rotation: [-Math.PI / 2, 0, 0] }));
  return (
    <mesh ref={ref} receiveShadow>
      <planeGeometry args={[600, 600]} />
      <meshStandardMaterial color="#0a0a12" roughness={0.9} metalness={0.1} />
    </mesh>
  );
}

/* -------------------------------------------------------------------------- */
/* World (put this inside your own <Canvas>)                                   */
/* -------------------------------------------------------------------------- */

export interface VehicleSceneProps {
  /** Body paint color. */
  color?: string;
  /** Neon accent (underglow, strips, wheels). */
  accent?: string;
  /** Drive the default camera as a chase cam (lerp + sway + vibration). */
  chaseCamera?: boolean;
  /** Forward live telemetry to a HUD / minimap / socket. */
  onTelemetry?: (t: VehicleTelemetry) => void;
  /** Optional external input ref (e.g. driven by an AI or gamepad). */
  controlsRef?: React.MutableRefObject<VehicleInput>;
}

export function VehicleScene({
  color = '#1b1f2e',
  accent = '#12f7ff',
  chaseCamera = true,
  onTelemetry,
  controlsRef,
}: VehicleSceneProps) {
  return (
    <Physics
      gravity={[0, -9.81, 0]}
      defaultContactMaterial={{ friction: 0.5, restitution: 0.05 }}
      allowSleep
    >
      <ambientLight intensity={0.25} />
      <directionalLight position={[20, 30, 10]} intensity={1.2} castShadow />
      <pointLight position={[0, 6, -8]} color="#ff1e56" intensity={20} distance={40} />
      <Ground />
      <CyberpunkVehicle
        position={[0, 1.2, 0]}
        color={color}
        accent={accent}
        chaseCamera={chaseCamera}
        onTelemetry={onTelemetry}
        controlsRef={controlsRef}
      />
    </Physics>
  );
}

/* -------------------------------------------------------------------------- */
/* Self-contained demo: Canvas + scene + HUD overlay                           */
/* -------------------------------------------------------------------------- */

export function VehicleDemo() {
  const [telemetry, setTelemetry] = useState<VehicleTelemetry>({ speed: 0, boost: 100, sliding: false });
  const input = useRef<VehicleInput>({
    forward: false,
    backward: false,
    left: false,
    right: false,
    brake: false,
    boost: false,
  });

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#05060a' }}>
      <Canvas shadows camera={{ position: [0, 4, 10], fov: 55 }}>
        <color attach="background" args={['#05060a']} />
        <fog attach="fog" args={['#05060a', 30, 160]} />
        <VehicleScene onTelemetry={setTelemetry} controlsRef={input} />
      </Canvas>

      {/* Minimal cyberpunk HUD — keyboard driven (WASD / arrows / Space / Shift). */}
      <div
        style={{
          position: 'absolute',
          left: 16,
          bottom: 16,
          padding: '10px 14px',
          border: '1px solid rgba(18,247,255,0.5)',
          borderRadius: 8,
          background: 'rgba(5,6,10,0.65)',
          color: '#12f7ff',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 13,
          lineHeight: 1.6,
          textShadow: '0 0 8px rgba(18,247,255,0.6)',
          pointerEvents: 'none',
        }}
      >
        <div>SPEED {Math.round(telemetry.speed * 3.6)} km/h</div>
        <div>BOOST {Math.round(telemetry.boost)}%</div>
        <div style={{ color: telemetry.sliding ? '#ff1e56' : '#12f7ff' }}>
          {telemetry.sliding ? 'DRIFT' : 'GRIP'}
        </div>
      </div>
    </div>
  );
}

export default VehicleDemo;
