import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useArena } from '../store/arena';
import { getTrackCurve } from './Track';

/* ------------------------------------------------------------------ */
/*  Параметры трибун                                                    */
/* ------------------------------------------------------------------ */
const SECTIONS = 96; // секций вокруг трассы
const TIERS = 3; // 3 яруса
const STEPS_PER_TIER = 8; // ступеней в ярусе
const STEP_DEPTH = 1.2; // глубина ступени
const STEP_RISE = 0.55; // высота ступени
const STAND_START = 8; // отступ трибун от кромки трассы
const TIER_DEPTH = STEPS_PER_TIER * STEP_DEPTH; // глубина яруса
const TIER_BASE_HEIGHT = 6.5; // вертикальный сдвиг яруса
const SPECTATOR_COUNT = 10000; // зрителей-спрайтов

const SPECTATOR_COLORS = ['#ff3b30', '#3b82f6', '#22c55e', '#facc15'];

interface Frame {
  p: THREE.Vector3;
  normal: THREE.Vector3;
  tangent: THREE.Vector3;
  width: number;
}

/* ------------------------------------------------------------------ */
/*  Геометрия секций вдоль кривой трассы                                */
/* ------------------------------------------------------------------ */
function computeFrames(curve: THREE.CatmullRomCurve3, count: number): Frame[] {
  const up = new THREE.Vector3(0, 1, 0);
  const spaced = curve.getSpacedPoints(count);
  const frames: Frame[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const p = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t).setY(0).normalize();
    const normal = new THREE.Vector3().crossVectors(tangent, up).normalize();
    // Направляем нормаль наружу от центра арены
    if (normal.dot(p) < 0) normal.negate();
    const next = spaced[(i + 1) % count];
    const width = p.distanceTo(next);
    frames.push({ p, normal, tangent, width });
  }
  return frames;
}

/* ------------------------------------------------------------------ */
/*  Ступени + сиденья + крыша + опоры                                   */
/* ------------------------------------------------------------------ */
function buildStands(frames: Frame[]) {
  const perTier = SECTIONS * TIERS;
  const unit = new THREE.BoxGeometry(1, 1, 1);

  const stepMat = new THREE.MeshStandardMaterial({ color: '#2a2f3d', metalness: 0.2, roughness: 0.85 });
  const steps = new THREE.InstancedMesh(unit, stepMat, perTier * STEPS_PER_TIER);

  const benchMat = new THREE.MeshStandardMaterial({ color: '#3b4254', metalness: 0.3, roughness: 0.6 });
  const benches = new THREE.InstancedMesh(unit, benchMat, perTier * STEPS_PER_TIER);

  const roofMat = new THREE.MeshStandardMaterial({ color: '#151a26', metalness: 0.6, roughness: 0.4 });
  const roofs = new THREE.InstancedMesh(unit, roofMat, perTier);

  const pillarMat = new THREE.MeshStandardMaterial({ color: '#5b647a', metalness: 0.5, roughness: 0.5 });
  const pillars = new THREE.InstancedMesh(unit, pillarMat, perTier);

  const dummy = new THREE.Object3D();
  let si = 0;
  let ri = 0;
  const roofY = TIERS * TIER_BASE_HEIGHT + STEPS_PER_TIER * STEP_RISE + 3;

  frames.forEach((f) => {
    const yaw = Math.atan2(f.tangent.x, f.tangent.z);
    for (let t = 0; t < TIERS; t++) {
      for (let k = 0; k < STEPS_PER_TIER; k++) {
        const dist = STAND_START + t * TIER_DEPTH + k * STEP_DEPTH;
        const y = t * TIER_BASE_HEIGHT + k * STEP_RISE;

        // ступень
        dummy.position.set(f.p.x + f.normal.x * dist, y - STEP_RISE / 2, f.p.z + f.normal.z * dist);
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(f.width * 1.02, STEP_RISE, STEP_DEPTH * 1.02);
        dummy.updateMatrix();
        steps.setMatrixAt(si, dummy.matrix);

        // сиденье (сплошная лавка по ширине секции)
        dummy.position.set(f.p.x + f.normal.x * (dist - 0.15), y + 0.2, f.p.z + f.normal.z * (dist - 0.15));
        dummy.scale.set(f.width * 0.94, 0.4, 0.5);
        dummy.updateMatrix();
        benches.setMatrixAt(si, dummy.matrix);
        si++;
      }

      // крыша яруса
      const roofDist = STAND_START + t * TIER_DEPTH + TIER_DEPTH / 2;
      dummy.position.set(f.p.x + f.normal.x * roofDist, roofY + t * 0.6, f.p.z + f.normal.z * roofDist);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(f.width * 1.1, 0.25, TIER_DEPTH * 1.15);
      dummy.updateMatrix();
      roofs.setMatrixAt(ri, dummy.matrix);

      // опора у внешнего края
      const pH = roofY + t * 0.6;
      const pDist = STAND_START + (t + 1) * TIER_DEPTH;
      dummy.position.set(f.p.x + f.normal.x * pDist, pH / 2, f.p.z + f.normal.z * pDist);
      dummy.scale.set(0.4, pH, 0.4);
      dummy.updateMatrix();
      pillars.setMatrixAt(ri, dummy.matrix);
      ri++;
    }
  });

  steps.instanceMatrix.needsUpdate = true;
  benches.instanceMatrix.needsUpdate = true;
  roofs.instanceMatrix.needsUpdate = true;
  pillars.instanceMatrix.needsUpdate = true;

  return { steps, benches, roofs, pillars };
}

/* ------------------------------------------------------------------ */
/*  Толпа: 10000 спрайтов                                               */
/* ------------------------------------------------------------------ */
function buildCrowd(frames: Frame[]) {
  const geo = new THREE.PlaneGeometry(0.55, 1.0);
  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    emissive: new THREE.Color('#ffffff'),
    emissiveIntensity: 0,
    metalness: 0.1,
    roughness: 0.8,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.InstancedMesh(geo, material, SPECTATOR_COUNT);
  const baseY = new Float32Array(SPECTATOR_COUNT);
  const phase = new Float32Array(SPECTATOR_COUNT);
  const speed = new Float32Array(SPECTATOR_COUNT);

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  for (let i = 0; i < SPECTATOR_COUNT; i++) {
    const f = frames[Math.floor(Math.random() * frames.length)];
    const tier = i % TIERS;
    const step = Math.floor(Math.random() * STEPS_PER_TIER);
    const dist = STAND_START + tier * TIER_DEPTH + step * STEP_DEPTH + (Math.random() - 0.5) * 0.5;
    const along = (Math.random() - 0.5) * f.width * 0.9;
    const y = tier * TIER_BASE_HEIGHT + step * STEP_RISE + 0.6;

    dummy.position.set(
      f.p.x + f.normal.x * dist + f.tangent.x * along,
      y,
      f.p.z + f.normal.z * dist + f.tangent.z * along,
    );
    // Разворачиваем зрителя лицом к трассе (внутрь)
    dummy.rotation.set(0, Math.atan2(-f.normal.x, -f.normal.z), 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);

    color.set(SPECTATOR_COLORS[i % SPECTATOR_COLORS.length]);
    mesh.setColorAt(i, color);

    baseY[i] = y;
    phase[i] = Math.random() * Math.PI * 2;
    speed[i] = 1.5 + Math.random() * 2;
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  return { mesh, material, baseY, phase, speed };
}

/* ------------------------------------------------------------------ */
/*  Флаг гонки                                                          */
/* ------------------------------------------------------------------ */
function currentFlag(): 'idle' | 'green' | 'red' | 'white' {
  const list = Object.values(useArena.getState().agents);
  if (list.some((a) => a.status === 'failed')) return 'red';
  if (list.some((a) => a.status === 'done')) return 'white';
  if (list.some((a) => a.status === 'running')) return 'green';
  return 'idle';
}

/* ------------------------------------------------------------------ */
/*  Компонент                                                           */
/* ------------------------------------------------------------------ */
export function Tribunes() {
  const curve = useMemo(() => getTrackCurve(), []);
  const frames = useMemo(() => computeFrames(curve, SECTIONS), [curve]);
  const stands = useMemo(() => buildStands(frames), [frames]);
  const crowd = useMemo(() => buildCrowd(frames), [frames]);

  useFrame((state) => {
    const time = state.clock.getElapsedTime();
    const flag = currentFlag();
    const pulse = flag === 'green';

    // Анимация болтания зрителей + pulse при зелёном флаге
    const amp = pulse ? 0.18 : 0.06;
    const arr = crowd.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < SPECTATOR_COUNT; i++) {
      const bob = Math.sin(time * crowd.speed[i] + crowd.phase[i]) * amp;
      arr[i * 16 + 13] = crowd.baseY[i] + bob;
    }
    crowd.mesh.instanceMatrix.needsUpdate = true;
    crowd.material.emissiveIntensity = pulse ? 0.25 + Math.abs(Math.sin(time * 6)) * 0.25 : 0;
  });

  return (
    <group name="tribunes">
      <primitive object={stands.steps} />
      <primitive object={stands.benches} />
      <primitive object={stands.roofs} />
      <primitive object={stands.pillars} />
      <primitive object={crowd.mesh} />
    </group>
  );
}

export default Tribunes;
