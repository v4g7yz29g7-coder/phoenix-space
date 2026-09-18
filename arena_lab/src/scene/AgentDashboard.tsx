import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { useArena } from '../store/arena';

/* ============================================================================
 * ЗАДАЧА 6.3 — DASHBOARD «МОИ АГЕНТЫ»  (Formula I1 · Platform)
 * ----------------------------------------------------------------------------
 * Мульти-агентная сводка по спринту: отдельная 3D-стела у bоксов с живым
 * табло «MY AGENTS». В отличие от LEADERBOARD гонки (позиции на трассе) и
 * публичного /tasks-стенда, здесь показана ПЕРСОНАЛЬНАЯ доска владельца —
 * все агенты, их статус, прогресс задачи и накопленный счёт.
 *
 * Что на экране:
 *   • шапка «MY AGENTS · FORMULA I1» + счётчик online;
 *   • сводка: done / running / idle / failed + средний прогресс;
 *   • по каждому агенту: цветовой чип, имя, статус, полоса прогресса, %, score;
 *   • ранг-акцент (gold/silver/bronze) для тройки лидеров;
 *   • бегущая сканирующая линия и пульс рамки.
 *
 * Источник данных: store `useArena` (agents). Компонент также принимает
 * `agents` через props — удобно для тестов / серверного снапшота.
 *
 * Приёмы взяты из research/racing-game (MIT):
 *   - src/ui/LeaderBoard.tsx — сортировка участников и медалиста тройки;
 *   - src/ui/Minimap.tsx     — чтение данных в useFrame без лишних ререндеров;
 *   - src/ui/Keys.tsx        — статичная панель со строками состояния.
 * Код собственный, в терминах проекта AI-1.
 * ========================================================================== */

/** Мировая позиция стелы «моих агентов» (позади стартовой решётки). */
export const DASHBOARD_POSITION: [number, number, number] = [0, 0, -56];

/** Высота центра LED-экрана над землёй. */
export const DASHBOARD_SCREEN_Y = 4.5;

/** Ширина области полосы прогресса в мировых единицах. */
const BAR_W = 3.0;

const RANK_ACCENT = ['#ffd700', '#c0c0c0', '#cd7f32'];

export type AgentStatus = 'idle' | 'running' | 'done' | 'failed';

export interface DashboardAgent {
  name: string;
  color: string;
  progress: number;
  status: AgentStatus;
  score: number;
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: '#7d8597',
  running: '#facc15',
  done: '#22c55e',
  failed: '#ef4444',
};

interface AgentDashboardProps {
  /** Внешний снапшот агентов. Если не задан — берётся из store. */
  agents?: DashboardAgent[];
  /** Разворот табло: 'track' (+Z, к трассе) или 'audience' (-Z, к зрителям). */
  facing?: 'track' | 'audience';
  /** Заголовок экрана. */
  title?: string;
}

const MAX_ROWS = 7;

/* -------------------------------------------------------------------------- */
/*  Строка агента                                                             */
/* -------------------------------------------------------------------------- */
function AgentRow({ agent, rank, y }: { agent: DashboardAgent; rank: number; y: number }) {
  const fillRef = useRef<THREE.Mesh>(null);
  const p = useRef(agent.progress);

  useFrame((_, dt) => {
    // плавно тянем полосу к фактическому прогрессу (без ререндеров)
    p.current = THREE.MathUtils.lerp(p.current, agent.progress, Math.min(1, dt * 5));
    const fill = fillRef.current;
    if (fill) {
      const w = Math.max(0.0001, p.current * BAR_W);
      fill.scale.x = w;
      fill.position.x = -BAR_W / 2 + w / 2;
    }
  });

  const accent = rank < 3 ? RANK_ACCENT[rank] : agent.color;
  const statusColor = STATUS_COLOR[agent.status] ?? '#7d8597';

  return (
    <group position={[0, y, 0.5]}>
      {/* чип ранга/агента */}
      <mesh position={[-3.85, 0, 0]}>
        <boxGeometry args={[0.34, 0.34, 0.06]} />
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={agent.status === 'running' ? 1.1 : 0.5}
          metalness={0.5}
          roughness={0.4}
        />
      </mesh>

      {/* имя */}
      <Text position={[-3.55, 0, 0]} fontSize={0.28} color="#eaf3ff" anchorX="left" anchorY="middle">
        {agent.name}
      </Text>

      {/* фон + заливка полосы прогресса */}
      <mesh position={[-0.5, 0, 0]}>
        <boxGeometry args={[BAR_W, 0.16, 0.04]} />
        <meshBasicMaterial color="#16233a" />
      </mesh>
      <mesh ref={fillRef} position={[-0.5, 0, 0.02]}>
        <boxGeometry args={[1, 0.16, 0.05]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.9} />
      </mesh>

      {/* процент */}
      <Text position={[1.15, 0, 0]} fontSize={0.24} color="#9fb4cf" anchorX="left" anchorY="middle">
        {`${Math.round(agent.progress * 100)}%`}
      </Text>

      {/* статус */}
      <Text position={[1.95, 0, 0]} fontSize={0.2} color={statusColor} anchorX="left" anchorY="middle">
        {agent.status.toUpperCase()}
      </Text>

      {/* счёт */}
      <Text position={[3.85, 0, 0]} fontSize={0.26} color="#ffd700" anchorX="right" anchorY="middle">
        {`${agent.score}`}
      </Text>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  Сканирующая линия по экрану                                                */
/* -------------------------------------------------------------------------- */
function ScanLine({ height }: { height: number }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const t = (clock.getElapsedTime() * 0.35) % 1;
    m.position.y = height / 2 - t * height;
    const mat = m.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.10 + 0.12 * Math.sin(t * Math.PI);
  });
  return (
    <mesh ref={ref} position={[0, 0, 0.55]}>
      <planeGeometry args={[8.0, 0.09]} />
      <meshBasicMaterial color="#8fe3ff" transparent opacity={0.15} depthWrite={false} />
    </mesh>
  );
}

/* -------------------------------------------------------------------------- */
/*  Панель                                                                    */
/* -------------------------------------------------------------------------- */
export function AgentDashboard({ agents, facing = 'track', title = 'MY AGENTS · FORMULA I1' }: AgentDashboardProps) {
  const storeAgents = useArena((s) => s.agents);
  const connected = useArena((s) => s.connected);

  const list: DashboardAgent[] = useMemo(() => {
    if (agents) {
      return [...agents].sort((a, b) => b.progress - a.progress || b.score - a.score);
    }
    return Object.values(storeAgents)
      .map((a) => ({
        name: a.name,
        color: a.color,
        progress: a.progress,
        status: a.status as AgentStatus,
        score: a.score,
      }))
      .sort((a, b) => b.progress - a.progress || b.score - a.score);
  }, [agents, storeAgents]);

  const done = list.filter((a) => a.status === 'done').length;
  const running = list.filter((a) => a.status === 'running').length;
  const failed = list.filter((a) => a.status === 'failed').length;
  const avg = list.length ? list.reduce((s, a) => s + a.progress, 0) / list.length : 0;

  const rotY = facing === 'audience' ? Math.PI : 0;

  const boardMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#0b1020', emissive: '#0a1a33', emissiveIntensity: 0.6, metalness: 0.4, roughness: 0.4 }),
    []
  );
  const screenMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#06121f', emissive: '#0d2740', emissiveIntensity: 0.9, metalness: 0.1, roughness: 0.9 }),
    []
  );
  const frameMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#233046', metalness: 0.7, roughness: 0.35 }),
    []
  );

  const frameRef = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (frameRef.current) {
      frameRef.current.emissiveIntensity = 0.9 + Math.sin(clock.getElapsedTime() * 2) * 0.25;
    }
  });

  return (
    <group position={DASHBOARD_POSITION} rotation={[0, rotY, 0]}>
      {/* корпус стелы */}
      <mesh position={[0, DASHBOARD_SCREEN_Y - 0.2, 0]} material={boardMat} castShadow receiveShadow>
        <boxGeometry args={[9.4, 6.6, 0.6]} />
      </mesh>
      {/* рамка */}
      <mesh position={[0, DASHBOARD_SCREEN_Y, 0.32]} material={frameMat}>
        <boxGeometry args={[8.6, 5.4, 0.12]} />
      </mesh>
      {/* экран */}
      <mesh position={[0, DASHBOARD_SCREEN_Y, 0.4]} material={screenMat}>
        <planeGeometry args={[8.2, 5.0]} />
      </mesh>
      {/* подсветка рамки */}
      <mesh position={[0, DASHBOARD_SCREEN_Y, 0.38]}>
        <planeGeometry args={[8.5, 5.3]} />
        <meshStandardMaterial ref={frameRef} color="#0e2a4a" emissive="#2a7fd4" emissiveIntensity={0.9} transparent opacity={0.15} />
      </mesh>

      {/* шапка */}
      <Text position={[0, DASHBOARD_SCREEN_Y + 2.05, 0.5]} fontSize={0.6} color="#8fe3ff" anchorX="center" anchorY="middle" letterSpacing={0.06}>
        {title}
      </Text>
      <Text position={[0, DASHBOARD_SCREEN_Y + 1.5, 0.5]} fontSize={0.3} color={connected ? '#6eff8b' : '#ff9b6b'} anchorX="center" anchorY="middle">
        {`${connected ? '● ONLINE' : '● OFFLINE'} · ${list.length} AGENTS · AVG ${Math.round(avg * 100)}%`}
      </Text>

      {/* сводка */}
      <Text position={[-3.85, DASHBOARD_SCREEN_Y + 1.0, 0.5]} fontSize={0.26} color="#22c55e" anchorX="left" anchorY="middle">
        {`DONE ${done}`}
      </Text>
      <Text position={[-1.4, DASHBOARD_SCREEN_Y + 1.0, 0.5]} fontSize={0.26} color="#facc15" anchorX="left" anchorY="middle">
        {`RUNNING ${running}`}
      </Text>
      <Text position={[1.2, DASHBOARD_SCREEN_Y + 1.0, 0.5]} fontSize={0.26} color="#ef4444" anchorX="left" anchorY="middle">
        {`FAILED ${failed}`}
      </Text>
      <Text position={[3.85, DASHBOARD_SCREEN_Y + 1.0, 0.5]} fontSize={0.26} color="#7d8597" anchorX="right" anchorY="middle">
        {`IDLE ${list.length - done - running - failed}`}
      </Text>

      {/* строки агентов */}
      {list.slice(0, MAX_ROWS).map((a, i) => (
        <AgentRow key={a.name} agent={a} rank={i} y={DASHBOARD_SCREEN_Y + 0.4 - i * 0.56} />
      ))}

      {/* пустое состояние */}
      {list.length === 0 && (
        <Text position={[0, DASHBOARD_SCREEN_Y - 0.6, 0.5]} fontSize={0.34} color="#4a5570" anchorX="center" anchorY="middle">
          NO AGENTS CONNECTED
        </Text>
      )}

      {/* сканирующая линия по экрану */}
      <group position={[0, DASHBOARD_SCREEN_Y, 0]}>
        <ScanLine height={4.6} />
      </group>
    </group>
  );
}
