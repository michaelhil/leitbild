import { expect, test } from 'bun:test'
import { controlledSprayBasis, heldSprayFlow } from './reference-design-controlled-spray-delivery'

const nominal = { density: 745.1482932491854, viscosity: 0.00009227008594392644, sourcePressure: 15202734.919352943, receiverPressure: 14862307.366898242, opening: 1, activeTips: 16 }
test('series hardware gives actual sub-reference flow, not requested capacity', () => {
  const full = heldSprayFlow(nominal)
  expect(full.flow_kg_s).toBeGreaterThan(0)
  expect(full.flow_kg_s).toBeLessThan(20)
  expect(Math.abs(full.residual_Pa)).toBeLessThan(1e-7)
  expect(heldSprayFlow({ ...nominal, opening: 0.25 }).flow_kg_s).toBeLessThan(full.flow_kg_s)
  expect(heldSprayFlow({ ...nominal, activeTips: 8 }).flow_kg_s).toBeLessThan(full.flow_kg_s)
  expect(full.valveDrop_Pa + full.lineDrop_Pa + full.nozzleDrop_Pa).toBeCloseTo(full.availableAfterElevation_Pa, 6)
})
test('isolation, absent head and blocked tips do not erase finite geometry', () => {
  expect(heldSprayFlow({ ...nominal, opening: 0 }).flow_kg_s).toBe(0)
  expect(heldSprayFlow({ ...nominal, activeTips: 0 }).flow_kg_s).toBe(0)
  expect(heldSprayFlow({ ...nominal, sourcePressure: nominal.sourcePressure - 300000 }).flow_kg_s).toBe(0)
  expect(controlledSprayBasis.length_m * Math.PI * controlledSprayBasis.diameter_m ** 2 / 4).toBeCloseTo(0.1963495408493621, 12)
  expect(() => heldSprayFlow({ ...nominal, opening: 2 })).toThrow()
  expect(() => heldSprayFlow({ ...nominal, activeTips: -1 })).toThrow()
})
