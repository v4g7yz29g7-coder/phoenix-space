'use strict';

/**
 * chaos_theory.js — wild chaos experiments.
 *
 * Pure-JS playground of deterministic-but-unpredictable systems:
 *   - Logistic map & bifurcation hunting
 *   - Lyapunov exponents (measure of chaos)
 *   - Lorenz & Rössler attractors (ODE integration)
 *   - Mandelbrot / Julia escape-time fractals
 *   - Double pendulum (Hamiltonian chaos)
 *   - Logistic-map PRNG + avalanche/bit-mixing tests
 *   - Orbit-diagram entropy estimation
 *
 * Public API:  chaosRun(a, b) -> report object
 *
 * Node --check clean. No dependencies.
 */

const TAU = Math.PI * 2;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/* ------------------------------------------------------------------ */
/* 1. Logistic map                                                      */
/* ------------------------------------------------------------------ */

function logisticMap(r, x0 = 0.4, steps = 1000) {
  const out = new Float64Array(steps);
  let x = x0;
  for (let i = 0; i < steps; i++) {
    x = r * x * (1 - x);
    out[i] = x;
  }
  return out;
}

function logisticSteadyState(r, x0 = 0.4, burn = 1000, keep = 64) {
  let x = x0;
  for (let i = 0; i < burn; i++) x = r * x * (1 - x);
  const vals = [];
  for (let i = 0; i < keep; i++) {
    x = r * x * (1 - x);
    vals.push(x);
  }
  return vals.sort((p, q) => p - q);
}

/* ------------------------------------------------------------------ */
/* 2. Lyapunov exponent                                                 */
/* ------------------------------------------------------------------ */

function lyapunovLogistic(r, x0 = 0.1234567, n = 20000, burn = 1000) {
  let x = x0;
  for (let i = 0; i < burn; i++) x = r * x * (1 - x);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(r * (1 - 2 * x));
    if (d > 0) sum += Math.log(d);
    x = r * x * (1 - x);
  }
  return sum / n;
}

function lyapunovMap(f, df, x0 = 0.5, n = 20000, burn = 1000) {
  let x = x0;
  for (let i = 0; i < burn; i++) x = f(x);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(df(x));
    if (d > 1e-15) s += Math.log(d);
    x = f(x);
  }
  return s / n;
}

/* ------------------------------------------------------------------ */
/* 3. ODE integrators + attractors                                      */
/* ------------------------------------------------------------------ */

function rk4(deriv, state, dt) {
  const n = state.length;
  const k1 = deriv(state);
  const s2 = new Array(n);
  for (let i = 0; i < n; i++) s2[i] = state[i] + (dt / 2) * k1[i];
  const k2 = deriv(s2);
  const s3 = new Array(n);
  for (let i = 0; i < n; i++) s3[i] = state[i] + (dt / 2) * k2[i];
  const k3 = deriv(s3);
  const s4 = new Array(n);
  for (let i = 0; i < n; i++) s4[i] = state[i] + dt * k3[i];
  const k4 = deriv(s4);
  const next = new Array(n);
  for (let i = 0; i < n; i++) {
    next[i] = state[i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }
  return next;
}

function lorenz({ sigma = 10, rho = 28, beta = 8 / 3 } = {}) {
  return (s) => [
    sigma * (s[1] - s[0]),
    s[0] * (rho - s[2]) - s[1],
    s[0] * s[1] - beta * s[2],
  ];
}

function rossler({ a = 0.2, b = 0.2, c = 5.7 } = {}) {
  return (s) => [-s[1] - s[2], s[0] + a * s[1], b + s[2] * (s[0] - c)];
}

function integrate(deriv, start, dt, steps) {
  let state = start.slice();
  const traj = [];
  for (let i = 0; i < steps; i++) {
    state = rk4(deriv, state, dt);
    traj.push(state);
  }
  return traj;
}

/* sensitivity: distance growth between two nearby trajectories */
function divergence(deriv, a, b, dt, steps) {
  let s1 = a.slice();
  let s2 = b.slice();
  const gaps = [];
  for (let i = 0; i < steps; i++) {
    s1 = rk4(deriv, s1, dt);
    s2 = rk4(deriv, s2, dt);
    let d = 0;
    for (let j = 0; j < s1.length; j++) d += (s1[j] - s2[j]) ** 2;
    gaps.push(Math.sqrt(d));
  }
  return gaps;
}

/* ------------------------------------------------------------------ */
/* 4. Fractals                                                          */
/* ------------------------------------------------------------------ */

function escapeTime(cRe, cIm, cRe0 = 0, cIm0 = 0, maxIter = 200, bail = 4) {
  let zx = cRe0;
  let zy = cIm0;
  for (let i = 0; i < maxIter; i++) {
    const x2 = zx * zx;
    const y2 = zy * zy;
    if (x2 + y2 > bail) return i;
    zy = 2 * zx * zy + cIm;
    zx = x2 - y2 + cRe;
  }
  return maxIter;
}

function mandelCount(reMin, reMax, imMin, imMax, w = 64, h = 64, maxIter = 128) {
  let inside = 0;
  for (let j = 0; j < h; j++) {
    const im = imMin + ((imMax - imMin) * j) / (h - 1);
    for (let i = 0; i < w; i++) {
      const re = reMin + ((reMax - reMin) * i) / (w - 1);
      if (escapeTime(re, im, 0, 0, maxIter) === maxIter) inside++;
    }
  }
  return { inside, total: w * h, ratio: inside / (w * h) };
}

/* Julia set for a fixed parameter c: iterate z -> z^2 + c from each pixel. */
function juliaCount(cRe, cIm, reMin, reMax, imMin, imMax, w = 64, h = 64, maxIter = 128) {
  let inside = 0;
  for (let j = 0; j < h; j++) {
    const im = imMin + ((imMax - imMin) * j) / (h - 1);
    for (let i = 0; i < w; i++) {
      const re = reMin + ((reMax - reMin) * i) / (w - 1);
      if (escapeTime(cRe, cIm, re, im, maxIter) === maxIter) inside++;
    }
  }
  return { c: [cRe, cIm], inside, total: w * h, ratio: inside / (w * h) };
}

/* ------------------------------------------------------------------ */
/* 5. Double pendulum (chaotic Hamiltonian system)                      */
/* ------------------------------------------------------------------ */

function doublePendulumDeriv({ m1 = 1, m2 = 1, l1 = 1, l2 = 1, g = 9.81 } = {}) {
  return (s) => {
    const [t1, t2, w1, w2] = s;
    const d = t1 - t2;
    const den = 2 * m1 + m2 - m2 * Math.cos(2 * d);
    const a1 =
      (-g * (2 * m1 + m2) * Math.sin(t1) -
        m2 * g * Math.sin(t1 - 2 * t2) -
        2 * Math.sin(d) * m2 * (w2 * w2 * l2 + w1 * w1 * l1 * Math.cos(d))) /
      (l1 * den);
    const a2 =
      (2 *
        Math.sin(d) *
        (w1 * w1 * l1 * (m1 + m2) +
          g * (m1 + m2) * Math.cos(t1) +
          w2 * w2 * l2 * m2 * Math.cos(d))) /
      (l2 * den);
    return [w1, w2, a1, a2];
  };
}

/* ------------------------------------------------------------------ */
/* 6. Logistic PRNG + avalanche / bit mixing                            */
/* ------------------------------------------------------------------ */

function logPrng(seed = 0.987654321, r = 3.9999) {
  let x = seed;
  return () => {
    x = r * x * (1 - x);
    return x;
  };
}

function bitsFromFloat(x, n = 32) {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0);
  const out = [];
  for (let i = 0; i < n; i++) out.push((hi >>> (31 - i)) & 1);
  return out;
}

function avalancheScore(seedA, seedB) {
  const a = bitsFromFloat(seedA, 32);
  const b = bitsFromFloat(seedB, 32);
  let diff = 0;
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) diff++;
  return diff / 32;
}

/* ------------------------------------------------------------------ */
/* 7. Entropy of an orbit                                               */
/* ------------------------------------------------------------------ */

function orbitEntropy(values, bins = 64) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const hist = new Array(bins).fill(0);
  for (const v of values) {
    const idx = clamp(Math.floor(((v - min) / span) * bins), 0, bins - 1);
    hist[idx]++;
  }
  const n = values.length;
  let H = 0;
  for (const c of hist) {
    if (c === 0) continue;
    const p = c / n;
    H -= p * Math.log2(p);
  }
  return H;
}

/* ------------------------------------------------------------------ */
/* 8. Bifurcation scan                                                  */
/* ------------------------------------------------------------------ */

function bifurcationScan(rMin = 2.5, rMax = 4, samples = 400, burn = 500, keep = 16) {
  const points = [];
  for (let i = 0; i < samples; i++) {
    const r = rMin + ((rMax - rMin) * i) / (samples - 1);
    let x = 0.4;
    for (let k = 0; k < burn; k++) x = r * x * (1 - x);
    for (let k = 0; k < keep; k++) {
      x = r * x * (1 - x);
      points.push({ r, x });
    }
  }
  return points;
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

function chaosRun(a = 3.99, b = 0.4) {
  const r = Number.isFinite(a) ? a : 3.99;
  const x0 = Number.isFinite(b) ? b : 0.4;

  const orbit = logisticMap(r, x0, 2000);
  const tail = Array.from(orbit.slice(-1000));
  const lambda = lyapunovLogistic(r, x0);
  const entropy = orbitEntropy(tail);

  const lorenzTraj = integrate(lorenz(), [1, 1, 1], 0.01, 5000);
  const lorenzTail = lorenzTraj.slice(-2000);
  const lorenzSpread = {
    x: Math.max(...lorenzTail.map((p) => p[0])) - Math.min(...lorenzTail.map((p) => p[0])),
    y: Math.max(...lorenzTail.map((p) => p[1])) - Math.min(...lorenzTail.map((p) => p[1])),
    z: Math.max(...lorenzTail.map((p) => p[2])) - Math.min(...lorenzTail.map((p) => p[2])),
  };

  const gaps = divergence(lorenz(), [1, 1, 1], [1.0001, 1, 1], 0.01, 2000);
  const firstCross = gaps.findIndex((d) => d > 1);

  const fractal = mandelCount(-2.5, 1, -1.25, 1.25, 128, 128, 128);

  const pendA = integrate(doublePendulumDeriv(), [Math.PI / 2, Math.PI / 2, 0, 0], 0.005, 4000);
  const pendB = integrate(doublePendulumDeriv(), [Math.PI / 2 + 1e-6, Math.PI / 2, 0, 0], 0.005, 4000);
  let pendGap = 0;
  for (let i = 0; i < pendA.length; i++) {
    let d = 0;
    for (let k = 0; k < 4; k++) d += (pendA[i][k] - pendB[i][k]) ** 2;
    pendGap = Math.max(pendGap, Math.sqrt(d));
  }

  const prng = logPrng(x0 === 0 ? 0.5 : x0, clamp(r, 3.9, 4));
  const stream = Array.from({ length: 512 }, () => prng());
  const av = avalancheScore(stream[0], stream[1]);

  const bifur = bifurcationScan(2.5, 4, 200, 500, 8);
  const bifurRs = [...new Set(bifur.map((p) => p.r))];
  const chaoticR = bifurRs.filter((rr) => lyapunovLogistic(rr, 0.4) > 0).length;

  const julia = juliaCount(-0.8, 0.156, -1.6, 1.6, -1.6, 1.6, 96, 96, 128);

  return {
    input: { r, x0 },
    lyapunov: lambda,
    chaotic: lambda > 0,
    orbitEntropyBits: entropy,
    orbitTailMean: tail.reduce((s, v) => s + v, 0) / tail.length,
    lorenzSpread,
    lorenzSensitiveAt: firstCross < 0 ? 'no-cross' : firstCross,
    mandelbrot: fractal,
    julia,
    doublePendulumMaxGap: pendGap,
    prngAvalanche: av,
    bifurcationPoints: chaoticR,
    bifurcationSample: bifur.slice(0, 5),
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                  */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  const [a, b] = process.argv.slice(2).map(Number);
  const report = chaosRun(a, b);
  console.log('=== CHAOS REPORT ===');
  console.log(JSON.stringify(report, null, 2));
  console.log('Rössler sample:', integrate(rossler(), [1, 1, 1], 0.01, 3));
  console.log('Julia(0,0) escape @ (0.3,0.5):', escapeTime(0, 0, 0.3, 0.5));
  console.log('TAU:', TAU);
}

module.exports = {
  chaosRun,
  logisticMap,
  logisticSteadyState,
  lyapunovLogistic,
  lyapunovMap,
  rk4,
  lorenz,
  rossler,
  integrate,
  divergence,
  escapeTime,
  mandelCount,
  juliaCount,
  doublePendulumDeriv,
  logPrng,
  avalancheScore,
  orbitEntropy,
  bifurcationScan,
};
