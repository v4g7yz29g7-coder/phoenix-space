/**
 * CameraShake.tsx — procedural camera shake + broadcast "flash cut"  (FORMULA I1 / AI-1)
 * --------------------------------------------------------------------------------------------
 * ЗАДАЧА 3.7. Два телевизионных приёма, которые отделяют «рендер сцены» от «эфира»:
 *
 *  1) CameraShake  (внутри <Canvas>) — процедурная тряска АКТИВНОЙ камеры.
 *     Не физическая симуляция, а классический Hollywood-«trauma»-шум:
 *       · trauma 0..1, затухает линейно за `duration`;
 *       · амплитуда = trauma² (мягкий вход/выход, без дёрганья на старте);
 *       · смещение позиции + roll + лёгкий FOV-kick считаются суммой синусов
 *         от времени (детерминированно, БЕЗ Math.random → не «прыгает» между кадрами).
 *     Тряска навешивается ПОВЕРХ позы, которую каждый кадр ставит TV-режиссёр
 *     (useTVDirector / TVDirectorRigs), поэтому не конфликтует с auto-режиссурой:
 *     в начале кадра старый offset снимается, в конце — накладывается новый.
 *
 *  2) FlashCut     (DOM-оверлей) — монтажный «flash cut»: на смене плана (cutKey)
 *     экран на 1 кадр вспыхивает белым и гаснет ~5 кадров. Плюс red-flash на
 *     удар/аварию через ту же шину событий. Рисуется вне WebGL — нулевая цена
 *     для рендера сцены.
 *
 * Общая шина (shakeBus / flashBus) — крошечный pub/sub без zustand и без
 * React-ререндеров: любой игровой код может дёрнуть `triggerShake()` /
 * `triggerFlash()` из useFrame или из сетевого колбэка.
 *
 * Приёмы: research/audit.md, раздел про `racing-game` (MIT) — «camera-feel» и
 * кинематика камеры в useFrame без ререндеров (TOP-3 #2). Код переписан с нуля
 * в терминах проекта AI-1; из референса взят только паттерн, не код.
 *
 * ВАЖНО (порядок монтирования): размещайте <CameraShake /> в <Canvas> ПОСЛЕ
 * драйвера режиссёра (TVDirectorDriver), чтобы тряска накладывалась на уже
 * посчитанную позу кадра.
 *
 * Использование:
 *   <Canvas>
 *     <TVDirectorDriver onUpdate={...} />
 *     <CameraShake />                       // в-canvas, сцена 3D
 *   </Canvas>
 *   <FlashCut cutKey={camId} />             // DOM, поверх всего
 *
 *   // произвольный триггер, например в crash-колбэке:
 *   triggerShake(0.9, 0.6, 34); triggerFlash('#ff5c5c', 0.8, 0.25);
 * ========================================================================== */

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useArena } from '../store/arena';

/* -------------------------------------------------------------------------- */
/*  Микро-шина событий (pub/sub, без стейт-менеджера)                          */
/* -------------------------------------------------------------------------- */

type Unsub = () => void;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface ShakeCommand {
  /** Начальная «травма» 0..1 (амплитуда = trauma²). */
  trauma: number;
  /** Полное время затухания в секундах. */
  duration: number;
  /** Базовая частота шума, Гц. */
  freq: number;
}

export interface FlashCommand {
  /** Цвет вспышки (hex/css). */
  color: string;
  /** Пиковая непрозрачность 0..1. */
  intensity: number;
}

const shakeListeners = new Set<(c: ShakeCommand) => void>();
const flashListeners = new Set<(c: FlashCommand) => void>();

/**
 * Запустить тряску камеры. События складываются: берётся максимальная травма.
 * @param trauma   0..1 (например 0.35 — лёгкий «удар камеры», 0.9 — авария)
 * @param duration время затухания, сек (по умолчанию 0.5)
 * @param freq     частота шума, Гц (по умолчанию 26)
 */
export function triggerShake(trauma = 0.6, duration = 0.5, freq = 26): void {
  const cmd: ShakeCommand = {
    trauma: clamp01(trauma),
    duration: duration > 0.02 ? duration : 0.02,
    freq: freq > 1 ? freq : 1,
  };
  shakeListeners.forEach((l) => l(cmd));
}

/**
 * Запустить вспышку экрана (flash cut).
 * @param color     цвет (по умолчанию белый)
 * @param intensity пиковая непрозрачность 0..1
 */
export function triggerFlash(color = '#ffffff', intensity = 0.85): void {
  const cmd: FlashCommand = { color, intensity: clamp01(intensity) };
  flashListeners.forEach((l) => l(cmd));
}

/** Монтажный flash cut на смене плана — короткая белая вспышка. */
export function flashCut(): void {
  triggerFlash('#ffffff', 0.9);
}

function onShake(l: (c: ShakeCommand) => void): Unsub {
  shakeListeners.add(l);
  return () => shakeListeners.delete(l);
}

function onFlash(l: (c: FlashCommand) => void): Unsub {
  flashListeners.add(l);
  return () => flashListeners.delete(l);
}

/* -------------------------------------------------------------------------- */
/*  CameraShake — в-canvas процедурная тряска                                  */
/* -------------------------------------------------------------------------- */

export interface CameraShakeProps {
  /** Постоянная фоновая травма (например «дрожь на скорости»). По умолчанию 0. */
  baseTrauma?: number;
  /** Масштаб смещения позиции камеры в мировых единицах. */
  positionAmount?: number;
  /** Масштаб крена (roll) камеры в радианах. */
  rollAmount?: number;
  /** Масштаб FOV-kick в градусах (0 — выключить). */
  fovAmount?: number;
  /** Реагировать лёгкой тряской на каждое новое radio-событие арены. */
  shakeOnRadio?: boolean;
}

/**
 * Навешивает процедурную тряску на камеру по умолчанию <Canvas>.
 * Каждый кадр: снять прошлый offset → посчитать новый → наложить.
 * Поза, поставленная режиссёром, остаётся базовой; работает с любой камерой.
 */
export function CameraShake({
  baseTrauma = 0,
  positionAmount = 0.5,
  rollAmount = 0.035,
  fovAmount = 3.2,
  shakeOnRadio = true,
}: CameraShakeProps) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;

  const trauma = useRef(0);
  const duration = useRef(0.5);
  const freq = useRef(26);
  const appliedPos = useRef(new THREE.Vector3());
  const fovBase = useRef(camera.fov ?? 50);

  // Свежие props без пересоздания подписки в useFrame.
  const cfg = useRef({ baseTrauma, positionAmount, rollAmount, fovAmount });
  cfg.current = { baseTrauma, positionAmount, rollAmount, fovAmount };

  useLayoutEffect(() => {
    fovBase.current = camera.fov;
    return () => {
      // Вернуть камеру в чистое состояние при размонтировании.
      camera.position.sub(appliedPos.current);
      camera.fov = fovBase.current;
      camera.updateProjectionMatrix();
    };
  }, [camera]);

  // Подписка на шину тряски.
  useEffect(
    () =>
      onShake((c) => {
        trauma.current = Math.max(trauma.current, c.trauma);
        duration.current = c.duration;
        freq.current = c.freq;
      }),
    [],
  );

  // Мягкая тряска на каждое новое radio-событие (реальные/мок гонки).
  useEffect(() => {
    if (!shakeOnRadio) return;
    let prev = useArena.getState().radioEvents.length;
    return useArena.subscribe((s) => {
      const n = s.radioEvents.length;
      if (n > prev) triggerShake(0.3 + Math.min(0.25, (n - prev) * 0.05), 0.45, 30);
      prev = n;
    });
  }, [shakeOnRadio]);

  useFrame((state, delta) => {
    const cam = camera;
    const t = state.clock.elapsedTime;

    // 1) затухание травмы: полностью за `duration` секунд.
    if (trauma.current > 0) {
      trauma.current = Math.max(0, trauma.current - delta / duration.current);
    }
    const tr = Math.max(trauma.current, clamp01(cfg.current.baseTrauma));
    const amp = tr * tr; // trauma² — мягкая огибающая

    // 2) снять прошлый offset, вернув базовую позу режиссёра.
    cam.position.sub(appliedPos.current);

    if (amp <= 0.0001) {
      appliedPos.current.set(0, 0, 0);
      if (fovAmount > 0 && cam.fov !== fovBase.current) {
        cam.fov = fovBase.current;
        cam.updateProjectionMatrix();
      }
      return;
    }

    // 3) детерминированный шум: сумма синусов с несоизмеримыми частотами.
    const f = freq.current;
    const nx =
      Math.sin(t * f * 1.0) * 0.6 +
      Math.sin(t * f * 2.3 + 1.3) * 0.3 +
      Math.sin(t * f * 0.47 + 4.1) * 0.1;
    const ny =
      Math.sin(t * f * 1.13 + 2.1) * 0.6 +
      Math.sin(t * f * 2.71 + 0.7) * 0.3 +
      Math.sin(t * f * 0.53 + 5.3) * 0.1;
    const nz =
      Math.sin(t * f * 0.89 + 3.7) * 0.6 +
      Math.sin(t * f * 2.07 + 2.9) * 0.3 +
      Math.sin(t * f * 0.61 + 1.1) * 0.1;

    const { positionAmount: pa, rollAmount: ra, fovAmount: fa } = cfg.current;
    appliedPos.current.set(nx * amp * pa, ny * amp * pa, nz * amp * pa);
    cam.position.add(appliedPos.current);

    // 4) крен камеры поверх lookAt-ориентации режиссёра.
    if (ra > 0 && cam instanceof THREE.PerspectiveCamera) {
      cam.rotateZ(Math.sin(t * f * 0.73 + 0.5) * amp * ra);
    }

    // 5) FOV-kick: «дыхание» изображения на ударе.
    if (fa > 0 && cam.isPerspectiveCamera) {
      cam.fov = Math.max(10, fovBase.current + Math.abs(nz) * amp * fa);
      cam.updateProjectionMatrix();
    }
  });

  return null;
}

/* -------------------------------------------------------------------------- */
/*  FlashCut — DOM-оверлей монтажной вспышки                                   */
/* -------------------------------------------------------------------------- */

export interface FlashCutProps {
  /**
   * Смените это значение (например activeId TV-камеры) — сработает flash cut.
   * Первое значение игнорируется (не мигаем на маунте).
   */
  cutKey?: string | number;
  /** Цвет вспышки на монтажном срезе. */
  cutColor?: string;
  /** Верхний z-index оверлея. */
  zIndex?: number;
}

/**
 * Полноэкранный flash-cut. Вспышка мгновенно появляется (opacity → intensity)
 * и гаснет экспоненциально через requestAnimationFrame. Никаких React-стейтов
 * в горячем цикле — только прямое управление style.
 */
export function FlashCut({ cutKey, cutColor = '#ffffff', zIndex = 60 }: FlashCutProps) {
  const ref = useRef<HTMLDivElement>(null);
  const intensity = useRef(0);
  const color = useRef('#ffffff');
  const first = useRef(true);

  // Один rAF-цикл затухания на всю жизнь компонента.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      intensity.current *= 0.82; // ~5-6 кадров до нуля (60 fps)
      if (intensity.current < 0.002) intensity.current = 0;
      const el = ref.current;
      if (el) {
        el.style.opacity = intensity.current.toFixed(3);
        el.style.background = color.current;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Явные вспышки из шины (удар, boost, finish).
  useEffect(
    () =>
      onFlash((c) => {
        color.current = c.color;
        intensity.current = Math.max(intensity.current, c.intensity);
      }),
    [],
  );

  // Монтажный срез: реагируем на смену плана, но не на первый рендер.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    color.current = cutColor;
    intensity.current = Math.max(intensity.current, 0.9);
  }, [cutKey, cutColor]);

  const style: CSSProperties = {
    position: 'fixed',
    inset: 0,
    pointerEvents: 'none',
    zIndex,
    opacity: 0,
    background: '#ffffff',
    mixBlendMode: 'screen',
    willChange: 'opacity, background',
  };

  return <div ref={ref} style={style} aria-hidden />;
}
