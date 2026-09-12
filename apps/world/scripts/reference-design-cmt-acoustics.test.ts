import { expect, test } from 'bun:test'
import { acousticMesh, parseAcousticBasis } from './reference-design-cmt-acoustics.ts'
import type { GeometryBasis } from './reference-design-cmt-geometry.ts'

const basis: ReturnType<typeof parseAcousticBasis> = { pressure_MPa: 15.2, temperature_C: 40, pulse_Pa: 100,
  duration_s: .002, steps_s: [.00001, .000005], referenceFlow_kg_s: 25, impedanceReferenceTemperature_C: 290,
  holeDischargeCoefficient: .62, balanceLoss_Pa: 2000, outletLoss_Pa: 20000, dviVolume_m3: .5,
  maximumMidpointRelativeError: .01, maximumTagDifference_kg: 1e-8 }
const document = (b: unknown) => '```reference-cmt-acoustics\n' + JSON.stringify(b) + '\n```'
const geometry: GeometryBasis = { freeWater_m3: 60, bottomDatum_m: 6, top_m: 12, bodyBottom_m: 11.725,
  bodyTop_m: 11.975, bodyOuterDiameter_m: .41, bodyEffectiveInnerDiameter_m: .35,
  feedOuterDiameter_m: .22, feedInnerDiameter_m: .2, mouthDiameter_m: .2,
  balanceWater_m3: 1, distributorGroupWater_m3: .05, hardwareSolid_m3: .02,
  holeDiameter_m: .06153846153846154, holesPerRing: 10, ringElevations_m: [11.925, 11.85, 11.775],
  upperTap_m: 11.95, topProbe_m: 11.25, bottomProbe_m: 6.75,
  probeRadialInset_m: .15, probeAzimuth_deg: 18 }

test('acoustic reference inputs reject hidden fields, invalid impedances and unmatched temporal pairs', () => {
  expect(parseAcousticBasis(document(basis))).toEqual(basis)
  for (const b of [{ ...basis, steps_s: [.00001, .000003] }, { ...basis, duration_s: .002003 },
    { ...basis, holeDischargeCoefficient: 1.1 }, { ...basis, dviVolume_m3: 0 }, { ...basis, hiddenMixing: 1 }])
    expect(() => parseAcousticBasis(document(b))).toThrow()
})

test('actual-domain acoustic partitions retain material and complete physical ports without inventing port inertia', () => {
  for (const [fine, count] of [[false, 39], [true, 138]] as const) {
    const mesh = acousticMesh(geometry, fine)
    expect(mesh.cells.length).toBe(count)
    expect(mesh.freeWater_m3).toBeCloseTo(60, 10)
    expect(mesh.internalBAL_m3 + mesh.externalBAL_m3).toBe(1)
    // Circle-segment endpoints retain the existing geometry check's absolute 1e-9 m² tolerance.
    expect(Math.abs(mesh.holes.reduce((s, f) => s + f.area_m2, 0) - 30 * Math.PI * (geometry.holeDiameter_m / 2) ** 2)).toBeLessThan(1e-9)
    expect(mesh.mouth.reduce((s, f) => s + f.area_m2, 0)).toBeCloseTo(Math.PI * .1 ** 2, 12)
    for (let d = 0; d < 2; d++) {
      expect(mesh.movingComponentVolume_m3[d]! + mesh.unallocatedBoundaryHalfVolume_m3[d]!).toBeCloseTo(60, 10)
      expect(mesh.unallocatedBoundaryHalfVolume_m3[d]!).toBeGreaterThan(0)
    }
    expect(mesh.faces.every(f => f.area_m2 > 0 && f.dualVolume_m3 > 0 && f.left !== f.right)).toBe(true)
  }
})
