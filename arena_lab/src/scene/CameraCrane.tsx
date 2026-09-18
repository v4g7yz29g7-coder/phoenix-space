import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

/* ============================================================================
 * ЗАДАЧА 4.3 — КАМЕРА-КРАН НАД РЕШЁТКОЙ  (Cinematic Intro, FORMULA I1)
 * ----------------------------------------------------------------------------
 * Кинематографический кран (jib / camera crane) над стартовой решёткой.
 *
 * Что делает:
 *   • физическая модель крана: платформа с выносными опорами, телескопическая
 *     мачта, качающаяся стрела (boom) с противовесом и камерой-головой
 *     (объектив + красный REC-огонёк);
 *   • риг анимируется по монтажному листу из 5 планов (CraneShot[]), которые
 *     ведут камеру от низкого «push-in» через подъём стрелы к верхней
 *     панораме над решёткой и финальному низкому hero-проезду;
 *   • при `active` риг управляет ГЛАВНОЙ камерой <Canvas> — это и есть вывод
 *     интро; при `active={false}` кран просто стоит в сцене и его снимает
 *     камера-наблюдатель (например, TV Director).
 *
 * Приёмы взяты из research/racing-game (MIT):
 *   - src/effects/Cameras.tsx — смена камеры через makeDefault/PerspectiveCamera;
 *   - src/models/vehicle/Vehicle.tsx — кинематика в useFrame без React-ререндеров
 *     (мутация ref'ов, lerp позиции и наклона).
 * Код собственный, в терминах проекта AI-1.
 *
 * Решётка (grid) в Arena.tsx/AgentCube.tsx: болиды выстроены вдоль оси Z
 * около x = -20 (progress = 0). Кран стоит сзади (z > 0) и стрела идёт
 * на -Z — «коридор» из болидов.
 * ========================================================================== */

/** Центр стартовой решётки (совпадает со спавном болидов: x≈-20, progress 0). */
export const GRID_CENTER: [number, number, number] = [-20, 0.3, 0];

/** База крана: сзади решётки, стрела смотрит на -Z (yaw ≈ 180°). */
export const CRANE_BASE: [number, number, number] = [-20, 0, 16];

export const CRANE_MAST_MIN = 1.6;
export const CRANE_MAST_MAX = 11;
export const CRANE_BOOM_MIN = 3;
export const CRANE_BOOM_MAX = 16;

const deg = (d: number): number => (d * Math.PI) / 180;

/* --------------------------------------------------------------------------
 *  Типы монтажного листа
 * ------------------------------------------------------------------------ */

/** Поза стрелы крана (все углы — радианы, длины — метры). */
export interface CranePose {
  /** поворот мачты вокруг Y (направление стрелы) */
  yaw: number;
  /** наклон стрелы: 0 — горизонт, +вверх */
  pitch: number;
  /** вылет (телескоп) стрелы от вершины мачты */
  length: number;
  /** высота мачты */
  mast: number;
  /** dutch angle камеры (крен) */
  roll: number;
  /** вертикальный угол обзора */
  fov: number;
}

/** Один план: интерполяция позы и точки взгляда за `duration` секунд. */
export interface CraneShot {
  id: string;
  label: string;
  duration: number;
  from: CranePose;
  to: CranePose;
  /** точка взгляда на старте/финише — СМЕЩЕНИЕ от GRID_CENTER */
  targetFrom: [number, number, number];
  targetTo: [number, number, number];
}

/* --------------------------------------------------------------------------
 *  Монтажный лист (Cinematic Intro над решёткой)
 * ------------------------------------------------------------------------ */
export const CRANE_SHOTS: CraneShot[] = [
  {
    id: 'establish-low',
    label: 'Низкий заезд вдоль решётки',
    duration: 3.2,
    from: { yaw: deg(180), pitch: deg(6), length: 5.5, mast: 1.7, roll: 0, fov: 44 },
    to: { yaw: deg(178), pitch: deg(12), length: 6.5, mast: 2.4, roll: 0, fov: 40 },
    targetFrom: [0, 0.6, 2],
    targetTo: [0, 0.5, -1],
  },
  {
    id: 'crane-rise',
    label: 'Подъём стрелы над болидами',
    duration: 3.6,
    from: { yaw: deg(178), pitch: deg(12), length: 6.5, mast: 2.4, roll: 0, fov: 40 },
    to: { yaw: deg(172), pitch: deg(24), length: 9, mast: 6.5, roll: 0, fov: 38 },
    targetFrom: [0, 0.5, -1],
    targetTo: [-1, 0.3, -6],
  },
  {
    id: 'overhead-sweep',
    label: 'Верхняя панорама над решёткой',
    duration: 3.8,
    from: { yaw: deg(172), pitch: deg(24), length: 9, mast: 6.5, roll: 0, fov: 38 },
    to: { yaw: deg(128), pitch: deg(52), length: 12.5, mast: 9.5, roll: deg(-4), fov: 36 },
    targetFrom: [-1, 0.3, -6],
    targetTo: [0, 0.2, 0],
  },
  {
    id: 'parallax-drift',
    label: 'Параллакс-проезд поперёк решётки',
    duration: 3.6,
    from: { yaw: deg(128), pitch: deg(52), length: 12.5, mast: 9.5, roll: deg(-4), fov: 36 },
    to: { yaw: deg(214), pitch: deg(30), length: 10, mast: 5.5, roll: deg(3), fov: 34 },
    targetFrom: [0, 0.2, 0],
    targetTo: [3, 0.6, 4],
  },
  {
    id: 'hero-low',
    label: 'Hero: низкий проезд вдоль прямой',
    duration: 3.4,
    from: { yaw: deg(214), pitch: deg(30), length: 10, mast: 5.5, roll: deg(3), fov: 34 },
    to: { yaw: deg(186), pitch: deg(11), length: 6.8, mast: 2.1, roll: 0, fov: 30 },
    targetFrom: [3, 0.6, 4],
    targetTo: [10, 0.6, 6],
  },
];

export const CRANE_TOTAL_DURATION = CRANE_SHOTS.reduce((s, x) => s + x.duration, 0);

/* --------------------------------------------------------------------------
 *  Чистая математика (экспортируется — удобно тестировать и переиспользовать)
 * ------------------------------------------------------------------------ */
function smootherstep(x: number): number {
  const t = THREE.MathUtils.clamp(x, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/** Линейная интерполяция позы крана. */
export function lerpPose(a: CranePose, b: CranePose, k: number): CranePose {
  return {
    yaw: lerp(a.yaw, b.yaw, k),
    pitch: lerp(a.pitch, b.pitch, k),
    length: lerp(a.length, b.length, k),
    mast: lerp(a.mast, b.mast, k),
    roll: lerp(a.roll, b.roll, k),
    fov: lerp(a.fov, b.fov, k),
  };
}

/**
 * Мировая позиция камеры-головы на конце стрелы.
 * dir = (sin(yaw)·cos(pitch), sin(pitch), cos(yaw)·cos(pitch)).
 */
export function craneCameraWorld(
  base: THREE.Vector3,
  pose: CranePose,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const cp = Math.cos(pose.pitch);
  const sp = Math.sin(pose.pitch);
  out.set(
    base.x + Math.sin(pose.yaw) * cp * pose.length,
    base.y + pose.mast + sp * pose.length,
    base.z + Math.cos(pose.yaw) * cp * pose.length,
  );
  return out;
}

/** Мировая точка взгляда для плана при прогрессе k (0..1). */
export function craneTargetWorld(
  shot: CraneShot,
  k: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  out.set(
    GRID_CENTER[0] + lerp(shot.targetFrom[0], shot.targetTo[0], k),
    GRID_CENTER[1] + lerp(shot.targetFrom[1], shot.targetTo[1], k),
    GRID_CENTER[2] + lerp(shot.targetFrom[2], shot.targetTo[2], k),
  );
  return out;
}

interface TimelineEntry {
  shot: CraneShot;
  index: number;
  start: number;
  end: number;
}

function buildTimeline(shots: CraneShot[]): TimelineEntry[] {
  let acc = 0;
  return shots.map((shot, index) => {
    const start = acc;
    acc += shot.duration;
    return { shot, index, start, end: acc };
  });
}

interface Segment extends TimelineEntry {
  /** локальный прогресс внутри плана 0..1 (после easing — в компоненте) */
  local: number;
}

function findSegment(timeline: TimelineEntry[], t: number): Segment {
  for (let i = 0; i < timeline.length; i++) {
    const seg = timeline[i];
    // последний план «залипает» на финальном кадре
    if (t < seg.end || i === timeline.length - 1) {
      const denom = Math.max(seg.shot.duration, 1e-6);
      return { ...seg, local: THREE.MathUtils.clamp((t - seg.start) / denom, 0, 1) };
    }
  }
  const last = timeline[timeline.length - 1];
  return { ...last, local: 1 };
}

/** Сэмпл монтажного листа в момент t — используется и камерой, и тестами. */
export function evalCraneAt(
  t: number,
  shots: CraneShot[] = CRANE_SHOTS,
): { pose: CranePose; target: THREE.Vector3; position: THREE.Vector3; shotId: string } {
  const timeline = buildTimeline(shots);
  const seg = findSegment(timeline, t);
  const k = smootherstep(seg.local);
  const pose = lerpPose(seg.shot.from, seg.shot.to, k);
  const target = craneTargetWorld(seg.shot, k);
  const position = craneCameraWorld(new THREE.Vector3(...CRANE_BASE), pose);
  return { pose, target, position, shotId: seg.shot.id };
}

/* --------------------------------------------------------------------------
 *  Компонент
 * ------------------------------------------------------------------------ */
export interface CameraCraneProps {
  /** true — кран управляет главной камерой (вывод кинематографичного интро). */
  active?: boolean;
  /** Показывать физическую модель крана (по умолчанию — когда он не камера). */
  showRig?: boolean;
  /** Позиция базы крана (мир). */
  base?: [number, number, number];
  /** Свой монтажный лист (иначе CRANE_SHOTS). */
  shots?: CraneShot[];
  /** Зациклить интро. */
  loop?: boolean;
  /** Множитель скорости воспроизведения. */
  playbackSpeed?: number;
  /** Смена плана. */
  onShotChange?: (id: string, index: number) => void;
  /** Интро доиграло (один раз, если !loop). */
  onComplete?: () => void;
}

export function CameraCrane({
  active = false,
  showRig,
  base,
  shots,
  loop = false,
  playbackSpeed = 1,
  onShotChange,
  onComplete,
}: CameraCraneProps) {
  const camera = useThree((s) => s.camera);

  const list = shots ?? CRANE_SHOTS;
  const timeline = useMemo(() => buildTimeline(list), [list]);
  const total = timeline.length > 0 ? timeline[timeline.length - 1].end : 0;
  const renderRig = showRig ?? !active;

  const baseVec = useMemo(
    () =>
      new THREE.Vector3(
        base?.[0] ?? CRANE_BASE[0],
        base?.[1] ?? CRANE_BASE[1],
        base?.[2] ?? CRANE_BASE[2],
      ),
    [base],
  );

  // refs рига
  const mastRef = useRef<THREE.Group>(null);
  const mastMeshRef = useRef<THREE.Mesh>(null);
  const pivotRef = useRef<THREE.Group>(null);
  const boomRef = useRef<THREE.Mesh>(null);
  const headRef = useRef<THREE.Group>(null);
  const lampRef = useRef<THREE.MeshStandardMaterial>(null);

  // состояние времени (без ре-рендеров)
  const timeRef = useRef(0);
  const shotRef = useRef(-1);
  const doneRef = useRef(false);

  const tmpPos = useMemo(() => new THREE.Vector3(), []);
  const tmpTarget = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, rawDelta) => {
    if (timeline.length === 0) return;
    const delta = Math.min(rawDelta, 0.1) * playbackSpeed;

    if (!doneRef.current) timeRef.current += delta;
    const t = loop ? timeRef.current % total : Math.min(timeRef.current, total);

    const seg = findSegment(timeline, t);
    const k = smootherstep(seg.local);
    const pose = lerpPose(seg.shot.from, seg.shot.to, k);
    craneTargetWorld(seg.shot, k, tmpTarget);

    if (seg.index !== shotRef.current) {
      shotRef.current = seg.index;
      onShotChange?.(seg.shot.id, seg.index);
    }

    /* --- вывод: управление главной камерой --- */
    if (active) {
      craneCameraWorld(baseVec, pose, tmpPos);
      const cam = camera as THREE.PerspectiveCamera;
      cam.position.copy(tmpPos);
      cam.lookAt(tmpTarget);
      if (pose.roll !== 0) cam.rotateZ(pose.roll);
      if (cam.isPerspectiveCamera && Math.abs(cam.fov - pose.fov) > 1e-3) {
        cam.fov = pose.fov;
        cam.updateProjectionMatrix();
      }
    }

    /* --- риг: телескоп мачты + качание стрелы --- */
    if (renderRig) {
      const mast = mastRef.current;
      if (mast) mast.rotation.y = pose.yaw;

      const mastMesh = mastMeshRef.current;
      if (mastMesh) {
        mastMesh.scale.y = pose.mast;
        mastMesh.position.y = pose.mast / 2;
      }

      const pivot = pivotRef.current;
      if (pivot) {
        pivot.position.y = pose.mast;
        pivot.rotation.x = -pose.pitch;
      }

      const boom = boomRef.current;
      if (boom) {
        boom.scale.z = pose.length;
        boom.position.z = pose.length / 2;
      }

      const head = headRef.current;
      if (head) {
        head.position.z = pose.length;
        // Обновляем мировую матрицу, чтобы lookAt учёл вращение мачты/стрелы.
        head.updateWorldMatrix(true, false);
        head.lookAt(tmpTarget);
      }

      // мигающий REC-огонёк
      const lamp = lampRef.current;
      if (lamp) {
        const blink = (Math.sin(state.clock.elapsedTime * 6) + 1) * 0.5;
        lamp.emissiveIntensity = 0.4 + blink * 2.2;
      }
    }

    if (!loop && !doneRef.current && timeRef.current >= total) {
      doneRef.current = true;
      onComplete?.();
    }
  });

  if (!renderRig) return null;

  return (
    <group name="camera-crane" position={baseVec}>
      {/* Платформа-основание */}
      <mesh position={[0, 0.15, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1.1, 1.35, 0.3, 24]} />
        <meshStandardMaterial color="#1c2230" metalness={0.7} roughness={0.4} />
      </mesh>

      {/* Жёлтое предупреждающее кольцо */}
      <mesh position={[0, 0.33, 0]}>
        <cylinderGeometry args={[1.12, 1.12, 0.06, 24]} />
        <meshStandardMaterial color="#ffd400" emissive="#ffd400" emissiveIntensity={0.5} />
      </mesh>

      {/* Выносные опоры (4 шт.) */}
      {[0, 1, 2, 3].map((i) => (
        <group key={i} rotation={[0, (i * Math.PI) / 2 + Math.PI / 4, 0]}>
          <mesh position={[0, 0.09, 1.9]} castShadow>
            <boxGeometry args={[0.24, 0.16, 1.5]} />
            <meshStandardMaterial color="#f5b400" metalness={0.6} roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.28, 2.5]}>
            <cylinderGeometry args={[0.14, 0.2, 0.52, 12]} />
            <meshStandardMaterial color="#141821" />
          </mesh>
        </group>
      ))}

      {/* Мачта (вращается по yaw) */}
      <group ref={mastRef}>
        <mesh ref={mastMeshRef} position={[0, 1, 0]} castShadow>
          <boxGeometry args={[0.34, 1, 0.34]} />
          <meshStandardMaterial color="#3a4254" metalness={0.6} roughness={0.45} />
        </mesh>

        {/* Пивот стрелы на вершине мачты */}
        <group ref={pivotRef} position={[0, 2, 0]}>
          <mesh>
            <boxGeometry args={[0.7, 0.4, 0.7]} />
            <meshStandardMaterial color="#ffd400" metalness={0.5} roughness={0.4} />
          </mesh>

          {/* Стрела (телескоп вдоль локального +Z) */}
          <mesh ref={boomRef} position={[0, 0.15, 1]} castShadow>
            <boxGeometry args={[0.22, 0.22, 1]} />
            <meshStandardMaterial color="#c8d0e0" metalness={0.7} roughness={0.35} />
          </mesh>

          {/* Противовес */}
          <mesh position={[0, -0.05, -1.1]} castShadow>
            <boxGeometry args={[1.0, 0.7, 1.4]} />
            <meshStandardMaterial color="#20242e" metalness={0.5} roughness={0.7} />
          </mesh>

          {/* Камера-голова на конце стрелы */}
          <group ref={headRef} position={[0, 0.2, 3]}>
            <mesh castShadow>
              <boxGeometry args={[0.5, 0.5, 0.6]} />
              <meshStandardMaterial color="#12161f" metalness={0.6} roughness={0.4} />
            </mesh>
            {/* Объектив смотрит в -Z (lookAt целится туда) */}
            <mesh position={[0, 0, -0.55]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.16, 0.2, 0.6, 20]} />
              <meshStandardMaterial color="#05070c" metalness={0.9} roughness={0.2} />
            </mesh>
            {/* REC-огонёк */}
            <mesh position={[0.26, 0.2, 0.1]}>
              <sphereGeometry args={[0.075, 12, 12]} />
              <meshStandardMaterial
                ref={lampRef}
                color="#ff2d2d"
                emissive="#ff2d2d"
                emissiveIntensity={2}
              />
            </mesh>
          </group>
        </group>
      </group>
    </group>
  );
}

export default CameraCrane;
