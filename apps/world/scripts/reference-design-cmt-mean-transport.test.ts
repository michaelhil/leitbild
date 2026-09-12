import { test, expect } from 'bun:test'
import { checkMeanTransport, constituent, moments, parseMeanTransportBasis, type MeanTransportBasis } from './reference-design-cmt-mean-transport.ts'

// Standalone test inputs; no sibling wiki, research environment or property package.
const b: MeanTransportBasis = { Cd: .62, Cv: .98, flow_kg_s: 25, D25_m2_s: 1.07e-9, mu25_Pa_s: .0008900224890776955,
  states: [{ T: 313.15, rho: 998.7373535000849, mu: .0006547658656041072, cp: 4143.936144343833,
    alpha: .00038991773668077583, c: 1555.0722859521386, conductivity: .6363475209361235 },
  { T: 563.15, rho: 745.7158573797482, mu: .00009238956797398296, cp: 5251.918779041047,
    alpha: .00253453405748272, c: 1021.9583436875857, conductivity: .5787930804311847 }] }
const record = (x: unknown) => '```reference-cmt-mean-transport\n' + JSON.stringify(x) + '\n```'
const geometry = { holeDiameter_m: .06153846153846154, bodyOuterDiameter_m: .41,
  holesPerRing: 10 as const, ringElevations_m: [11.925, 11.850, 11.775] as [number, number, number] }
test('jet covariance and third moment preserve signed total kinetic flux', () => {
  const r = checkMeanTransport(geometry, parseMeanTransportBasis(record(b)))
  expect(r.jet.omittedMeanOnlyKineticFraction).toBeGreaterThan(.94)
  for (const x of r.boundary) expect(Math.abs(x.ledger_W)).toBeLessThan(1e-12)
  expect(r.boundary[0]!.tractionWork_W).toBeGreaterThan(0)
  expect(r.boundary[1]!.unresolvedFlux_W).toBe(-r.boundary[0]!.unresolvedFlux_W)
  expect(r.boundary[2]!.mass_kg_s).toBeCloseTo(0, 12)
  expect(r.boundary[2]!.unresolvedFlux_W).toBeGreaterThan(0)
  expect(r.connectedTransportQualified).toBe(false)
})
test('stable, unstable and adiabatic gradients keep paired entropy and finite decay', () => {
  const r = checkMeanTransport(geometry, b)
  for (const x of r.buoyancy) {
    expect(x.entropy_W_m3K).toBeCloseTo(x.expectedEntropy_W_m3K, 12)
    expect(x.G_W_m3).toBeCloseTo(-b.states.find(w => w.T === x.T_K)!.rho * x.diffusivity * x.N2_s2, 12)
  }
  for (const x of r.decay) {
    expect(x.k_J_kg + x.internalGain_J_kg).toBeCloseTo(r.boundary[0]!.k, 14)
    for (const w of x.states) { expect(w.DB_m2_s).toBeGreaterThan(0); expect(w.boronModeAmplitude).toBeGreaterThan(0) }
  }
})
test('analytic zero/wall states, invalid boundaries and duplicate records', () => {
  expect(constituent(0, .06, 0, 1)).toEqual({ l: 0, nu: 0, diffusivity: 0, epsilon: 0 })
  expect(() => constituent(-1, .06, 1, 0)).toThrow()
  expect(() => constituent(1, .06, 0, 0)).toThrow()
  expect(() => constituent(1, .06, 1, NaN)).toThrow()
  expect(() => parseMeanTransportBasis(record(b) + '\n' + record(b))).toThrow()
  expect(() => parseMeanTransportBasis(record({ ...b, hiddenSeed: 1 }))).toThrow()
  expect(() => moments([{ fraction: .5, rho: 1, v: 1 }], 1)).toThrow()
})
