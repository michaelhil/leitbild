import { expect, test } from 'bun:test'
import { ruptureBasis as b, rupturePatches } from './reference-design-rupture-interfaces'

test('independent header and sump intersections retain both physical and effective aperture', () => {
  const rows = rupturePatches(3, 3.005), area = Math.PI * (b.rcsDiameter_m / 2) ** 2
  expect(area).toBeGreaterThan(b.rcsCdA_m2)
  expect(rows.map(q => [q.header, q.receiver])).toEqual([['liquid', 'liquid'], ['gas', 'liquid'], ['gas', 'gas']])
  expect(rows[0]!.area_m2).toBeCloseTo(area / 2, 13)
  expect(rows.reduce((s, q) => s + q.effectiveArea_m2, 0)).toBeCloseTo(b.rcsCdA_m2, 13)
  // Independent midpoint integration of the circle width, not the consumed primitive.
  const r = b.rcsDiameter_m / 2, lo = 0, hi = .005, n = 10000, dz = (hi - lo) / n
  let integrated = 0
  for (let i = 0; i < n; i++) integrated += 2 * Math.sqrt(r * r - (lo + (i + .5) * dz) ** 2) * dz
  expect(Math.abs(integrated - rows[1]!.area_m2)).toBeLessThan(1e-12)
})

test('actual full wet/dry endpoints and invalid input, with unchanged fault size/time', () => {
  expect(rupturePatches(2.98, 3.02).map(q => [q.header, q.receiver])).toEqual([['gas', 'liquid']])
  expect(rupturePatches(3.02, 2.98).map(q => [q.header, q.receiver])).toEqual([['liquid', 'gas']])
  expect(() => rupturePatches(Number.NaN, 3)).toThrow()
  expect(b.sgCdA_m2).toBe(2e-5)
  expect(b.rcsCdA_m2).toBe(1e-4)
  expect(b.openingTime_s).toBe(.1)
})

test('all sharp-interface combinations satisfy the receipt area gate at the 20mm opening', () => {
  const surfaces = [2.98, 2.99, 2.995, 3, 3.005, 3.01, 3.02]
  const area = Math.PI * (b.rcsDiameter_m / 2) ** 2
  for (const header of surfaces) for (const receiver of surfaces) {
    const patches = rupturePatches(header, receiver)
    expect(Math.abs(patches.reduce((s, q) => s + q.area_m2, 0) - area)).toBeLessThan(1e-15)
    expect(Math.abs(patches.reduce((s, q) => s + q.effectiveArea_m2, 0) - b.rcsCdA_m2)).toBeLessThan(1e-15)
  }
})
