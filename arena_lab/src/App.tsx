import { Canvas } from '@react-three/fiber';
import { Arena } from './scene/Arena';
import { Track } from './scene/Track';
import { PitLane } from './scene/PitLane';
import { Tribunes } from './scene/Tribunes';
import { CameraCrane } from './scene/CameraCrane';
import { AgentDashboard } from './scene/AgentDashboard';
import { SlowMoOvertake } from './scene/SlowMoOvertake';
import { CinematicIntro } from './scene/CinematicIntro';
import { FlagSync } from './scene/FlagSync';
import { CameraShake, FlashCut } from './scene/CameraShake';
import { ControlStage } from './scene/ControlStage';
import { AuthGate } from './scene/AuthGate';
import { AuthHUD } from './scene/AuthHUD';
// ЗАДАЧА 6.4: станция создания агентов в паддоке
import { AgentCreator } from './scene/AgentCreator';
// ЗАДАЧА 6.5: станция песочницы — изолированный прогон агентского кода
import { AgentSandbox } from './scene/AgentSandbox';
// ЗАДАЧА 7.2: API /parts, /builds — павильон маркетплейса тюнинга на пит-лейне
import { MarketStage } from './scene/MarketStage';
// ЗАДАЧА 7.3: UI-каталог запчастей — стенд «PARTS CATALOG» на пит-лейне
import { PartsCatalog } from './scene/PartsCatalog';
// ЗАДАЧА 6.2: схема БД — 3D-стела реестра + живой DDL-инспектор
import { DbSchemaBoard } from './scene/DbSchema';
import { DbSchemaLive } from './scene/DbSchemaLive';
// ЗАДАЧА 6.2: DML-слой — параметризованные запросы, выведенные из того же реестра
import { DbSchemaQueries } from './scene/DbSchemaQueries';
import { useTVDirector } from './hooks/useTVDirector';
import type { TVCameraId } from './hooks/useTVDirector';
import { useSocket } from './hooks/useSocket';
import { useArena } from './store/arena';
import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

/** Драйвер авто-режиссуры: живёт внутри <Canvas> и рулит камерой + slow-mo */
function TVDirectorDriver({
  onUpdate,
}: {
  onUpdate: (
    id: TVCameraId,
    slow: boolean,
    dilation: number,
    overtaker: string | null,
    overtakes: number,
  ) => void;
}) {
  const { activeId, slowMo, dilation, overtaker, overtakes } = useTVDirector();
  useEffect(() => {
    onUpdate(activeId, slowMo, dilation, overtaker, overtakes);
  }, [activeId, slowMo, dilation, overtaker, overtakes, onUpdate]);
  return null;
}

export default function App() {
  useSocket();
  const connected = useArena((s) => s.connected);
  const radioEvents = useArena((s) => s.radioEvents);
  const agents = useArena((s) => s.agents);
  const raceId = useArena((s) => s.raceId);
  const task = useArena((s) => s.task);
  const addMockAgents = useArena((s) => s.addMockAgents);

  const [camId, setCamId] = useState<TVCameraId>('chase');
  const [slowMo, setSlowMo] = useState(false);
  const [camDilation, setCamDilation] = useState(1);
  const [overtaker, setOvertaker] = useState<string | null>(null);
  const [overtakes, setOvertakes] = useState(0);
  // ЗАДАЧА 6.2: показ живого инспектора схемы БД (DDL/целостность/миграции)
  const [showDbSchema, setShowDbSchema] = useState(false);
  // ЗАДАЧА 6.2: консоль DML (INSERT/UPSERT/SELECT/DELETE + bind-параметры)
  const [showDbQueries, setShowDbQueries] = useState(false);
  const handleCam = useCallback(
    (
      id: TVCameraId,
      slow: boolean,
      dilation: number,
      who: string | null,
      total: number,
    ) => {
      setCamId(id);
      setSlowMo(slow);
      setCamDilation(dilation);
      setOvertaker(who);
      setOvertakes(total);
    },
    [],
  );

  useEffect(() => {
    // Мок только если нет реальных агентов и нет подключения
    if (Object.keys(agents).length > 0) return;
    addMockAgents();
    const iv = setInterval(() => {
      const state = useArena.getState();
      // Если пришли реальные агенты от race:start — стопаем мок
      if (state.raceId && state.raceId !== 'mock_race') {
        clearInterval(iv);
        return;
      }
      Object.values(state.agents).forEach((a) => {
        if (a.status === 'idle') a.status = 'running';
        a.progress = Math.min(1, a.progress + Math.random() * 0.01);
      });
      useArena.setState({ agents: { ...state.agents } });
    }, 100);
    return () => clearInterval(iv);
  }, []);

  // Slow-mo активен, если финишный (0.3x) или обгонный (0.45x) всплеск.
  const slowNow = slowMo || camDilation < 1;

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', background: '#0a0e1a' }}>
      <Canvas shadows camera={{ position: [-25, 25, 55], fov: 50 }}>
        <Arena />
        {/* ЗАДАЧА 4.4: синхронизация старта — гантри с 5 огнями + 🟢 флаг */}
        <FlagSync />
        <Track />
        <PitLane />
        {/* ЗАДАЧА 4.1: «Сцена в боксах» — кинематографичное интро пит-стены */}
        <CinematicIntro />
        <Tribunes />
        <AgentDashboard />
        <TVDirectorDriver onUpdate={handleCam} />
        {/* ЗАДАЧА 3.6: «пузырь времени» на обгоне */}
        <SlowMoOvertake />
        {/* ЗАДАЧА 3.7: процедурная тряска камеры (после режиссёра) */}
        <CameraShake />
        {/* ЗАДАЧА 5.4: /control — выносной пульт Mission Control */}
        <ControlStage activeCamera={camId} />
        {/* ЗАДАЧА 6.1: физический терминал регистрации/логина пилота (JWT) */}
        <AuthGate position={[-14, 0, 10]} rotation={[0, Math.PI / 6, 0]} />
        {/* ЗАДАЧА 6.4: «Агентный цех» — физическая станция создания/регистрации агента */}
        <AgentCreator position={[14, 0, 10]} rotation={[0, -Math.PI / 6, 0]} />
        {/* ЗАДАЧА 6.5: «Sandbox Lab» — изоляция агентского кода до допуска к заезду */}
        <AgentSandbox position={[0, 0, 13]} rotation={[0, 0, 0]} />
        {/* ЗАДАЧА 6.2: 3D-стела реестра схемы БД (таблицы/колонки/целостность) */}
        <DbSchemaBoard position={[-20, 0, -8]} dialect="postgres" />
        {/* ЗАДАЧА 7.3: интерактивный каталог запчастей на пит-лейне */}
        <PartsCatalog />
      </Canvas>

      {/* ЗАДАЧА 6.1: 2D-HUD авторизации — форма всегда под рукой поверх арены */}
      <AuthHUD initialOpen={false} />

      {/* ЗАДАЧА 6.2: тумблер живого инспектора схемы БД */}
      <button style={dbSchemaBtn(showDbSchema)} onClick={() => setShowDbSchema((v) => !v)}>
        🗄 SCHEMA
      </button>
      {showDbSchema && <DbSchemaLive onClose={() => setShowDbSchema(false)} />}

      {/* ЗАДАЧА 6.2: тумблер DML-консоли (паттерн запросов к БД для бэкенда) */}
      <button style={dbQueriesBtn(showDbQueries)} onClick={() => setShowDbQueries((v) => !v)}>
        🧩 DML
      </button>
      {showDbQueries && <DbSchemaQueries onClose={() => setShowDbQueries(false)} />}

      {/* ЗАДАЧА 3.7: монтажный flash cut на смене телеплана */}
      <FlashCut cutKey={camId} />

      <div style={overlayTop}>
        <div style={{
          fontSize: 22, fontWeight: 900, letterSpacing: 3,
          background: 'linear-gradient(90deg, #4dd0ff, #a855f7, #ff7eb6)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>
          🎮 FORMULA I1
        </div>
        <div style={{ fontSize: 12, color: connected ? '#6eff8b' : '#ff5c5c', marginTop: 4 }}>
          {connected ? '● LIVE' : '● OFFLINE'} {raceId ? `· ${raceId}` : ''}
        </div>
        <div style={{ fontSize: 11, color: slowNow ? '#ffd400' : '#7a8baa', marginTop: 4 }}>
          🎥 {camId.toUpperCase()}
          {slowMo
            ? ' · SLOW-MO 0.3x'
            : overtaker && camDilation < 1
              ? ` · SLOW-MO ${camDilation.toFixed(2)}x`
              : ''}
        </div>
        {overtakes > 0 && (
          <div style={{ fontSize: 11, color: '#a855f7', marginTop: 2 }}>
            🏎 ОБГОНОВ: {overtakes}{overtaker ? ` · последний: ${overtaker}` : ''}
          </div>
        )}
      </div>

      <div style={overlayLeft}>
        <div style={panelTitle}>LEADERBOARD</div>
        {Object.values(agents)
          .sort((a, b) => b.progress - a.progress)
          .map((a, i) => (
            <div key={a.name} style={row}>
              <span style={{ color: a.color }}>{i + 1}.</span>
              <span style={{ flex: 1, marginLeft: 8 }}>{a.name}</span>
              <span style={{ color: '#7a8baa' }}>{(a.progress * 100).toFixed(0)}%</span>
            </div>
          ))}
      </div>

      <div style={overlayRight}>
        <div style={panelTitle}>📻 RADIO</div>
        {radioEvents.slice(0, 8).map((e, i) => (
          <div key={i} style={radioRow}>
            <div style={{ color: '#7a8baa', fontSize: 10 }}>
              {new Date(e.ts).toLocaleTimeString('ru-RU')}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.4 }}>{e.text}</div>
          </div>
        ))}
        {radioEvents.length === 0 && (
          <div style={{ color: '#4a5570', fontSize: 12 }}>Ожидание событий...</div>
        )}
      </div>

      {task && (
        <div style={overlayBottom}>
          <span style={{ color: '#7a8baa', fontSize: 11 }}>TASK:</span>
          <span style={{ marginLeft: 8, color: '#e0e6f0', fontSize: 13 }}>{task}</span>
        </div>
      )}
    </div>
  );
}

const dbSchemaBtn = (active: boolean): CSSProperties => ({
  position: 'absolute', top: 20, right: 24, zIndex: 20,
  padding: '7px 14px', borderRadius: 8, cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 12, fontWeight: 700, letterSpacing: 1,
  color: active ? '#0a0e1a' : '#e0e6f0',
  background: active ? '#4dd0ff' : 'rgba(20, 26, 45, 0.85)',
  border: '1px solid rgba(77, 208, 255, 0.55)',
  boxShadow: active ? '0 0 18px rgba(77, 208, 255, 0.5)' : 'none',
  transition: 'all 120ms ease-out',
});

// ЗАДАЧА 6.2: тумблер DML-консоли — ставим под кнопкой SCHEMA, чтобы не перекрывались.
const dbQueriesBtn = (active: boolean): CSSProperties => ({
  ...dbSchemaBtn(active),
  top: 60,
  border: '1px solid rgba(168, 85, 247, 0.55)',
  boxShadow: active ? '0 0 18px rgba(168, 85, 247, 0.5)' : 'none',
});

const overlayTop: CSSProperties = { position: 'absolute', top: 20, left: 24, zIndex: 10, pointerEvents: 'none' };
const overlayLeft: CSSProperties = {
  position: 'absolute', top: 80, left: 24, zIndex: 10, width: 200,
  background: 'rgba(20, 26, 45, 0.75)', backdropFilter: 'blur(10px)',
  borderRadius: 12, padding: 14, pointerEvents: 'none',
};
const overlayRight: CSSProperties = {
  position: 'absolute', top: 80, right: 24, zIndex: 10, width: 280,
  background: 'rgba(20, 26, 45, 0.75)', backdropFilter: 'blur(10px)',
  borderRadius: 12, padding: 14, maxHeight: '70vh', overflow: 'hidden', pointerEvents: 'none',
};
const overlayBottom: CSSProperties = {
  position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
  zIndex: 10, background: 'rgba(20, 26, 45, 0.85)', backdropFilter: 'blur(10px)',
  borderRadius: 20, padding: '8px 20px', pointerEvents: 'none',
};
const panelTitle: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: '#7a8baa', marginBottom: 10 };
const row: CSSProperties = { display: 'flex', alignItems: 'center', padding: '4px 0', fontSize: 13 };
const radioRow: CSSProperties = { padding: '6px 0', borderBottom: '1px solid rgba(122, 139, 170, 0.1)' };
