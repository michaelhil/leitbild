import { expect, test } from 'bun:test'
import { checkColdHeaderPort, coldHeaderPort, parseColdHeaderBasis } from './reference-design-cold-header-port.ts'
const basis = { area_m2: 4, bottom_m: 2.5, top_m: 3.5, tap_m: 3, tapBore_m: .2 } as const
const doc = '```reference-cold-header\n' + JSON.stringify(basis) + '\n```\n'
test('actual header input is explicit and standalone', () => {
  expect(parseColdHeaderBasis(doc)).toEqual(basis)
  expect(() => parseColdHeaderBasis(doc + doc)).toThrow()
  expect(() => parseColdHeaderBasis(doc.replace('"area_m2":4', '"area_m2":20'))).toThrow()
})
test('physical side tap changes phase only through its actual intersection', () => {
  expect(coldHeaderPort(basis, 2.85).liquidArea_m2).toBe(0)
  expect(coldHeaderPort(basis, 3.15).vaporArea_m2).toBe(0)
  const half = coldHeaderPort(basis, 3)
  expect(half.liquidArea_m2).toBeCloseTo(Math.PI * .01 / 2, 14)
  expect(half.vaporArea_m2).toBeCloseTo(half.liquidArea_m2, 14)
  expect(() => coldHeaderPort(basis, Number.NaN)).toThrow()
  expect(() => coldHeaderPort(basis, 4)).toThrow()
})
test('zero net mass does not erase the actual signed material/energy donors', () => {
  const q = checkColdHeaderPort(basis).prescribedOpposedExchange
  expect(q.netMass_kg).toBe(0)
  expect(q.grossMass_kg).toBe(.02)
  expect(q.headerChange.E_J).toBeCloseTo(18000.0012, 8)
  expect(q.headerChange.B_kg).toBe(-.00002)
  expect(q.headerChange.E_J + q.passageChange.E_J).toBe(0)
  expect(q.headerChange.B_kg + q.passageChange.B_kg).toBe(0)
  expect(q.strips.map(s => s.donor)).toEqual(['COLD header', 'BAL passage'])
})
