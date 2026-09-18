import { useMemo } from 'react';
import * as THREE from 'three';
import tracksData from '../data/tracks.json';

export interface TrackPoint {
  x: number;
  z: number;
  radius?: number;
}

export interface TrackDef {
  id: string;
  name: string;
  difficulty: string;
  length: number;
  lanes: number;
  path: TrackPoint[];
  tribunes: Array<{ side: string; size: number; levels: number }>;
}

const ALL_TRACKS = (tracksData as { tracks: TrackDef[] }).tracks;
export const DEFAULT_TRACK: TrackDef = ALL_TRACKS[0];

/** Ширина полотна трассы */
export const ROAD_WIDTH = 9;

/** Преобразует точку из tracks.json в 3D-координату (поддержка spiral: radius) */
function toVector3(p: TrackPoint, i: number, total: number): THREE.Vector3 {
  if (typeof p.radius === 'number') {
    const angle = (i / Math.max(1, total)) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(angle) * p.radius, 0, Math.sin(angle) * p.radius);
  }
  return new THREE.Vector3(p.x, 0, p.z);
}

/** Строит замкнутую кривую Катмулла-Рома по path трассы */
export function buildCurve(track: TrackDef): THREE.CatmullRomCurve3 {
  const points = track.path.map((p, i) => toVector3(p, i, track.path.length));
  return new THREE.CatmullRomCurve3(points, true, 'catmullrom', 0.5);
}

/** Кривая трассы по умолчанию (module-level, используется export-функциями) */
const trackCurve: THREE.CatmullRomCurve3 = buildCurve(DEFAULT_TRACK);

/**
 * Позиция на кривой трассы при t в диапазоне 0..1.
 * Публичный экспорт для TV Director / болидов.
 */
export function getTrackProgress(t: number): { x: number; y: number; z: number } {
  const tt = THREE.MathUtils.clamp(t, 0, 1);
  const p = trackCurve.getPointAt(tt);
  return { x: p.x, y: p.y, z: p.z };
}

export function getTrackCurve(): THREE.CatmullRomCurve3 {
  return trackCurve;
}

/** Точка финиша трассы */
export function getFinishPoint(): { x: number; y: number; z: number } {
  return getTrackProgress(1);
}

/** Плоская лента (полотно / разметка), повторяющая кривую */
function buildRibbon(
  curve: THREE.CatmullRomCurve3,
  width: number,
  y: number,
  samples = 400,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const half = width / 2;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    const side = new THREE.Vector3().crossVectors(tan, up).normalize().multiplyScalar(half);
    positions.push(p.x - side.x, y, p.z - side.z);
    positions.push(p.x + side.x, y, p.z + side.z);
    uvs.push(0, t * 30, 1, t * 30);
    if (i < samples) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

const CURB_SEGMENTS = 120;

/** Красно-белые бордюры по обе стороны трассы */
function buildCurb(curve: THREE.CatmullRomCurve3): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(0.8, 0.18, 1.4);
  const mat = new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.75 });
  const mesh = new THREE.InstancedMesh(geo, mat, CURB_SEGMENTS * 2);

  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const red = new THREE.Color('#e10600');
  const white = new THREE.Color('#f5f5f5');
  let index = 0;

  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < CURB_SEGMENTS; i++) {
      const t = i / CURB_SEGMENTS;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t);
      const sideVec = new THREE.Vector3()
        .crossVectors(tan, up)
        .normalize()
        .multiplyScalar(side * (ROAD_WIDTH / 2 + 0.4));
      dummy.position.set(p.x + sideVec.x, 0.09, p.z + sideVec.z);
      dummy.rotation.set(0, Math.atan2(tan.x, tan.z), 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      mesh.setColorAt(index, i % 2 === 0 ? red : white);
      index++;
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/** Шахматная линия старта/финиша в начале кривой */
function FinishLine({ curve }: { curve: THREE.CatmullRomCurve3 }) {
  const { position, angle } = useMemo(() => {
    const p = curve.getPointAt(0);
    const tan = curve.getTangentAt(0);
    return {
      position: new THREE.Vector3(p.x, 0.05, p.z),
      angle: Math.atan2(tan.x, tan.z),
    };
  }, [curve]);

  const cells = 10;
  const cellWidth = ROAD_WIDTH / cells;

  return (
    <group position={position} rotation={[0, angle, 0]}>
      {Array.from({ length: cells }).map((_, i) => (
        <mesh
          key={i}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[(i - cells / 2 + 0.5) * cellWidth, 0, 0]}
        >
          <planeGeometry args={[cellWidth, 1.4]} />
          <meshStandardMaterial color={i % 2 === 0 ? '#f5f5f5' : '#101010'} />
        </mesh>
      ))}
    </group>
  );
}

/** Прямая арена -> FORMULA I1 трасса */
export function Track() {
  const roadGeo = useMemo(() => buildRibbon(trackCurve, ROAD_WIDTH, 0.02, 420), []);
  const centerGeo = useMemo(() => buildRibbon(trackCurve, 0.35, 0.045, 420), []);
  const curb = useMemo(() => buildCurb(trackCurve), []);

  return (
    <group name="track">
      {/* Асфальт — PBR */}
      <mesh geometry={roadGeo} receiveShadow>
        <meshStandardMaterial
          color="#1a1a1a"
          metalness={0.3}
          roughness={0.7}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Жёлтая разметка по центру */}
      <mesh geometry={centerGeo}>
        <meshStandardMaterial
          color="#ffd400"
          metalness={0.1}
          roughness={0.6}
          emissive="#ffd400"
          emissiveIntensity={0.25}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Красно-белые бордюры */}
      <primitive object={curb} />

      <FinishLine curve={trackCurve} />
    </group>
  );
}
