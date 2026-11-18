import { describe, expect, test } from 'bun:test'
import { twinPlan, twinV3Options } from '../../tests/harness/twin-plan.ts'
import { CERTIFIED_SIZE, generate, subSolve } from './generate.ts'
import { createSolverPool } from './pool.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'
import twinJson from './fixtures/twin-v3.json'

// Every solve on a pool is independent (lane P's defect report): flagship, V1, V2, twin v3 and the flagship
// again on ONE pool give exactly what each gives on a fresh pool. Evaluation budgets make the runs
// reproducible only while evals, not time, ends each search: the evals are set far below what the 20 s
// Generate's time budgets allow even on a loaded machine (measured: the flagship's 300 take about 0.13 s of CPU
// against a 3.6 s CPU budget). The twin's 330-job compile and bounds take most of a 20 s Generate's slot on a
// loaded machine, so as the load in this test it is one sub-solve with time budgets far above what its 600 evals
// need. Every search is checked to have stopped on its evals before the plans are compared. The memory guard is
// set out of the way of the runner's memory.
const flagship = trainAInputs({ read: true })
const twin = twinPlan(twinJson, twinV3Options(twinJson))
const requests = [
  { name: 'flagship', inputs: flagship, input: { seconds: 20 }, evals: 300 },
  { name: 'V1', inputs: flagship, input: { variants: [{ label: 'V1', methods: [{ choice: 'SWA-method', option: 'rebuild' }], buy: 'no-extra-crew-hours' as const }], seconds: 20 }, evals: 300 },
  { name: 'V2', inputs: flagship, input: { variants: [{ label: 'V2', methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'no-extra-crew-hours' as const }], seconds: 20 }, evals: 300 },
  { name: 'twin', inputs: twin.inputs, input: { variants: [{ label: 'twin', methods: [...twin.variant.methods], buy: [...twin.variant.purchases] }], seconds: 20 }, evals: 600 },
  { name: 'flagship again', inputs: flagship, input: { seconds: 20 }, evals: 300 },
]
type Options = Awaited<ReturnType<typeof generate>>['optionSet']['options']
const summary = (options: Options) => options.map(option => ({
  key: option.key, word: option.status.word, purchases: option.variant.purchases, metrics: option.metrics,
  stoppedBy: 'run' in option.status ? option.status.run.stoppedBy : null, evals: 'run' in option.status ? option.status.run.evals : null,
  rows: option.rows.map(row => [row.job, row.start, row.finish, row.uses.map(use => `${use.resource}${use.purchase === undefined ? '' : `+${use.purchase}`}`).join(',')]),
  ...(option.status.word === 'proven infeasible' ? { cause: option.status.cause } : {}),
}))
const run = async (pool: ReturnType<typeof createSolverPool>, request: (typeof requests)[number]): Promise<Options> => {
  const deps = { engine: pool, check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }
  if (request.name === 'twin') {
    // Twin v3 (330 jobs, above the certified size), the load: one sub-solve, its time budgets far above its evals'.
    const outcome = await subSolve(deps)({ inputs: twin.inputs, revision: 1, variant: { key: 'twin', label: 'twin', buy: [...twin.variant.purchases] }, combo: [...twin.variant.methods], budget: { evals: request.evals, cpuMs: 300_000, wallMs: 600_000 }, seed: 1 }, new AbortController().signal)
    return [outcome.option]
  }
  return (await generate({ ...deps, certifiedSize: { ...CERTIFIED_SIZE, maxJobs: 330, limitJobs: 330 } }, { inputs: request.inputs, revision: 1, previous: null, input: request.input, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed: 1, evals: request.evals })).optionSet.options
}

describe('solves on one pool are independent', () => {
  test('flagship, V1, V2, twin v3, flagship on one pool equal each run alone', async () => {
    const alone = []
    for (const request of requests) alone.push(summary(await run(createSolverPool({ rssLimitMb: 4_000 }), request)))
    const shared = createSolverPool({ rssLimitMb: 4_000 })
    const together = []
    for (const request of requests) together.push(summary(await run(shared, request)))
    // A search that stopped on its time could differ for that reason alone: said so plainly, before the comparison.
    for (const [index, request] of requests.entries()) {
      for (const result of [alone[index]!, together[index]!]) for (const option of result) expect({ name: request.name, option: option.key, stoppedBy: option.stoppedBy }).toEqual({ name: request.name, option: option.key, stoppedBy: option.stoppedBy === 'done' ? 'done' : 'evals' })
    }
    for (const [index, request] of requests.entries()) expect({ name: request.name, result: together[index] }).toEqual({ name: request.name, result: alone[index] })
    expect(together[0]).toEqual(together[4])
    // The twin compiles through the product path and every flagship option is a checked plan.
    expect(together[3]![0]!.word).not.toBe('unsupported feature')
    expect(together[0]!.map(option => option.word)).toEqual(['validated feasible', 'validated feasible'])
  }, 300_000)
})

describe('a sub-solve runs whole in a solver child', () => {
  test('the child gives the same option as the same sub-solve in this process; a second Generate is refused, never queued', async () => {
    const { subSolve } = await import('./generate.ts')
    const { searchEngine } = await import('./search.ts')
    const { checkForSolver, judgeRetimedForSolver, verifyBoundForSolver, verifyForSolver } = await import('./lane-k-ports.ts')
    const { createRealSolver } = await import('../api/wiring.ts')
    const { SOLVER_BUSY_WORDS } = await import('./pool.ts')
    const task = { inputs: flagship, revision: 1, variant: { key: 'swap', label: 'Swap', buy: 'allowed' as const }, combo: [{ choice: 'SWA-method', option: 'swap' }], budget: { evals: 1_500, cpuMs: 20_000, wallMs: 40_000 }, seed: 1 }
    const here = await subSolve({ engine: searchEngine({ pace: true }), check: checkForSolver, verify: verifyForSolver, verifyBound: verifyBoundForSolver, judgeRetimed: judgeRetimedForSolver })(task, new AbortController().signal)
    const pool = createSolverPool()
    try {
      const there = await pool.subSolver(task, new AbortController().signal)
      expect(there.option.status.word).toBe('validated feasible')
      // The same plan: rows, metrics, purchases, goal words and the search's own count. CPU time and the CPU
      // budget the pool granted are the run's, not the plan's.
      const plan = (outcome: typeof here) => {
        const { status, ...option } = outcome.option
        return { option, goals: status.word === 'validated feasible' ? status.goals : [], evals: 'run' in status ? status.run.evals : 0, rounded: outcome.rounded, dropped: outcome.dropped }
      }
      expect(plan(there)).toEqual(plan(here))
      expect(pool.records().at(-1)!.peakRssMb).toBeGreaterThan(0)
      const solver = createRealSolver(pool)
      const request = { inputs: flagship, inputsRevision: 1, variants: undefined, seconds: 2, stored: null, at: new Date().toISOString(), by: { kind: 'service' as const, name: 'test' }, signal: new AbortController().signal }
      const first = solver.generate(request)
      await expect(solver.generate(request)).rejects.toMatchObject({ status: 409, code: 'solver_busy', message: SOLVER_BUSY_WORDS })
      await first
    } finally { await pool.shutdown() }
  }, 120_000)
})

describe('a preview runs in a solver child too', () => {
  test('the child gives the same preview as in this process; a preview while a Generate runs is refused, never queued', async () => {
    const { previewOption } = await import('./preview.ts')
    const { createRealSolver } = await import('../api/wiring.ts')
    const { SOLVER_BUSY_WORDS } = await import('./pool.ts')
    const pool = createSolverPool()
    try {
      const solver = createRealSolver(pool)
      // A plan to preview needs a full Generate: at 2 s the flagship's searches end before any plan on a
      // loaded machine (as before increment 2), and nothing is recommended.
      const request = (seconds: number) => ({ inputs: flagship, inputsRevision: 1, variants: undefined, seconds, stored: null, at: new Date().toISOString(), by: { kind: 'service' as const, name: 'test' }, signal: new AbortController().signal })
      const set = await solver.generate(request(20))
      expect(set.recommended).toBeDefined()
      const option = set.options.find(candidate => candidate.key === set.recommended)!
      expect(await pool.preview(flagship, option)).toEqual(previewOption(flagship, option))
      const running = solver.generate(request(2))
      await expect(solver.preview({ inputs: flagship, option })).rejects.toMatchObject({ status: 409, code: 'solver_busy', message: SOLVER_BUSY_WORDS })
      await running
    } finally { await pool.shutdown() }
  }, 120_000)
})
