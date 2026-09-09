import { expect, test } from 'bun:test'
import { parseRhrSupport } from './reference-design-rhr-support'

const basis = { primaryInlet_C: 150, primaryOutlet_C: 100, primaryPressure_MPa: 1, primaryFlow_kg_s: 150,
  primaryPumpTotal_kg_s: 165, primaryPumpHead_MPa: .5, primaryHydraulicEfficiency: .75, primaryMotorEfficiency: .92,
  primaryDragFraction: .01, referenceWall_C: 70, referenceColdInlet_C: 30, referenceColdFlow_kg_s: 500,
  primaryPipe_m3: 1, primaryHX_m3: 3, rhrWall_MJ_K: 50, rhrCold_m3: 5, supply_m3: 250, return_m3: 200,
  cooler_m3: 50, supportWall_MJ_K: 100, sw_m3: 100 }
const page = (b: unknown) => '```reference-rhr-support\n' + JSON.stringify(b) + '\n```'

test('RHR consumes exactly one strict owned apparatus record', () => {
  expect(parseRhrSupport(page(basis))).toEqual(basis)
  expect(() => parseRhrSupport(page(basis) + '\n' + page(basis))).toThrow()
  expect(() => parseRhrSupport(page({ ...basis, overrideHeat: 32 }))).toThrow()
})
test('RHR sizing rejects nonphysical inventory, temperature and pump-flow boundaries', () => {
  expect(() => parseRhrSupport(page({ ...basis, rhrCold_m3: 0 }))).toThrow()
  expect(() => parseRhrSupport(page({ ...basis, referenceWall_C: 110 }))).toThrow()
  expect(() => parseRhrSupport(page({ ...basis, primaryPumpTotal_kg_s: 140 }))).toThrow()
  expect(() => parseRhrSupport(page({ ...basis, primaryHydraulicEfficiency: 1.1 }))).toThrow()
})
