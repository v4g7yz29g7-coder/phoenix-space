import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';

/* ============================================================================
 * ЗАДАЧА 6.4 — СОЗДАНИЕ АГЕНТА  (Formula I1 · Platform)
 * ----------------------------------------------------------------------------
 * 3D-аватар агента-пилота: живая фигура в комбинезоне команды, которая стоит
 * в паддоке/пит-боксе. Это «лицо» агента — дополняет AgentCube (болид на
 * трассе) и AgentDashboard (табло очков).
 *
 * Агент умеет:
 *   • дышать (idle-анимация торса без ре-рендеров);
 *   • поворачивать голову, осматриваясь, пока задача выполняется (running);
 *   • поднимать руку и победно пульсировать на финише (done);
 *   • поникать и мигать красным при провале (failed);
 *   • отображать светящееся кольцо статуса и дугу прогресса на полу;
 *   • показывать номер на груди, имя и счёт на плавающей табличке.
 *
 * Приёмы взяты из research/racing-game (MIT):
 *   - src/models/vehicle/Vehicle.tsx — вся анимация через мутацию refs в
 *     useFrame (position/rotation/scale), без ре-рендеров React;
 *   - src/effects/Dust.tsx, Skid.tsx   — дешёвые emissive/прозрачные акценты
 *     и instanced-подобная экономия материалов;
 *   - src/ui/Checkpoint.tsx            — цветовой код состояния зелёный/красный.
 * Реализация собственная, в терминах проекта AI-1.
 * ========================================================================== */

export type AgentStatus = 'idle' | 'running' | 'done' | 'failed';

/** Цветовой код состояния агента (единый для кольца, визора и таблички). */
export const AGENT_STATUS_COLOR: Record<AgentStatus, string> = {
  idle: '#7d8597',
  running: '#facc15',
  done: '#22c55e',
  failed: '#ef4444',
};

const SKIN = '#e8b98a';
const DARK = '#1b2130';

interface AgentAvatarProps {
  /** Имя агента (например agent_7). */
  name: string;
  /** Командный цвет комбинезона. */
  color: string;
  /** Текущее состояние задачи. */
  status?: AgentStatus;
  /** Прогресс 0..1 — рисуется дугой на полу и на табличке. */
  progress?: number;
  /** Накопленный счёт агента. */
  score?: number;
  /** Позиция в мире. */
  position?: [number, number, number];
  /** Поворот вокруг Y (куда смотрит агент). */
  facing?: number;
  /** Общий масштаб фигуры. */
  scale?: number;
  /** Показывать плавающую табличку с именем/счётом. */
  showTag?: boolean;
}

/**
 * Один 3D-агент. Компонент полностью управляется props — удобно для
 * отдельного использования, тестов и снапшотов с сервера.
 */
export function AgentAvatar({
  name,
  color,
  status = 'idle',
  progress = 0,
  score = 0,
  position = [0, 0, 0],
  facing = 0,
  scale = 1,
  showTag = true,
}: AgentAvatarProps) {
  const root = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Mesh>(null);
  const head = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const visor = useRef<THREE.MeshStandardMaterial>(null);
  const ring = useRef<THREE.Mesh>(null);
  const progressArc = useRef<THREE.Mesh>(null);

  const clamped = THREE.MathUtils.clamp(progress, 0, 1);
  const stateColor = AGENT_STATUS_COLOR[status] ?? AGENT_STATUS_COLOR.idle;
  const isRunning = status === 'running';
  const isDone = status === 'done';
  const isFailed = status === 'failed';

  // Цвета аватара: комбинезон — командный, тёмные элементы — базовая экипировка.
  const suitMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color, metalness: 0.25, roughness: 0.55, emissive: color, emissiveIntensity: 0.12 }),
    [color],
  );
  const darkMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: DARK, metalness: 0.4, roughness: 0.7 }),
    [],
  );
  const skinMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.9 }),
    [],
  );

  // Дуга прогресса: пересобирается только при изменении прогресса.
  const arc = Math.max(0.0001, clamped * Math.PI * 2);
  const arcGeo = useMemo(() => new THREE.TorusGeometry(0.62, 0.045, 8, 48, arc), [arc]);

  useFrame((ctx, dt) => {
    const t = ctx.clock.getElapsedTime();
    const g = root.current;
    if (!g) return;

    // — Дыхание: лёгкое покачивание корпуса и вертикальный «bob».
    const breath = Math.sin(t * (isRunning ? 3.2 : 1.4));
    g.position.y = position[1] + breath * 0.025;
    if (torso.current) {
      torso.current.scale.y = 1 + breath * 0.012;
      torso.current.scale.x = 1 - breath * 0.008;
      torso.current.scale.z = 1 - breath * 0.008;
    }

    // — Наклон: провал — поникший агент, финиш — грудь вперёд.
    const targetPitch = isFailed ? 0.34 : isDone ? -0.08 : 0;
    g.rotation.x = THREE.MathUtils.lerp(g.rotation.x, targetPitch, Math.min(1, dt * 4));

    // — Голова: осматривается на running, кивает на done, опущена на failed.
    const targetYaw = isRunning ? Math.sin(t * 1.1) * 0.5 : Math.sin(t * 0.6) * 0.08;
    const targetNod = isFailed ? 0.5 : isDone ? -0.15 : 0;
    if (head.current) {
      head.current.rotation.y = THREE.MathUtils.lerp(head.current.rotation.y, targetYaw, Math.min(1, dt * 3));
      head.current.rotation.x = THREE.MathUtils.lerp(head.current.rotation.x, targetNod, Math.min(1, dt * 3));
    }

    // — Правая рука: победный салют на финише, иначе лёгкое покачивание.
    if (armR.current) {
      const targetArm = isDone ? -2.5 + Math.sin(t * 6) * 0.12 : Math.sin(t * 1.3) * 0.06;
      armR.current.rotation.z = THREE.MathUtils.lerp(armR.current.rotation.z, targetArm, Math.min(1, dt * 4));
    }

    // — Визор: пульсирующее свечение активного («живого») агента.
    if (visor.current) {
      const base = isFailed ? 0.25 : isDone ? 1.4 : 0.5;
      const pulse = isRunning ? 0.6 + Math.sin(t * 5) * 0.4 : 0;
      visor.current.emissiveIntensity = base + pulse;
      visor.current.color.set(stateColor);
      visor.current.emissive.set(stateColor);
    }

    // — Кольцо статуса: вращается, пока задача выполняется.
    if (ring.current) {
      ring.current.rotation.z += dt * (isRunning ? 1.4 : 0.15);
    }

    // — Дуга прогресса всегда горизонтальна и смотрит вверх.
    if (progressArc.current) {
      progressArc.current.rotation.x = -Math.PI / 2;
    }
  });

  const torsoBaseY = 1.02;
  const hipY = 0.72;

  return (
    <group ref={root} position={position} rotation={[0, facing, 0]} scale={scale}>
      {/* ── Кольцо статуса на полу ─────────────────────────────────── */}
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[0.72, 0.82, 48]} />
        <meshBasicMaterial color={stateColor} transparent opacity={0.55} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>

      {/* ── Дуга прогресса на полу ─────────────────────────────────── */}
      <mesh ref={progressArc} geometry={arcGeo} position={[0, 0.03, 0]}>
        <meshStandardMaterial color={stateColor} emissive={color} emissiveIntensity={1.1} />
      </mesh>

      {/* ── Ноги + ботинки ─────────────────────────────────────────── */}
      <mesh position={[-0.14, hipY / 2, 0]} material={darkMat} castShadow>
        <boxGeometry args={[0.2, hipY, 0.24]} />
      </mesh>
      <mesh position={[0.14, hipY / 2, 0]} material={darkMat} castShadow>
        <boxGeometry args={[0.2, hipY, 0.24]} />
      </mesh>
      <mesh position={[-0.14, 0.06, 0.05]} material={darkMat} castShadow>
        <boxGeometry args={[0.22, 0.12, 0.4]} />
      </mesh>
      <mesh position={[0.14, 0.06, 0.05]} material={darkMat} castShadow>
        <boxGeometry args={[0.22, 0.12, 0.4]} />
      </mesh>

      {/* ── Тас + корпус ───────────────────────────────────────────── */}
      <mesh position={[0, hipY + 0.06, 0]} material={darkMat} castShadow>
        <boxGeometry args={[0.46, 0.2, 0.28]} />
      </mesh>

      {/* ── Торс (комбинезон) ──────────────────────────────────────── */}
      <mesh ref={torso} position={[0, torsoBaseY, 0]} material={suitMat} castShadow>
        <boxGeometry args={[0.52, 0.62, 0.3]} />
      </mesh>

      {/* Командная полоса + номер на груди */}
      <mesh position={[0, torsoBaseY + 0.14, 0.16]} material={darkMat}>
        <boxGeometry args={[0.54, 0.07, 0.02]} />
      </mesh>
      <Text position={[0, torsoBaseY - 0.08, 0.17]} fontSize={0.2} color="#eaf3ff" anchorX="center" anchorY="middle">
        {`#${name.replace(/[^0-9]/g, '') || '1'}`}
      </Text>

      {/* Плечи */}
      <mesh position={[-0.32, torsoBaseY + 0.24, 0]} material={suitMat} castShadow>
        <sphereGeometry args={[0.14, 16, 16]} />
      </mesh>
      <mesh position={[0.32, torsoBaseY + 0.24, 0]} material={suitMat} castShadow>
        <sphereGeometry args={[0.14, 16, 16]} />
      </mesh>

      {/* ── Левая рука (опущена) ───────────────────────────────────── */}
      <mesh position={[-0.34, torsoBaseY - 0.12, 0]} material={suitMat} castShadow>
        <boxGeometry args={[0.14, 0.5, 0.16]} />
      </mesh>
      <mesh position={[-0.34, torsoBaseY - 0.4, 0]} material={darkMat} castShadow>
        <sphereGeometry args={[0.09, 12, 12]} />
      </mesh>

      {/* ── Правая рука (анимированная группа) ─────────────────────── */}
      <group ref={armR} position={[0.34, torsoBaseY + 0.2, 0]}>
        <mesh position={[0, -0.26, 0]} material={suitMat} castShadow>
          <boxGeometry args={[0.14, 0.5, 0.16]} />
        </mesh>
        <mesh position={[0, -0.54, 0]} material={darkMat} castShadow>
          <sphereGeometry args={[0.09, 12, 12]} />
        </mesh>
      </group>

      {/* ── Шея ────────────────────────────────────────────────────── */}
      <mesh position={[0, torsoBaseY + 0.34, 0]} material={skinMat}>
        <cylinderGeometry args={[0.09, 0.1, 0.12, 12]} />
      </mesh>

      {/* ── Голова + шлем (анимированная группа) ───────────────────── */}
      <group ref={head} position={[0, torsoBaseY + 0.48, 0]}>
        <mesh material={skinMat} castShadow>
          <sphereGeometry args={[0.17, 20, 20]} />
        </mesh>
        {/* Шлем-оболочка командного цвета */}
        <mesh position={[0, 0.04, -0.03]} material={suitMat} castShadow>
          <sphereGeometry args={[0.205, 20, 20, 0, Math.PI * 2, 0, Math.PI * 0.66]} />
        </mesh>
        {/* Визор со статусным свечением */}
        <mesh position={[0, 0.0, 0.15]} rotation={[0, 0, 0]}>
          <sphereGeometry args={[0.135, 20, 20, 0, Math.PI, Math.PI * 0.15, Math.PI * 0.45]} />
          <meshStandardMaterial
            ref={visor}
            color={stateColor}
            emissive={stateColor}
            emissiveIntensity={0.6}
            metalness={0.9}
            roughness={0.1}
            transparent
            opacity={0.92}
          />
        </mesh>
        {/* Гребень на шлеме — командный акцент */}
        <mesh position={[0, 0.2, -0.02]} material={suitMat} castShadow>
          <boxGeometry args={[0.05, 0.1, 0.32]} />
        </mesh>
      </group>

      {/* ── Плавающая табличка: имя · статус · очки ────────────────── */}
      {showTag && (
        <group position={[0, torsoBaseY + 1.15, 0]}>
          <mesh position={[0, 0.02, -0.01]}>
            <planeGeometry args={[1.5, 0.5]} />
            <meshBasicMaterial color="#0b1020" transparent opacity={0.55} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
          <Text position={[0, 0.12, 0]} fontSize={0.17} color="#eaf3ff" anchorX="center" anchorY="middle">
            {name}
          </Text>
          <Text position={[-0.45, -0.12, 0]} fontSize={0.13} color={stateColor} anchorX="left" anchorY="middle">
            {status.toUpperCase()}
          </Text>
          <Text position={[0.45, -0.12, 0]} fontSize={0.13} color="#ffd700" anchorX="right" anchorY="middle">
            {`${Math.round(clamped * 100)}% · ${score}`}
          </Text>
        </group>
      )}
    </group>
  );
}

export default AgentAvatar;
