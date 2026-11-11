import { describe, expect, test } from 'bun:test'
import { boundsSoundness, enumerate, lexicographicOptimum, smallInstance } from '../../tests/harness/bounds-soundness.ts'
import type { BoundsPort } from '../../tests/harness/ports.ts'

// The harness re-verifies lane S's bounds at integration. Here bound doubles show what it accepts and
// refuses. Every optimum is found by enumerating every schedule the checker accepts.
const seeds = Array.from({ length: 10 }, (_, index) => index + 1)

const exact: BoundsPort = {
  bounds: async (inputs, variant) => {
    const optimum = lexicographicOptimum(inputs, variant, enumerate(inputs, variant))
    return { goals: (optimum ?? []).map((value, goal) => ({ goal, value })) }
  },
}

describe('bounds soundness re-verification', () => {
  test('the random small instances include both feasible and infeasible ones', async () => {
    const { feasible, infeasible } = await boundsSoundness({ bounds: async () => ({ goals: [] }) }, seeds)
    expect(feasible).toBeGreaterThan(2)
    expect(infeasible).toBeGreaterThan(1)
  }, 60_000)
  test('bounds equal to the exhaustive optimum are sound', async () => {
    expect((await boundsSoundness(exact, seeds)).failures).toEqual([])
  }, 60_000)
  test('a bound above the optimum is caught', async () => {
    const above: BoundsPort = { bounds: async (inputs, variant) => ({ goals: (await exact.bounds(inputs, variant)).goals.map(bound => ({ ...bound, value: bound.value + 0.5 })) }) }
    const { failures } = await boundsSoundness(above, seeds)
    expect(failures.length).toBeGreaterThan(0)
    expect(failures.every(failure => failure.problem.includes('above the exhaustive optimum'))).toBe(true)
  }, 60_000)
  test('a certificate issued where a validated schedule exists is caught', async () => {
    const always: BoundsPort = {
      bounds: async inputs => ({
        certificate: { kind: 'chain', jobs: ['P-TAG', 'P-WORK', 'P-TEST'], workHours: 99, calendars: ['always'], availableHours: 1, from: inputs.settings.window!.start, by: inputs.settings.window!.end },
        goals: [],
      }),
    }
    const { failures, feasible } = await boundsSoundness(always, seeds)
    expect(failures.filter(failure => failure.problem.includes('checker-validated schedules exist'))).toHaveLength(feasible)
    // on the truly infeasible ones the made-up figures do not re-verify either
    expect(failures.some(failure => failure.problem.startsWith('the certificate does not re-verify'))).toBe(true)
  }, 60_000)
  test('a certificate with figures that hold but premises left unverified does not count as re-verified', async () => {
    // on the infeasible instances: an energy claim over the first hour that nothing forces work into
    const loose: BoundsPort = {
      bounds: async inputs => ({
        certificate: { kind: 'energy', resources: ['crew', 'ops'], jobs: ['P-WORK', 'Q-WORK'], requiredHours: 0, availableHours: 0, from: inputs.settings.window!.start, to: new Date(Date.parse(inputs.settings.window!.start) + 1_800_000).toISOString() },
        goals: [],
      }),
    }
    const { failures, infeasible } = await boundsSoundness(loose, seeds)
    expect(failures.filter(failure => failure.problem.startsWith('the certificate does not re-verify'))).toHaveLength(infeasible)
  }, 60_000)
  test('the instances are reproducible from their seed', () => {
    expect(smallInstance(3)).toEqual(smallInstance(3))
  })
})
