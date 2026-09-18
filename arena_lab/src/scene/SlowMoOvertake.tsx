import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useArena } from '../store/arena';
import { carWorldPosition } from './Arena';

/* ============================================================================
 * SLOW-MO НА ОБГОНАХ — детектор обгонов + киношный «time-warp» (AI-1, 3.6)
 * ----------------------------------------------------------------------------
 * ЗАДАЧА 3.6 / STAGE «Трассы + Трибуны + TV». Модуль даёт телевизионный приём
 * «замедление на обгоне» и является ЕДИНСТВЕННЫМ владельцем детектора обгонов:
 *
 *   1) DETECTOR (любое место в пелотоне, не только лидер)
 *      Каждый кадр агенты ранжируются по прогрессу. Сравниваем порядок с
 *      прошлым кадром и ищем ЛЮБУЮ перестановку соседей (кто-то кого-то
 *      обогнал) — в том числе борьбу за 2–3 места. Берём самую «переднюю»
 *      пару и взводим короткий всплеск slow-mo (time dilation 0.45×).
 *
 *   2) BATTLE DETECTOR (бок о бок без смены позиции)
 *      Если две машины идут в пределах BATTLE_GAP метров, но ещё не
 *      разъехались по позициям — включаем мягкий slow-mo 0.62× (борьба колёсами).
 *      У него свой, более редкий кулдаун, чтобы не «залипать».
 *
 *   3) TIME DILATION
 *      Коэффициент лежит в `overtakeSlowMo`; авто-режиссёр (useTVDirector.ts)
 *      читает его и подмешивает к глобальному time-scale сцены. Владелец
 *      time-scale один — здесь мы только публикуем состояние.
 *
 *   4) SLOW-MO CAMERA
 *      `overtakeCameraPose()` возвращает кинопозу «боковой slow-mo план» по
 *      середине борющейся пары. TV-режиссёр подхватывает её на время всплеска
 *      (см. useTVDirector.ts) — замедление приходит вместе с монтажным планом,
 *      а не «висит» на случайной камере авто-режиссуры.
 *
 *   5) VISUAL
 *      <SlowMoOvertake /> рисует «пузырь времени» между обгоняющим и
 *      обгоняемым: пульсирующие кольца, каркасную сферу, луч и подсветку.
 *      Всё мутируется в useFrame (ref'ы, никаких React-ререндеров) — приём
 *      из research/racing-game (MIT), src/effects/{Skid,Dust}.tsx.
 *
 * Приёмы вдохновлены research/racing-game (MIT): src/effects/Cameras.tsx
 * (переключение камер) и кинематика в useFrame без ререндеров. Ассетов нет,
 * внешних зависимостей кроме three/@react-three нет.
 *
 * Использование:
 *   // авто-режиссёр (ровно один вызов за кадр):
 *   const slow = updateOvertakeSlowMo(dt, list);
 *   // сцена (внутри <Canvas>):
 *   <SlowMoOvertake />
 * ========================================================================== */

/** Минимальный срез агента, нужный детектору обгонов (совместим с AgentState). */
export interface OvertakeAgentLike {
  name: string;
  progress: number;
  status: string;
  color?: string;
}

/** Коэффициент замедления во время обгона (мягче, чем 0.3× на финише). */
export const OVERTAKE_SLOWMO_DILATION = 0.45;
/** Длительность всплеска slow-mo при обгоне (в секундах сцены). */
export const OVERTAKE_SLOWMO_TIME = 1.8;
/** Пауза между всплесками, чтобы серия обгонов не держала slow-mo вечно. */
export const OVERTAKE_COOLDOWN = 6;
/** Обгонов раньше этой доли дистанции не бывает — отсекаем стартовую «толкучку». */
export const OVERTAKE_MIN_PROGRESS = 0.03;

/** Мягкое замедление для борьбы «бок о бок» (без смены позиции). */
export const BATTLE_SLOWMO_DILATION = 0.62;
/** Длительность всплеска battle slow-mo, сек. */
export const BATTLE_SLOWMO_TIME = 1.1;
/** Дистанция по трассе между машинами, при которой это «борьба», м. */
export const BATTLE_GAP = 2.4;
/** Общий кулдаун для battle-всплесков, сек. */
export const BATTLE_COOLDOWN = 10;
/** Сколько последних обгонов хранить в истории (для HUD/реплея). */
export const OVERTAKE_HISTORY = 8;

/** Полный режим всплеска: обгон / борьба колёсами / тишина. */
export type SlowMoMode = 'overtake' | 'battle' | null;

/** Одно зафиксированное событие обгона — уходит в HUD и лог режиссёра. */
export interface OvertakeEvent {
  /** Кто вышел вперёд. */
  overtaker: string;
  /** Кого обогнали. */
  victim: string;
  /** Новая позиция обгоняющего (1-based). */
  overtakerRank: number;
  /** Какая позиция была у жертвы (1-based). */
  victimRank: number;
  /** Мировая X середины пары в момент обгона. */
  midX: number;
  /** Мировая Z середины пары в момент обгона. */
  midZ: number;
}

/** Публичное состояние детектора (читается HUD'ом, сценой и режиссёром). */
export interface OvertakeSlowMoState {
  /** Идёт ли сейчас всплеск slow-mo (обгон или борьба). */
  active: boolean;
  /** Что именно вызвало всплеск. */
  mode: SlowMoMode;
  /** Остаток всплеска, сек. */
  timer: number;
  /** Полная длительность текущего всплеска, сек. */
  duration: number;
  /** Остаток кулдауна обгонов, сек. */
  cooldown: number;
  /** Остаток кулдауна борьбы, сек. */
  battleCooldown: number;
  /** Имя болида, который вышел вперёд (или null). */
  overtaker: string | null;
  /** Имя болида, которого обогнали (или null). */
  victim: string | null;
  /** Новая позиция обгоняющего (1-based, 0 — нет события). */
  overtakerRank: number;
  /** Позиция жертвы (1-based, 0 — нет события). */
  victimRank: number;
  /** Всего зафиксировано обгонов за заезд. */
  overtakes: number;
  /** Всего зафиксировано эпизодов борьбы за заезд. */
  battles: number;
  /** Текущий коэффициент замедления (0.45 обгон / 0.62 борьба / 1). */
  dilation: number;
  /** Последнее событие обгона (для HUD). */
  lastEvent: OvertakeEvent | null;
  /** История последних обгонов (свежие — в начале). */
  history: OvertakeEvent[];
}

/** Единственный экземпляр состояния — единый источник правды для сцены. */
export const overtakeSlowMo: OvertakeSlowMoState = {
  active: false,
  mode: null,
  timer: 0,
  duration: OVERTAKE_SLOWMO_TIME,
  cooldown: 0,
  battleCooldown: 0,
  overtaker: null,
  victim: null,
  overtakerRank: 0,
  victimRank: 0,
  overtakes: 0,
  battles: 0,
  dilation: OVERTAKE_SLOWMO_DILATION,
  lastEvent: null,
  history: [],
};

/** Порядок имён с прошлого кадра (модульная переменная — без ререндеров). */
let prevOrder: string[] = [];

/** Полный сброс детектора (новый заезд / финиш / размонтирование). */
export function resetOvertakeSlowMo(): void {
  prevOrder = [];
  overtakeSlowMo.active = false;
  overtakeSlowMo.mode = null;
  overtakeSlowMo.timer = 0;
  overtakeSlowMo.duration = OVERTAKE_SLOWMO_TIME;
  overtakeSlowMo.cooldown = 0;
  overtakeSlowMo.battleCooldown = 0;
  overtakeSlowMo.overtaker = null;
  overtakeSlowMo.victim = null;
  overtakeSlowMo.overtakerRank = 0;
  overtakeSlowMo.victimRank = 0;
  overtakeSlowMo.overtakes = 0;
  overtakeSlowMo.battles = 0;
  overtakeSlowMo.dilation = OVERTAKE_SLOWMO_DILATION;
  overtakeSlowMo.lastEvent = null;
  overtakeSlowMo.history = [];
}

/** 0..1: 1 — всплеск только начался, 0 — закончился. */
export function overtakeSlowMoStrength(): number {
  const total = overtakeSlowMo.duration;
  if (total <= 0) return 0;
  return THREE.MathUtils.clamp(overtakeSlowMo.timer / total, 0, 1);
}

/** Имена болидов в порядке убывания прогресса (лидер — первый). */
export function rankOrder(list: OvertakeAgentLike[]): string[] {
  return list
    .filter((a) => a != null)
    .slice()
    .sort((a, b) => b.progress - a.progress)
    .map((a) => a.name);
}

/** 1-based позиция имени в порядке (0, если не найдено). */
export function rankOf(order: string[], name: string | null): number {
  if (!name) return 0;
  const i = order.indexOf(name);
  return i < 0 ? 0 : i + 1;
}

/**
 * Самая «передняя» пара, которая поменялась местами относительно прошлого
 * порядка. Возвращает [обгоняющий, жертва] или null.
 */
function findSwap(prev: string[], now: string[]): [string, string] | null {
  if (prev.length !== now.length || prev.length < 2) return null;
  let best: [string, string] | null = null;
  let bestSum = Infinity;
  for (let i = 0; i < now.length; i++) {
    for (let j = i + 1; j < now.length; j++) {
      const a = now[i];
      const b = now[j];
      const pa = prev.indexOf(a);
      const pb = prev.indexOf(b);
      if (pa < 0 || pb < 0) continue;
      // a был позади b, а теперь впереди → a обогнал b
      if (pa > pb && i < j && i + j < bestSum) {
        bestSum = i + j;
        best = [a, b];
      }
    }
  }
  return best;
}

/** Ближайшая пара «бок о бок» (по дистанции вдоль трассы) или null. */
function findBattle(
  list: OvertakeAgentLike[],
  rankIdx: Map<string, number>,
): [string, string] | null {
  let best: [string, string] | null = null;
  let bestGap = BATTLE_GAP;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const gap = Math.abs(a.progress - b.progress) * 40; // 40 = CAR_RUN_LENGTH
      if (gap > bestGap) continue;
      if (a.progress < OVERTAKE_MIN_PROGRESS || b.progress < OVERTAKE_MIN_PROGRESS) continue;
      // интересна только борьба за близкие позиции
      if (Math.abs((rankIdx.get(a.name) ?? 0) - (rankIdx.get(b.name) ?? 0)) !== 1) continue;
      bestGap = gap;
      best = a.progress >= b.progress ? [a.name, b.name] : [b.name, a.name];
    }
  }
  return best;
}

/**
 * Один шаг детектора. Вызывается РОВНО ОДИН РАЗ за кадр (владелец — авто-
 * режиссёр useTVDirector.ts). Возвращает true, если slow-mo сейчас активен.
 */
export function updateOvertakeSlowMo(dt: number, list: OvertakeAgentLike[]): boolean {
  if (overtakeSlowMo.cooldown > 0) {
    overtakeSlowMo.cooldown = Math.max(0, overtakeSlowMo.cooldown - dt);
  }
  if (overtakeSlowMo.battleCooldown > 0) {
    overtakeSlowMo.battleCooldown = Math.max(0, overtakeSlowMo.battleCooldown - dt);
  }

  const now = rankOrder(list);
  const rankIdx = new Map<string, number>();
  now.forEach((n, i) => rankIdx.set(n, i + 1));

  // --- 1. Обгон: любая перестановка в пелотоне. ---
  let event: OvertakeEvent | null = null;
  if (overtakeSlowMo.cooldown === 0) {
    const swap = findSwap(prevOrder, now);
    if (swap) {
      const [over, under] = swap;
      const oa = list.find((a) => a.name === over);
      const ua = list.find((a) => a.name === under);
      const progress = Math.max(oa?.progress ?? 0, ua?.progress ?? 0);
      if (progress > OVERTAKE_MIN_PROGRESS) {
        const count = Math.max(1, list.length);
        const oi = list.findIndex((a) => a.name === over);
        const ui = list.findIndex((a) => a.name === under);
        const op = carWorldPosition(oa?.progress ?? 0, oi, count);
        const up = carWorldPosition(ua?.progress ?? 0, ui, count);
        event = {
          overtaker: over,
          victim: under,
          overtakerRank: rankOf(now, over),
          victimRank: rankOf(now, under),
          midX: (op.x + up.x) / 2,
          midZ: (op.z + up.z) / 2,
        };
      }
    }
  }

  if (event) {
    overtakeSlowMo.active = true;
    overtakeSlowMo.mode = 'overtake';
    overtakeSlowMo.duration = OVERTAKE_SLOWMO_TIME;
    overtakeSlowMo.timer = OVERTAKE_SLOWMO_TIME;
    overtakeSlowMo.cooldown = OVERTAKE_COOLDOWN;
    overtakeSlowMo.dilation = OVERTAKE_SLOWMO_DILATION;
    overtakeSlowMo.overtaker = event.overtaker;
    overtakeSlowMo.victim = event.victim;
    overtakeSlowMo.overtakerRank = event.overtakerRank;
    overtakeSlowMo.victimRank = event.victimRank;
    overtakeSlowMo.overtakes += 1;
    overtakeSlowMo.lastEvent = event;
    overtakeSlowMo.history = [event, ...overtakeSlowMo.history].slice(0, OVERTAKE_HISTORY);
  } else if (overtakeSlowMo.battleCooldown === 0 && overtakeSlowMo.timer <= 0) {
    // --- 2. Борьба колёсами: рядом, но позиции ещё не сменились. ---
    const battle = findBattle(list, rankIdx);
    if (battle) {
      overtakeSlowMo.active = true;
      overtakeSlowMo.mode = 'battle';
      overtakeSlowMo.duration = BATTLE_SLOWMO_TIME;
      overtakeSlowMo.timer = BATTLE_SLOWMO_TIME;
      overtakeSlowMo.battleCooldown = BATTLE_COOLDOWN;
      overtakeSlowMo.dilation = BATTLE_SLOWMO_DILATION;
      overtakeSlowMo.overtaker = battle[0];
      overtakeSlowMo.victim = battle[1];
      overtakeSlowMo.overtakerRank = rankOf(now, battle[0]);
      overtakeSlowMo.victimRank = rankOf(now, battle[1]);
      overtakeSlowMo.battles += 1;
    }
  }

  prevOrder = now;

  if (overtakeSlowMo.timer > 0) {
    overtakeSlowMo.timer = Math.max(0, overtakeSlowMo.timer - dt);
    if (overtakeSlowMo.timer === 0) {
      overtakeSlowMo.active = false;
      overtakeSlowMo.mode = null;
      overtakeSlowMo.dilation = 1;
    }
  }

  return overtakeSlowMo.active;
}

/* -------------------------------------------------------------------------- */
/*  SLOW-MO CAMERA — кинопоза «боковой план» по середине борющейся пары       */
/* -------------------------------------------------------------------------- */

const _tmpPos = new THREE.Vector3();
const _tmpLook = new THREE.Vector3();

/**
 * Мировая середина текущей борющейся пары (или null, если всплеска нет).
 * Используется и визуалом, и кинокамерой.
 */
export function overtakeZone(out = new THREE.Vector3()): THREE.Vector3 | null {
  if (!overtakeSlowMo.active || !overtakeSlowMo.overtaker) return null;
  const list = Object.values(useArena.getState().agents);
  const count = Math.max(1, list.length);
  const oi = list.findIndex((a) => a.name === overtakeSlowMo.overtaker);
  if (oi < 0) return null;
  const vi = overtakeSlowMo.victim
    ? list.findIndex((a) => a.name === overtakeSlowMo.victim)
    : -1;
  const op = carWorldPosition(list[oi].progress, oi, count);
  const vp = vi >= 0 ? carWorldPosition(list[vi].progress, vi, count) : op;
  return out.set((op.x + vp.x) / 2, 0.9, (op.z + vp.z) / 2);
}

/**
 * Кинопоза slow-mo: камера сбоку от пары, взгляд в её середину. Считается
 * перпендикуляр к вектору «обгоняющий → жертва» в плоскости земли, так что
 * план всегда 3/4 и не зависит от того, разъезжаются болиды по X или по Z.
 * Возвращает false, если всплеска нет (камеру трогать не нужно).
 */
export function overtakeCameraPose(
  outPos = _tmpPos,
  outLook = _tmpLook,
): boolean {
  if (!overtakeSlowMo.active || !overtakeSlowMo.overtaker) return false;
  const list = Object.values(useArena.getState().agents);
  const count = Math.max(1, list.length);
  const oi = list.findIndex((a) => a.name === overtakeSlowMo.overtaker);
  if (oi < 0) return false;
  const vi = overtakeSlowMo.victim
    ? list.findIndex((a) => a.name === overtakeSlowMo.victim)
    : -1;
  const op = carWorldPosition(list[oi].progress, oi, count);
  const vp = vi >= 0 ? carWorldPosition(list[vi].progress, vi, count) : op;

  const mx = (op.x + vp.x) / 2;
  const mz = (op.z + vp.z) / 2;
  let sx = vp.x - op.x;
  let sz = vp.z - op.z;
  let len = Math.hypot(sx, sz);
  if (len < 1e-3) {
    sx = 0;
    sz = 1;
    len = 1;
  }
  const px = -sz / len;
  const pz = sx / len;
  const dist = 7.5;
  outPos.set(mx + px * dist, 3.0, mz + pz * dist);
  outLook.set(mx + sx * 0.18, 0.9, mz + sz * 0.18);
  return true;
}

/* -------------------------------------------------------------------------- */
/*  ВИЗУАЛ: «пузырь времени» вокруг пары обгон-обгоняемый                     */
/* -------------------------------------------------------------------------- */

/**
 * 3D-эффект slow-mo. Появляется только когда детектор активен, позиционируется
 * между болидами пары и пульсирует по остатку всплеска. Ничего не рендерит вне
 * события (`visible=false`). Цвет: золото — обгон, циан — борьба.
 */
export function SlowMoOvertake() {
  const groupRef = useRef<THREE.Group>(null);
  const ringARef = useRef<THREE.Mesh>(null);
  const ringBRef = useRef<THREE.Mesh>(null);
  const shellRef = useRef<THREE.Mesh>(null);
  const beamRef = useRef<THREE.Mesh>(null);
  const lightRef = useRef<THREE.PointLight>(null);

  const ringAMat = useRef<THREE.MeshBasicMaterial>(null);
  const ringBMat = useRef<THREE.MeshBasicMaterial>(null);
  const shellMat = useRef<THREE.MeshBasicMaterial>(null);

  const mid = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, delta) => {
    const grp = groupRef.current;
    if (!grp) return;

    if (!overtakeZone(mid)) {
      grp.visible = false;
      return;
    }
    grp.visible = true;
    grp.position.copy(mid);

    const s = overtakeSlowMoStrength(); // 1 → 0
    const grow = 1 - s; // 0 → 1
    const dt = Math.min(delta, 0.1);
    const battle = overtakeSlowMo.mode === 'battle';
    const color = battle ? '#4dd0ff' : '#ffd400';
    const pulse = battle ? 1.25 : 1;

    if (ringARef.current) {
      ringARef.current.scale.setScalar((1 + grow * 1.6) * pulse);
      ringARef.current.rotation.z += dt * (battle ? 2.4 : 1.6);
    }
    if (ringBRef.current) {
      ringBRef.current.scale.setScalar((1.4 + grow * 2.2) * pulse);
      ringBRef.current.rotation.z -= dt * (battle ? 1.8 : 1.1);
    }
    if (shellRef.current) {
      shellRef.current.rotation.y += dt * (battle ? 1.4 : 0.9);
      shellRef.current.rotation.x += dt * 0.4;
    }
    if (beamRef.current) beamRef.current.scale.set(1, 1 + grow * 0.6, 1);
    if (lightRef.current) {
      lightRef.current.intensity = s * 8;
      lightRef.current.color.set(color);
    }

    if (ringAMat.current) {
      ringAMat.current.opacity = s * 0.8;
      ringAMat.current.color.set(color);
    }
    if (ringBMat.current) ringBMat.current.opacity = s * 0.5;
    if (shellMat.current) {
      shellMat.current.opacity = s * 0.16;
      shellMat.current.color.set(color);
    }
  });

  return (
    <group ref={groupRef} visible={false}>
      {/* Внутреннее кольцо — расширяется от центра обгона. */}
      <mesh ref={ringARef} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.6, 0.06, 10, 48]} />
        <meshBasicMaterial
          ref={ringAMat}
          color="#ffd400"
          transparent
          opacity={0}
          depthWrite={false}
        />
      </mesh>

      {/* Внешнее кольцо — второй фронт «волны времени». */}
      <mesh ref={ringBRef} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[2.2, 0.03, 8, 64]} />
        <meshBasicMaterial
          ref={ringBMat}
          color="#ffffff"
          transparent
          opacity={0}
          depthWrite={false}
        />
      </mesh>

      {/* Каркасная сфера — сам «пузырь замедления». */}
      <mesh ref={shellRef}>
        <icosahedronGeometry args={[1.7, 1]} />
        <meshBasicMaterial
          ref={shellMat}
          color="#ffd400"
          wireframe
          transparent
          opacity={0}
          depthWrite={false}
        />
      </mesh>

      {/* Нисходящий луч, привязывающий пузырь к полотну. */}
      <mesh ref={beamRef} position={[0, -0.9, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[1.5, 1.8, 4, 1, true]} />
        <meshBasicMaterial
          color="#ffd400"
          transparent
          opacity={0.08}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* Мягкая подсветка сцены во время всплеска. */}
      <pointLight
        ref={lightRef}
        color="#ffd400"
        intensity={0}
        distance={9}
        position={[0, 0.6, 0]}
      />
    </group>
  );
}

export default SlowMoOvertake;
