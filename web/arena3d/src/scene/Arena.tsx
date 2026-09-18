import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Stars } from '@react-three/drei';
import type { PointLight } from 'three';
import { useArena } from '../store/arena';
import { F1Car, getCarSpec } from './F1Car';
import { Track } from './Track';
import { Tribunes } from './Tribunes';
import agentAvatars from '../data/agent_avatars.json';

export function Arena() {
  const agents = useArena((s) => s.agents);
  const list = Object.values(agents);
  const count = list.length;
  const laneSpacing = 1.8;
  const startLane = -((count - 1) * laneSpacing) / 2;

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

      <fog attach="fog" args={['#0a0e1a', 40, 120]} />

      <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />

      {/* Трасса FORMULA I1 */}
      <Track />
      
      {/* Трибуны с 10 000 зрителей */}
      <Tribunes />

      {list.map((a, i) => (
        <F1Car
          key={a.name}
          name={a.name}
          spec={getCarSpec(a.name, agentAvatars)}
          lane={startLane + i * laneSpacing}
          progress={a.progress}
          status={a.status}
        />
      ))}
    </>
  );
}
