import { expect, test } from 'bun:test'
import { applyJacketLoads, assertPzrEvidenceLineage, auditPzrInterface, reconcileFixedCycle } from './reference-design-primary-station'

// Exact synthetic thermodynamic budget for arithmetic tests, not plant evidence.
const reference = { powers_MW: { SG_total: 102, turbine_thermodynamic_work: 40, gross_electric: 39,
  condenser: 65, feed_pump_fluid: 2, condensate_pump_fluid: 1, feed_pump_electric: 2.2,
  condensate_pump_electric: 1.1, regenerated_feed_heat: 8 }, flows: { SG_total_kg_s: 20 } }
const boundary = { sourceHeat_W: 200e6, shaftToFluid_W: 4e6, electricalInput_W: 5e6,
  perSGHeat_W: 102e6, independentSGHeat_W: 102e6 }
test('fixed-state secondary scales extensive duties, not new primary power or fixed equipment loads', () => {
  const result = reconcileFixedCycle(reference, boundary)
  expect(result.scale).toBe(2)
  expect(result.steamFlow_kg_s).toBe(40)
  expect(result.powers_MW.gross_electric).toBe(78)
  expect(result.powers_MW.RCP_electric).toBe(5)
  expect(result.powers_MW.electrical_after_listed_pumps).toBeCloseTo(66.4, 12)
  expect(result.secondaryResidual_MW).toBe(0)
  expect(result).not.toHaveProperty('points')
  expect(reference.powers_MW.gross_electric).toBe(39)
})
test('primary numerical heat residual is separate from exact secondary budget arithmetic', () => {
  const result = reconcileFixedCycle(reference, { ...boundary, independentSGHeat_W: 102e6 + 2 })
  expect(result.primaryQuadratureResidual_W).toBe(-4)
  expect(result.secondaryResidual_MW).toBe(0)
  for (const edit of [{ sourceHeat_W: NaN }, { perSGHeat_W: 0 }, { electricalInput_W: 3e6 },
    { perSGHeat_W: 102e6 + 10 }, { independentSGHeat_W: 102e6 + 10 }])
    expect(() => reconcileFixedCycle(reference, { ...boundary, ...edit })).toThrow()
  expect(() => reconcileFixedCycle({ ...reference, powers_MW: { ...reference.powers_MW, condenser: 66 } }, boundary)).toThrow('first law')
})
test('changed jacket heat never resizes installed reference flow or conductance', () => {
  const sized = [{ id: 'a', heat_MW: 1, reference_kg_s: 20, conductance_MW_K: .1 }]
  const changed = [{ id: 'a', heat_MW: 3, reference_kg_s: 60, conductance_MW_K: .3 }]
  expect(applyJacketLoads(sized, changed)).toEqual([{ ...sized[0]!, heat_MW: 3 }])
  expect(sized[0]!.heat_MW).toBe(1)
  expect(() => applyJacketLoads(sized, [{ ...changed[0]!, id: 'b' }])).toThrow()
  expect(() => applyJacketLoads(sized, [...changed, ...changed])).toThrow()
  expect(() => applyJacketLoads(sized, [{ ...changed[0]!, heat_MW: NaN }])).toThrow()
})

const interfaceInput = { coreFlow_kg_s: 100, hotAFlow_kg_s: 50, bypassFlow_kg_s: .1,
  coldTotalEnthalpy_J_kg: 1e6, returnTotalEnthalpy_J_kg: 1.3e6,
  heater_W: 50000, ambient_W: 20000, reportedPrimaryReturn_W: 30000,
  secondary: reference.powers_MW, shaftEfficiency: .995, transformerLossFraction: .01 }
test('PZR side loop changes segment flows, not total core mass by a duplicate source', () => {
  const r = auditPzrInterface(interfaceInput), f = r.flows_kg_s
  expect(f.hotAAfterTee).toBe(50.1)
  expect(f.coldAToDowncomer).toBe(50)
  expect(f.hotBAndSGB).toBe(50)
  expect(f.eachRcpA * 2).toBe(f.SGA)
  for (const residual of Object.values(r.massResiduals_kg_s)) expect(Math.abs(residual)).toBeLessThan(1e-12)
  expect(r.coupledHydraulicsSolved).toBe(false)
  expect(r.radialBaselineRefreshed).toBe(false)
})
test('conditional allocation pays heater once and returns physical heat with invariant enthalpy datum', () => {
  const r = auditPzrInterface(interfaceInput), p = r.conditionalIncrements_W
  expect(r.primaryReturn_W).toBe(30000)
  expect(r.sideEnergyResidual_W).toBe(0)
  expect(Math.abs(p.allocationResidual)).toBeLessThan(1e-8)
  expect(p.busA - p.busB).toBeCloseTo(50000 + 1.1e6 * 30000 / 102e6, 8)
  expect(p.transformer).toBeCloseTo((p.busA + p.busB) * .01, 9)
  expect(r.heaterOnlySubtractionError_W).not.toBe(0)
  const shifted = auditPzrInterface({ ...interfaceInput, coldTotalEnthalpy_J_kg: 8e6, returnTotalEnthalpy_J_kg: 8.3e6 })
  expect(shifted).toEqual(r)
  const residual = auditPzrInterface({ ...interfaceInput, heater_W: 50001 })
  expect(residual.sideEnergyResidual_W).toBe(1)
  expect(residual.conditionalIncrements_W.allocationResidual).toBeCloseTo(-1, 8)
})
test('counter-direction heat transfer is signed, while disconnected or inconsistent steady evidence is rejected', () => {
  const r = auditPzrInterface({ ...interfaceInput, returnTotalEnthalpy_J_kg: .9e6,
    heater_W: 10000, ambient_W: 20000, reportedPrimaryReturn_W: -10000 })
  expect(r.primaryReturn_W).toBe(-10000)
  expect(r.conditionalIncrements_W.gross).toBeLessThan(0)
  expect(Math.abs(r.conditionalIncrements_W.allocationResidual)).toBeLessThan(1e-8)
  for (const edit of [{ bypassFlow_kg_s: 0 }, { hotAFlow_kg_s: 100 }, { heater_W: 0 },
    { heater_W: 80000 }, { reportedPrimaryReturn_W: 60000 }, { coldTotalEnthalpy_J_kg: NaN }])
    expect(() => auditPzrInterface({ ...interfaceInput, ...edit })).toThrow()
  expect(() => auditPzrInterface({ ...interfaceInput, secondary: { ...reference.powers_MW, condenser: 66 } })).toThrow('conserve')
  for (const edit of [{ feed_pump_electric: 1 }, { condensate_pump_electric: .5 }, { gross_electric: 40 }])
    expect(() => auditPzrInterface({ ...interfaceInput, secondary: { ...reference.powers_MW, ...edit } })).toThrow('conversion')
  expect(() => auditPzrInterface({ ...interfaceInput, returnTotalEnthalpy_J_kg: -2e9,
    reportedPrimaryReturn_W: -.1 * (2e9 + 1e6), ambient_W: 50000 + .1 * (2e9 + 1e6) })).toThrow('throughput')
})
test('retained primary, thermal and station receipts must identify the same admitted parent', () => {
  const id = { sourceSha256: 'a'.repeat(64), calculationSha256: 'b'.repeat(64), inputSha256: 'c'.repeat(64) }
  const primary = { ...id, accepted: true }, thermal = { parentIdentities: { primary: id } }
  const station = { primaryIdentity: { source: id.sourceSha256, calculation: id.calculationSha256, input: id.inputSha256 }, checks: { steady: true } }
  expect(assertPzrEvidenceLineage(station, primary, thermal)).toEqual(id)
  expect(() => assertPzrEvidenceLineage(station, { ...primary, accepted: false }, thermal)).toThrow()
  expect(() => assertPzrEvidenceLineage({ ...station, checks: {} }, primary, thermal)).toThrow()
  expect(() => assertPzrEvidenceLineage({ ...station, checks: { steady: false } }, primary, thermal)).toThrow()
  expect(() => assertPzrEvidenceLineage(station, primary, { parentIdentities: { primary: { ...id, inputSha256: 'd'.repeat(64) } } })).toThrow('Mismatched')
  expect(() => assertPzrEvidenceLineage({ ...station, primaryIdentity: { ...station.primaryIdentity, source: 'd'.repeat(64) } }, primary, thermal)).toThrow('Mismatched')
})
