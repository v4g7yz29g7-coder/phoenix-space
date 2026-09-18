import { useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useArena } from '../store/arena';
import { getTrackProgress, getFinishPoint } from '../scene/Track';

export type TVCameraId = 'onboard' | 'chase' | 'wide' | 'helicam' | 'trackside' | 'finishline';
export type TVCameraMode = 'chase' | 'orbit' | 'static';

export interface TVCameraDef {
  id: TVCameraId;
  mode: TVCameraMode;
  target?: 'leader' | 'track' | 'finish';
  offset?: [number, number, number];
  center?: 'track' | 'leader';
  radius?: number;
  height?: number;
  position?: [number, number, number];
  lookAt?: 'leader' | 'finish';
}

/** Шесть камер авто-режиссуры */
export const TV_CAMERAS: TVCameraDef[] = [
  { id: 'onboard', mode: 'chase', target: 'leader', offset: [0, 0.5, 0] },
  { id: 'chase', mode: 'chase', target: 'leader', offset: [4, 2, -4] },
  { id: 'wide', mode: 'orbit', center: 'track', radius: 60, height: 28 },
  { id: 'helicam', mode: 'orbit', center: 'leader', radius: 20, height: 15 },
  { id: 'trackside', mode: 'static', position: [40, 2, 15], lookAt: 'leader' },
  { id: 'finishline', mode: 'static', position: [0, 3, 0], lookAt: 'finish' },
];

const SLOWMO_FACTOR = 0.3;
const SWITCH_MIN = 8;
const SWITCH_MAX = 15;

/* ------------------------------------------------------------------ */
/*  Глобальный time-scale (slow-mo 0.3x при финише)                     */
/* ------------------------------------------------------------------ */
let timeScale = 1;

function installTimeScale(clock: THREE.Clock) {
  const c = clock as THREE.Clock & { __tvScaled?: boolean };
  if (c.__tvScaled) return;
  const original = clock.getDelta.bind(clock);
  clock.getDelta = () => {
    const real = original();
    if (timeScale === 1) return real;
    // Компенсируем уже накопленное elapsedTime -> масштабируем время
    clock.elapsedTime += real * (timeScale - 1);
    return real * timeScale;
  };
  c.__tvScaled = true;
}

function vec3(p: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(p.x, p.y, p.z);
}

function randomDuration(): number {
  return SWITCH_MIN + Math.random() * (SWITCH_MAX - SWITCH_MIN);
}

function pickNext(current: TVCameraId): TVCameraId {
  const options = TV_CAMERAS.filter((c) => c.id !== current);
  return options[Math.floor(Math.random() * options.length)].id;
}

function applyCamera(
  camera: THREE.Camera,
  def: TVCameraDef,
  leaderPos: THREE.Vector3,
  aheadPos: THREE.Vector3,
  orbitRef: { current: number },
  delta: number,
  finish: THREE.Vector3,
) {
  const desired = new THREE.Vector3();
  const look = new THREE.Vector3();

  if (def.mode === 'chase') {
    const [ox, oy, oz] = def.offset ?? [4, 2, -4];
    desired.set(leaderPos.x + ox, leaderPos.y + oy, leaderPos.z + oz);
    look.copy(def.id === 'onboard' ? aheadPos : leaderPos);
  } else if (def.mode === 'orbit') {
    orbitRef.current += delta * 0.25;
    const center = def.center === 'leader' ? leaderPos : new THREE.Vector3(0, 0, 0);
    const r = def.radius ?? 60;
    const h = def.height ?? 20;
    desired.set(center.x + Math.cos(orbitRef.current) * r, h, center.z + Math.sin(orbitRef.current) * r);
    look.copy(center);
  } else {
    const p = def.position ?? [0, 3, 0];
    desired.set(p[0], p[1], p[2]);
    look.copy(def.lookAt === 'finish' ? finish : leaderPos);
  }

  camera.position.lerp(desired, Math.min(1, delta * (orbitRef.current === 0 ? 20 : 4)));
  camera.lookAt(look);
}

/* ------------------------------------------------------------------ */
/*  Хук авто-режиссуры                                                  */
/* ------------------------------------------------------------------ */
export function useTVDirector() {
  const camera = useThree((s) => s.camera);
  const [activeId, setActiveId] = useState<TVCameraId>('chase');
  const [slowMo, setSlowMo] = useState(false);

  const activeRef = useRef<TVCameraId>('chase');
  const slowRef = useRef(false);
  const timerRef = useRef(0);
  const durationRef = useRef(randomDuration());
  const orbitRef = useRef(0);
  const finish = useMemo(() => vec3(getFinishPoint()), []);

  useFrame((state, delta) => {
    installTimeScale(state.clock);

    const list = Object.values(useArena.getState().agents);

    let finished = false;
    let failed = false;
    for (const a of list) {
      if (a.status === 'done') finished = true;
      if (a.status === 'failed') failed = true;
    }
    if (finished) failed = false;

    let leader: { progress: number } | null = null;
    for (const a of list) {
      if (!leader || a.progress > leader.progress) leader = a;
    }
    const lp = THREE.MathUtils.clamp(leader?.progress ?? 0, 0, 1);
    const leaderPos = vec3(getTrackProgress(lp));
    const aheadPos = vec3(getTrackProgress((lp + 0.02) % 1));
    leaderPos.y += 0.4;

    // Slow-mo при финише
    const wantSlow = finished;
    timeScale = wantSlow ? SLOWMO_FACTOR : 1;
    if (wantSlow !== slowRef.current) {
      slowRef.current = wantSlow;
      setSlowMo(wantSlow);
    }

    // Выбор камеры
    let target: TVCameraId = activeRef.current;
    if (finished) {
      target = 'finishline';
    } else if (failed) {
      target = 'trackside';
    } else {
      timerRef.current += delta;
      if (timerRef.current >= durationRef.current) {
        timerRef.current = 0;
        durationRef.current = randomDuration();
        target = pickNext(activeRef.current);
      }
    }

    if (target !== activeRef.current) {
      activeRef.current = target;
      // setActiveId НЕ вызываем — это вызывает ре-рендер и дёрганье
      // активную камеру показываем через UI отдельно (throttled)
    }

    const def = TV_CAMERAS.find((c) => c.id === activeRef.current) ?? TV_CAMERAS[0];
    applyCamera(camera, def, leaderPos, aheadPos, orbitRef, delta, finish);
  });

  return { activeId, slowMo, cameras: TV_CAMERAS };
}

export default useTVDirector;
