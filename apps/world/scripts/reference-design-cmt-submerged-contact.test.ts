import { expect, test } from 'bun:test'
import { parseSubmergedBasis, recipientConfinement, type SubmergedBasis } from './reference-design-cmt-submerged-contact.ts'
import type { GeometryBasis } from './reference-design-cmt-geometry.ts'

// Explicit test-only geometry; no sibling wiki, research Python or downloaded source dependency.
const geometry: GeometryBasis = { freeWater_m3: 60, bottomDatum_m: 6, top_m: 12,
  bodyBottom_m: 11.725, bodyTop_m: 11.975, bodyOuterDiameter_m: .41, bodyEffectiveInnerDiameter_m: .35,
  feedOuterDiameter_m: .22, feedInnerDiameter_m: .20, mouthDiameter_m: .20,
  balanceWater_m3: 1, distributorGroupWater_m3: .05, hardwareSolid_m3: .02,
  holeDiameter_m: .06153846153846154, holesPerRing: 10, ringElevations_m: [11.925, 11.850, 11.775],
  upperTap_m: 11.95, topProbe_m: 11.25, bottomProbe_m: 6.75, probeRadialInset_m: .15, probeAzimuth_deg: 18 }
const basis: SubmergedBasis = { pressure_Pa: 5e6, staticPressures_Pa: [1e6, 15e6], contactVolume_m3: .01, duration_s: .1,
  initialVoids: [.1, .4, .9], subcoolings_K: [50, 2], sizeFactors: [.5, 1, 2],
  coldWitness: { pressure_Pa: 15202734.919352943, enthalpy_J_kg: 1286155.0442236066, elevation_m: 3,
    parentSha256: 'ad606e4d156cb9b635bfbd3fbdeb8e6eaf21bd53e60b510ad57dcabe82136ca6' },
  boronFraction: .002, residualVaporFraction: 1e-6, coldHeaderPlanArea_m2: 4 }
const block = (x: unknown) => '```reference-cmt-submerged\n' + JSON.stringify(x) + '\n```'
test('strict bounded contact record does not silently broaden selected cases', () => {
  expect(parseSubmergedBasis(block(basis))).toEqual(basis)
  expect(() => parseSubmergedBasis(block(basis) + '\n' + block(basis))).toThrow()
  expect(() => parseSubmergedBasis(block({ ...basis, pressure_Pa: 22e6 }))).toThrow()
  expect(() => parseSubmergedBasis(block({ ...basis, hiddenSteamLifetime_s: .02 }))).toThrow()
  expect(() => parseSubmergedBasis(block({ ...basis, duration_s: 10 }))).toThrow()
})
test('actual annular and header confinement is independent of computational resolution', () => {
  const c = recipientConfinement(geometry, 4)
  expect(c).toHaveLength(4)
  for (const x of c) {
    expect(x.Dh_m).toBeCloseTo(4 * x.planArea_m2 / x.solidPerimeter_m, 12)
    expect(x.Dh_m).toBeGreaterThan(geometry.holeDiameter_m)
  }
  expect(c[0]!.Dh_m).toBeLessThan(c[1]!.Dh_m)
  expect(c[1]!.Dh_m).toBeLessThan(c[2]!.Dh_m)
  expect(c[3]!.Dh_m).toBeCloseTo(2 * Math.sqrt(4 / Math.PI), 12)
  expect(c[3]!.elevation_m).toBe(3)
})
test('invalid physical receiving section is rejected rather than replaced by mesh size', () => {
  expect(() => recipientConfinement(geometry, 0)).toThrow()
  expect(() => recipientConfinement(geometry, NaN)).toThrow()
  expect(() => recipientConfinement(geometry, Infinity)).toThrow()
})
