import { describe, expect, test } from 'bun:test'
import { generate, searchBudgetBy, SEARCH_STOP_LATENCY_MS, subSolve, type SubSolveOutcome, type SubSolveTask } from './generate.ts'
import { createSolverPool } from './pool.ts'
import { searchEngine } from './search.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'
import type { Engine, EngineBudget } from './problem.ts'
import type { CheckPlan } from './status.ts'

// Production, 15 Nov: under the unit's CPU quota a solver child's spawn, compile and check take seconds, and the
// flagship's second sub-solve was killed at the Generate's deadline on every Generate ('ended', no plan). A
// sub-solve's search now ends in time for the work after it, and each sub-solve answers by its share of the time.
const flagship = trainAInputs({ read: true })
const by = { kind: 'service' as const, name: 'test' }
const swap = { variant: { key: 'swap', label: 'Swap', buy: 'allowed' as const }, combo: [{ choice: 'SWA-method', option: 'swap' }] }
const busy = (ms: number): void => { const until = performance.now() + ms; while (performance.now() < until) { /* CPU-bound, as under the quota */ } }
/** Lane K's real check, slowed as on a CPU-capped machine, before the search and after it. */
const slowCheck = (ms: number): CheckPlan => plan => { busy(ms); return laneKCheck(plan) }
/** The real search, run to its whole wall budget as on production, where it stops on its time, not its work. */
const toItsTime = (granted: EngineBudget[]): Engine => {
  const real = searchEngine()
  return {
    name: real.name,
    solve: async (problem, options) => {
      granted.push(options.budget)
      const at = performance.now()
      const result = await real.solve(problem, { ...options, budget: { ...options.budget, evals: Math.min(options.budget.evals, 1_500) } })
      await Bun.sleep(Math.max(0, options.budget.wallMs - (performance.now() - at)))
      return { ...result, stoppedBy: 'wall' }
    },
  }
}
const runOf = (outcome: SubSolveOutcome) => ('run' in outcome.option.status ? outcome.option.status.run : undefined)

describe('the search budget within the time a sub-solve has', () => {
  test('a budget that fits is unchanged; one that does not ends its search the reserve before, CPU in proportion', () => {
    const budget = { evals: 9, cpuMs: 3_600, wallMs: 9_000 }
    expect(searchBudgetBy(budget, Infinity, 500, 0)).toBe(budget)
    expect(searchBudgetBy(budget, 10_000, 500, 0)).toBe(budget)
    expect(searchBudgetBy(budget, 5_000, 500, 0)).toEqual({ evals: 9, cpuMs: 1_800, wallMs: 4_500 })
    expect(searchBudgetBy(budget, 400, 500, 0)).toEqual({ evals: 9, cpuMs: 0, wallMs: 0 })
  })
})

describe('a sub-solve answers by its time', () => {
  test('a slow start before the search: the search is cut to fit, and the checked plan comes before the deadline', async () => {
    const granted: EngineBudget[] = []
    const run = subSolve({ engine: toItsTime(granted), check: slowCheck(400), verify: laneKVerify, verifyBound: laneKVerifyBound })
    const start = Date.now()
    const answerBy = start + 2_500
    const outcome = await run({ inputs: flagship, revision: 1, ...swap, budget: { evals: Number.MAX_SAFE_INTEGER, cpuMs: 1_200, wallMs: 3_000 }, seed: 1, deadlineAt: answerBy + 5_000, answerBy }, new AbortController().signal)
    expect(Date.now()).toBeLessThan(answerBy)
    expect(outcome.option.status.word).toBe('validated feasible')
    // The search got what was left after the work before it, less that work again (for the slow check after it)
    // and the engine's stop latency, at the granted CPU rate.
    expect(granted.length).toBe(1)
    expect(granted[0]!.wallMs).toBeLessThanOrEqual(2_500 - 400 - SEARCH_STOP_LATENCY_MS - 400)
    expect(granted[0]!.wallMs).toBeGreaterThan(0)
    expect(granted[0]!.cpuMs / granted[0]!.wallMs).toBeCloseTo(1_200 / 3_000, 2)
    // The run basis says the budget the search had.
    expect(runOf(outcome)).toMatchObject({ stoppedBy: 'wall', budget: { cpuMs: granted[0]!.cpuMs, wallMs: granted[0]!.wallMs } })
  }, 30_000)

  test('no time left to search: no plan, said as a search stopped by its time; the engine never runs', async () => {
    const granted: EngineBudget[] = []
    const run = subSolve({ engine: toItsTime(granted), check: slowCheck(300), verify: laneKVerify, verifyBound: laneKVerifyBound })
    const answerBy = Date.now() + 200
    const outcome = await run({ inputs: flagship, revision: 1, ...swap, budget: { evals: Number.MAX_SAFE_INTEGER, cpuMs: 400, wallMs: 1_000 }, seed: 1, deadlineAt: answerBy }, new AbortController().signal)
    expect(granted).toEqual([])
    expect(outcome.option.status).toMatchObject({ word: 'unresolved', run: { stoppedBy: 'wall', evals: 0, cpuMs: 0, budget: { cpuMs: 0, wallMs: 0 } } })
  }, 30_000)

  test('each sub-solve answers by its equal share of the time left; the last by the deadline', async () => {
    const tasks: SubSolveTask[] = []
    const inline = subSolve({ engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound })
    const recorded = async (task: SubSolveTask, signal: AbortSignal) => { tasks.push(task); return inline(task, signal) }
    await generate({ engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound, subSolver: recorded }, { inputs: flagship, revision: 1, previous: null, input: {}, by, signal: new AbortController().signal, seed: 1, evals: 300 })
    expect(tasks.length).toBe(2)
    const [first, second] = tasks as [SubSolveTask, SubSolveTask]
    expect(first.deadlineAt).toBe(second.deadlineAt!)
    expect(first.deadlineAt! - first.answerBy!).toBeGreaterThan(9_500)
    expect(first.deadlineAt! - first.answerBy!).toBeLessThanOrEqual(10_000)
    expect(second.answerBy).toBe(second.deadlineAt!)
  }, 30_000)
})

describe('in a solver child on a slow start (as under the service\'s CPU quota)', () => {
  const slowStart = new URL('./fixtures/child-slow-start.ts', import.meta.url).pathname

  test('a sub-solve whose wall budget runs past the deadline answers before it, with a checked plan, not \'ended\'', async () => {
    const pool = createSolverPool({ childEntry: slowStart })
    try {
      const start = Date.now()
      const deadlineAt = start + 4_000
      const outcome = await pool.subSolver({ inputs: flagship, revision: 1, ...swap, budget: { evals: Number.MAX_SAFE_INTEGER, cpuMs: 1_440, wallMs: 3_600 }, seed: 1, deadlineAt }, new AbortController().signal)
      expect(Date.now()).toBeLessThan(deadlineAt)
      expect(runOf(outcome)?.stoppedBy).not.toBe('ended')
      expect(outcome.option.status.word).toBe('validated feasible')
      expect(runOf(outcome)!.evals).toBeGreaterThan(0)
    } finally { await pool.shutdown() }
  }, 30_000)

  test('the flagship\'s two variants under a tight deadline: the second gets a real search too', async () => {
    const pool = createSolverPool({ childEntry: slowStart })
    try {
      const at = performance.now()
      const result = await generate({ engine: pool, check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound, subSolver: pool.subSolver }, { inputs: flagship, revision: 1, previous: null, input: { seconds: 8 }, by, signal: new AbortController().signal, seed: 1 })
      expect(performance.now() - at).toBeLessThan(8_000)
      // What the slot arithmetic guarantees, whatever the machine's load: both sub-solves answered (none was
      // killed at the deadline), each was granted a search budget of its own and searched, and each search
      // stopped on that budget. Whether a search that short finds a plan depends on the load; it is not asserted.
      expect(result.optionSet.options.length).toBe(2)
      for (const option of result.optionSet.options) {
        const run = 'run' in option.status ? option.status.run : undefined
        expect(run?.stoppedBy).not.toBe('ended')
        expect(run!.budget.wallMs).toBeGreaterThan(0)
        expect(['evals', 'cpu', 'wall', 'done']).toContain(run!.stoppedBy)
        expect(run!.evals).toBeGreaterThan(0)
      }
    } finally { await pool.shutdown() }
  }, 60_000)
})
