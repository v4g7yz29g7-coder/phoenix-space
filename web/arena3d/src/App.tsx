import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Arena } from './scene/Arena';
import { TVDirectorController } from './scene/TVDirectorController';
import { useSocket } from './hooks/useSocket';
import { useArena } from './store/arena';
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { io } from 'socket.io-client';

export default function App() {
  useSocket();
  const connected = useArena((s) => s.connected);
  const radioEvents = useArena((s) => s.radioEvents);
  const agents = useArena((s) => s.agents);
  const raceId = useArena((s) => s.raceId);
  const task = useArena((s) => s.task);
  const currentFlag = useArena((s) => s.currentFlag);
  const addMockAgents = useArena((s) => s.addMockAgents);

  // === LAP COUNTER + OVERTAKE (Sprint 2) ===
  const [laps, setLaps] = useState<Record<string, number>>({});
  const [totalLaps, setTotalLaps] = useState(3);
  const [overtake, setOvertake] = useState<{ by: string; on: string; ts: number } | null>(null);

  useEffect(() => {
    const s = io('/', { transports: ['polling'], reconnection: true });

    s.on('race:start', () => setLaps({}));

    s.on('race:tick', (data: any) => {
      const positions: any[] = data?.positions || [];
      if (typeof data?.total_laps === 'number') setTotalLaps(data.total_laps);
      if (!positions.length) return;
      setLaps((prev) => {
        const next = { ...prev };
        positions.forEach((p) => {
          if (typeof p?.lap === 'number') next[p.agent] = p.lap;
        });
        return next;
      });
    });

    s.on('race:overtake', (data: any) => {
      if (data?.by && data?.on) setOvertake({ by: data.by, on: data.on, ts: Date.now() });
    });

    return () => {
      s.off('race:tick');
      s.off('race:overtake');
      s.close();
    };
  }, []);

  // Баннер обгона живёт 3 секунды
  useEffect(() => {
    if (!overtake) return;
    const t = setTimeout(() => setOvertake(null), 3000);
    return () => clearTimeout(t);
  }, [overtake]);

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

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', background: '#0a0e1a' }}>
      <Canvas shadows camera={{ position: [-8, 4, 8], fov: 55 }}>
        <Arena />
        <TVDirectorController />
        <OrbitControls
          enableDamping
          dampingFactor={0.1}
          minDistance={3}
          maxDistance={40}
          maxPolarAngle={Math.PI / 2.2}
          target={[0, 0.5, 0]}
          enabled={false}
        />
      </Canvas>

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
      </div>

      <div style={overlayLeft}>
        <div style={panelTitle}>LEADERBOARD</div>
        <div style={lapHeader}>
          <span style={{ flex: 1, marginLeft: 22 }}>AGENT</span>
          <span style={{ marginRight: 8 }}>PROG</span>
          <span>LAP</span>
        </div>
        {(() => {
          const list = Object.values(agents).sort((a, b) => b.progress - a.progress);
          const maxLap = list.reduce((m, a) => Math.max(m, laps[a.name] || 0), 0);
          return list.map((a, i) => {
            const lap = laps[a.name] || 0;
            const gap = maxLap - lap;
            return (
              <div key={a.name} style={row}>
                <span style={{ color: a.color }}>{i + 1}.</span>
                <span style={{ flex: 1, marginLeft: 8 }}>{a.name}</span>
                <span style={{ color: '#7a8baa', marginRight: 8 }}>{(a.progress * 100).toFixed(0)}%</span>
                <span style={{ color: '#cdd6ea', fontVariantNumeric: 'tabular-nums' }}>{lap}/{totalLaps}</span>
                {gap >= 1 && <span style={lapBadge}>+{gap}</span>}
              </div>
            );
          });
        })()}
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
      {overtake && (
        <div style={overtakeBanner}>
          🔵 LAPPED! {overtake.by} обошёл {overtake.on}
        </div>
      )}
      {currentFlag && <FlagOverlay flag={currentFlag} />}
    </div>
  );
}

function FlagOverlay({ flag }: { flag: any }) {
  const age = Date.now() - flag.ts;
  if (age > 4000) return null;

  const bg = {
    green:  'rgba(110, 255, 139, 0.15)',
    yellow: 'rgba(255, 215, 0, 0.15)',
    blue:   'rgba(77, 208, 255, 0.15)',
    red:    'rgba(255, 92, 92, 0.25)',
    finish: 'rgba(168, 85, 247, 0.2)',
  }[flag.flag] || 'rgba(0, 0, 0, 0.5)';

  const border = {
    green:  '#6eff8b',
    yellow: '#ffd700',
    blue:   '#4dd0ff',
    red:    '#ff5c5c',
    finish: '#a855f7',
  }[flag.flag] || '#fff';

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'none',
      background: bg, border: `4px solid ${border}`,
      animation: 'pulse 1s ease-in-out',
    }}>
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        fontSize: 64, fontWeight: 900, color: border,
        letterSpacing: 8,
        textShadow: `0 0 40px ${border}`,
      }}>
        {flag.emoji} {flag.label}
      </div>
      <style>{`
        @keyframes pulse {
          0% { opacity: 0; }
          20% { opacity: 1; }
          100% { opacity: 0.6; }
        }
      `}</style>
    </div>
  );
}

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
const lapHeader: CSSProperties = {
  display: 'flex', alignItems: 'center', padding: '2px 0 6px',
  fontSize: 10, fontWeight: 700, letterSpacing: 1, color: '#4a5570',
  borderBottom: '1px solid rgba(122, 139, 170, 0.15)', marginBottom: 4,
};
const lapBadge: CSSProperties = {
  marginLeft: 6, background: '#ff5c5c', color: '#fff', borderRadius: 6,
  padding: '1px 5px', fontSize: 11, fontWeight: 800,
};
const overtakeBanner: CSSProperties = {
  position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)',
  zIndex: 30, background: 'rgba(77, 208, 255, 0.18)', border: '2px solid #4dd0ff',
  borderRadius: 12, padding: '10px 24px', color: '#4dd0ff', fontWeight: 800,
  fontSize: 18, letterSpacing: 1, pointerEvents: 'none',
  boxShadow: '0 0 30px rgba(77, 208, 255, 0.5)',
};
const radioRow: CSSProperties = { padding: '6px 0', borderBottom: '1px solid rgba(122, 139, 170, 0.1)' };
