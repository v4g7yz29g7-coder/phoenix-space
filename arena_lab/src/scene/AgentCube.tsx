import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';

interface Props {
  name: string;
  color: string;
  lane: number;
  progress: number;
  status: string;
}

/**
 * 3D-болид Формулы-1 (вместо куба).
 * Все меши собраны внутри <group ref={groupRef}> и двигаются по трассе.
 */
export function AgentCube({ name, color, lane, progress, status }: Props) {
  const groupRef = useRef<THREE.Group>(null);
  const wheelFL = useRef<THREE.Mesh>(null);
  const wheelFR = useRef<THREE.Mesh>(null);
  const wheelRL = useRef<THREE.Mesh>(null);
  const wheelRR = useRef<THREE.Mesh>(null);

  const targetX = -20 + progress * 40;
  const isFailed = status === 'failed';
  const isDone = status === 'done';

  useFrame((state, delta) => {
    const group = groupRef.current;
    if (!group) return;

    const time = state.clock.getElapsedTime();

    // движение к целевой позиции + лёгкое покачивание
    group.position.x = THREE.MathUtils.lerp(group.position.x, targetX, delta * 3);
    group.position.y = 0.3 + Math.sin(time * 3) * 0.05;
    group.position.z = lane;

    // провал — наклон болида
    group.rotation.z = isFailed ? 0.3 : 0;

    // финиш — пульсация по вертикали между 1.0 и 1.1
    if (isDone) {
      group.scale.set(1, 1 + (Math.sin(time * 5) * 0.5 + 0.5) * 0.1, 1);
    } else {
      group.scale.set(1, 1, 1);
    }

    // вращение колёс, замедляется при progress → 1
    const spin = delta * 10 * (1 - THREE.MathUtils.clamp(progress, 0, 1));
    for (const wheel of [wheelFL, wheelFR, wheelRL, wheelRR]) {
      if (wheel.current) wheel.current.rotation.x += spin;
    }
  });

  const emissiveIntensity = 0.3 + progress * 0.8;

  const bodyMaterial = (
    <meshStandardMaterial
      color={color}
      emissive={color}
      emissiveIntensity={emissiveIntensity}
      metalness={0.6}
      roughness={0.3}
    />
  );

  const wheelMaterial = (
    <meshStandardMaterial color="#111" metalness={0.4} roughness={0.7} />
  );

  return (
    <group ref={groupRef} position={[targetX, 0.3, lane]}>
      {/* Корпус болида — плоский, вытянутый */}
      <mesh position={[0, 0.4, 0]} castShadow>
        <boxGeometry args={[1.2, 0.3, 0.5]} />
        {bodyMaterial}
      </mesh>

      {/* Кокпит — сверху корпуса */}
      <mesh position={[0.1, 0.6, 0]} castShadow>
        <sphereGeometry args={[0.2, 16, 16]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={emissiveIntensity + 0.3}
          metalness={0.9}
          roughness={0.1}
        />
      </mesh>

      {/* Носовая часть — впереди, повёрнута горизонтально */}
      <mesh position={[0.85, 0.4, 0]} rotation={[0, 0, -Math.PI / 2]} castShadow>
        <coneGeometry args={[0.15, 0.5, 8]} />
        {bodyMaterial}
      </mesh>

      {/* Антикрыло — сзади */}
      <mesh position={[-0.6, 0.75, 0]} castShadow>
        <boxGeometry args={[0.1, 0.4, 0.6]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={emissiveIntensity}
          metalness={0.6}
          roughness={0.3}
        />
      </mesh>

      {/* Колёса — 4 штуки */}
      <mesh ref={wheelFL} position={[0.5, 0.15, 0.35]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.15, 0.15, 0.1, 16]} />
        {wheelMaterial}
      </mesh>
      <mesh ref={wheelFR} position={[0.5, 0.15, -0.35]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.15, 0.15, 0.1, 16]} />
        {wheelMaterial}
      </mesh>
      <mesh ref={wheelRL} position={[-0.4, 0.15, 0.35]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.15, 0.15, 0.1, 16]} />
        {wheelMaterial}
      </mesh>
      <mesh ref={wheelRR} position={[-0.4, 0.15, -0.35]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.15, 0.15, 0.1, 16]} />
        {wheelMaterial}
      </mesh>

      {/* Шлейф — светящийся хвост при движении */}
      {progress > 0.1 && (
        <mesh position={[-0.7 - progress * 0.5, 0.4, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.05, 0.05, progress * 2, 8]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={1.5}
            transparent
            opacity={progress}
          />
        </mesh>
      )}

      <Text
        position={[0, 1.5, 0]}
        fontSize={0.3}
        color="#e0e6f0"
        anchorX="center"
        anchorY="middle"
      >
        {name}
      </Text>
    </group>
  );
}
