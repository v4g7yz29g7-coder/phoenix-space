import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { useArena } from '../store/arena';

/* ============================================================================
 * ЗАДАЧА 5.4 — /control: НАША ПАНЕЛЬ · TELEMETRY WALL  (FORMULA I1)
 * ----------------------------------------------------------------------------
 * Дополнительная стела к выносному пульту Mission Control. Пока основной
 * ControlPanel даёт «кто впереди / радио / камеры», эта стена — ШИРОКАЯ
 * телеметрия гонки в реальном времени:
 *
 *   • LIVE-СПАРКЛАЙН по каждому агенту: история прогресса за последние
 *     SAMPLES замеров, нарисованная линиями THREE.Line (по одной на агента);
 *     данные копятся в ref-кольцевом буфере и обновляются в useFrame —
 *     БЕЗ React-ререндеров (приём ui/Minimap.tsx из research/racing-game, MIT);
 *   • СТРОКА ОТРЫВА: текущий %, отставание от лидера (dealta) и статус;
 *   • СЕКТОР-ФЛАГИ S1/S2/S3 (33% / 66% / 100%) — загораются по мере прохода;
 *   • пульсирующая рамка и бегущая сканирующая линия.
 *
 * Приёмы взяты из research/racing-game (MIT): instanced/Line-графика и
 * чтение стора в useFrame. Код собственный, в терминах проекта AI-1.
 * ========================================================================== */

/** Мировая позиция стелы телеметрии (справа от пульта, лицом к трассе). */
export const TELEMETRY_POSITION: [number, number, number] = [11.6, 0, 41];

/** Высота центра LED-экрана телеметрии над землёй. */
export const TELEMETRY_SCREEN_Y = 6.2;

/* --------------------------- геометрия экрана ---------------------------- */
const PANEL_W = 8.2;
const PANEL_H = 4.6;
const HALF_W = PANEL_W / 2;

/** Область графика (локальные координаты экрана). */
const CHART_X0 = -3.6;
const CHART_Y0 = 0.5;
const CHART_W = 7.2;
const CHART_H = 1.05;

/** Сколько замеров истории держим и как часто снимаем. */
const SAMPLES = 48;
const SAMPLE_DT = 0.15;

/** Максимум агентов на стене (топ по прогрессу). */
const MAX_AGENTS = 5;

/** Порог секторов. */
const SECTOR_AT = [0.34, 0.67, 0.999];

type Row = { name: string; color: string };

/* -------------------------------------------------------------------------- */
/*  График-спарклайны                                                          */
/* -------------------------------------------------------------------------- */
function Sparklines({ rows }: { rows: Row[] }) {
  const namesKey = rows.map((r) => r.name).join('|');

  const history = useRef<Map<string, number[]>>(new Map());
  const acc = useRef(0);

  // По одной линии на агента; геометрия — SAMPLES точек.
  const lines = useMemo(() => {
    const map = new Map<string, THREE.Line>();
    rows.forEach((r) => {
      const positions = new Float32Array(SAMPLES * 3);
      for (let k = 0; k < SAMPLES; k++) {
        positions[k * 3] = CHART_X0 + (k / (SAMPLES - 1)) * CHART_W;
        positions[k * 3 + 1] = CHART_Y0;
        positions[k * 3 + 2] = 0;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({ color: r.color, transparent: true, opacity: 0.95 });
      map.set(r.name, new THREE.Line(geo, mat));
      if (!history.current.has(r.name)) history.current.set(r.name, []);
    });
    return map;
    // список пересобирается только при смене набора агентов
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesKey]);

  useFrame((_, delta) => {
    acc.current += delta;
    const takeSample = acc.current >= SAMPLE_DT;
    if (takeSample) acc.current = 0;

    // свежие значения читаем напрямую из стора — без подписки/ререндера
    const live = useArena.getState().agents;

    if (takeSample) {
      rows.forEach((r) => {
        const arr = history.current.get(r.name) ?? [];
        arr.push(live[r.name]?.progress ?? 0);
        while (arr.length > SAMPLES) arr.shift();
        history.current.set(r.name, arr);
      });
    }

    rows.forEach((r) => {
      const line = lines.get(r.name);
      if (!line) return;
      const arr = history.current.get(r.name) ?? [];
      const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let k = 0; k < SAMPLES; k++) {
        const idx = arr.length - SAMPLES + k;
        const v = idx >= 0 ? arr[idx] : arr[0] ?? 0;
        pos.setY(k, CHART_Y0 + v * CHART_H);
      }
      pos.needsUpdate = true;
    });
  });

  return (
    <>
      {/* сетка графика */}
      {[0, 0.5, 1].map((g) => (
        <mesh key={`grid-${g}`} position={[0, CHART_Y0 + g * CHART_H, 0.02]}>
          <planeGeometry args={[CHART_W, 0.008]} />
          <meshBasicMaterial color="#1c2c44" transparent opacity={g === 0 ? 0.9 : 0.4} />
        </mesh>
      ))}

      {/* линии агентов */}
      {rows.map((r) => {
        const line = lines.get(r.name);
        return line ? <primitive key={r.name} object={line} /> : null;
      })}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Строка отрыва + сектор-флаги                                              */
/* -------------------------------------------------------------------------- */
function GapRow({
  row,
  y,
  progress,
  gap,
  status,
}: {
  row: Row;
  y: number;
  progress: number;
  gap: number;
  status: string;
}) {
  const statusColor =
    status === 'done'
      ? '#22c55e'
      : status === 'failed'
        ? '#ef4444'
        : status === 'running'
          ? '#facc15'
          : '#7d8597';

  return (
    <group position={[0, y, 0.18]}>
      {/* цветовой чип */}
      <mesh position={[-HALF_W + 0.35, 0, 0]}>
        <boxGeometry args={[0.26, 0.26, 0.05]} />
        <meshStandardMaterial color={row.color} emissive={row.color} emissiveIntensity={0.7} />
      </mesh>

      {/* имя */}
      <Text position={[-HALF_W + 0.62, 0, 0]} fontSize={0.21} color="#eaf3ff" anchorX="left" anchorY="middle">
        {row.name}
      </Text>

      {/* прогресс */}
      <Text position={[-0.55, 0, 0]} fontSize={0.21} color="#9fb4cf" anchorX="left" anchorY="middle">
        {`${Math.round(progress * 100)}%`}
      </Text>

      {/* отрыв от лидера */}
      <Text
        position={[0.55, 0, 0]}
        fontSize={0.19}
        color={gap > 0.001 ? '#ff7eb6' : '#6eff8b'}
        anchorX="left"
        anchorY="middle"
      >
        {gap > 0.001 ? `-${(gap * 100).toFixed(0)}%` : 'LEAD'}
      </Text>

      {/* сектор-флаги S1 S2 S3 */}
      {SECTOR_AT.map((th, i) => {
        const on = progress >= th;
        return (
          <mesh key={`s${i}`} position={[1.55 + i * 0.42, 0, 0]}>
            <boxGeometry args={[0.28, 0.18, 0.04]} />
            <meshStandardMaterial
              color={on ? '#22c55e' : '#1b2740'}
              emissive={on ? '#22c55e' : '#0b1020'}
              emissiveIntensity={on ? 0.9 : 0.15}
            />
          </mesh>
        );
      })}
      <Text position={[1.34, 0.001, 0.03]} fontSize={0.12} color="#4a5570" anchorX="right" anchorY="middle">
        SEC
      </Text>

      {/* статус */}
      <Text position={[HALF_W - 0.28, 0, 0]} fontSize={0.19} color={statusColor} anchorX="right" anchorY="middle">
        {status.toUpperCase()}
      </Text>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  Бегущая сканирующая линия                                                  */
/* -------------------------------------------------------------------------- */
function ScanLine() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const t = (clock.getElapsedTime() * 0.28) % 1;
    m.position.y = PANEL_H / 2 - t * PANEL_H;
    const mat = m.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.06 + 0.1 * Math.sin(t * Math.PI);
  });
  return (
    <mesh ref={ref} position={[0, 0, 0.19]}>
      <planeGeometry args={[PANEL_W, 0.06]} />
      <meshBasicMaterial color="#8fe3ff" transparent opacity={0.1} depthWrite={false} />
    </mesh>
  );
}

/* -------------------------------------------------------------------------- */
/*  Основной компонент                                                         */
/* -------------------------------------------------------------------------- */
export function ControlTelemetry() {
  const agents = useArena((s) => s.agents);
  const connected = useArena((s) => s.connected);

  const rows: Row[] = useMemo(
    () =>
      Object.values(agents)
        .sort((a, b) => b.progress - a.progress)
        .slice(0, MAX_AGENTS)
        .map((a) => ({ name: a.name, color: a.color })),
    [agents],
  );

  const list = useMemo(
    () => Object.values(agents).sort((a, b) => b.progress - a.progress).slice(0, MAX_AGENTS),
    [agents],
  );

  const leaderProgress = list.length ? list[0].progress : 0;
  const done = Object.values(agents).filter((a) => a.status === 'done').length;

  const frameMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#0a1120',
        emissive: '#0d2740',
        emissiveIntensity: 0.55,
        metalness: 0.6,
        roughness: 0.4,
      }),
    [],
  );

  return (
    <group position={TELEMETRY_POSITION}>
      {/* опоры */}
      {[-1.9, 1.9].map((x) => (
        <mesh key={`tleg-${x}`} castShadow position={[x, TELEMETRY_SCREEN_Y / 2, 0]}>
          <boxGeometry args={[0.3, TELEMETRY_SCREEN_Y, 0.3]} />
          <meshStandardMaterial color="#0f172a" metalness={0.6} roughness={0.5} />
        </mesh>
      ))}

      {/* экран (развёрнут на -Z, к трассе) */}
      <group position={[0, TELEMETRY_SCREEN_Y, 0]} rotation={[0, Math.PI, 0]}>
        <mesh castShadow material={frameMat}>
          <boxGeometry args={[PANEL_W + 0.6, PANEL_H + 0.6, 0.32]} />
        </mesh>

        {/* заголовок */}
        <Text position={[0, PANEL_H / 2 - 0.35, 0.18]} fontSize={0.3} color="#4dd0ff" anchorX="center" anchorY="middle" outlineWidth={0.003} outlineColor="#000000">
          TELEMETRY · MISSION CONTROL
        </Text>
        <Text
          position={[0, PANEL_H / 2 - 0.68, 0.18]}
          fontSize={0.17}
          color={connected ? '#6eff8b' : '#ff5c5c'}
          anchorX="center"
          anchorY="middle"
        >
          {`${connected ? '● LIVE' : '● OFFLINE'}   ·   FINISHED ${done}/${Object.keys(agents).length}`}
        </Text>

        {/* график */}
        <Sparklines rows={rows} />
        <Text position={[CHART_X0, CHART_Y0 + CHART_H + 0.14, 0.18]} fontSize={0.14} color="#4a5570" anchorX="left" anchorY="middle">
          PROGRESS · last 48 samples
        </Text>
        {rows.length === 0 && (
          <Text position={[0, CHART_Y0 + CHART_H / 2, 0.18]} fontSize={0.22} color="#4a5570" anchorX="center" anchorY="middle">
            ожидание агентов…
          </Text>
        )}

        {/* строки отрыва + секторы */}
        {list.map((a, i) => (
          <GapRow
            key={a.name}
            row={{ name: a.name, color: a.color }}
            y={-0.15 - i * 0.4}
            progress={a.progress}
            gap={Math.max(0, leaderProgress - a.progress)}
            status={a.status}
          />
        ))}

        <ScanLine />
      </group>
    </group>
  );
}

export default ControlTelemetry;
