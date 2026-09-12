/** Finite analytic mean-closure selection, not a receiving-flow or TT simulation. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseGeometryBasis } from './reference-design-cmt-geometry.ts'

const positive = z.number().finite().positive()
const water = z.object({ T: positive, rho: positive, mu: positive, cp: positive,
  alpha: positive, c: positive, conductivity: positive }).strict()
const schema = z.object({ Cd: positive.max(1), Cv: positive.max(1), flow_kg_s: positive,
  D25_m2_s: positive, mu25_Pa_s: positive, states: z.tuple([water, water]) }).strict()
export type MeanTransportBasis = z.infer<typeof schema>
export function parseMeanTransportBasis(doc: string) {
  const blocks = [...doc.matchAll(/^```reference-cmt-mean-transport\s*\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('Expected one reference-cmt-mean-transport block')
  const b = schema.parse(JSON.parse(blocks[0]![1]!))
  if (b.Cd > b.Cv) throw new Error('Invalid contraction')
  return b
}
export function constituent(k: number, L: number, wallDistance: number, N2: number) {
  if (![k, L, wallDistance, N2].every(Number.isFinite) || k < 0 || L <= 0 || wallDistance < 0)
    throw new Error('Invalid mean closure state')
  if (k === 0) return { l: 0, nu: 0, diffusivity: 0, epsilon: 0 }
  if (wallDistance === 0) throw new Error('Positive k at solid wall')
  const l = Math.min(L, .7 * wallDistance, N2 > 0 ? .76 * Math.sqrt(k / N2) : L)
  const nu = .1 * l * Math.sqrt(k)
  return { l, nu, diffusivity: (1 + 2 * l / L) * nu,
    epsilon: (.19 + .51 * l / L) * k ** 1.5 / l }
}
/** One-dimensional normal traces; tensor analogue is specified in the owner. */
export function moments(traces: { fraction: number; rho: number; v: number }[], A: number) {
  if (!(A > 0 && Number.isFinite(A)) || traces.some(x => ![x.fraction, x.rho, x.v].every(Number.isFinite)
    || x.fraction < 0 || x.rho <= 0) || Math.abs(traces.reduce((s, x) => s + x.fraction, 0) - 1) > 1e-14)
    throw new Error('Invalid aperture traces')
  const rho = traces.reduce((s, x) => s + x.fraction * x.rho, 0)
  const mean = traces.reduce((s, x) => s + x.fraction * x.rho * x.v, 0) / rho
  const R = traces.reduce((s, x) => s + x.fraction * x.rho * (x.v - mean) ** 2, 0)
  const k = R / (2 * rho), m = A * rho * mean
  const exactKinetic_W = A * traces.reduce((s, x) => s + .5 * x.fraction * x.rho * x.v ** 3, 0)
  const meanKinetic_W = .5 * m * mean ** 2, tractionWork_W = A * R * mean
  const thirdMoment_W = .5 * A * traces.reduce((s, x) => s + x.fraction * x.rho * (x.v - mean) ** 3, 0)
  const unresolvedFlux_W = m * k + thirdMoment_W
  return { rho, mean, R, k, mass_kg_s: m, exactKinetic_W, meanKinetic_W, tractionWork_W,
    thirdMoment_W, unresolvedFlux_W, ledger_W: exactKinetic_W - meanKinetic_W - tractionWork_W - unresolvedFlux_W }
}
export function checkMeanTransport(g: Pick<ReturnType<typeof parseGeometryBasis>, 'holeDiameter_m' | 'bodyOuterDiameter_m' | 'holesPerRing' | 'ringElevations_m'>, b: MeanTransportBasis) {
  const D = g.holeDiameter_m, A = Math.PI * g.bodyOuterDiameter_m * D
  const holes = g.holesPerRing * Math.PI * D ** 2 / 4, phi = b.Cd / b.Cv * holes / A
  if (!(phi > 0 && phi < 1)) throw new Error('Overlapping contracted jet reference')
  const hot = b.states[1], v = b.flow_kg_s / g.ringElevations_m.length / (hot.rho * phi * A)
  const jet = (sign: number) => moments([{ fraction: phi, rho: hot.rho, v: sign * v },
    { fraction: 1 - phi, rho: hot.rho, v: 0 }], A)
  const boundary = [jet(1), jet(-1), moments([{ fraction: 1 / 3, rho: hot.rho, v },
    { fraction: 2 / 3, rho: hot.rho, v: -v / 2 }], A), jet(0)]
  const guard = (ok: boolean, name: string) => { if (!ok) throw new Error(name) }
  for (const x of boundary) guard(Math.abs(x.ledger_W) < 1e-12 && x.k >= 0, 'Boundary moment ledger')
  guard(Math.abs(boundary[2]!.mass_kg_s) < 1e-14 && boundary[2]!.unresolvedFlux_W > 0, 'Zero-net energy transport')
  const k0 = boundary[0]!.k
  const buoyancy = b.states.flatMap(w => [-100, 0, 100].map(entropyGradient => {
    const dp = -w.rho * 9.80665, rhoS = -w.rho * w.alpha * w.T / w.cp
    const drho = dp / w.c ** 2 + rhoS * entropyGradient
    const N2 = 9.80665 / w.rho * (dp / w.c ** 2 - drho)
    const c = constituent(k0, D, 1, N2), a = -c.diffusivity / w.rho * rhoS * entropyGradient
    const G = a * dp, qh = -w.rho * c.diffusivity * w.T * entropyGradient
    const dT = w.T / w.cp * (entropyGradient + w.alpha / w.rho * dp)
    const entropy = -G / w.T - qh * dT / w.T ** 2
    const expected = w.rho * c.diffusivity / w.cp * entropyGradient ** 2
    guard(Math.abs(G + w.rho * c.diffusivity * N2) < 1e-12, 'Hydrostatic buoyancy sign')
    guard(Math.abs(entropy - expected) < 1e-12 && entropy >= -1e-14, 'Paired entropy identity')
    return { T_K: w.T, entropyGradient_J_kgK_m: entropyGradient, N2_s2: N2, ...c, G_W_m3: G,
      qh_W_m2: qh, entropy_W_m3K: entropy, expectedEntropy_W_m3K: expected,
      molecularEntropy_W_m3K: w.conductivity * (dT / w.T) ** 2, dissipationEntropy_W_m3K: w.rho * c.epsilon / w.T }
  }))
  const decay = [.5, 1, 2].flatMap(factor => [.1, 1].map(t => {
    const L = factor * D, x = .7 * Math.sqrt(k0) * t / (2 * L)
    const k = k0 / (1 + x) ** 2, integral = .6 * L ** 2 / .7 * Math.log1p(x)
    const decayDerivative = -.7 * k0 ** 1.5 / L / (1 + x) ** 3
    const diffusivityDerivative = .3 * L * Math.sqrt(k0) / (1 + x)
    guard(Math.abs(decayDerivative + constituent(k, L, 10, 0).epsilon) < 1e-14
      && Math.abs(diffusivityDerivative - constituent(k, L, 10, 0).diffusivity) < 1e-14, 'Analytic decay and diffusion derivatives')
    const states = b.states.map(w => {
      const DB = b.D25_m2_s * w.T / 298.15 * b.mu25_Pa_s / w.mu
      const alpha = w.conductivity / (w.rho * w.cp), wave = Math.PI / D
      return { T_K: w.T, DB_m2_s: DB, molecularBoronDistance1s_m: Math.sqrt(2 * DB),
        heatModeAmplitude: Math.exp(-(wave ** 2) * (integral + alpha * t)),
        boronModeAmplitude: Math.exp(-(wave ** 2) * (integral + DB * t)) }
    })
    guard(k > 0 && k < k0 && Math.abs((k0 - k) + k - k0) < 1e-16, 'Decay conserves U+Q')
    return { lengthFactor: factor, t_s: t, k_J_kg: k, internalGain_J_kg: k0 - k,
      decayDerivative_J_kg_s: decayDerivative, diffusivityDerivative_m2_s: diffusivityDerivative,
      integratedDiffusivity_m2: integral, states }
  }))
  const c = constituent(k0, D, 1, 0)
  // Cylindrical S=(1,-2,1), Srz=3 s^-1, divergence zero; includes hoop strain.
  const production = (rr: number, zz: number, hoop: number, rz: number) => {
    const div = rr + zz + hoop
    return 2 * hot.rho * c.nu * ((rr - div / 3) ** 2 + (zz - div / 3) ** 2
      + (hoop - div / 3) ** 2 + 2 * rz ** 2) - 2 / 3 * hot.rho * k0 * div
  }
  const strainProduction = production(1, -2, 1, 3), reversed = production(-1, 2, -1, -3)
  const compression = production(-1, -1, -1, 0)
  guard(strainProduction > 0 && reversed === strainProduction && compression > 0
    && constituent(0, D, 0, 1).epsilon === 0, 'Strain and analytic wall/zero limits')
  return { scope: 'Analytic mean-closure budget selection; no connected thermal front or TT accuracy',
    jet: { contractedFraction: phi, jetVelocity_m_s: v, crossing_s: D / v,
      omittedMeanOnlyKineticFraction: 1 - phi ** 2 }, boundary, buoyancy, decay,
    strainProduction_W_m3: strainProduction, reversedStrainProduction_W_m3: reversed,
    compressionProduction_W_m3: compression,
    analyticSelectionChecksPassed: true, connectedTransportQualified: false, pointTTQualified: false }
}
if (import.meta.main) {
  const [geometryPath, transportPath, output] = process.argv.slice(2)
  if (!geometryPath || !transportPath || !output) throw new Error('Usage: bun reference-design-cmt-mean-transport.ts geometry.md transport.md output.json')
  const hash = (x: string) => createHash('sha256').update(x).digest('hex')
  const sourceHash = hash(await Bun.file(import.meta.path).text())
  const geometry = parseGeometryBasis(await Bun.file(geometryPath).text())
  const basis = parseMeanTransportBasis(await Bun.file(transportPath).text())
  await Bun.write(output, JSON.stringify({ sourceHash, inputHash: hash(JSON.stringify({ geometry, basis })), geometry, basis,
    ...checkMeanTransport(geometry, basis) }, null, 2) + '\n')
}
