import { expect, test } from 'bun:test'
import { capContacts, parseCapBasis } from './reference-design-cmt-cap-interface.ts'
import { type GeometryBasis } from './reference-design-cmt-geometry.ts'

// Explicit clean-checkout fixture; no sibling wiki or research dependency.
const geometry: GeometryBasis = { freeWater_m3: 60, bottomDatum_m: 6, top_m: 12,
  bodyBottom_m: 11.725, bodyTop_m: 11.975, bodyOuterDiameter_m: .41, bodyEffectiveInnerDiameter_m: .35,
  feedOuterDiameter_m: .22, feedInnerDiameter_m: .20, mouthDiameter_m: .20,
  balanceWater_m3: 1, distributorGroupWater_m3: .05, hardwareSolid_m3: .02,
  holeDiameter_m: .06153846153846154, holesPerRing: 10, ringElevations_m: [11.925, 11.850, 11.775],
  upperTap_m: 11.95, topProbe_m: 11.25, bottomProbe_m: 6.75, probeRadialInset_m: .15, probeAzimuth_deg: 18 }
const basis: ReturnType<typeof parseCapBasis> = { pressures_Pa: [1e6, 5e6, 15e6], liquidDonorK_J_kg: .03192509963313496,
  receiverVolume_m3: .5, receivedSteam_kg: .02, boronFraction: .002 }
const block = (x: unknown) => '```reference-cmt-cap\n' + JSON.stringify(x) + '\n```'
test('separated phase volumes partition only actual free tank space', () => {
  const rows = capContacts(geometry)
  for (const r of rows) {
    expect(r.liquidVolume_m3 + r.vaporVolume_m3).toBeCloseTo(60, 10)
    expect(r.liquidVolume_m3).toBeGreaterThanOrEqual(0)
    expect(r.vaporVolume_m3).toBeGreaterThanOrEqual(0)
  }
  expect(rows[0]!.liquidMouthEligible).toBe(false)
  expect(rows[0]!.liquidVolume_m3).toBe(0)
  expect(rows.at(-1)!.vaporVolume_m3).toBe(0)
})
test('ring-center phase contact retains two half apertures without whole-hole switching', () => {
  const rows = capContacts(geometry)
  for (const z of geometry.ringElevations_m) {
    const ring = rows.find(r => r.height_m === z)!.rings.find(r => r.z_m === z)!
    expect(ring.liquidArea_m2).toBeCloseTo(ring.totalArea_m2 / 2, 12)
    expect(ring.vaporArea_m2).toBeCloseTo(ring.totalArea_m2 / 2, 12)
  }
  expect(rows.find(r => r.height_m === 11.25)!.probeContact[1]).toBe('interface')
  expect(rows.find(r => r.height_m === 6.75)!.probeContact[0]).toBe('interface')
})
test('bounded phase-input contract rejects invalid or ambiguous records', () => {
  expect(parseCapBasis(block(basis))).toEqual(basis)
  expect(() => parseCapBasis(block(basis) + '\n' + block(basis))).toThrow()
  expect(() => parseCapBasis(block({ ...basis, liquidDonorK_J_kg: -1 }))).toThrow()
  expect(() => parseCapBasis(block({ ...basis, hiddenVaporFloor: 1e-6 }))).toThrow()
  expect(() => parseCapBasis(block({ ...basis, pressures_Pa: [1e6, 5e6, 22e6] }))).toThrow()
})
