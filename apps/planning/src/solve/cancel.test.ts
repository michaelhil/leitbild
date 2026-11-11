import { describe, expect, test } from 'bun:test'
import { compile } from './compile.ts'
import { generate, rawOf } from './generate.ts'
import { createSolverPool } from './pool.ts'
import { goalKeys, compareKeys } from './rank.ts'
import { checkDouble } from './fixtures/check-double.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

// Cancel (A7, design §6.5): answered within one second, keeping per variant the better of the stored
// and the new option; a stored option is replaced only by a valid better one, or when it is stale.
const inputs = trainAInputs()
const goals = inputs.goals.map(goal => ({ threshold: goal.threshold?.value ?? 0, step: goal.tolerance.value }))
const by = { kind: 'human' as const, name: 'Planner' }

const run = (pool: ReturnType<typeof createSolverPool>, request: { revision: number; previous: Awaited<ReturnType<typeof generate>>['optionSet'] | null; seconds: number; abortAfterMs?: number }) => {
  const controller = new AbortController()
  let abortedAt = 0
  if (request.abortAfterMs !== undefined) setTimeout(() => { abortedAt = performance.now(); controller.abort() }, request.abortAfterMs)
  return generate({ engine: pool, check: checkDouble() }, {
    inputs, revision: request.revision, previous: request.previous, input: { seconds: request.seconds }, by, signal: controller.signal, stoppedByWho: () => 'person',
  }).then(result => ({ result, answeredAfterAbortMs: abortedAt === 0 ? undefined : performance.now() - abortedAt }))
}

describe('cancel', () => {
  const pool = createSolverPool()

  test('a cancel is answered within one second, with the best plan found so far', async () => {
    const { result, answeredAfterAbortMs } = await run(pool, { revision: 1, previous: null, seconds: 20, abortAfterMs: 1_500 })
    expect(answeredAfterAbortMs).toBeLessThan(1_000)
    const first = result.optionSet.options[0]!
    expect(['validated feasible', 'cancelled']).toContain(first.status.word)
    expect('run' in first.status && first.status.run.stoppedBy).toBe('cancelled')
    expect('run' in first.status && first.status.run.stoppedByWho).toBe('person')
  }, 30_000)

  test('a cancel never demotes a stored option; variants not reached are kept', async () => {
    const stored = (await run(pool, { revision: 1, previous: null, seconds: 6 })).result.optionSet
    expect(stored.options.map(option => option.status.word)).toEqual(['validated feasible', 'validated feasible'])
    const { result } = await run(pool, { revision: 1, previous: stored, seconds: 20, abortAfterMs: 300 })
    for (const old of stored.options) {
      const now = result.optionSet.options.find(option => option.key === old.key)!
      expect(now.status.word).toBe('validated feasible')
      const keys = (option: typeof old) => goalKeys(rawOf(option, inputs.goals.length), goals)
      expect(compareKeys(keys(now), keys(old))).toBeLessThanOrEqual(0)
    }
    expect(result.optionSet.recommended).toBeDefined()
  }, 60_000)

  test('a stale stored option (older inputs revision) is replaced by the new result', async () => {
    const stored = (await run(pool, { revision: 1, previous: null, seconds: 4 })).result.optionSet
    const { result } = await run(pool, { revision: 2, previous: stored, seconds: 4 })
    expect(result.kept).toEqual([])
    expect(result.optionSet.options.every(option => option.inputsRevision === 2)).toBe(true)
  }, 60_000)

  test('a third solve while two run is refused as busy; the memory guard stops a solve', async () => {
    const compiled = compile(inputs, { methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'allowed' })
    if (!compiled.ok) throw new Error('compiles')
    const budget = { evals: Number.MAX_SAFE_INTEGER, cpuMs: 1_000, wallMs: 2_000, memoryMb: 80 }
    const busyPool = createSolverPool()
    const signal = new AbortController().signal
    const running = [busyPool.solve(compiled.problem, { budget, seed: 1, signal }), busyPool.solve(compiled.problem, { budget, seed: 2, signal })]
    await expect(busyPool.solve(compiled.problem, { budget, seed: 3, signal })).rejects.toMatchObject({ code: 'planning_busy' })
    await Promise.all(running)
    const tight = createSolverPool({ rssLimitMb: 1 })
    expect((await tight.solve(compiled.problem, { budget, seed: 1, signal })).stoppedBy).toBe('memory')
    await expect(busyPool.solve(compiled.problem, { budget: { ...budget, memoryMb: 0.01 }, seed: 1, signal })).rejects.toMatchObject({ code: 'above_certified_size' })
  }, 30_000)
})
