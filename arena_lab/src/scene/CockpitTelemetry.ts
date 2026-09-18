/**
 * CockpitTelemetry.ts — «Пилот за стеклом» telemetry bus
 * ============================================================================
 * FORMULA I1 · STAGE «Киберпанк-кар» · TASK 2.5 (data layer)
 *
 * `PilotCockpit.tsx` already publishes a per-frame {@link CockpitTelemetry}
 * sample through its optional `onTelemetry` sink, but a render-tree callback is
 * awkward to consume from outside the `<Canvas>` (DOM HUD, minimap, socket
 * broadcast, replay). This module is the missing bridge: a tiny, framework-free
 * pub/sub bus with a bounded rolling history, so *any* subsystem can read the
 * pilot's speed / boost / steering once per frame without prop-drilling.
 *
 *   import { cockpitTelemetry, publishCockpitTelemetry } from './CockpitTelemetry';
 *
 *   // producer — inside the scene:
 *   <PilotCockpit onTelemetry={publishCockpitTelemetry} />
 *
 *   // consumer — anywhere (React effect, socket loop, requestAnimationFrame):
 *   useEffect(() => cockpitTelemetry.subscribe((s) => setSpeed(s.kmh)), []);
 *
 * Zero allocations after warm-up, zero dependencies, SSR-safe (guards
 * `performance`). Companion to `PilotCockpit.tsx` / `CockpitStage.tsx`.
 * ============================================================================
 */
import type { CockpitTelemetry } from './PilotCockpit';

/** Scene units / second → km/h. Keeps the 4-wheel port's scale believable. */
export const SCENE_UNITS_PER_KMH = 0.3;

/** A stamped telemetry frame handed to subscribers. */
export interface CockpitTelemetrySample extends CockpitTelemetry {
  /** Monotonic timestamp in ms (or seconds if `performance` is unavailable). */
  readonly t: number;
  /** Convenience read-out: speed converted to km/h. */
  readonly kmh: number;
  /** Normalised 0..1 speed, against the bus' current `referenceSpeed`. */
  readonly ratio: number;
}

export type CockpitTelemetryListener = (sample: CockpitTelemetrySample) => void;

const HISTORY_LIMIT = 120; // ~2 s @ 60 fps — enough for a mini graph / replay ping

/**
 * Bounded, dependency-free telemetry bus used by the cockpit kit.
 *
 * Publishing is O(listeners): we reuse a single mutable sample object so the
 * hot render path performs no allocations. History stores frozen snapshots so
 * late readers always see the value as it was, not as it mutates.
 */
export class CockpitTelemetryBus {
  /** Speed (scene units / s) that maps to `ratio === 1`. */
  referenceSpeed = 88;

  private readonly listeners = new Set<CockpitTelemetryListener>();
  private readonly history: CockpitTelemetrySample[] = [];
  private readonly scratch: {
    speed: number;
    boost: number;
    steer: number;
    t: number;
    kmh: number;
    ratio: number;
  } = { speed: 0, boost: 0, steer: 0, t: 0, kmh: 0, ratio: 0 };

  /** Latest published snapshot (null until the first frame). */
  latest: CockpitTelemetrySample | null = null;

  /** Subscribe to every published frame. Returns an unsubscribe function. */
  subscribe(listener: CockpitTelemetryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Push the current frame. Called once per `useFrame` by the cockpit. */
  publish(telemetry: CockpitTelemetry): CockpitTelemetrySample {
    const s = this.scratch;
    s.speed = telemetry.speed;
    s.boost = telemetry.boost;
    s.steer = telemetry.steer;
    s.t = now();
    s.kmh = Math.round(telemetry.speed / SCENE_UNITS_PER_KMH);
    s.ratio = this.referenceSpeed > 0 ? clamp01(telemetry.speed / this.referenceSpeed) : 0;

    // One frozen snapshot per frame → safe to retain in history / `latest`.
    const sample: CockpitTelemetrySample = Object.freeze({ ...s });
    this.latest = sample;

    if (this.history.length >= HISTORY_LIMIT) this.history.shift();
    this.history.push(sample);

    for (const listener of this.listeners) listener(sample);
    return sample;
  }

  /** Read-only view of the rolling history, oldest → newest. */
  getHistory(): readonly CockpitTelemetrySample[] {
    return this.history;
  }

  /** Average km/h across the stored window (0 when empty). */
  averageKmh(): number {
    if (this.history.length === 0) return 0;
    let sum = 0;
    for (const s of this.history) sum += s.kmh;
    return sum / this.history.length;
  }

  /** Drop the rolling history (keeps subscribers + reference speed). */
  reset(): void {
    this.history.length = 0;
    this.latest = null;
  }
}

/** Shared bus instance used by the cockpit stage. */
export const cockpitTelemetry = new CockpitTelemetryBus();

/**
 * Module-level producer callback — stable identity, so it can be handed
 * straight to `<PilotCockpit onTelemetry={...} />` without re-creating props
 * every render (which would defeat memoisation).
 */
export function publishCockpitTelemetry(telemetry: CockpitTelemetry): void {
  cockpitTelemetry.publish(telemetry);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export default cockpitTelemetry;
