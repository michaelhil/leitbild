import { expect, test } from 'bun:test'
import { checkColdPartition, foldedGeometry, parsePrimaryMechanics, sectionMechanics } from './reference-design-primary-mechanics'

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
    coldHeaderHeight_m: 1, sgDevelopedLength_m: 20, downcomerBottom_m: -3, downcomerTop_m: 3 }) + '\n```'
  const parsed = parsePrimaryMechanics(doc)
  expect(parsed.coldHeaderHeight_m).toBe(1)
  expect(() => parsePrimaryMechanics(doc + '\n' + doc)).toThrow()
  expect(() => parsePrimaryMechanics(doc.replace('"coldHeaderHeight_m":1', '"coldHeaderHeight_m":0'))).toThrow()
})
