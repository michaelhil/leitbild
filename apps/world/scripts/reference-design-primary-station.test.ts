import { expect, test } from 'bun:test'
import { applyJacketLoads, reconcileFixedCycle } from './reference-design-primary-station'

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
