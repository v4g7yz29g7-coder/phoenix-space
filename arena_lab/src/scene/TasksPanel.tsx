import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';

/* ============================================================================
 * ЗАДАЧА 5.5 — /tasks: ПУБЛИЧНАЯ ПАНЕЛЬ  (Mission Control, FORMULA I1)
 * ----------------------------------------------------------------------------
 * Отдельный публичный стенд (public board) у входа на арену. В отличие от
 * служебного пульта /control (задача 5.4), эта панель рассчитана на зрителей:
 *
 *   • вертикальная стела с LED-табло, развёрнутая в сторону зрительской площади;
 *   • шапка «TASKS · FORMULA I1» + живой счётчик прогресса (N/M done);
 *   • список задач спринта (id, название, статус) — цветовая индикация
 *     queued / running / done / failed;
 *   • бегущая строка (marquee) с текущей активной задачей;
 *   • декоративные бегущие огни по периметру и пульсирующие маячки.
 *
 * Источник данных: список TASKS (ниже) — публичная, read-only модель. Компонент
 * принимает tasks через props, поэтому реальные данные (например из
 * /tasks API или tasks_pool.json) можно подставить снаружи.
 *
 * Приёмы взяты из research/racing-game (MIT):
 *   - src/ui/Keys.tsx        — статичная панель со строками состояния;
 *   - src/ui/Minimap.tsx     — HUD, читающий данные без React-ререндеров;
 *   - src/effects/*          — публичный LED-вид, инстансные огни.
 * Код собственный, в терминах проекта AI-1.
 * ========================================================================== */

/** Мировая позиция публичного стенда /tasks (перед входом, лицом на -Z). */
export const TASKS_PANEL_POSITION: [number, number, number] = [0, 0, -46];

/** Высота центра LED-экрана над землёй. */
export const TASKS_SCREEN_Y = 4.6;

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed';

export interface TaskEntry {
  /** Короткий id задачи, напр. «5.5». */
  id: string;
  /** Название/описание. */
  title: string;
  /** Статус выполнения. */
  status: TaskStatus;
  /** Назначенный агент (опционально). */
  agent?: string;
}

const STATUS_COLOR: Record<TaskStatus, string> = {
  queued: '#7d8597',
  running: '#facc15',
  done: '#22c55e',
  failed: '#ef4444',
};

/** Публичный список задач спринта «Mission Control» (read-only дефолт). */
export const DEFAULT_TASKS: TaskEntry[] = [
  { id: '5.1', title: 'Race engine / task router', status: 'done' },
  { id: '5.2', title: 'TV director cues', status: 'done' },
  { id: '5.3', title: 'Pit lane + tribunes', status: 'done' },
  { id: '5.4', title: 'Control panel /control', status: 'done' },
  { id: '5.5', title: 'Public panel /tasks', status: 'running', agent: 'agent_4' },
  { id: '5.6', title: 'Mission Control replay', status: 'queued' },
];

interface TasksPanelProps {
  tasks?: TaskEntry[];
  /** Направление разворота панели: 'audience' (на -Z) или 'track' (на +Z). */
  facing?: 'audience' | 'track';
}

const MAX_ROWS = 7;

function statusLabel(s: TaskStatus): string {
  return s.toUpperCase();
}

/* ------------------------------------------------------------------ */
/*  Стела + LED-экран                                                  */
/* ------------------------------------------------------------------ */
function Board({ tasks, facing }: { tasks: TaskEntry[]; facing: 'audience' | 'track' }) {
  const rotY = facing === 'audience' ? Math.PI : 0;

  const done = tasks.filter((t) => t.status === 'done').length;
  const total = tasks.length;
  const running = tasks.find((t) => t.status === 'running');

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

  return (
    <group rotation={[0, rotY, 0]}>
      {/* корпус стелы */}
      <mesh position={[0, 3.4, 0]} material={boardMat} castShadow receiveShadow>
        <boxGeometry args={[9.4, 6.6, 0.6]} />
      </mesh>
      {/* рамка LED-экрана */}
      <mesh position={[0, 3.6, 0.34]} material={frameMat}>
        <boxGeometry args={[8.6, 5.4, 0.12]} />
      </mesh>
      {/* сам экран */}
      <mesh position={[0, 3.6, 0.42]} material={screenMat}>
        <planeGeometry args={[8.2, 5.0]} />
      </mesh>

      {/* шапка */}
      <Text position={[0, 5.7, 0.5]} fontSize={0.62} color="#8fe3ff" anchorX="center" anchorY="middle" letterSpacing={0.08}>
        TASKS · FORMULA I1
      </Text>

      {/* счётчик прогресса */}
      <Text position={[0, 5.05, 0.5]} fontSize={0.36} color={done === total ? '#6eff8b' : '#ffd700'} anchorX="center" anchorY="middle">
        {`${done}/${total} DONE`}
      </Text>

      {/* разделитель */}
      <Line y={4.62} />

      {/* строки задач */}
      {tasks.slice(0, MAX_ROWS).map((t, i) => {
        const y = 4.2 - i * 0.62;
        const c = STATUS_COLOR[t.status];
        return (
          <group key={t.id} position={[0, y, 0.5]}>
            <Text position={[-3.85, 0, 0]} fontSize={0.3} color="#c9d6e5" anchorX="left" anchorY="middle">
              {t.id}
            </Text>
            <Text position={[-3.0, 0, 0]} fontSize={0.28} color="#eaf3ff" anchorX="left" anchorY="middle" maxWidth={5.0}>
              {t.title}
            </Text>
            <Text position={[3.85, 0, 0]} fontSize={0.24} color={c} anchorX="right" anchorY="middle">
              {t.agent ? `${statusLabel(t.status)} · ${t.agent}` : statusLabel(t.status)}
            </Text>
          </group>
        );
      })}

      {/* бегущая строка с активной задачей */}
      <Line y={-0.05} />
      <Text position={[0, -0.42, 0.5]} fontSize={0.3} color={running ? '#facc15' : '#7d8597'} anchorX="center" anchorY="middle">
        {running ? `▶ NOW: ${running.id} ${running.title}` : '▶ ALL TASKS COMPLETE'}
      </Text>
    </group>
  );
}

function Line({ y }: { y: number }) {
  const geo = useMemo(() => {
    const g = new THREE.BoxGeometry(8.2, 0.03, 0.02);
    return g;
  }, []);
  const mat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#2a4a6b' }),
    []
  );
  return <mesh position={[0, y, 0.5]} geometry={geo} material={mat} />;
}

/* ------------------------------------------------------------------ */
/*  Бегущие огни по периметру + маячки                                 */
/* ------------------------------------------------------------------ */
function PerimeterLights({ tasks }: { tasks: TaskEntry[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const COLORS = ['#4dd0ff', '#ff7eb6', '#a855f7', '#6eff8b'];

  const COUNT = 40;

  useFrame(({ clock }) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = clock.getElapsedTime();
    for (let i = 0; i < COUNT; i++) {
      const side = i % 4;
      const k = (i - side) / 4; // 0..9
      let x = 0;
      let y = 0;
      const halfW = 4.85;
      const top = 6.85;
      const bottom = 0.15;
      if (side === 0) {
        x = -halfW;
        y = bottom + (top - bottom) * (k / 9);
      } else if (side === 1) {
        x = halfW;
        y = top - (top - bottom) * (k / 9);
      } else if (side === 2) {
        x = -halfW + (2 * halfW) * (k / 9);
        y = top;
      } else {
        x = halfW - (2 * halfW) * (k / 9);
        y = bottom;
      }
      const phase = t * 4 - i * 0.3;
      const pulse = 0.5 + 0.5 * Math.sin(phase);
      dummy.position.set(x, y, 0.62);
      const s = 0.1 + pulse * 0.09;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, COUNT]} frustumCulled={false}>
      <sphereGeometry args={[1, 8, 8]} />
      <meshBasicMaterial color={COLORS[0]} toneMapped={false} />
    </instancedMesh>
  );
}

/* ------------------------------------------------------------------ */
/*  Публичный стенд целиком                                            */
/* ------------------------------------------------------------------ */
export function TasksPanel({ tasks = DEFAULT_TASKS, facing = 'audience' }: TasksPanelProps) {
  return (
    <group position={TASKS_PANEL_POSITION}>
      {/* основание / подиум */}
      <mesh position={[0, 0.1, 0]} receiveShadow>
        <boxGeometry args={[10.6, 0.2, 2.6]} />
        <meshStandardMaterial color="#1a2233" metalness={0.3} roughness={0.8} />
      </mesh>
      {/* опоры */}
      <mesh position={[-4.2, 1.7, 0]}>
        <boxGeometry args={[0.4, 3.4, 0.4]} />
        <meshStandardMaterial color="#2b3a52" metalness={0.8} roughness={0.3} />
      </mesh>
      <mesh position={[4.2, 1.7, 0]}>
        <boxGeometry args={[0.4, 3.4, 0.4]} />
        <meshStandardMaterial color="#2b3a52" metalness={0.8} roughness={0.3} />
      </mesh>

      <Board tasks={tasks} facing={facing} />
      <PerimeterLights tasks={tasks} />
    </group>
  );
}

export default TasksPanel;
