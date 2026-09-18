import { useEffect, useState } from 'react';
import { Text } from '@react-three/drei';
import { ControlPanel, CONTROL_DECK_POSITION, DECK_Y } from './ControlPanel';
import { ControlTelemetry } from './ControlTelemetry';
import { useArena } from '../store/arena';
import type { TVCameraId } from '../hooks/useTVDirector';

/* ============================================================================
 * ЗАДАЧА 5.4 — /control: НАША ПАНЕЛЬ  (Mission Control, FORMULA I1)
 * ----------------------------------------------------------------------------
 * Точка входа «/control» на сцене: монтирует выносной пульт `ControlPanel`
 * и надстраивает над ним живую Mission-Control-вывеску:
 *   • гоночный хронометр MM:SS.d, тикающий в реальном времени (10 Гц);
 *   • строка статуса LIVE/OFFLINE + race id из store (Zustand);
 *   • две прожекторные мачты с тёплым светом над пультом.
 *
 * Хронометр обновляется React-состоянием с интервалом 100 мс — дешёвый
 * независимый от кадра счётчик (приём `ui/Clock.tsx` из research/racing-game,
 * MIT, код переписан под термины AI-1).
 * ========================================================================== */

const START_MS = Date.now();

/** Возвращает прошедшее с загрузки время в формате MM:SS.d. */
function useElapsedLabel(): string {
  const [label, setLabel] = useState('00:00.0');
  useEffect(() => {
    const tick = () => {
      const t = (Date.now() - START_MS) / 1000;
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = String(Math.floor(t % 60)).padStart(2, '0');
      const ds = Math.floor((t * 10) % 10);
      setLabel(`${mm}:${ss}.${ds}`);
    };
    tick();
    const iv = setInterval(tick, 100);
    return () => clearInterval(iv);
  }, []);
  return label;
}

/* -------------------------------------------------------------------------- */
/*  Живая вывеска над пультом                                                 */
/* -------------------------------------------------------------------------- */

function ClockBoard() {
  const elapsed = useElapsedLabel();
  const raceId = useArena((s) => s.raceId);
  const connected = useArena((s) => s.connected);

  return (
    <group
      position={[CONTROL_DECK_POSITION[0], DECK_Y + 6.0, CONTROL_DECK_POSITION[2] + 1.4]}
      rotation={[0, Math.PI, 0]}
    >
      <mesh position={[0, 0, -0.06]}>
        <boxGeometry args={[6.4, 1.6, 0.12]} />
        <meshStandardMaterial color="#05070f" emissive="#061a26" emissiveIntensity={0.7} />
      </mesh>
      <Text
        position={[0, 0.32, 0]}
        fontSize={0.62}
        color="#4dd0ff"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.004}
        outlineColor="#000000"
      >
        {elapsed}
      </Text>
      <Text
        position={[0, -0.42, 0]}
        fontSize={0.2}
        color={connected ? '#6eff8b' : '#ff5c5c'}
        anchorX="center"
        anchorY="middle"
        maxWidth={6}
      >
        {`${connected ? '● LIVE' : '● OFFLINE'}   ${raceId ?? 'MISSION CONTROL'}`}
      </Text>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  Публичный компонент                                                       */
/* -------------------------------------------------------------------------- */

export function ControlStage({ activeCamera }: { activeCamera?: TVCameraId }) {
  return (
    <group>
      {/* выносной пульт управления гонкой */}
      <ControlPanel activeCamera={activeCamera} />

      {/* живой хронометр + статус */}
      <ClockBoard />

      {/* ЗАДАЧА 5.4: широкая телеметрия — спарклайны/отрыв/секторы */}
      <ControlTelemetry />

      {/* прожекторные мачты по краям панели */}
      {[-9.4, 9.4].map((x) => (
        <group
          key={`mast-${x}`}
          position={[CONTROL_DECK_POSITION[0] + x, 0, CONTROL_DECK_POSITION[2] - 3.4]}
        >
          <mesh position={[0, 4.2, 0]}>
            <cylinderGeometry args={[0.12, 0.16, 8.4, 8]} />
            <meshStandardMaterial color="#1a2233" metalness={0.7} roughness={0.4} />
          </mesh>
          <mesh position={[0, 8.4, 0]}>
            <boxGeometry args={[0.9, 0.5, 0.5]} />
            <meshStandardMaterial color="#0b1020" emissive="#ffd400" emissiveIntensity={0.8} />
          </mesh>
          <pointLight position={[0, 8.3, 0]} color="#ffe9a8" intensity={2.4} distance={40} />
        </group>
      ))}
    </group>
  );
}

export default ControlStage;
