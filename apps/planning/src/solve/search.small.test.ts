import { describe, expect, test } from 'bun:test'
import { SMALL_PROBLEM, searchEngine } from './search.ts'
import { fromBenchInstance, type BenchInstance } from './fixtures/bench-instance.ts'
import { finishOf, makeDecoder, prepare } from './decode.ts'
import type { NormalizedProblem, Schedule } from './problem.ts'
import fixture from './fixtures/tiny-s1.json'

// or's tiny(1): seven jobs, one mechanical crew, paid night slots. Its optimum for finish then extra cost was
// proven by or's exact enumeration and its MILP. The decoder alone never reaches it: the optimum starts a
// 24-hour job later to pay fewer night slots, while the competing job takes the day slot after it.
const { problem: base } = fromBenchInstance(fixture.instance as unknown as BenchInstance)
const problem: NormalizedProblem = {
  ...base,
  goals: [
    { metric: 'finish', unit: 'h', threshold: 0, step: 0 },
    { metric: 'extra-cost', unit: 'NOK', threshold: 0, step: 0 },
  ] as unknown as NormalizedProblem['goals'],
}
const budget = { evals: Number.MAX_SAFE_INTEGER, cpuMs: 10_000, wallMs: 100_000, memoryMb: 80 }
const solve = (seed: number) => searchEngine().solve(problem, { budget, seed, signal: new AbortController().signal })
const valuesOf = (schedule: Schedule): readonly number[] => {
  const prep = prepare(problem)
  const finish = Int32Array.from(schedule.start, (t, a) => finishOf(prep, a, schedule.mode[a]!, t))
  const raw = makeDecoder(prep).evaluate({ start: Int32Array.from(schedule.start), finish, mode: Int32Array.from(schedule.mode), penalty: 0, restarts: 0, note: '' }).raw
  return raw.map(value => value as number)
}

describe('the small-problem path', () => {
  test('a tiny problem is enumerated and reaches its proven optimum', async () => {
    expect(problem.activities.length).toBeLessThanOrEqual(SMALL_PROBLEM.maxJobs)
    const result = await solve(1)
    expect(result.stoppedBy).toBe('done')
    const [finish, cost] = valuesOf(result.candidates[0]!)
    expect(finish).toBeCloseTo(fixture.optimum.finishSlots * problem.slotMs / 3_600_000, 9)
    expect(cost).toBeCloseTo(fixture.optimum.costNok, 6)
  })

  test('the enumeration uses no random stream: every seed gives the same plan', async () => {
    const [a, b] = [await solve(1), await solve(7)]
    expect([...b.candidates[0]!.start]).toEqual([...a.candidates[0]!.start])
    expect([...b.candidates[0]!.mode]).toEqual([...a.candidates[0]!.mode])
  })
})
