import { expect, test } from 'bun:test'
import { checkGeometry, parseGeometryBasis, ringArea, tankGeometry, type GeometryBasis } from './reference-design-cmt-geometry.ts'

const basis: GeometryBasis = { freeWater_m3: 60, bottomDatum_m: 6, top_m: 12, bodyBottom_m: 11.725,
  bodyTop_m: 11.975, bodyOuterDiameter_m: .41, bodyEffectiveInnerDiameter_m: .35,
  feedOuterDiameter_m: .22, feedInnerDiameter_m: .2, mouthDiameter_m: .2,
  balanceWater_m3: 1, distributorGroupWater_m3: .05, hardwareSolid_m3: .02,
  holeDiameter_m: .06153846153846154, holesPerRing: 10, ringElevations_m: [11.925, 11.85, 11.775],
  upperTap_m: 11.95, topProbe_m: 11.25, bottomProbe_m: 6.75,
  probeRadialInset_m: .15, probeAzimuth_deg: 18 }
const document = (b: unknown) => '```reference-cmt-geometry\n' + JSON.stringify(b) + '\n```'

test('selected geometry is explicit; overlapping apertures, incompatible inventories and hidden fields reject', () => {
  expect(parseGeometryBasis(document(basis))).toEqual(basis)
  for (const b of [{ ...basis, ringElevations_m: [11.925, 11.925, 11.775] },
    { ...basis, ringElevations_m: [11.925, 11.9, 11.775] }, { ...basis, holeDiameter_m: .12 },
    { ...basis, bodyEffectiveInnerDiameter_m: .15 }, { ...basis, topProbe_m: 12 },
    { ...basis, freeWater_m3: Infinity }, { ...basis, entranceLoss: 1 }])
    expect(() => parseGeometryBasis(document(b))).toThrow()
  expect(() => tankGeometry({ ...basis, distributorGroupWater_m3: .01 })).toThrow()
  expect(() => tankGeometry({ ...basis, hardwareSolid_m3: .001 })).toThrow()
  expect(() => tankGeometry({ ...basis, upperTap_m: 12 })).toThrow()
  expect(() => tankGeometry({ ...basis, probeRadialInset_m: 2 })).toThrow()
  expect(() => parseGeometryBasis(document({ ...basis, probeAzimuth_deg: 360 }))).toThrow()
})

test('CMT sensing tips use fixed physical coordinates, not mesh centers or section means', () => {
  const g = tankGeometry(basis)
  expect(g.probes.map(p => p.elevation_m)).toEqual([11.25, 6.75])
  for (const p of g.probes) {
    expect(p.wallRadius_m - p.radius_m).toBeCloseTo(.15, 12)
    expect(Math.hypot(p.x_m, p.y_m)).toBeCloseTo(p.radius_m, 12)
    expect(p.radius_m ** 2).toBeLessThan(g.shellR2(p.elevation_m))
    expect(p.azimuth_deg).toBe(18)
    // A manufactured radial field demonstrates why its area mean is not the tip value.
    const point = 30 + 100 * (p.radius_m / p.wallRadius_m) ** 2
    const sectionMean = 30 + 100 / 2
    expect(point - sectionMean).toBeGreaterThan(30)
  }
  expect(checkGeometry(basis).probes).toEqual(g.probes)
})

test('real tank volume, lower mouth and internal/external inventory reproduce independent analytic values', () => {
  const g = tankGeometry(basis)
  expect(g.R).toBeCloseTo(1.88618807437, 9)
  expect(g.mouth).toBeCloseTo(6.001326357248, 11)
  expect(g.volume()).toBeCloseTo(60, 11)
  expect(g.volume(g.mouth, 7)).toBeCloseTo(7.66323005546, 7)
  expect(g.volume(g.mouth, 8)).toBeCloseTo(18.84009137415, 7)
  expect(g.area(g.mouth)).toBeCloseTo(Math.PI * .1 ** 2, 12)
  expect(g.area(12)).toBe(0)
  expect(g.volume(g.roof(.11), 12)).toBe(0)
  expect(g.inventories.internalBAL_m3 + g.inventories.externalBAL_m3).toBe(1)
  expect(g.inventories.internalSolid_m3 + g.inventories.externalHardware_m3).toBe(.02)
})

test('whole-domain r/z partition preserves volume, actual open faces and circular aperture measure', () => {
  const result = checkGeometry(basis), g = tankGeometry(basis)
  expect(result.numericalGeometryPassed).toBe(true)
  expect(result.transportImplemented).toBe(false)
  expect(result.partitions[1]!.activeCells).toBeGreaterThan(result.partitions[0]!.activeCells)
  expect(result.partitions.every(p => p.cellsReachableFromMouth === p.activeCells && p.ringAdjacentRecipientCells > 0)).toBe(true)
  expect(result.checks.every(c => Math.abs(c.residual) <= c.tolerance)).toBe(true)
  const z = basis.ringElevations_m[0], half = ringArea(basis, z, z, 12)
  expect(half).toBeCloseTo(5 * Math.PI * (basis.holeDiameter_m / 2) ** 2, 12)
  expect(g.radialFace(.205, basis.bodyBottom_m, basis.bodyTop_m)).toBe(0)
  // No open numerical face through a closed distributor end cap; source holes are separate boundaries.
  expect(g.area(basis.bodyBottom_m, 0, .205)).toBe(0)
  expect(g.area(basis.bodyTop_m, 0, .205)).toBe(0)
  expect(g.radialFace(.3, basis.bodyBottom_m, basis.bodyTop_m)).toBeGreaterThan(0)
})
