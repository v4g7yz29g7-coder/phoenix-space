import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useArena } from '../store/arena';
import { carWorldPosition, finishWorldPosition } from './Arena';
import { TV_CAMERAS, CAMERA_LABELS } from '../hooks/useTVDirector';
import type { TVCameraDef, TVCameraId } from '../hooks/useTVDirector';
import type { CSSProperties } from 'react';

/* ============================================================================
 * TV DIRECTOR — 6 физических камер + эфирная графика  (FORMULA I1 / AI-1)
 * ----------------------------------------------------------------------------
 * ЗАДАЧА 3.5. Файл делает два уровня телевизионной постановки:
 *
 *  1) TVDirectorRigs  (внутри <Canvas>) — материализует ШЕСТЬ камер-ригов в
 *     сцене: onboard · chase · wide · helicam · trackside · finishline.
 *     Каждый кадр поза рига пересчитывается из РЕАЛЬНОЙ геометрии болидов
 *     (Arena.carWorldPosition / finishWorldPosition). У камеры «в эфире»
 *     горит красный TALLY + конус кадра; у остальных — серый стендбай.
 *
 *  2) TVDirectorHud   (DOM-оверлей) — эфирная графика телережиссёра:
 *     LIVE-bug, план «CAM n/6 · <ИМЯ>», нижняя плашка лидера, индикатор
 *     спец-плана и бейдж REPLAY 0.3× на финише. Всё читает активный план из
 *     общей шины режиссёра (props из useTVDirector), только отображение.
 *
 * Приёмы вдохновлены research/racing-game (MIT), src/effects/Cameras.tsx:
 *   переключение планов + кинематика в useFrame без React-ререндеров.
 * Код написан с нуля в терминах проекта AI-1.
 *
 * Использование:
 *   <Canvas><TVDirectorRigs activeId={camId} /></Canvas>
 *   <TVDirectorHud activeId={camId} slowMo={slowMo} />
 * ========================================================================== */

const ORBIT_SPEED = 0.35; // рад/сек — синхронно с useTVDirector.ts
const LERP_RATE = 4; // сглаживание перемещения рига
const FRUSTUM_LEN = 7; // длина пирамиды кадра

/** Человекочитаемое описание каждого плана (для HUD). */
export const TV_CAMERA_DESC: Record<TVCameraId, string> = {
  onboard: 'ONBOARD · от пилота',
  chase: 'CHASE · позади лидера',
  wide: 'WIDE · орбита арены',
  helicam: 'HELI · вертолёт над лидером',
  trackside: 'TRACKSIDE · у полотна',
  finishline: 'FINISH · шахматка',
};

const vec = (p: { x: number; y: number; z: number }) =>
  new THREE.Vector3(p.x, p.y, p.z);

interface PoseCtx {
  leaderPos: THREE.Vector3;
  aheadPos: THREE.Vector3;
  finishPos: THREE.Vector3;
  trackCenter: THREE.Vector3;
  orbit: number;
}

/** Поза камеры для конкретного плана — единая логика для ригов. */
function resolvePose(
  def: TVCameraDef,
  ctx: PoseCtx,
  outPos: THREE.Vector3,
  outLook: THREE.Vector3,
) {
  if (def.mode === 'chase') {
    const [ox, oy, oz] = def.offset ?? [-4, 2, 0];
    outPos.set(ctx.leaderPos.x + ox, ctx.leaderPos.y + oy, ctx.leaderPos.z + oz);
    outLook.copy(def.id === 'onboard' ? ctx.aheadPos : ctx.leaderPos);
  } else if (def.mode === 'orbit') {
    const center = def.center === 'leader' ? ctx.leaderPos : ctx.trackCenter;
    const r = def.radius ?? 48;
    const h = def.height ?? 26;
    outPos.set(
      center.x + Math.cos(ctx.orbit) * r,
      h,
      center.z + Math.sin(ctx.orbit) * r,
    );
    outLook.copy(center);
  } else {
    const p = def.position ?? [0, 3, 0];
    outPos.set(p[0], p[1], p[2]);
    outLook.copy(def.lookAt === 'finish' ? ctx.finishPos : ctx.leaderPos);
  }
}

/* -------------------------------------------------------------------------- */
/*  Физический корпус камеры (объектив смотрит в -Z)                          */
/* -------------------------------------------------------------------------- */
function CameraBody({ onAir }: { onAir: boolean }) {
  return (
    <group>
      {/* тушка */}
      <mesh castShadow>
        <boxGeometry args={[0.5, 0.45, 0.9]} />
        <meshStandardMaterial color="#20263a" metalness={0.6} roughness={0.4} />
      </mesh>
      {/* объектив */}
      <mesh position={[0, 0, -0.6]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.16, 0.2, 0.5, 20]} />
        <meshStandardMaterial color="#0b0e16" metalness={0.9} roughness={0.2} />
      </mesh>
      {/* стекло */}
      <mesh position={[0, 0, -0.86]}>
        <circleGeometry args={[0.15, 20]} />
        <meshStandardMaterial
          color={onAir ? '#ff5c5c' : '#3fd0ff'}
          emissive={onAir ? '#ff5c5c' : '#3fd0ff'}
          emissiveIntensity={onAir ? 1.2 : 0.6}
          transparent
          opacity={0.9}
        />
      </mesh>
      {/* видоискатель */}
      <mesh position={[0.3, 0.18, 0.2]} rotation={[0, 0, -0.4]}>
        <boxGeometry args={[0.16, 0.12, 0.24]} />
        <meshStandardMaterial color="#111624" metalness={0.8} roughness={0.3} />
      </mesh>
    </group>
  );
}

export interface TVDirectorRigsProps {
  /** Камера, находящаяся сейчас «в эфире» (подсветка TALLY). */
  activeId: TVCameraId;
}

/**
 * Шесть физических камер-ригов в сцене. Не трогает главную камеру <Canvas> —
 * только расставляет и подсвечивает риги по текущему плану режиссёра.
 */
export function TVDirectorRigs({ activeId }: TVDirectorRigsProps) {
  const groupRefs = useRef<Array<THREE.Group | null>>([]);
  const tallyRefs = useRef<Array<THREE.MeshStandardMaterial | null>>([]);
  const orbitRef = useRef(0);

  const tmpDesired = useMemo(() => new THREE.Vector3(), []);
  const tmpLook = useMemo(() => new THREE.Vector3(), []);
  const trackCenter = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    orbitRef.current += dt * ORBIT_SPEED;

    // --- Лидер заезда (та же логика, что в useTVDirector). ---
    const list = Object.values(useArena.getState().agents);
    const count = list.length;
    let leaderIdx = 0;
    let leader = list[0];
    for (let i = 0; i < count; i++) {
      if (!leader || list[i].progress > leader.progress) {
        leader = list[i];
        leaderIdx = i;
      }
    }
    const lp = THREE.MathUtils.clamp(leader?.progress ?? 0, 0, 1);
    const safeCount = Math.max(1, count);
    const leaderPos = vec(carWorldPosition(lp, leaderIdx, safeCount));
    leaderPos.y += 0.4;
    const aheadPos = vec(
      carWorldPosition(Math.min(1, lp + 0.02), leaderIdx, safeCount),
    );
    aheadPos.y += 0.4;
    const finishPos = vec(finishWorldPosition());

    const ctx: PoseCtx = {
      leaderPos,
      aheadPos,
      finishPos,
      trackCenter,
      orbit: orbitRef.current,
    };

    TV_CAMERAS.forEach((def, i) => {
      const g = groupRefs.current[i];
      if (!g) return;

      resolvePose(def, ctx, tmpDesired, tmpLook);
      g.position.lerp(tmpDesired, Math.min(1, dt * LERP_RATE));
      g.lookAt(tmpLook);

      const mat = tallyRefs.current[i];
      if (mat) {
        const onAir = def.id === activeId;
        mat.color.set(onAir ? '#ff2d2d' : '#3a4256');
        mat.emissiveIntensity = onAir ? 2.4 : 0.12;
      }
    });
  });

  return (
    <>
      {TV_CAMERAS.map((def, i) => {
        const onAir = def.id === activeId;
        return (
          <group
            key={def.id}
            ref={(el) => {
              groupRefs.current[i] = el;
            }}
          >
            <CameraBody onAir={onAir} />

            {/* Конус кадра (FOV-пирамида), смотрит вперёд по -Z */}
            <mesh position={[0, 0, -FRUSTUM_LEN / 2]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[2.0, FRUSTUM_LEN, 4, 1, true]} />
              <meshBasicMaterial
                color={onAir ? '#ff5c5c' : '#4dd0ff'}
                transparent
                opacity={onAir ? 0.12 : 0.05}
                side={THREE.DoubleSide}
                depthWrite={false}
              />
            </mesh>

            {/* TALLY-лампа: красная у камеры в эфире */}
            <mesh
              position={[0, 0.34, 0.18]}
              ref={(el) => {
                tallyRefs.current[i] = el
                  ? (el.material as THREE.MeshStandardMaterial)
                  : null;
              }}
            >
              <sphereGeometry args={[0.1, 12, 12]} />
              <meshStandardMaterial
                color="#3a4256"
                emissive="#ff2d2d"
                emissiveIntensity={0.12}
              />
            </mesh>

            {/* Ореол эфира */}
            {onAir && (
              <pointLight
                color="#ff2d2d"
                intensity={4}
                distance={5}
                position={[0, 0.5, 0]}
              />
            )}
          </group>
        );
      })}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Эфирная графика (DOM-оверлей)                                             */
/* -------------------------------------------------------------------------- */

export interface TVDirectorHudProps {
  activeId: TVCameraId;
  slowMo: boolean;
}

const HUD_CSS = `
@keyframes tvdBlink { 0%,55% { opacity: 1 } 56%,100% { opacity: .15 } }
@keyframes tvdCut { from { transform: translateY(8px) scale(.96); opacity: 0 } to { transform: none; opacity: 1 } }
@keyframes tvdScan { from { background-position: 0 0 } to { background-position: 0 6px } }
.tvd-live-dot { animation: tvdBlink 1.1s steps(1, end) infinite; }
.tvd-cut { animation: tvdCut .32s cubic-bezier(.2,.9,.3,1) both; }
`;

/** Телевизионная эфирная графика: LIVE, номер плана, лидер, REPLAY. */
export function TVDirectorHud({ activeId, slowMo }: TVDirectorHudProps) {
  const raceId = useArena((s) => s.raceId);
  const connected = useArena((s) => s.connected);
  const agents = useArena((s) => s.agents);

  const sorted = Object.values(agents).sort((a, b) => b.progress - a.progress);
  const leader = sorted[0];
  const idx = Math.max(0, TV_CAMERAS.findIndex((c) => c.id === activeId));

  return (
    <>
      <style>{HUD_CSS}</style>

      {/* LIVE-bug */}
      <div style={liveBug}>
        <span style={{ ...liveDot, background: connected ? '#ff2d2d' : '#556' }} className={connected ? 'tvd-live-dot' : undefined} />
        <span style={{ fontWeight: 800, letterSpacing: 2 }}>
          {connected ? 'LIVE' : 'OFFLINE'}
        </span>
        {raceId && (
          <span style={{ color: '#8fa2c4', fontWeight: 500, letterSpacing: 0.5 }}>
            {raceId}
          </span>
        )}
      </div>

      {/* REPLAY / SLOW-MO badge */}
      {slowMo && (
        <div style={replayBadge} className="tvd-cut">
          <span style={{ fontSize: 18 }}>⏪</span> REPLAY · 0.3×
        </div>
      )}

      {/* Нижняя плашка плана + полоса 6 камер */}
      <div style={planPlate}>
        <div key={activeId} className="tvd-cut" style={planRow}>
          <span style={camNum}>CAM {idx + 1}/6</span>
          <span style={camName}>{CAMERA_LABELS[activeId]}</span>
          <span style={camDesc}>{TV_CAMERA_DESC[activeId]}</span>
        </div>
        <div style={strip}>
          {TV_CAMERAS.map((c, i) => {
            const onAir = c.id === activeId;
            return (
              <div
                key={c.id}
                title={TV_CAMERA_DESC[c.id]}
                style={{
                  ...cell,
                  borderColor: onAir ? '#ff2d2d' : 'rgba(122,139,170,.35)',
                  background: onAir
                    ? 'linear-gradient(180deg,#ff2d2d33,#ff2d2d11)'
                    : 'transparent',
                  color: onAir ? '#ff8a8a' : '#7a8baa',
                }}
              >
                <span style={{ fontSize: 10, fontWeight: 800 }}>{i + 1}</span>
                <span style={{ fontSize: 8, letterSpacing: 0.4 }}>
                  {onAir ? 'PGM' : 'STBY'}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Мини-табло лидера */}
      {leader && (
        <div style={leaderTicker}>
          <span style={{ color: '#ffd400', fontWeight: 800, fontSize: 11 }}>P1</span>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              background: leader.color,
              display: 'inline-block',
            }}
          />
          <span style={{ fontWeight: 700 }}>{leader.name}</span>
          <span style={{ color: '#8fa2c4', marginLeft: 'auto' }}>
            {(leader.progress * 100).toFixed(0)}%
          </span>
        </div>
      )}
    </>
  );
}

/* ----------------------------- стили HUD ---------------------------------- */
const liveBug: CSSProperties = {
  position: 'absolute',
  top: 20,
  right: 24,
  zIndex: 12,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 12px',
  borderRadius: 8,
  background: 'rgba(10,14,26,.82)',
  border: '1px solid rgba(255,45,45,.5)',
  color: '#e6ecf7',
  fontSize: 12,
  pointerEvents: 'none',
};
const liveDot: CSSProperties = {
  width: 9,
  height: 9,
  borderRadius: '50%',
  display: 'inline-block',
};
const replayBadge: CSSProperties = {
  position: 'absolute',
  top: 20,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 12,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 18px',
  borderRadius: 20,
  background: 'rgba(255,212,0,.14)',
  border: '1px solid rgba(255,212,0,.6)',
  color: '#ffd400',
  fontWeight: 800,
  letterSpacing: 2,
  fontSize: 13,
  pointerEvents: 'none',
};
const planPlate: CSSProperties = {
  position: 'absolute',
  bottom: 20,
  left: 24,
  zIndex: 12,
  minWidth: 300,
  padding: '10px 14px',
  borderRadius: 12,
  background: 'rgba(10,14,26,.82)',
  borderLeft: '3px solid #ff2d2d',
  pointerEvents: 'none',
};
const planRow: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  marginBottom: 8,
};
const camNum: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: '#ff5c5c',
  letterSpacing: 1.5,
};
const camName: CSSProperties = {
  fontSize: 17,
  fontWeight: 900,
  color: '#e6ecf7',
  letterSpacing: 1.5,
};
const camDesc: CSSProperties = {
  fontSize: 10,
  color: '#7a8baa',
};
const strip: CSSProperties = { display: 'flex', gap: 6 };
const cell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  width: 40,
  height: 34,
  borderRadius: 6,
  border: '1px solid rgba(122,139,170,.35)',
};
const leaderTicker: CSSProperties = {
  position: 'absolute',
  bottom: 20,
  right: 24,
  zIndex: 12,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 14px',
  borderRadius: 20,
  background: 'rgba(10,14,26,.82)',
  border: '1px solid rgba(122,139,170,.25)',
  color: '#e6ecf7',
  fontSize: 13,
  minWidth: 200,
  pointerEvents: 'none',
};

export default TVDirectorRigs;
