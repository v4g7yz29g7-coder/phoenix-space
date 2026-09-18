import { useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useArena } from '../store/arena';
import { carWorldPosition, finishWorldPosition } from '../scene/Arena';
import {
  OVERTAKE_SLOWMO_DILATION,
  overtakeSlowMo,
  updateOvertakeSlowMo,
  resetOvertakeSlowMo,
} from '../scene/SlowMoOvertake';

/* ============================================================================
 * TV DIRECTOR — 6 камер + авто-режиссура  (FORMULA I1)
 * ----------------------------------------------------------------------------
 * «Телевизионный режиссёр», который сам выбирает план и рулит главной камерой
 * <Canvas>:
 *
 *   1. onboard    — вид от пилота (на носу болида, смотрит вперёд по прямой)
 *   2. chase      — позади болида лидера
 *   3. wide       — орбита вокруг всей арены
 *   4. helicam    — вертолёт над лидером
 *   5. trackside  — статичная придорожная камера
 *   6. finishline — статичная камера на финишной шахматке
 *
 *   • авто-переключение каждые 8–15 сек (случайно, без повтора текущей);
 *   • спец-планы по событиям: OVERTAKE (смена лидера) → chase,
 *     FINISH → finishline, FAILURE → trackside;
 *   • slow-mo на финише: time dilation = 0.3 (глобальный time-scale сцены);
 *   • ЗАДАЧА 3.6 — slow-mo на обгонах: детектор из SlowMoOvertake.tsx
 *     (updateOvertakeSlowMo) вызывается здесь РОВНО ОДИН РАЗ за кадр и
 *     подмешивает time dilation 0.45 в тот же глобальный time-scale.
 *     Приоритет: финиш (0.3) > обгон (0.45) > норма (1).
 *
 * Приёмы вдохновлены research/racing-game (MIT):
 *   src/effects/Cameras.tsx — переключение камер;
 *   кинематика в useFrame без React-ререндеров (мутация refs, lerp позы).
 *
 * Геометрия болидов берётся из Arena.tsx (carWorldPosition / finishWorldPosition),
 * поэтому камеры фреймят РЕАЛЬНЫЕ позиции, а не абстрактную кривую.
 * ========================================================================== */

export type TVCameraId =
  | 'onboard'
  | 'chase'
  | 'wide'
  | 'helicam'
  | 'trackside'
  | 'finishline';

export type TVCameraMode = 'chase' | 'orbit' | 'static';

export interface TVCameraDef {
  id: TVCameraId;
  mode: TVCameraMode;
  /** Для chase: точка слежения. */
  target?: 'leader' | 'track' | 'finish';
  /** Для orbit: центр вращения. */
  center?: 'track' | 'leader';
  /** Для chase: смещение относительно цели. */
  offset?: [number, number, number];
  /** Для orbit: радиус и высота. */
  radius?: number;
  height?: number;
  /** Для static: абсолютная позиция и точка взгляда. */
  position?: [number, number, number];
  lookAt?: 'leader' | 'finish';
}

/** Шесть камер авто-режиссуры. */
export const TV_CAMERAS: TVCameraDef[] = [
  { id: 'onboard', mode: 'chase', target: 'leader', offset: [0.9, 0.55, 0] },
  { id: 'chase', mode: 'chase', target: 'leader', offset: [-4.5, 2.2, 0] },
  { id: 'wide', mode: 'orbit', center: 'track', radius: 48, height: 26 },
  { id: 'helicam', mode: 'orbit', center: 'leader', radius: 8, height: 14 },
  { id: 'trackside', mode: 'static', position: [6, 3, 16], lookAt: 'leader' },
  { id: 'finishline', mode: 'static', position: [30, 5, 0], lookAt: 'finish' },
];

/** План каждой камеры в человекочитаемом виде (для HUD / отладки). */
export const CAMERA_LABELS: Record<TVCameraId, string> = {
  onboard: 'ONBOARD',
  chase: 'CHASE',
  wide: 'WIDE ORBIT',
  helicam: 'HELICAM',
  trackside: 'TRACKSIDE',
  finishline: 'FINISH LINE',
};

/** Коэффициент slow-mo на финише (time dilation). */
export const SLOWMO_DILATION = 0.3;
/** Границы авто-переключения (сек). */
const SWITCH_MIN = 8;
const SWITCH_MAX = 15;
/** Длительность удержания спец-плана «обгон» (сек). */
const OVERTAKE_HOLD = 3.5;
/** Скорость орбиты (рад/сек) и скорость сглаживания камеры. */
const ORBIT_SPEED = 0.35;
const LERP_RATE = 4;

/* ------------------------------------------------------------------ */
/*  Глобальный time-scale (slow-mo 0.3x финиш / 0.45x обгон)           */
/* ------------------------------------------------------------------ */
let timeDilation = 1;

/** Текущий глобальный time-scale (1 = норма, 0.3 = финиш, 0.45 = обгон). */
export function getTimeDilation(): number {
  return timeDilation;
}

/**
 * Однократно патчит clock.getDelta, масштабируя время сцены на timeDilation.
 * Так slow-mo влияет на ВСЕ useFrame-анимации (колёса, движение болидов),
 * а не только на движение камеры.
 */
function installTimeDilation(clock: THREE.Clock) {
  const c = clock as THREE.Clock & { __tvDilated?: boolean };
  if (c.__tvDilated) return;
  const original = clock.getDelta.bind(clock);
  clock.getDelta = () => {
    const real = original();
    if (timeDilation === 1) return real;
    // Компенсируем elapsedTime так, чтобы общий ход времени был real*dilation.
    clock.elapsedTime += real * (timeDilation - 1);
    return real * timeDilation;
  };
  c.__tvDilated = true;
}

/* ------------------------------------------------------------------ */
/*  Утилиты                                                            */
/* ------------------------------------------------------------------ */
const vec3 = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);

const randomDuration = () => SWITCH_MIN + Math.random() * (SWITCH_MAX - SWITCH_MIN);

function pickNext(current: TVCameraId): TVCameraId {
  const options = TV_CAMERAS.filter((c) => c.id !== current);
  return options[Math.floor(Math.random() * options.length)].id;
}

/** Тип события-спецплана. */
export type TVEvent = 'overtake' | 'finish' | 'failure';

/** Какой план соответствует событию. */
export const EVENT_CAMERA: Record<TVEvent, TVCameraId> = {
  overtake: 'chase',
  finish: 'finishline',
  failure: 'trackside',
};

interface CamEnv {
  camera: THREE.Camera;
  def: TVCameraDef;
  leader: THREE.Vector3;
  ahead: THREE.Vector3;
  finish: THREE.Vector3;
  orbit: { current: number };
  delta: number;
}

const staticLook = new THREE.Vector3();
const staticCenter = new THREE.Vector3(0, 1, 0);

function applyCamera({ camera, def, leader, ahead, finish, orbit, delta }: CamEnv) {
  const desired = new THREE.Vector3();
  const look = new THREE.Vector3();

  if (def.mode === 'chase') {
    const [ox, oy, oz] = def.offset ?? [-4, 2, 0];
    desired.set(leader.x + ox, leader.y + oy, leader.z + oz);
    // onboard смотрит вперёд по трассе, chase — на сам болид.
    look.copy(def.id === 'onboard' ? ahead : leader);
  } else if (def.mode === 'orbit') {
    orbit.current += delta * ORBIT_SPEED;
    const center = def.center === 'leader' ? leader : staticCenter;
    const r = def.radius ?? 48;
    const h = def.height ?? 26;
    staticLook.copy(center);
    desired.set(
      center.x + Math.cos(orbit.current) * r,
      h,
      center.z + Math.sin(orbit.current) * r,
    );
    look.copy(staticLook);
  } else {
    const p = def.position ?? [0, 3, 0];
    desired.set(p[0], p[1], p[2]);
    look.copy(def.lookAt === 'finish' ? finish : leader);
  }

  camera.position.lerp(desired, Math.min(1, delta * LERP_RATE));
  camera.lookAt(look);
}

/* ------------------------------------------------------------------ */
/*  Хук авто-режиссуры                                                 */
/* ------------------------------------------------------------------ */
export interface TVDirectorState {
  activeId: TVCameraId;
  slowMo: boolean;
  /** Текущий time-dilation (0.3 финиш, 0.45 обгон, иначе 1). */
  dilation: number;
  /** Идёт ли сейчас slow-mo-всплеск от обгона (задача 3.6). */
  overtaking: boolean;
  /** Кто только что вышел в лидеры (обгоняющий) или null. */
  overtaker: string | null;
  /** Кого обогнали (бывший лидер) или null. */
  victim: string | null;
  /** Сколько обгонов зафиксировано за заезд. */
  overtakes: number;
  /** Имя лидера (или null, если болидов нет). */
  leaderName: string | null;
  cameras: TVCameraDef[];
}

export function useTVDirector(): TVDirectorState {
  const camera = useThree((s) => s.camera);

  const [activeId, setActiveId] = useState<TVCameraId>('wide');
  const [slowMo, setSlowMo] = useState(false);
  const [dilation, setDilation] = useState(1);
  const [overtaking, setOvertaking] = useState(false);
  const [leaderName, setLeaderName] = useState<string | null>(null);

  const activeRef = useRef<TVCameraId>('wide');
  const slowRef = useRef(false);
  const dilationRef = useRef(1);
  const overtakingRef = useRef(false);
  const raceIdRef = useRef<string | null>(null);
  const leaderNameRef = useRef<string | null>(null);
  const timerRef = useRef(0);
  const durationRef = useRef(randomDuration());
  const orbitRef = useRef(0);

  const finishRef = useRef(vec3(finishWorldPosition()));

  // Спец-план «обгон»: следим за сменой лидера.
  const prevLeaderRef = useRef<string | null>(null);
  const eventHoldRef = useRef(0);

  useFrame((state, delta) => {
    installTimeDilation(state.clock);

    const dt = Math.min(delta, 0.1); // защита от больших пауз
    const list = Object.values(useArena.getState().agents);
    const count = list.length;

    // --- Новый заезд → сброс детектора обгонов (без утечки между гонками) ---
    const rid = useArena.getState().raceId;
    if (rid !== raceIdRef.current) {
      raceIdRef.current = rid;
      resetOvertakeSlowMo();
    }

    // --- ЗАДАЧА 3.6: детектор обгона; РОВНО ОДИН вызов за кадр ---
    const overtakingNow = updateOvertakeSlowMo(dt, list);
    if (overtakingNow !== overtakingRef.current) {
      overtakingRef.current = overtakingNow;
      setOvertaking(overtakingNow);
    }

    // --- Определяем лидера и агрегированное состояние гонки ---
    let finished = false;
    let failed = false;
    let leaderIdx = 0;
    let leader = list[0] ?? null;
    for (let i = 0; i < count; i++) {
      const a = list[i];
      if (a.status === 'done') finished = true;
      else if (a.status === 'failed') failed = true;
      if (!leader || a.progress > leader.progress) {
        leader = a;
        leaderIdx = i;
      }
    }
    // Финиш важнее единичного провала.
    if (finished) failed = false;

    const lp = THREE.MathUtils.clamp(leader?.progress ?? 0, 0, 1);
    const leaderPos = leader
      ? vec3(carWorldPosition(lp, leaderIdx, count))
      : new THREE.Vector3(0, 0.3, 0);
    leaderPos.y += 0.4; // чуть выше корпуса болида
    const aheadPos = leader
      ? vec3(carWorldPosition(Math.min(1, lp + 0.02), leaderIdx, count))
      : leaderPos.clone();
    aheadPos.y += 0.4;

    // --- Slow-mo: финиш 0.3x приоритетнее обгона 0.45x, иначе норм. ---
    const wantSlow = finished;
    const nextDilation = finished
      ? SLOWMO_DILATION
      : overtakingNow
        ? OVERTAKE_SLOWMO_DILATION
        : 1;
    timeDilation = nextDilation;
    if (nextDilation !== dilationRef.current) {
      dilationRef.current = nextDilation;
      setDilation(nextDilation);
    }
    if (wantSlow !== slowRef.current) {
      slowRef.current = wantSlow;
      setSlowMo(wantSlow);
    }

    const currentLeaderName = leader?.name ?? null;
    if (currentLeaderName !== leaderNameRef.current) {
      leaderNameRef.current = currentLeaderName;
      setLeaderName(currentLeaderName);
    }

    // --- Спец-план OVERTAKE: лидер сменился (не на старте) ---
    if (eventHoldRef.current > 0) {
      eventHoldRef.current = Math.max(0, eventHoldRef.current - dt);
    } else if (
      !finished &&
      !failed &&
      prevLeaderRef.current !== null &&
      currentLeaderName !== null &&
      prevLeaderRef.current !== currentLeaderName &&
      lp > 0.03
    ) {
      eventHoldRef.current = OVERTAKE_HOLD;
    }
    prevLeaderRef.current = currentLeaderName;

    // --- Выбор активной камеры ---
    let target: TVCameraId = activeRef.current;
    if (finished) {
      target = EVENT_CAMERA.finish;
    } else if (failed) {
      target = EVENT_CAMERA.failure;
    } else if (eventHoldRef.current > 0) {
      target = EVENT_CAMERA.overtake;
    } else {
      timerRef.current += dt;
      if (timerRef.current >= durationRef.current) {
        timerRef.current = 0;
        durationRef.current = randomDuration();
        target = pickNext(activeRef.current);
      }
    }

    if (target !== activeRef.current) {
      activeRef.current = target;
      setActiveId(target);
    }

    const def = TV_CAMERAS.find((c) => c.id === activeRef.current) ?? TV_CAMERAS[0];
    applyCamera({
      camera,
      def,
      leader: leaderPos,
      ahead: aheadPos,
      finish: finishRef.current,
      orbit: orbitRef,
      delta: dt,
    });
  });

  return {
    activeId,
    slowMo,
    dilation,
    overtaking,
    overtaker: overtakeSlowMo.overtaker,
    victim: overtakeSlowMo.victim,
    overtakes: overtakeSlowMo.overtakes,
    leaderName,
    cameras: TV_CAMERAS,
  };
}

export default useTVDirector;
