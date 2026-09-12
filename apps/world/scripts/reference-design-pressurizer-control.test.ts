import { expect, test } from 'bun:test'
import { acquirePressure, compareNormalDuty, pressureDemand, type PressureSample } from './reference-design-pressurizer-control'

const setpoint = 14864186.805529881
const sample = (pressure_Pa: number | null, sampledAt_s = 0): PressureSample => ({ pressure_Pa, sampledAt_s, quality: 'usable' })
const demand = (s: PressureSample, now = 0) => pressureDemand(s, now, setpoint, 3e6, 1e5)

test('one acquired pressure with explicit tie, range and finite-value semantics', () => {
  expect(acquirePressure(14862499.999)).toBe(14862000)
  expect(acquirePressure(14862500)).toBe(14863000)
  expect(acquirePressure(0)).toBe(0)
  expect(acquirePressure(20e6)).toBe(20e6)
  for (const value of [-0.1, 20e6 + 0.1, NaN, Infinity]) expect(acquirePressure(value)).toBeNull()
})

test('normal duty is bracketed by real adjacent commands, not silently made exact', () => {
  const result = compareNormalDuty({ physicalPressureTap_Pa: 14862307.366898242,
    commissionedSetpoint_Pa: setpoint, requiredHeater_W: 56383.15894915307 }, 3e6, 1e5)
  expect(result.adjacentCommandsBracketDuty).toBe(true)
  expect(result.commands[0]!.heaterRequest_W - result.commands[1]!.heaterRequest_W).toBe(30000)
  expect(result.higherCommandTimeFractionIfSuchACycleOccurs).toBeCloseTo(0.692633101757, 9)
  expect(result.commands[0]!.heaterRequest_W).not.toBe(result.requiredMeanHeater_W)
  expect(() => compareNormalDuty({ physicalPressureTap_Pa: NaN, commissionedSetpoint_Pa: setpoint,
    requiredHeater_W: 56383 }, 3e6, 1e5)).toThrow()
  expect(() => compareNormalDuty({ physicalPressureTap_Pa: 14862307, commissionedSetpoint_Pa: setpoint,
    requiredHeater_W: NaN }, 3e6, 1e5)).toThrow()
})

test('heater and controlled spray retain independent dead band and saturation', () => {
  expect(demand(sample(setpoint - 1e5)).heaterRequest_W).toBe(3e6)
  expect(demand(sample(setpoint - 2e5)).heaterRequest_W).toBe(3e6)
  expect(demand(sample(setpoint))).toEqual({ usable: true, heaterRequest_W: 0, controlledSprayRequest: 0 })
  expect(demand(sample(setpoint + 20000)).controlledSprayRequest).toBe(0)
  expect(demand(sample(setpoint + 60000)).controlledSprayRequest).toBe(0.5)
  expect(demand(sample(setpoint + 100000)).controlledSprayRequest).toBe(1)
  expect(demand(sample(setpoint + 200000)).controlledSprayRequest).toBe(1)
})

test('unusable evidence withdraws demands; valid fresh-stuck evidence is not repaired', () => {
  const off = { usable: false, heaterRequest_W: 0, controlledSprayRequest: 0 }
  for (const quality of ['unavailable', 'below-range', 'above-range'] as const) expect(demand({ ...sample(14862000), quality })).toEqual(off)
  for (const value of [null, NaN, Infinity, -1, 20e6 + 1]) expect(demand(sample(value))).toEqual(off)
  expect(demand(sample(14862000), 2).usable).toBe(true)
  expect(demand(sample(14862000), 2.000001)).toEqual(off)
  expect(demand(sample(14862000, 1), 0)).toEqual(off)
  expect(demand(sample(14862000, NaN))).toEqual(off)
  expect(demand(sample(14862000, 10), 10)).toEqual(demand(sample(14862000)))
  // Restored supply alone cannot update this retained sample's timestamp.
  expect(demand(sample(14862000), 10)).toEqual(off)
  expect(() => pressureDemand(sample(14862000), 0, setpoint, 3e6, 0)).toThrow()
})
