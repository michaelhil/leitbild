import { describe, expect, test } from 'bun:test'
import { dcSequence, evaluateDcCases, holdingContinuity, parseDcBasis } from './reference-design-dc-sequence'

const values = { usableEnergy_kWh: 16, continuousDuty_W: 2000, chargerLimit_W: 10000, outputLimit_W: 20000, chargeEfficiency: .95, dischargeEfficiency: .95, converterEfficiency: .92 }
const document = '```reference-dc-actuation\n' + JSON.stringify(values) + '\n```'

describe('offline DC boundary and support reference', () => {
  test('reads one strict engineering input record', () => {
    expect(parseDcBasis(document)).toEqual(values)
    expect(() => parseDcBasis(document + '\n' + document)).toThrow()
    expect(() => parseDcBasis(document.replace('0.95', '1.1'))).toThrow()
    expect(() => parseDcBasis(document.replace('"usableEnergy_kWh":16', '"usableEnergy_kWh":16,"extra":0'))).toThrow()
  })
  test('independent constant-duty depletion formula and energy ledger', () => {
    const out = dcSequence(values, 30000, [])
    const empty = out.rows.find(r => r.energy_J === 0)!
    expect(empty.time_s).toBe(27360)
    expect(empty.deliveredEnergy_J).toBeCloseTo(54_720_000, 5)
    expect(empty.lossEnergy_J).toBeCloseTo(2_880_000, 5)
    expect(empty.supplied).toBe(false)
    expect(Math.abs(out.energyResidual_J)).toBeLessThan(1e-6)
  })
  test('all selected restore, exact-boundary and physical-contact cases', () => {
    const result = evaluateDcCases(values)
    expect(result.checks.nominalHours).toBe(7.6)
  })
  test('battery failure does not remove a healthy charger or charge unavailable storage', () => {
    const out = dcSequence(values, 10, [{ at_s: 0, changes: { chargerAvailable: true, batteryAvailable: false } }], 0)
    expect(out.rows.every(r => r.supplied)).toBe(true)
    expect(out.state.energy_J).toBe(0)
    expect(out.state.deliveredEnergy_J).toBe(20000)
  })
  test('actual full-charge crossing throttles the charger to delivered duty', () => {
    const capacity = values.usableEnergy_kWh * 3.6e6
    const out = dcSequence(values, 2, [{ at_s: 0, changes: { chargerAvailable: true } }], capacity - 7600)
    expect(out.rows.find(r => r.time_s === 1)?.energy_J).toBe(capacity)
    expect(out.state.energy_J).toBe(capacity)
    expect(out.state.sourceEnergy_J).toBeCloseTo(12000 / .92, 8)
    expect(out.state.deliveredEnergy_J).toBe(4000)
  })
  test('same-time external change determines real support, not energy alone', () => {
    const low = dcSequence(values, 11, [{ at_s: 10, changes: { chargerAvailable: true } }], 2000 * 10 / .95)
    expect(low.rows.every(r => r.supplied)).toBe(true)
    const high = dcSequence(values, 11, [{ at_s: 0, changes: { requested_W: 15000 } }, { at_s: 10, changes: { chargerAvailable: true } }], 15000 * 10 / .95)
    expect(high.rows.find(r => r.time_s === 10)?.supplied).toBe(false)
    expect(high.rows.find(r => r.time_s === 10)?.cause).toBe('insufficient_supply')
    const late = dcSequence(values, 27361, [{ at_s: 27360 + 1e-6, changes: { chargerAvailable: true } }])
    expect(late.state.outputClosed).toBe(false)
    expect(late.state.cause).toBe('insufficient_supply')
  })
  test('power loss and retained requests cannot create energy or immediate auto-close', () => {
    const out = dcSequence(values, 10, [{ at_s: 0, changes: { requested_W: 25000, chargerAvailable: true } }], 0)
    expect(out.state.deliveredEnergy_J).toBe(0)
    expect(out.state.energy_J).toBe(95000)
    expect(out.state.cause).toBe('overload')
  })
  test('rejects invalid time and demand', () => {
    expect(() => dcSequence(values, 1, [{ at_s: 2 }])).toThrow()
    expect(() => dcSequence(values, 1, [{ at_s: 0 }, { at_s: 0 }])).toThrow()
    expect(() => dcSequence(values, 1, [{ at_s: 0, changes: { requested_W: NaN } }])).toThrow()
    expect(() => dcSequence(values, 1, [], -1)).toThrow()
    const copied = dcSequence(values, 1, [])
    for (const state of [{ ...copied.state, energy_J: NaN }, { ...copied.state, energy_J: -1 }, { ...copied.state, sourceEnergy_J: Infinity }, { ...copied.state, energy_J: 1e20 }, { ...copied.state, cause: 'overload' as const }]) {
      expect(() => dcSequence(values, 2, [], undefined, { state, inputs: copied.inputs })).toThrow()
    }
  })
  test('only arithmetic-coincident boundary changes coalesce', () => {
    const at = 27360, numericalEnvelope = 4 * Number.EPSILON * at
    for (const offset of [-1e-6, -numericalEnvelope * 2, 0, numericalEnvelope / 2, numericalEnvelope * 2, 1e-6]) {
      const out = dcSequence(values, at + 1, [{ at_s: at + offset, changes: { chargerAvailable: true } }])
      expect(out.state.outputClosed).toBe(offset <= numericalEnvelope)
    }
  })
  test('stuck closed contacts can defeat software trip but not a real manual interruption', () => {
    expect(holdingContinuity(true, true, true, [true, true, false])).toBe(true)
    expect(holdingContinuity(true, true, false, [true, true, false])).toBe(false)
  })
})
