/**
 * FlagSync.tsx — Синхронизация с 🟢 флагом (стартовая процедура)
 * ============================================================================
 * FORMULA I1 · STAGE Cinematic Intro · ЗАДАЧА 4.4
 *
 * Единый «мастер-таймер» старта заезда: пять красных стартовых огней на
 * гантри загораются по одному, после короткой паузы гаснут — и одновременно
 * взмывает зелёный флаг. Все кинематографичные подсистемы сцены
 * (интро-камера, запуск болидов, TV-режиссёр, slow-mo) подписываются на
 * ОДНО событие — переход в фазу `green` — и синхронно стартуют от него, а не
 * от собственных независимых таймеров.
 *
 * Почему так (референс приёмов — research/racing-game, MIT © 2021 pmndrs,
 * см. research/audit.md §1 «per-frame rig без ре-рендеров»):
 *   • секвенция старта — чистая функция `flagSequenceAt(elapsed)` от времени:
 *     детерминированно, тестируемо, легко перематывается;
 *   • состояние живёт в zustand-сторе `useFlagSyncStore` — один драйвер
 *     (`<FlagSync/>` → `useFlagSync`) пишет, остальные читают без лишних
 *     React-ререндеров;
 *   • визуал (5 лампочек / гантри / полотнище флага) мутируется на refs в
 *     `useFrame` — ноль аллокаций и ноль ререндеров на кадр.
 *
 * Фазы `FlagPhase`:
 *   idle      — заезд не объявлен, гантри тёмная, флаг опущен;
 *   forming   — «на старт»: гантри оживает, красные лампы ещё не горят;
 *   countdown — красные огни загораются один за другим (1..5);
 *   green     — все огни гаснут + вспышка зелёного флага (GO!);
 *   racing    — заезд идёт, флаг спокойно колышется.
 *
 * Использование:
 *   // 1) сцена (ровно один «драйвер» за кадр):
 *   <FlagSync />                     // сам армится на raceId/agents
 *   // 2) другие модули читают синхронное состояние:
 *   const phase = useFlagSyncStore((s) => s.phase);
 *   const off = onGreenFlag((at, runId) => startCinematic(at, runId));
 *   // 3) React-компоненты (интро-камера, болид) ждут зелёный хук-обёрткой:
 *   useGreenFlagOnce((at, runId) => startCinematic(at, runId));
 *   // 4) болиды стартуют с задержкой реакции:
 *   const delay = launchDelay(index);
 *   // 5) HUD-оверлей читает фазу без per-frame цикла:
 *   const phase = useFlagPhase();
 *   const label = flagPhaseLabel(phase);
 * ============================================================================
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { create } from 'zustand';
import * as THREE from 'three';
import { useArena } from '../store/arena';
import { CAR_START_X, LANE_SPACING } from './Arena';

/* -------------------------------------------------------------------------- */
/* 1. РАСПИСАНИЕ СТАРТА (чистая, детерминированная секвенция)                  */
/* -------------------------------------------------------------------------- */

/** Сколько красных огней на стартовой гантри (канон F1). */
export const FLAG_LIGHTS = 5;
/** Пауза «на старт» до первого огня, сек. */
export const FLAG_PRESTART = 0.9;
/** Интервал между загорающимися огнями, сек. */
export const FLAG_LIGHT_INTERVAL = 0.6;
/** Выдержка «все горят» перед тем, как погасить и дать зелёный, сек. */
export const FLAG_HOLD = 1.0;
/** Длительность вспышки зелёного, сек. */
export const FLAG_GREEN_FLASH = 1.4;
/** Общая длительность секвенции (до устойчивой фазы `racing`), сек. */
export const FLAG_TOTAL =
  FLAG_PRESTART + (FLAG_LIGHTS - 1) * FLAG_LIGHT_INTERVAL + FLAG_HOLD + FLAG_GREEN_FLASH;
/** Разброс «реакции» болидов по старту, сек на позицию (стартовая толкучка). */
export const LAUNCH_STAGGER = 0.05;

export type FlagPhase = 'idle' | 'forming' | 'countdown' | 'green' | 'racing';

export interface FlagSequence {
  phase: FlagPhase;
  /** Сколько красных огней горит (0..FLAG_LIGHTS). На `green` — всегда 0. */
  lights: number;
  /** Интенсивность зелёного 0..1 (пик — в момент `green`, затем затухает). */
  green: number;
  /** Прогресс всей секвенции 0..1 (для полосок/реплея). */
  progress: number;
}

/** Момент (в секундах от начала секвенции), когда загорается последний огонь. */
export const FLAG_ALL_ON_AT = FLAG_PRESTART + (FLAG_LIGHTS - 1) * FLAG_LIGHT_INTERVAL;
/** Момент перехода в `green` (все огни гаснут, флаг вверх), сек. */
export const FLAG_GREEN_AT = FLAG_ALL_ON_AT + FLAG_HOLD;

/** Порядок фаз старта — удобно сравнивать «раньше/позже» без перечислений. */
export const FLAG_PHASE_ORDER: readonly FlagPhase[] = ['idle', 'forming', 'countdown', 'green', 'racing'];

/**
 * Секвенция старта как чистая функция от прошедшего времени (сек).
 * Не аллоцирует, пригодна для юнит-тестов и реплея.
 */
export function flagSequenceAt(elapsed: number): FlagSequence {
  const t = Math.max(0, elapsed);
  const progress = Math.min(1, t / FLAG_TOTAL);

  if (t < FLAG_PRESTART) {
    return { phase: 'forming', lights: 0, green: 0, progress };
  }
  if (t < FLAG_GREEN_AT) {
    const lit = Math.floor((t - FLAG_PRESTART) / FLAG_LIGHT_INTERVAL) + 1;
    return { phase: 'countdown', lights: Math.min(FLAG_LIGHTS, lit), green: 0, progress };
  }

  const since = t - FLAG_GREEN_AT;
  if (since < FLAG_GREEN_FLASH) {
    const green = 0.35 + 0.65 * (1 - since / FLAG_GREEN_FLASH);
    return { phase: 'green', lights: 0, green, progress };
  }
  return { phase: 'racing', lights: 0, green: 0.24, progress };
}

/** Сколько секунд осталось до зелёного флага при данном elapsed (0 — уже дан). */
export function timeToGreen(elapsed: number): number {
  return Math.max(0, FLAG_GREEN_AT - Math.max(0, elapsed));
}

/** Задержка старта болида с индексом `index` после зелёного флага, сек. */
export function launchDelay(index: number): number {
  return Math.max(0, index) * LAUNCH_STAGGER;
}

/** Человекочитаемая подпись фазы старта (для HUD/титров). */
export function flagPhaseLabel(phase: FlagPhase): string {
  switch (phase) {
    case 'forming':
      return 'НА СТАРТ';
    case 'countdown':
      return 'ОГНИ ЗАЖЖЕНЫ';
    case 'green':
      return 'GO!';
    case 'racing':
      return 'ЗАЕЗД ИДЁТ';
    case 'idle':
    default:
      return 'ОЖИДАНИЕ';
  }
}

/** Идёт ли заезд (после зелёного флага) — для блокировки ввода/камер. */
export function isRaceLive(phase: FlagPhase): boolean {
  return phase === 'green' || phase === 'racing';
}

/**
 * Прошёл ли старт: фаза строго после `green`. Удобно, чтобы отличить момент
 * самой вспышки (её ещё показываем) от уже идущего заезда.
 */
export function isGreenGiven(phase: FlagPhase): boolean {
  return phase === 'green' || phase === 'racing';
}

/* -------------------------------------------------------------------------- */
/* 2. МАСТЕР-СОСТОЯНИЕ (zustand) — единственный источник правды о флаге        */
/* -------------------------------------------------------------------------- */

type GreenListener = (greenAt: number, runId: number) => void;
type PhaseListener = (phase: FlagPhase, runId: number) => void;

interface FlagSyncStore {
  phase: FlagPhase;
  lights: number;
  green: number;
  /** Scene-clock время вооружения секвенции; -1 — не вооружена. */
  armedAt: number;
  /** Scene-clock время зелёного флага; -1 — ещё не было. */
  greenAt: number;
  /** Номер заезда (растёт при каждом `arm`) — защита от «протухших» стартов. */
  runId: number;
  /** Вооружить секвенцию в заданный момент scene-clock. */
  arm: (at: number) => void;
  /** Применить кадр секвенции (вызывает только драйвер). */
  apply: (seq: FlagSequence, now: number) => void;
  /** Сброс в `idle` (например, при смене raceId). */
  reset: () => void;
}

export const useFlagSyncStore = create<FlagSyncStore>((set) => ({
  phase: 'idle',
  lights: 0,
  green: 0,
  armedAt: -1,
  greenAt: -1,
  runId: 0,

  arm: (at) =>
    set((s) => ({
      phase: 'forming',
      lights: 0,
      green: 0,
      armedAt: at,
      greenAt: -1,
      runId: s.runId + 1,
    })),

  apply: (seq, now) =>
    set((s) => {
      // квантуем зелёный, чтобы не дёргать подписчиков 60 раз/сек
      const g = Math.round(seq.green * 24) / 24;
      if (s.phase === seq.phase && s.lights === seq.lights && s.green === g) return {};
      const justGreen = seq.phase === 'green' && s.phase !== 'green';
      return {
        phase: seq.phase,
        lights: seq.lights,
        green: g,
        greenAt: justGreen ? now : s.greenAt,
      };
    }),

  reset: () => set({ phase: 'idle', lights: 0, green: 0, armedAt: -1, greenAt: -1 }),
}));

/** Императивный снимок флага вне React (для TV-режиссёра, аудио и т.п.). */
export function getFlagSyncState(): FlagSyncStore {
  return useFlagSyncStore.getState();
}

/** Вооружить секвенцию по текущему scene-clock (вне React). */
export function armGreenFlag(at?: number): number {
  const clock = typeof performance !== 'undefined' ? performance.now() / 1000 : 0;
  const time = at ?? clock;
  useFlagSyncStore.getState().arm(time);
  return time;
}

/* --- шина события «зелёный флаг» (для не-React потребителей) --------------- */

const greenListeners = new Set<GreenListener>();
const phaseListeners = new Set<PhaseListener>();

/** Подписка на событие зелёного флага; возвращает функцию отписки. */
export function onGreenFlag(cb: GreenListener): () => void {
  greenListeners.add(cb);
  return () => {
    greenListeners.delete(cb);
  };
}

/** Подписка на любую смену фазы старта; возвращает функцию отписки. */
export function onFlagPhase(cb: PhaseListener): () => void {
  phaseListeners.add(cb);
  return () => {
    phaseListeners.delete(cb);
  };
}

function emitGreen(greenAt: number, runId: number): void {
  greenListeners.forEach((cb) => {
    try {
      cb(greenAt, runId);
    } catch {
      /* слушатель не должен ломать кадр */
    }
  });
}

function emitPhase(phase: FlagPhase, runId: number): void {
  phaseListeners.forEach((cb) => {
    try {
      cb(phase, runId);
    } catch {
      /* слушатель не должен ломать кадр */
    }
  });
}

/**
 * React-обёртка над шиной `onGreenFlag`: вызывает колбэк ровно один раз на
 * каждый заезд, когда секвенция доходит до зелёного флага. Идеально для
 * компонентов интро-камеры / болидов: подписка снимается при размонтировании,
 * свежий колбэк берётся из ref, поэтому его не нужно мемоизировать.
 */
export function useGreenFlagOnce(cb: GreenListener): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => onGreenFlag((at, runId) => ref.current(at, runId)), []);
}

/* -------------------------------------------------------------------------- */
/* 3. ДРАЙВЕР (hook)                                                          */
/* -------------------------------------------------------------------------- */

export interface UseFlagSyncOptions {
  /** Автоматически вооружать секвенцию при появлении заезда. По умолчанию да. */
  autoArm?: boolean;
  /** Автосброс при смене raceId. По умолчанию да. */
  autoReset?: boolean;
  /** Множитель хода секвенции (например, для slow-mo стартового плана). */
  speed?: number;
  /** Колбэк ровно в момент зелёного флага. */
  onGreen?: GreenListener;
  /** Колбэк на каждую смену фазы. */
  onPhase?: (phase: FlagPhase, runId: number) => void;
}

/**
 * Драйвер стартовой секвенции. Должен быть смонтирован ВНУТРИ <Canvas>
 * ровно один раз (обычно им является `<FlagSync/>`). Пишет мастер-состояние
 * в `useFlagSyncStore` и публикует событие зелёного флага.
 */
export function useFlagSync(options: UseFlagSyncOptions = {}) {
  const { autoArm = true, autoReset = true, speed = 1, onGreen, onPhase } = options;
  const clock = useThree((s) => s.clock);

  const raceId = useArena((s) => s.raceId);
  const agentCount = useArena((s) => (s.agents ? Object.keys(s.agents).length : 0));

  const arm = useFlagSyncStore((s) => s.arm);
  const reset = useFlagSyncStore((s) => s.reset);
  const apply = useFlagSyncStore((s) => s.apply);

  const prevPhase = useRef<FlagPhase>('idle');
  const opts = useRef({ onGreen, onPhase });
  opts.current = { onGreen, onPhase };

  // Сброс при смене заезда (объявлен раньше arm — сработает первым).
  useEffect(() => {
    if (!autoReset) return;
    if (!raceId) return;
    reset();
  }, [raceId, autoReset, reset]);

  // Авто-вооружение, когда появился заезд и в нём есть болиды.
  useEffect(() => {
    if (!autoArm) return;
    if (!raceId || agentCount === 0) return;
    const s = useFlagSyncStore.getState();
    if (s.armedAt >= 0) return; // уже вооружена/идёт
    arm(clock.getElapsedTime());
  }, [autoArm, raceId, agentCount, clock, arm]);

  useFrame(() => {
    const s = useFlagSyncStore.getState();
    if (s.armedAt < 0) return;

    const now = clock.getElapsedTime();
    const seq = flagSequenceAt((now - s.armedAt) * speed);
    apply(seq, now);

    const live = useFlagSyncStore.getState();
    if (live.phase !== prevPhase.current) {
      const was = prevPhase.current;
      prevPhase.current = live.phase;
      opts.current.onPhase?.(live.phase, live.runId);
      emitPhase(live.phase, live.runId);
      if (live.phase === 'green' && was !== 'green') {
        const at = live.greenAt >= 0 ? live.greenAt : now;
        emitGreen(at, live.runId);
        opts.current.onGreen?.(at, live.runId);
      }
    }
  });

  return useFlagSyncStore;
}

/* -------------------------------------------------------------------------- */
/* 4. React-хуки чтения (без per-frame ре-рендеров)                            */
/* -------------------------------------------------------------------------- */

/** React-хук: текущая фаза старта с ре-рендером только при её смене. */
export function useFlagPhase(): FlagPhase {
  return useFlagSyncStore((s) => s.phase);
}

/** React-хук: сколько красных огней сейчас горит (0..FLAG_LIGHTS). */
export function useFlagLights(): number {
  return useFlagSyncStore((s) => s.lights);
}

/** React-хук: интенсивность зелёного 0..1 (для свечения HUD/постэффектов). */
export function useGreenIntensity(): number {
  return useFlagSyncStore((s) => s.green);
}

/** React-хук: номер текущего заезда (растёт при каждом `arm`). */
export function useFlagRunId(): number {
  return useFlagSyncStore((s) => s.runId);
}

/** React-хук: секунды до зелёного флага (0 после старта) — для HUD-таймера. */
export function useFlagCountdown(): number {
  const armedAt = useFlagSyncStore((s) => s.armedAt);
  const phase = useFlagSyncStore((s) => s.phase);
  const clock = useThree((s) => s.clock);
  if (phase !== 'forming' && phase !== 'countdown') return 0;
  if (armedAt < 0) return FLAG_GREEN_AT;
  return timeToGreen(clock.getElapsedTime() - armedAt);
}

/* -------------------------------------------------------------------------- */
/* 5. ВИЗУАЛ: гантри со стартовыми огнями + полотнище зелёного флага           */
/* -------------------------------------------------------------------------- */

export interface FlagSyncProps {
  /** X стартовой линии (по умолчанию совпадает с решёткой Arena). */
  x?: number;
  /** Ширина решётки в полосах (для расчёта пролёта гантри). */
  lanes?: number;
  /** Шаг полосы по Z. */
  spacing?: number;
  /** Этот инстанс ведёт секвенцию (по умолчанию — да). */
  drive?: boolean;
  /** Показывать полотнище зелёного флага. */
  showFlag?: boolean;
  onGreen?: (greenAt: number, runId: number) => void;
  onPhase?: (phase: FlagPhase, runId: number) => void;
}

export function FlagSync({
  x = CAR_START_X + 3,
  lanes = 6,
  spacing = LANE_SPACING,
  drive = true,
  showFlag = true,
  onGreen,
  onPhase,
}: FlagSyncProps) {
  // Единственный драйвер секвенции. Компонент может быть смонтирован и как
  // «чистый визуал» (drive=false) — тогда его кормит внешний драйвер.
  useFlagSync({ autoArm: drive, autoReset: drive, onGreen, onPhase });

  const span = Math.max(4, lanes) * spacing;
  const halfSpan = span / 2;

  // Z-координаты пяти красных огней вдоль балки.
  const redZ = useMemo(() => {
    const step = 0.78;
    const start = -((FLAG_LIGHTS - 1) * step) / 2;
    return Array.from({ length: FLAG_LIGHTS }, (_, i) => start + i * step);
  }, []);

  const redMats = useRef<Array<THREE.MeshStandardMaterial | null>>([]);
  const greenMat = useRef<THREE.MeshStandardMaterial | null>(null);
  const glowMat = useRef<THREE.MeshBasicMaterial | null>(null);
  const flagRef = useRef<THREE.Group>(null);

  // Полотнище флага: геометрия с сеткой + сохранённые исходные вершины.
  const flagGeo = useMemo(() => new THREE.PlaneGeometry(2.3, 1.4, 20, 10), []);
  const flagBase = useMemo(
    () => Float32Array.from(flagGeo.attributes.position.array as ArrayLike<number>),
    [flagGeo],
  );

  useFrame((state, dt) => {
    const s = useFlagSyncStore.getState();
    const k = Math.min(1, dt * 14);

    // Красные огни: плавно поджигаем/гасим по счётчику `lights`.
    for (let i = 0; i < FLAG_LIGHTS; i++) {
      const m = redMats.current[i];
      if (!m) continue;
      const target = i < s.lights ? 3.6 : 0.05;
      m.emissiveIntensity += (target - m.emissiveIntensity) * k;
    }

    // Зелёная лампа поверх гантри.
    if (greenMat.current) {
      const target = s.green * 3.6;
      greenMat.current.emissiveIntensity += (target - greenMat.current.emissiveIntensity) * Math.min(1, dt * 10);
      greenMat.current.opacity = 0.35 + 0.65 * Math.min(1, s.green);
    }

    // Зелёная подсветка асфальта под гантри.
    if (glowMat.current) {
      glowMat.current.opacity += (s.green * 0.5 - glowMat.current.opacity) * Math.min(1, dt * 8);
    }

    // Полотнище «взмывает» в момент зелёного (фаза green/racing) и колышется.
    if (showFlag && flagRef.current) {
      const raised = s.phase === 'green' || s.phase === 'racing' ? 1 : 0;
      const y = THREE.MathUtils.lerp(flagRef.current.position.y, -1.35 + raised * 1.35, Math.min(1, dt * 6));
      flagRef.current.position.y = y;
    }

    // Колыхание полотнища: амплитуда растёт после зелёного флага.
    if (showFlag) {
      const pos = flagGeo.attributes.position as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      const t = state.clock.elapsedTime;
      const amp = 0.14 + Math.min(1, s.green) * 0.85;
      for (let i = 0; i < arr.length; i += 3) {
        const bx = flagBase[i];
        const by = flagBase[i + 1];
        const u = (bx + 1.15) / 2.3; // 0 у древка, 1 у свободного края
        arr[i + 2] =
          Math.sin(bx * 3.1 - t * 6.5) * 0.22 * amp * u +
          Math.sin(by * 4.3 + t * 4.1) * 0.06 * amp * u;
      }
      pos.needsUpdate = true;
      flagGeo.computeVertexNormals();
    }
  });

  return (
    <group name="flag-sync" position={[x, 0, 0]}>
      {/* Вертикальные стойки гантри */}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[0, 2.35, side * (halfSpan + 0.5)]} castShadow>
          <boxGeometry args={[0.28, 4.7, 0.28]} />
          <meshStandardMaterial color="#1b2233" metalness={0.7} roughness={0.35} />
        </mesh>
      ))}

      {/* Горизонтальная балка поперёк решётки (вдоль Z) */}
      <mesh position={[0, 4.62, 0]} castShadow>
        <boxGeometry args={[0.34, 0.34, span + 1.2]} />
        <meshStandardMaterial color="#232c42" metalness={0.7} roughness={0.3} />
      </mesh>

      {/* Пять красных стартовых огней (смотрят в -X, навстречу болидам) */}
      {redZ.map((z, i) => (
        <group key={i} position={[0, 4.18, z]}>
          <mesh castShadow>
            <boxGeometry args={[0.34, 0.64, 0.6]} />
            <meshStandardMaterial color="#10141f" metalness={0.6} roughness={0.45} />
          </mesh>
          <mesh position={[-0.2, 0, 0]}>
            <sphereGeometry args={[0.23, 20, 20]} />
            <meshStandardMaterial
              ref={(el) => {
                redMats.current[i] = el;
              }}
              color="#3a0b0b"
              emissive="#ff2222"
              emissiveIntensity={0.05}
              roughness={0.3}
            />
          </mesh>
        </group>
      ))}

      {/* Зелёная лампа — венчает гантри, вспыхивает в момент GO */}
      <mesh position={[0, 5.05, 0]}>
        <sphereGeometry args={[0.26, 20, 20]} />
        <meshStandardMaterial
          ref={greenMat}
          color="#062e16"
          emissive="#22c55e"
          emissiveIntensity={0.05}
          transparent
          opacity={0.4}
          roughness={0.25}
        />
      </mesh>

      {/* Стартовая линия на асфальте */}
      <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.5, span + 0.6]} />
        <meshStandardMaterial color="#e8eef8" emissive="#aab8d0" emissiveIntensity={0.25} />
      </mesh>

      {/* Мягкая зелёная подсветка пола при зелёном флаге */}
      <mesh position={[-2.2, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[3.6, span + 1.6]} />
        <meshBasicMaterial
          ref={glowMat}
          color="#22c55e"
          transparent
          opacity={0}
          depthWrite={false}
        />
      </mesh>

      {/* Полотнище зелёного флага на флагштоке (взмывает на GO) */}
      {showFlag && (
        <group position={[0.55, 5.55, halfSpan + 0.5]}>
          {/* Флагшток */}
          <mesh position={[0, -0.75, 0]}>
            <cylinderGeometry args={[0.04, 0.04, 3.0, 10]} />
            <meshStandardMaterial color="#c9d4e6" metalness={0.6} roughness={0.35} />
          </mesh>
          {/* Сам флаг: плоская волнующаяся ткань */}
          <group ref={flagRef} position={[0, -1.35, 0]}>
            <mesh position={[1.15, 0.7, 0]}>
              <primitive object={flagGeo} attach="geometry" />
              <meshStandardMaterial
                color="#22c55e"
                emissive="#16a34a"
                emissiveIntensity={0.35}
                side={THREE.DoubleSide}
                roughness={0.6}
                metalness={0.05}
              />
            </mesh>
          </group>
        </group>
      )}
    </group>
  );
}

export default FlagSync;
