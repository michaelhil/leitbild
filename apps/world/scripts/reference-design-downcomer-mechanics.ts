/** Offline LD-01 annular mechanical selection; no runtime registration or EOS solver. */
import { createHash } from 'node:crypto';

export const geometry = (() => {
  const volume = 20, length = 6, ri = 2, ro = Math.sqrt(ri ** 2 + volume / (Math.PI * length));
  const area = volume / length, perimeter = 2 * Math.PI * (ri + ro), dh = 4 * area / perimeter;
  return { volume, length, ri, ro, area, perimeter, dh, barrelBore: 3.8 };
})();

export type Fluid = { p: number; rhoL: number; rhoV: number; muL: number; muV: number; hL: number; hV: number };
// Reproducible HEOS Water saturation snapshots, CoolProp 8.0.0. Inputs, not fitted coefficients.
export const fluids: Fluid[] = [
  { p: 200000, rhoL: 942.9372284408797, rhoV: 1.1290738262030748, muL: 0.0002315995908701398, muV: 1.2933790546639222e-5, hL: 504704.18503804394, hV: 2706230.741339982 },
  { p: 1000000, rhoL: 887.1292659772964, rhoV: 5.145040779948233, muL: 0.00015048928440970725, muV: 1.498101350405946e-5, hL: 762515.0697660758, hV: 2777108.604047311 },
];
const g = 9.80665;

/** Churchill's tau/(rho*u²), with authored parallel-plate laminar 12/Re. */
export function shear(u: number, rho: number, mu: number, diameter: number): number {
  if (![u, rho, mu, diameter].every(Number.isFinite) || rho <= 0 || mu <= 0 || diameter <= 0) throw new Error('Invalid physical shear input');
  if (u === 0) return 0;
  const re = rho * Math.abs(u) * diameter / mu;
  // Log form evaluates the exact expression without overflowing its sixteenth powers.
  const a = 16 * Math.log(Math.abs(2.457 * Math.log(1 / (7 / re) ** .9)));
  const b = 16 * Math.log(37530 / re);
  const logSum = (x: number, y: number) => Math.max(x, y) + Math.log1p(Math.exp(-Math.abs(x - y)));
  const logF = logSum(12 * Math.log(12 / re), -1.5 * logSum(a, b)) / 12;
  return Math.exp(logF) * rho * u * Math.abs(u);
}

export function forces(alpha: number, ul: number, uv: number, dp: number, fluid: Fluid, waveScale = 1) {
  if (!(alpha >= 0 && alpha <= 1) || ![ul, uv, dp, waveScale].every(Number.isFinite) || waveScale < 0) throw new Error('Invalid phase state');
  const { area, volume, dh, perimeter, length } = geometry;
  const ml = (1 - alpha) * volume * fluid.rhoL, mv = alpha * volume * fluid.rhoV;
  const wallL = alpha < 1 ? perimeter * length * shear(ul, fluid.rhoL, fluid.muL, (1 - alpha) * dh) : 0;
  const wallV = alpha === 1 ? perimeter * length * shear(uv, fluid.rhoV, fluid.muV, dh) : 0;
  const inter = alpha > 0 && alpha < 1
    ? perimeter * length * shear(uv - ul, fluid.rhoV, fluid.muV, alpha * dh) * (1 + waveScale * 75 * (1 - alpha)) : 0;
  const externalL = (1 - alpha) * area * dp - ml * g;
  const externalV = alpha * area * dp - mv * g;
  return { ml, mv, wallL, wallV, inter, externalL, externalV,
    forceL: externalL + inter - wallL, forceV: externalV - inter - wallV,
    liquidHeat: wallL * ul, vaporHeat: inter * (uv - ul) + wallV * uv,
    liquidInterfaceWork: inter * ul, vaporInterfaceWork: -inter * ul };
}

/** Monotone signed stress inversion for this offline steady comparison, not a solver API. */
function invert(target: number, law: (u: number) => number): number {
  if (target === 0) return 0;
  const sign = Math.sign(target); let lo = 0, hi = 1;
  while (law(hi) < Math.abs(target)) { hi *= 2; if (hi > 1e6) throw new Error('Comparison inversion outside domain'); }
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (law(mid) < Math.abs(target)) lo = mid; else hi = mid; }
  return sign * (lo + hi) / 2;
}

export function settled(alpha: number, dp: number, fluid: Fluid, waveScale = 1) {
  const zero = forces(alpha, 0, 0, dp, fluid, waveScale);
  let ul = 0, uv = 0;
  if (alpha === 1) uv = invert(zero.externalV, v => forces(alpha, 0, v, dp, fluid).wallV);
  else {
    ul = invert(zero.externalL + zero.externalV, u => forces(alpha, u, u, dp, fluid, waveScale).wallL);
    if (alpha > 0) uv = ul + invert(zero.externalV, w => forces(alpha, 0, w, dp, fluid, waveScale).inter);
  }
  const f = forces(alpha, ul, uv, dp, fluid, waveScale);
  return { alpha, dp, waveScale, ul, uv, massL: fluid.rhoL * (1 - alpha) * geometry.area * ul,
    massV: fluid.rhoV * alpha * geometry.area * uv, forceResidual: Math.max(Math.abs(f.forceL), Math.abs(f.forceV)), dissipation: f.liquidHeat + f.vaporHeat };
}

/** Isolated frozen-holdup mechanics: trapezoidal force step with exact discrete work ledger. */
export function pulse(fluid: Fluid, dt: number) {
  const alpha = .95, initial = settled(alpha, 2000, fluid);
  let ul = initial.ul, uv = initial.uv, externalWork = 0, heatL = 0, heatV = 0;
  const f0 = forces(alpha, ul, uv, 2000, fluid), k0 = (f0.ml * ul ** 2 + f0.mv * uv ** 2) / 2;
  let final = initial;
  const samples: { t: number; ul: number; uv: number; quasiUl: number; quasiUv: number }[] = [];
  for (let step = 0; step < Math.round(.4 / dt); step++) {
    const t = (step + .5) * dt;
    const dp = 2000 + 4000 * Math.min(t / .1, 1);
    // Eliminate u_v by its monotone implicit midpoint drag equation; then solve total momentum.
    const oldL = ul, oldV = uv;
    const mv = f0.mv, ml = f0.ml;
    const uvFor = (newL: number) => {
      const meanL = (oldL + newL) / 2;
      const residual = (newV: number) => mv * (newV - oldV) / dt - forces(alpha, meanL, (oldV + newV) / 2, dp, fluid).forceV;
      let lo = -1, hi = 1;
      while (residual(lo) >= 0) { lo *= 2; if (lo < -1e6) throw new Error('Pulse vapor bracket'); }
      while (residual(hi) <= 0) { hi *= 2; if (hi > 1e6) throw new Error('Pulse vapor bracket'); }
      for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (residual(mid) < 0) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    };
    const residualL = (newL: number) => ml * (newL - oldL) / dt - forces(alpha, (oldL + newL) / 2, (oldV + uvFor(newL)) / 2, dp, fluid).forceL;
    let lo = -1, hi = 1;
    while (residualL(lo) >= 0) { lo *= 2; if (lo < -1e6) throw new Error('Pulse liquid bracket'); }
    while (residualL(hi) <= 0) { hi *= 2; if (hi > 1e6) throw new Error('Pulse liquid bracket'); }
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (residualL(mid) < 0) lo = mid; else hi = mid; }
    ul = (lo + hi) / 2; uv = uvFor(ul);
    const meanL = (oldL + ul) / 2, meanV = (oldV + uv) / 2;
    const f = forces(alpha, meanL, meanV, dp, fluid);
    externalWork += dt * (f.externalL * meanL + f.externalV * meanV);
    heatL += dt * f.liquidHeat; heatV += dt * f.vaporHeat;
    final = settled(alpha, dp, fluid);
    if ((step + 1) % Math.round(.1 / dt) === 0) samples.push({ t: (step + 1) * dt, ul, uv, quasiUl: final.ul, quasiUv: final.uv });
  }
  const k = (f0.ml * ul ** 2 + f0.mv * uv ** 2) / 2;
  return { p: fluid.p, alpha, dt, samples, externalWork, heatL, heatV, kineticChange: k - k0, energyResidual: k - k0 + heatL + heatV - externalWork };
}

export function comparison() {
  const steady = fluids.flatMap(f => [.2, .7, .95, .995].flatMap(a => [0, 2000, 6000].flatMap(dp => [.5, 1, 2].map(s => ({ p: f.p, ...settled(a, dp, f, s) })))));
  const endpoints = fluids.flatMap(f => [0, 1e-8, 1e-6, 1e-4, 1 - 1e-4, 1 - 1e-6, 1 - 1e-8, 1].map(a => ({ p: f.p, ...settled(a, 2000, f) })));
  const pulses = fluids.flatMap(f => [.002, .001].map(dt => pulse(f, dt)));
  const exactAnnulusConductance = Math.PI / 8 * (geometry.ro ** 4 - geometry.ri ** 4 - (geometry.ro ** 2 - geometry.ri ** 2) ** 2 / Math.log(geometry.ro / geometry.ri));
  const flatConductance = geometry.area * geometry.dh ** 2 / 48;
  let count = 0, radius = 0;
  for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++) if (i * i + j * j <= 61) { count++; radius = Math.max(radius, .2142 * Math.hypot(Math.abs(i) + .5, Math.abs(j) + .5)); }
  return { kind: 'offline-downcomer-mechanical-selection', propertyBasis: 'CoolProp 8.0.0 HEOS Water, P/Q saturated snapshots', geometry,
    assemblyClearance: { count, circumscribedDiameter: radius * 2, radialClearance: geometry.barrelBore / 2 - radius },
    laminarCurvature: { exactAnnulusConductance, flatConductance, relativeError: flatConductance / exactAnnulusConductance - 1 },
    fluids, steady, endpoints, pulses };
}

if (import.meta.main) {
  const sourceBefore = await Bun.file(import.meta.path).text();
  const result = comparison();
  if (sourceBefore !== await Bun.file(import.meta.path).text()) throw new Error('Source changed during calculation');
  const receipt = { sourceSha256: createHash('sha256').update(sourceBefore).digest('hex'), ...result };
  const output = process.argv[2];
  if (!output) throw new Error('Usage: bun reference-design-downcomer-mechanics.ts output.json');
  await Bun.write(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ output, steady: result.steady.length, endpoints: result.endpoints.length, pulses: result.pulses.length, maxEnergyResidual: Math.max(...result.pulses.map(p => Math.abs(p.energyResidual))) }));
}
