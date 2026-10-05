import { expect, test } from 'bun:test'
import { checkColdPartition, coldReturnGeometry, foldedGeometry, parsePrimaryBarrelGeometry, parsePrimaryMechanics, sectionMechanics } from './reference-design-primary-mechanics'

test('cold channels and real header partition one inventory, never add a second old header', () => {
  checkColdPartition(20, 8, 4)
  expect(() => checkColdPartition(20, 8, 20)).toThrow()
  expect(() => checkColdPartition(20, 10, 4)).toThrow()
  expect(() => checkColdPartition(20, NaN, 4)).toThrow()
})

test('folded SG closes actual endpoint elevations and developed length', () => {
  const g = foldedGeometry(20, 2.5, 12, 3)
  expect(g.riseLength_m + g.crownLength_m + g.descentLength_m).toBeCloseTo(20, 12)
  expect(g.riseLength_m + g.radius_m).toBeCloseTo(9.5, 12)
  expect(g.descentLength_m + g.radius_m).toBeCloseTo(9, 12)
  // Independent midpoint integration of the selected straight/circular paths.
  let moment = 0
  const n = 10000
  for (let i = 0; i < n; i++) {
    const f = (i + .5) / n
    moment += (2.5 + f * g.riseLength_m) * g.riseLength_m / n
    moment += (3 + f * g.descentLength_m) * g.descentLength_m / n
    moment += (12 - g.radius_m + g.radius_m * Math.sin(Math.PI * f)) * g.crownLength_m / n
  }
  expect(Math.abs(moment / 20 - g.meanElevation_m)).toBeLessThan(1e-8)
  for (const length of [18, 18.5, 40, NaN]) expect(() => foldedGeometry(length, 2.5, 12, 3)).toThrow()
})

test('signed channel motion preserves nonnegative native kinetic energy and fixed inventory', () => {
  const f = sectionMechanics(8, .4, 700, 4000), r = sectionMechanics(8, .4, 700, -4000)
  expect(f.velocity_m_s).toBe(-r.velocity_m_s)
  expect(f.fluidKineticEnergy_J).toBe(r.fluidKineticEnergy_J)
  expect(f.fluidKineticEnergy_J).toBeCloseTo(.5 * 700 * 8 * (4000 / 280) ** 2, 8)
  expect(f.massFlowInertance_per_m).toBe(50)
  expect(sectionMechanics(8, .4, 700, 0).residenceTime_s).toBeNull()
  expect(sectionMechanics(8, .4, 700, 0).fluidKineticEnergy_J).toBe(0)
  expect(() => sectionMechanics(8, 0, 700, 1)).toThrow()
})

test('declared choices parse strictly and carry actual header height', () => {
  const doc = '```reference-primary-mechanics\n' + JSON.stringify({ design: 'LD-01', hotInsideDiameter_m: 1,
    pumpPassageInsideDiameter_m: .7, pumpPassageVolume_m3: 8, coldHeaderVolume_m3: 4,
    coldHeaderHeight_m: 1, coldReturnLength_m: .5, sgDevelopedLength_m: 20, downcomerBottom_m: -3, downcomerTop_m: 3 }) + '\n```'
  const parsed = parsePrimaryMechanics(doc)
  expect(parsed.coldHeaderHeight_m).toBe(1)
  expect(() => parsePrimaryMechanics(doc + '\n' + doc)).toThrow()
  expect(() => parsePrimaryMechanics(doc.replace('"coldHeaderHeight_m":1', '"coldHeaderHeight_m":0'))).toThrow()
})

test('barrel radii have one strict owner and finite return mouths fit the real annulus', () => {
  const barrelDocument = '```reference-primary-barrel-geometry\n{"innerRadius_m":1.9,"outerRadius_m":2}\n```'
  const barrel = parsePrimaryBarrelGeometry(barrelDocument)
  expect(() => parsePrimaryBarrelGeometry(barrelDocument + '\n' + barrelDocument)).toThrow()
  expect(() => parsePrimaryBarrelGeometry(barrelDocument.replace('1.9', '2.1'))).toThrow()
  expect(() => parsePrimaryBarrelGeometry(barrelDocument.replace('"outerRadius_m":2', '"outerRadius_m":2,"extra":0'))).toThrow()
  const selection = parsePrimaryMechanics('```reference-primary-mechanics\n' + JSON.stringify({ design: 'LD-01',
    hotInsideDiameter_m: 1, pumpPassageInsideDiameter_m: .7, pumpPassageVolume_m3: 8,
    coldHeaderVolume_m3: 4, coldHeaderHeight_m: 1, coldReturnLength_m: .5,
    sgDevelopedLength_m: 20, downcomerBottom_m: -3, downcomerTop_m: 3 }) + '\n```')
  const g = coldReturnGeometry(selection, barrel, 20)
  expect(g.area_m2).toBeCloseTo(2 * Math.PI * .7 ** 2 / 4, 14)
  expect(g.insideDiameter_m).toBeCloseTo(Math.SQRT2 * .7, 14)
  expect(g.wettedPerimeter_m).toBeCloseTo(Math.PI * g.insideDiameter_m, 14)
  expect(g.wettedPerimeter_m).not.toBeCloseTo(2 * Math.PI * .7, 6)
  expect(.5 * (g.annularOuterRadius_m ** 2 - g.annularInnerRadius_m ** 2) * g.mouthSectorAngle_rad)
    .toBeCloseTo(g.area_m2, 14)
  expect(g.mouthSectorAngle_rad).toBeLessThan(Math.PI)
  expect(g.mouthCentres_rad).toEqual([0, Math.PI])
  expect(g.meanElevation_m).toBe(3)
  expect(g.volumePerTrain_m3).toBeCloseTo(.3848451000647496, 14)
  expect(g.addedMainVolume_m3).toBe(2 * g.volumePerTrain_m3)
  expect(coldReturnGeometry({ ...selection, coldReturnLength_m: 1 }, barrel, 20).addedMainVolume_m3)
    .toBe(2 * g.addedMainVolume_m3)
  expect(() => coldReturnGeometry(selection, barrel, 0)).toThrow()
  expect(() => coldReturnGeometry(selection, barrel, 1)).toThrow()
  expect(() => coldReturnGeometry({ ...selection, coldHeaderHeight_m: .9 }, barrel, 20)).toThrow()
})
