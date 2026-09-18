import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { getTrackProgress } from './Track';

export interface CarSpec {
  primary: string;
  secondary: string;
  accent: string;
  body: 'sleek' | 'wide' | 'compact';
  wing: 'high' | 'low' | 'twin';
  wheels: 'slick' | 'wet' | 'off-road';
  number: number;
  pattern: 'stripes' | 'solid' | 'gradient' | 'camo';
}

interface Props {
  name: string;
  spec: CarSpec;
  lane: number;
  progress: number;
  status: string;
}

// Размеры корпуса по типу
const BODY_DIMS = {
  sleek:   { length: 3.6, width: 0.9, height: 0.35 },
  wide:    { length: 3.2, width: 1.1, height: 0.40 },
  compact: { length: 3.0, width: 0.95, height: 0.32 },
};

// Размеры спойлера
const WING_DIMS = {
  low:  { width: 1.4, height: 0.15, y: 0.55 },
  high: { width: 1.5, height: 0.45, y: 0.65 },
  twin: { width: 1.6, height: 0.35, y: 0.60 },
};

export function F1Car({ name, spec, lane, progress, status }: Props) {
  const groupRef = useRef<THREE.Group>(null);
  const wheelsRef = useRef<THREE.Mesh[]>([]);

  const isFailed = status === 'failed';
  const isDone = status === 'done';

  // Стартовая позиция на кривой (progress нормируем в 0..1)
  const initialT = ((progress % 1) + 1) % 1;
  const initialPos = getTrackProgress(initialT);

  const dims = BODY_DIMS[spec.body];
  const wingDims = WING_DIMS[spec.wing];

  useFrame((state, delta) => {
    const group = groupRef.current;
    if (!group) return;

    const time = state.clock.getElapsedTime();

    // Движение по замкнутой кривой трассы (овал), а не по прямой
    const t = ((progress % 1) + 1) % 1;
    const pos = getTrackProgress(t);
    const ahead = getTrackProgress((t + 0.01) % 1);
    const dirX = ahead.x - pos.x;
    const dirZ = ahead.z - pos.z;
    const dirLen = Math.hypot(dirX, dirZ) || 1;
    // Нормаль к траектории — раскладываем болиды по ширине полотна (lane)
    const nx = -dirZ / dirLen;
    const nz = dirX / dirLen;
    const lateral = lane * 0.5;
    group.position.set(
      pos.x + nx * lateral,
      pos.y + 0.25 + Math.sin(time * 3) * 0.04,
      pos.z + nz * lateral,
    );
    // Нос болида смотрит по траектории. Модель «носом» в +X, поэтому −90°.
    group.rotation.y = Math.atan2(ahead.x - pos.x, ahead.z - pos.z) - Math.PI / 2;

    // Наклон при провале
    group.rotation.z = isFailed ? 0.3 : 0;

    // Пульсация при финише
    if (isDone) {
      group.scale.setScalar(1 + (Math.sin(time * 5) * 0.5 + 0.5) * 0.08);
    } else {
      group.scale.setScalar(1);
    }

    // Вращение колёс
    const spin = delta * 12 * (1 - THREE.MathUtils.clamp(progress, 0, 1));
    for (const w of wheelsRef.current) {
      if (w) w.rotation.x += spin;
    }
  });

  const emissiveIntensity = 0.25 + progress * 0.6;

  return (
    <group ref={groupRef} position={[initialPos.x, initialPos.y + 0.25, initialPos.z]}>
      {/* === КОРПУС === */}
      <mesh position={[0, 0, 0]} castShadow>
        <boxGeometry args={[dims.length, dims.height, dims.width]} />
        <meshStandardMaterial
          color={spec.primary}
          emissive={spec.primary}
          emissiveIntensity={emissiveIntensity * 0.3}
          metalness={0.7}
          roughness={0.3}
        />
      </mesh>

      {/* Носовой конус */}
      <mesh position={[dims.length / 2 + 0.15, 0, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <coneGeometry args={[0.22, 0.5, 8]} />
        <meshStandardMaterial
          color={spec.primary}
          metalness={0.8}
          roughness={0.2}
        />
      </mesh>

      {/* Кокпит */}
      <mesh position={[-0.4, dims.height / 2 + 0.08, 0]} castShadow>
        <sphereGeometry args={[0.22, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={spec.secondary} metalness={0.5} roughness={0.4} />
      </mesh>

      {/* Воздухозаборник над кокпитом */}
      <mesh position={[-0.4, dims.height / 2 + 0.35, 0]}>
        <boxGeometry args={[0.5, 0.35, 0.25]} />
        <meshStandardMaterial color={spec.primary} metalness={0.6} roughness={0.3} />
      </mesh>

      {/* Боковые понтоны */}
      <mesh position={[-0.3, 0, dims.width / 2 + 0.08]}>
        <boxGeometry args={[1.6, 0.3, 0.2]} />
        <meshStandardMaterial color={spec.secondary} metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh position={[-0.3, 0, -dims.width / 2 - 0.08]}>
        <boxGeometry args={[1.6, 0.3, 0.2]} />
        <meshStandardMaterial color={spec.secondary} metalness={0.6} roughness={0.4} />
      </mesh>

      {/* === ПЕРЕДНЕЕ КРЫЛО === */}
      <mesh position={[dims.length / 2 + 0.35, -0.15, 0]} castShadow>
        <boxGeometry args={[0.5, 0.05, dims.width + 0.4]} />
        <meshStandardMaterial
          color={spec.accent}
          emissive={spec.accent}
          emissiveIntensity={emissiveIntensity * 0.5}
          metalness={0.6}
          roughness={0.3}
        />
      </mesh>

      {/* === ЗАДНЕЕ АНТИКРЫЛО === */}
      <group position={[-dims.length / 2 - 0.1, wingDims.y, 0]}>
        <mesh castShadow>
          <boxGeometry args={[0.15, 0.05, wingDims.width]} />
          <meshStandardMaterial
            color={spec.accent}
            emissive={spec.accent}
            emissiveIntensity={emissiveIntensity * 0.5}
            metalness={0.7}
            roughness={0.3}
          />
        </mesh>
        {/* Стойки антикрыла */}
        <mesh position={[0, -wingDims.y / 2 + 0.1, 0.4]}>
          <boxGeometry args={[0.1, wingDims.y * 0.8, 0.06]} />
          <meshStandardMaterial color={spec.secondary} />
        </mesh>
        <mesh position={[0, -wingDims.y / 2 + 0.1, -0.4]}>
          <boxGeometry args={[0.1, wingDims.y * 0.8, 0.06]} />
          <meshStandardMaterial color={spec.secondary} />
        </mesh>
      </group>

      {/* === КОЛЁСА === */}
      {[
        [1.0, 0.18, dims.width / 2 + 0.15],   // FR
        [1.0, 0.18, -dims.width / 2 - 0.15],  // FL
        [-1.2, 0.18, dims.width / 2 + 0.18],  // RR
        [-1.2, 0.18, -dims.width / 2 - 0.18], // RL
      ].map((pos, i) => (
        <mesh
          key={i}
          ref={(el) => { if (el) wheelsRef.current[i] = el; }}
          position={[pos[0], pos[1] - 0.1, pos[2]]}
          rotation={[0, 0, Math.PI / 2]}
          castShadow
        >
          <cylinderGeometry args={[0.22, 0.22, 0.15, 16]} />
          <meshStandardMaterial color="#1a1a1a" metalness={0.3} roughness={0.8} />
        </mesh>
      ))}

      {/* === НОМЕР === */}
      <Text
        position={[0.6, dims.height / 2 + 0.05, dims.width / 2 + 0.02]}
        fontSize={0.15}
        color={spec.accent}
        anchorX="center"
        anchorY="middle"
      >
        {String(spec.number)}
      </Text>

      {/* === ПОЛОСА-ПАТТЕРН === */}
      {spec.pattern === 'stripes' && (
        <mesh position={[-0.3, dims.height / 2 + 0.01, 0]}>
          <boxGeometry args={[2.0, 0.02, 0.15]} />
          <meshStandardMaterial color={spec.accent} emissive={spec.accent} emissiveIntensity={0.5} />
        </mesh>
      )}

      {/* === ИМЯ === */}
      <Text
        position={[0, 1.0, 0]}
        fontSize={0.22}
        color={spec.primary}
        anchorX="center"
        anchorY="middle"
      >
        {name}
      </Text>
    </group>
  );
}

// Хелпер — получить spec агента из JSON (fallback если нет)
export function getCarSpec(agentName: string, avatars: any): CarSpec {
  const avatar = avatars?.avatars?.[agentName];
  if (avatar?.spec) return avatar.spec;

  // Fallback — динамический hash → HSL
  const hash = agentName.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue = hash % 360;
  return {
    primary: `hsl(${hue}, 80%, 60%)`,
    secondary: '#1a1a1a',
    accent: '#ffffff',
    body: 'sleek',
    wing: 'low',
    wheels: 'slick',
    number: hash % 99,
    pattern: 'solid',
  };
}
