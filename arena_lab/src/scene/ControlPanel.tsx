import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { useArena } from '../store/arena';
import { TV_CAMERAS } from '../hooks/useTVDirector';
import type { TVCameraId } from '../hooks/useTVDirector';

/* ============================================================================
 * ЗАДАЧА 5.4 — /control: НАША ПАНЕЛЬ  (Mission Control, FORMULA I1)
 * ----------------------------------------------------------------------------
 * Выносной пульт управления гонкой — «mission control» за стартовой решёткой.
 *
 * Что это:
 *   • приподнятая платформа (deck) на опорах с перилами и маячками;
 *   • большой LED-экран, развёрнутый в сторону трассы (-Z), на котором:
 *       - шапка MISSION CONTROL · FORMULA I1 + статус соединения/race id/task;
 *       - живой ЛИДЕРБОРД из store (`useArena.agents`, сортировка по прогрессу);
 *       - лог РАДИО из store (`useArena.radioEvents`);
 *       - строка камер авто-режиссуры (активная подсвечена);
 *   • три операторских консоли + фигуры операторов;
 *   • вращающийся радар и пульсирующие маячки.
 *
 * Приёмы взяты из research/racing-game (MIT):
 *   - src/ui/Keys.tsx   — панель с «живыми» строками состояния;
 *   - src/ui/Minimap.tsx / Clock.tsx — HUD-панель, данные читаются на каждом кадре
 *     без React-ререндеров (мутация ref'ов, useFrame).
 * Код собственный, в терминах проекта AI-1.
 * ========================================================================== */

/** Мировая позиция пьедестала пульта (за стартовой решёткой, лицом на -Z). */
export const CONTROL_DECK_POSITION: [number, number, number] = [0, 0, 40];

/** Высота палубы над землёй. */
export const DECK_Y = 3.4;

interface ControlPanelProps {
  /** Какая ТВ-камера активна сейчас (подсвечивается в строке CAM). */
  activeCamera?: TVCameraId;
}

/* -------------------------------------------------------------------------- */
/*  Мелкие узлы                                                               */
/* -------------------------------------------------------------------------- */

function Beacon({ position, color }: { position: [number, number, number]; color: string }) {
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (mat.current) {
      mat.current.emissiveIntensity = 0.6 + Math.sin(clock.getElapsedTime() * 4) * 0.6;
    }
  });
  return (
    <mesh position={position}>
      <sphereGeometry args={[0.22, 12, 12]} />
      <meshStandardMaterial ref={mat} color={color} emissive={color} emissiveIntensity={1} />
    </mesh>
  );
}

function Console({ x, color }: { x: number; color: string }) {
  return (
    <group position={[x, DECK_Y + 0.55, -0.4]}>
      {/* столешница */}
      <mesh castShadow position={[0, 0, 0]}>
        <boxGeometry args={[2.6, 0.12, 1.1]} />
        <meshStandardMaterial color="#1b2436" metalness={0.5} roughness={0.4} />
      </mesh>
      {/* фронтальная панель */}
      <mesh position={[0, -0.45, 0.5]}>
        <boxGeometry args={[2.6, 0.8, 0.1]} />
        <meshStandardMaterial color="#101828" />
      </mesh>
      {/* монитор оператора */}
      <mesh position={[-0.6, 0.6, -0.3]} rotation={[0.35, 0, 0]}>
        <boxGeometry args={[1.0, 0.7, 0.08]} />
        <meshStandardMaterial color="#020617" emissive={color} emissiveIntensity={0.6} />
      </mesh>
      {/* клавиатура */}
      <mesh position={[0.55, 0.08, 0.1]}>
        <boxGeometry args={[0.9, 0.05, 0.35]} />
        <meshStandardMaterial color="#0b1020" emissive="#1e293b" emissiveIntensity={0.4} />
      </mesh>
    </group>
  );
}

function Operator({ x, color }: { x: number; color: string }) {
  return (
    <group position={[x, DECK_Y + 0.55, 0.9]}>
      {/* корпус */}
      <mesh castShadow position={[0, 0.45, 0]}>
        <capsuleGeometry args={[0.22, 0.5, 4, 8]} />
        <meshStandardMaterial color="#243049" roughness={0.8} />
      </mesh>
      {/* голова */}
      <mesh position={[0, 0.95, 0]}>
        <sphereGeometry args={[0.18, 16, 16]} />
        <meshStandardMaterial color="#e8b48c" />
      </mesh>
      {/* гарнитура */}
      <mesh position={[0, 0.97, 0]}>
        <torusGeometry args={[0.2, 0.03, 8, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} />
      </mesh>
    </group>
  );
}

function Radar() {
  const head = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    if (head.current) head.current.rotation.y += delta * 0.8;
  });
  return (
    <group position={[-7.6, DECK_Y + 0.6, 2.0]}>
      <mesh position={[0, 0.7, 0]}>
        <cylinderGeometry args={[0.06, 0.06, 1.4, 8]} />
        <meshStandardMaterial color="#334155" />
      </mesh>
      <group ref={head} position={[0, 1.4, 0]}>
        <mesh rotation={[0.5, 0, 0]}>
          <circleGeometry args={[0.9, 16, 0, Math.PI]} />
          <meshStandardMaterial color="#64748b" side={THREE.DoubleSide} />
        </mesh>
      </group>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  Основной компонент                                                        */
/* -------------------------------------------------------------------------- */

export function ControlPanel({ activeCamera }: ControlPanelProps) {
  const agents = useArena((s) => s.agents);
  const radioEvents = useArena((s) => s.radioEvents);
  const raceId = useArena((s) => s.raceId);
  const task = useArena((s) => s.task);
  const connected = useArena((s) => s.connected);

  const board = Object.values(agents)
    .sort((a, b) => b.progress - a.progress)
    .slice(0, 6);
  const radio = radioEvents.slice(0, 5);
  const active = activeCamera ?? 'chase';

  const statusText = `${connected ? '● LIVE' : '● OFFLINE'}  ${raceId ?? '—'}  ·  ${
    task ? task.slice(0, 42) : 'ожидание задания'
  }`;

  return (
    <group position={CONTROL_DECK_POSITION}>
      {/* ---------------- опоры палубы ---------------- */}
      {[-7.6, 7.6].map((x) =>
        [-2.4, 2.4].map((z) => (
          <mesh key={`leg-${x}-${z}`} castShadow position={[x, DECK_Y / 2, z]}>
            <boxGeometry args={[0.4, DECK_Y, 0.4]} />
            <meshStandardMaterial color="#0f172a" metalness={0.6} roughness={0.5} />
          </mesh>
        )),
      )}

      {/* ---------------- палуба ---------------- */}
      <mesh castShadow receiveShadow position={[0, DECK_Y, 0]}>
        <boxGeometry args={[18, 0.4, 6]} />
        <meshStandardMaterial color="#121826" metalness={0.6} roughness={0.5} />
      </mesh>

      {/* задние перила */}
      <mesh position={[0, DECK_Y + 1.05, 2.6]}>
        <boxGeometry args={[18, 0.08, 0.08]} />
        <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} />
      </mesh>
      {[-8, -4, 0, 4, 8].map((x) => (
        <mesh key={`post-${x}`} position={[x, DECK_Y + 0.6, 2.6]}>
          <boxGeometry args={[0.08, 1.0, 0.08]} />
          <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} />
        </mesh>
      ))}

      {/* ---------------- экранная стена (лицом на -Z, к трассе) ---------------- */}
      <group position={[0, DECK_Y + 2.7, -2.6]} rotation={[-0.06, 0, 0]}>
        <mesh castShadow>
          <boxGeometry args={[18, 4.6, 0.3]} />
          <meshStandardMaterial color="#05070f" metalness={0.4} roughness={0.6} />
        </mesh>

        {/* шапка */}
        <mesh position={[0, 1.75, -0.18]}>
          <boxGeometry args={[17.2, 1.0, 0.06]} />
          <meshStandardMaterial color="#06111f" emissive="#0b3a5a" emissiveIntensity={0.7} />
        </mesh>
        <Text
          position={[0, 1.95, -0.24]}
          rotation={[0, Math.PI, 0]}
          fontSize={0.34}
          color="#4dd0ff"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.004}
          outlineColor="#000000"
        >
          MISSION CONTROL · FORMULA I1
        </Text>
        <Text
          position={[0, 1.45, -0.24]}
          rotation={[0, Math.PI, 0]}
          fontSize={0.22}
          color="#8fb4d9"
          anchorX="center"
          anchorY="middle"
          maxWidth={16}
        >
          {statusText}
        </Text>

        {/* левое табло — лидерборд */}
        <mesh position={[-4.7, -0.45, -0.18]}>
          <boxGeometry args={[7.6, 2.6, 0.06]} />
          <meshStandardMaterial color="#040810" emissive="#06121f" emissiveIntensity={0.6} />
        </mesh>
        <Text position={[-1.05, 0.7, -0.24]} rotation={[0, Math.PI, 0]} fontSize={0.24} color="#7a8baa" anchorX="left">
          LEADERBOARD
        </Text>
        {board.map((a, i) => (
          <Text
            key={`lb-${a.name}`}
            position={[-1.05, 0.28 - i * 0.42, -0.24]}
            rotation={[0, Math.PI, 0]}
            fontSize={0.26}
            color={a.color}
            anchorX="left"
            maxWidth={7.2}
            outlineWidth={0.003}
            outlineColor="#000000"
          >
            {`${i + 1}. ${a.name}   ${(a.progress * 100).toFixed(0)}%`}
          </Text>
        ))}
        {board.length === 0 && (
          <Text position={[-1.05, 0.28, -0.24]} rotation={[0, Math.PI, 0]} fontSize={0.24} color="#4a5570" anchorX="left">
            нет агентов
          </Text>
        )}

        {/* правое табло — радио-лог */}
        <mesh position={[4.7, -0.45, -0.18]}>
          <boxGeometry args={[7.6, 2.6, 0.06]} />
          <meshStandardMaterial color="#040810" emissive="#1f0a12" emissiveIntensity={0.6} />
        </mesh>
        <Text position={[8.35, 0.7, -0.24]} rotation={[0, Math.PI, 0]} fontSize={0.24} color="#ff7eb6" anchorX="left">
          RADIO
        </Text>
        {radio.map((e, i) => (
          <Text
            key={`rd-${i}-${e.ts}`}
            position={[8.35, 0.28 - i * 0.44, -0.24]}
            rotation={[0, Math.PI, 0]}
            fontSize={0.22}
            color="#c9d6ea"
            anchorX="left"
            maxWidth={7.2}
          >
            {e.text.length > 44 ? `${e.text.slice(0, 44)}…` : e.text}
          </Text>
        ))}
        {radio.length === 0 && (
          <Text position={[8.35, 0.28, -0.24]} rotation={[0, Math.PI, 0]} fontSize={0.24} color="#4a5570" anchorX="left">
            ожидание событий…
          </Text>
        )}

        {/* строка камер авто-режиссуры */}
        {TV_CAMERAS.map((cam, i) => {
          const step = 16 / Math.max(TV_CAMERAS.length, 1);
          const x = (i - (TV_CAMERAS.length - 1) / 2) * step * 0.62;
          const on = cam.id === active;
          return (
            <Text
              key={cam.id}
              position={[x, -2.0, -0.24]}
              rotation={[0, Math.PI, 0]}
              fontSize={on ? 0.26 : 0.22}
              color={on ? '#6eff8b' : '#3a4a66'}
              anchorX="center"
              anchorY="middle"
            >
              {cam.id.toUpperCase()}
            </Text>
          );
        })}
      </group>

      {/* ---------------- консоли и операторы ---------------- */}
      <Console x={-4.4} color="#4dd0ff" />
      <Console x={0} color="#a855f7" />
      <Console x={4.4} color="#ff7eb6" />
      <Operator x={-4.4} color="#4dd0ff" />
      <Operator x={0} color="#a855f7" />
      <Operator x={4.4} color="#ff7eb6" />

      {/* ---------------- декор ---------------- */}
      <Radar />
      <Beacon position={[-8.6, DECK_Y + 5.0, -2.6]} color="#ff5c5c" />
      <Beacon position={[8.6, DECK_Y + 5.0, -2.6]} color="#6eff8b" />
      <pointLight position={[0, DECK_Y + 5.5, -1]} color="#4dd0ff" intensity={2.2} distance={26} />
      <pointLight position={[-6, DECK_Y + 3, 1]} color="#ff7eb6" intensity={1.1} distance={16} />
      <pointLight position={[6, DECK_Y + 3, 1]} color="#a855f7" intensity={1.1} distance={16} />
    </group>
  );
}

export default ControlPanel;
