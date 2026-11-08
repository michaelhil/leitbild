import { describe, expect, test } from 'bun:test'
import { calculateEngineeringMethod } from './engineering-methods'
import type { EngineeringDatum, EngineeringMethodInput } from './engineering-methods'

const time = (seconds: number) => new Date(Date.UTC(2026, 10, 8) + seconds * 1000).toISOString()
const datum = (name: string, value: number, quantity: string, unit: string, at: number): EngineeringDatum => ({ name, value, quantity, unit, simulationAt: time(at), quality: 'good', origin: 'assumption' })
const balance: EngineeringMethodInput = { method: 'reservoir_balance', initial: 'stored', streams: [{ name: 'delivered', direction: 'in', samples: ['p0', 'p1', 'p2'] }], interpolation: 'hold-left', maxGapSeconds: 600, from: time(0), to: time(1200), boundary: 'Finite store; delivered power crossing the boundary', omittedTerms: [] }
const energy = [datum('stored', 2, 'energy', 'MWh', 0), datum('p0', 4, 'power', 'MW', 0), datum('p1', -2, 'power', 'MW', 600), datum('p2', 0, 'power', 'MW', 1200)]

const fails = (request: unknown, data: unknown, code: string) => {
  try { calculateEngineeringMethod(request, data); throw new Error('Expected rejection') } catch (error) { expect(error).toHaveProperty('code', code) }
}

describe('reviewed engineering arithmetic', () => {
  test('uses actual irregular times, preserving the existing sample arithmetic contract', () => {
    const data = [datum('t0', 180, 'temperature', 'degC', 0), datum('t1', 178, 'temperature', 'degC', 30), datum('t2', 177, 'temperature', 'degC', 120)]
    const result = calculateEngineeringMethod({ method: 'sample_changes', samples: ['t0', 't1', 't2'] }, data)
    if (result.method !== 'sample_changes') throw new Error('Unexpected method')
    expect(result.changeQuantity).toBe('temperature-difference')
    expect(result.changeUnit).toBe('K')
    expect(result.arithmetic.inputsVerified).toBe(false)
    expect(result.arithmetic.series[0]!.changes).toEqual([{ change: -2, ratePerSecond: -2 / 30 }, { change: -1, ratePerSecond: -1 / 90 }])
  })

  test('does not equate absolute temperature and temperature differences despite identical units', () => {
    fails({ method: 'sample_changes', samples: ['a', 'b'] }, [datum('a', 300, 'temperature', 'K', 0), datum('b', 20, 'temperature-difference', 'K', 1)], 'quantity_unit_mismatch')
  })

  test('refuses unsupported dimensional labels and never infers pressure or percent meaning', () => {
    const request = { method: 'sample_changes', samples: ['a', 'b'] }
    fails(request, [datum('a', 1, 'power', 'degC', 0), datum('b', 2, 'power', 'degC', 1)], 'unsupported_quantity_unit')
    fails(request, [datum('a', 1, 'pressure', 'bar', 0), datum('b', 2, 'pressure', 'bar', 1)], 'unsupported_quantity_unit')
    fails(request, [datum('a', 0.1, 'fraction', '1', 0), datum('b', 20, 'percentage', '%', 1)], 'quantity_unit_mismatch')
    fails(request, [datum('a', 10, 'fraction', '%', 0), datum('b', 20, 'fraction', '%', 1)], 'unsupported_quantity_unit')
  })

  test('refuses missing, unknown, duplicate, unsorted and untimed evidence', () => {
    const request = { method: 'sample_changes', samples: ['a', 'b'] }
    const a = datum('a', 1, 'power', 'MW', 0), b = datum('b', 2, 'power', 'MW', 1)
    fails(request, [a], 'missing_datum')
    fails(request, [a, { ...b, quality: 'unknown' }], 'unknown_quality')
    fails(request, [a, b, a], 'duplicate_name')
    fails(request, [a, { ...b, simulationAt: time(0) }], 'time_order')
    fails(request, [a, { ...b, simulationAt: undefined }], 'missing_time')
    fails(request, [a, { ...b, simulationAt: '2026-02-30T00:00:00.000Z' }], 'invalid_input')
  })

  test('integrates signed power with explicit hold-left semantics', () => {
    const result = calculateEngineeringMethod(balance, energy)
    if (result.method !== 'reservoir_balance') throw new Error('Unexpected method')
    expect(result.finalAccountedStorage).toBeCloseTo(2 + 1 / 3, 12)
    expect(result.intervals.map(interval => interval.netAmount)).toEqual([2 / 3, -1 / 3])
    expect(result.extremaCoverage).toBe('declared-interpolation-only')
    expect(result.qualification).toBe('arithmetic-only')
  })

  test('linear rates use trapezoidal integration and explicit direction, including reversal', () => {
    const result = calculateEngineeringMethod({ ...balance, interpolation: 'linear', streams: [{ ...balance.streams[0], direction: 'out' }] }, energy)
    if (result.method !== 'reservoir_balance') throw new Error('Unexpected method')
    expect(result.intervals[0]!.netAmount).toBeCloseTo(-1 / 6, 12)
    expect(result.intervals[1]!.netAmount).toBeCloseTo(1 / 6, 12)
    expect(result.finalAccountedStorage).toBeCloseTo(2, 12)
  })

  test('converts mass-flow rates and preserves negative accounted storage', () => {
    const result = calculateEngineeringMethod({ ...balance, omittedTerms: ['Return stream unmeasured'], streams: [{ name: 'drain', direction: 'out', samples: ['p0', 'p1', 'p2'] }] }, [datum('stored', 1, 'mass', 'kg', 0), datum('p0', 6, 'mass-flow', 'kg/h', 0), datum('p1', 6, 'mass-flow', 'kg/h', 600), datum('p2', 6, 'mass-flow', 'kg/h', 1200)])
    if (result.method !== 'reservoir_balance') throw new Error('Unexpected method')
    expect(result.finalAccountedStorage).toBeCloseTo(-1, 12)
    expect(result.negativeAccountedStorage).toBe(true)
    expect(result.omittedTerms).toEqual(['Return stream unmeasured'])
    expect(result.coverage).toBe('supplied-streams-only')
  })

  test('finds a negative interior inventory under the declared linear flow reversal', () => {
    const result = calculateEngineeringMethod({ ...balance, to: time(4), interpolation: 'linear', streams: [{ name: 'signed_flow', direction: 'in', samples: ['p0', 'p1'] }] }, [datum('stored', 0.5, 'mass', 'kg', 0), datum('p0', -1, 'mass-flow', 'kg/s', 0), datum('p1', 1, 'mass-flow', 'kg/s', 4)])
    if (result.method !== 'reservoir_balance') throw new Error('Unexpected method')
    expect(result.finalAccountedStorage).toBe(0.5)
    expect(result.minimumSampledAccountedStorage).toBe(0.5)
    expect(result.minimumAccountedStorage).toBe(-0.5)
    expect(result.negativeAccountedStorage).toBe(true)
    expect(result.intervals[0]!.interiorExtremum).toEqual({ secondsAfterFrom: 2, accountedStorage: -0.5 })
  })

  test('refuses incompatible units/quantities, extrapolation, gaps, initial times and unequal grids', () => {
    fails(balance, energy.map(d => d.name === 'p0' || d.name === 'p1' || d.name === 'p2' ? { ...d, quantity: 'energy' } : d), 'quantity_unit_mismatch')
    fails(balance, energy.map(d => d.name === 'stored' ? { ...d, unit: 'MW' } : d), 'unsupported_storage')
    fails({ ...balance, from: time(-1) }, energy, 'initial_time_mismatch')
    fails({ ...balance, to: time(1201) }, energy, 'coverage_mismatch')
    fails({ ...balance, maxGapSeconds: 599 }, energy, 'sample_gap')
    fails({ ...balance, streams: [...balance.streams, { name: 'other', direction: 'out', samples: ['q0', 'q1', 'q2'] }] }, [...energy, datum('q0', 0, 'power', 'MW', 0), datum('q1', 0, 'power', 'MW', 500), datum('q2', 0, 'power', 'MW', 1200)], 'grid_mismatch')
  })

  test('rejects nonfinite arithmetic instead of serializing a favorable-looking null', () => {
    fails({ method: 'sample_changes', samples: ['a', 'b'] }, [datum('a', -1e308, 'energy', 'J', 0), datum('b', 1e308, 'energy', 'J', 1)], 'nonfinite_result')
    fails(balance, energy.map(d => d.quantity === 'power' ? { ...d, value: 1e308 } : d), 'nonfinite_result')
  })
})
