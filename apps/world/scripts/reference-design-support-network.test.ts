import { expect, test } from 'bun:test'
import { parseSupportBasis, selectSupportPoint, supportPoint } from './reference-design-support-network'
import { parseStationBasis } from './reference-design-station'

const b = { jacketDesignRise_K: 10, minimumBranch_kg_s: 5, localDesignDrop_MPa: .25, coolerFixedDrop_MPa: .04,
  coolerValveDrop_MPa: .01, bypassFixedDrop_MPa: .01, bypassValveDrop_MPa: .01, exchangerSide_MW_K: 8,
  serviceExchangerFlow_kg_s: 2000, rhrReference_kg_s: 500, rhrLoad_MW: 31.920, jacket_MW_K: { rcp: .05, feed: .02, small: .005, oil: 5 } }
const page = '```reference-support-network\n' + JSON.stringify(b) + '\n```'
// Deliberately synthetic station fixture, not a recorded LD-01 operating point.
const station = parseStationBasis('```reference-station\n' + JSON.stringify({
  design: 'LD-01', alignment: 'full-power-RHR-isolated', waterDensity_kg_m3: 1000, waterCp_J_kgK: 4180, siteWater_C: 20, ambient_C: 25,
  condenserOnlyRise_K: 10, CW: { head_MPa: .3, hydraulicEfficiency: .85, motorEfficiency: .96, dragFraction: 0 },
  CCW: { head_MPa: .3, hydraulicEfficiency: .8, motorEfficiency: .94, dragFraction: 0, ratedFlow_kg_s: 600, auxiliaryBranchReference_kg_s: 100, supply_C: 30 },
  SW: { head_MPa: .3, hydraulicEfficiency: .8, motorEfficiency: .94, dragFraction: .01, flowA_kg_s: 2000, flowB_kg_s: 3000 },
  shaftMechanicalEfficiency: .995, dcLoadA_kW: 8, dcLoadB_kW: 5, converterEfficiency: .92, fanEach_kW: 20,
  transformerFixed_kW: 20, transformerLoadFraction: .01, busEach_MW: 40, source_MW: 90,
  roomAirEach_kg_s: 20, airCp_J_kgK: 1005, roomWallEach_MW_K: .02, CWmotorEach_MW_K: .02, serviceMotorEach_MW_K: .002, transformerEach_MW_K: .02,
}) + '\n```')
const branches = [{ id: 'hot', heat_MW: 1, reference_kg_s: 100, conductance_MW_K: .5 }]

test('support input is one strict consumed record', () => {
  expect(parseSupportBasis(page)).toEqual(b)
  expect(() => parseSupportBasis(page + '\n' + page)).toThrow()
  expect(() => parseSupportBasis(page.replace('"minimumBranch_kg_s":5', '"minimumBranch_kg_s":-1'))).toThrow()
})
test('each actual path pays local and common pressure loss once', () => {
  const p = supportPoint(b, station, branches, 0, 20, 0, false)
  const independentFlow = Math.sqrt(.375 / (.25 / 100 ** 2 + .05 / 600 ** 2 + .075 / 600 ** 2))
  expect(p.flow_kg_s).toBeCloseTo(independentFlow, 10)
  expect(p.head_MPa).toBeCloseTo(p.localDrop_MPa + p.commonDrop_MPa, 12)
  expect(p.hxFlow_kg_s).toBe(p.flow_kg_s)
  expect(p.bypassFlow_kg_s).toBe(0)
  expect(p.temperatures_C.coolerOutlet).toBeCloseTo(p.temperatures_C.supply!, 10)
  expect(Math.abs(p.branchMixResidual_MW!)).toBeLessThan(1e-10)
  expect(Math.abs(p.supplyMixResidual_MW!)).toBeLessThan(1e-10)
})
test('full bypass and blocked hot jacket have no positive-load thermal steady state', () => {
  const bypass = supportPoint(b, station, branches, 1, 20, 0, false)
  expect(bypass.hxFlow_kg_s).toBe(0)
  expect(bypass.feasible).toBe(false)
  expect(bypass.temperatures_C.supply).toBeNull()
  const blocked = supportPoint(b, station, [...branches, { id: 'idle', heat_MW: 0, reference_kg_s: 5, conductance_MW_K: .5 }], .5, 20, 0, false, 'hot')
  expect(blocked.feasible).toBe(false)
  expect(blocked.temperatures_C.wall).toBeNull()
})
test('both sides of the wall and service-water warming limit capacity', () => {
  const p = supportPoint(b, station, branches, 0, 20, 0, false)
  const expected = 20 + p.heat_MW / (2000 * 4180 / 1e6) + 2 * p.heat_MW / 8
  expect(p.temperatures_C.supply).toBeCloseTo(expected, 12)
  expect(selectSupportPoint(b, station, branches, 35, 0).targetAchievable).toBe(false)
  expect(selectSupportPoint(b, station, branches, 20, 0).targetAchievable).toBe(true)
})
test('invalid branch data and absent blocking targets are rejected', () => {
  expect(() => supportPoint(b, station, [{ ...branches[0]!, heat_MW: NaN }], .5, 20, 0, false)).toThrow()
  expect(() => supportPoint(b, station, branches, .5, 20, 0, false, 'missing')).toThrow()
  expect(() => supportPoint(b, station, [branches[0]!, branches[0]!], .5, 20, 0, false)).toThrow()
})
