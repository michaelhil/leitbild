import { describe, expect, test } from 'bun:test'
import { compile } from './compile.ts'
import { generate, rawOf } from './generate.ts'
import { createSolverPool, SOLVER_CPU_CAP_CORES } from './pool.ts'
import { goalKeys, compareKeys } from './rank.ts'
import { laneKCheck, laneKVerify } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

// Cancel (A7, design §6.5): answered within one second, keeping per variant the better of the stored
// and the new option; a stored option is replaced only by a valid better one, or when it is stale.
const inputs = trainAInputs({ read: true })
const goals = inputs.goals.map(goal => ({ threshold: goal.threshold?.value ?? 0, step: goal.tolerance.value }))
const by = { kind: 'human' as const, name: 'Planner' }

const run = (pool: ReturnType<typeof createSolverPool>, request: { revision: number; previous: Awaited<ReturnType<typeof generate>>['optionSet'] | null; seconds: number; abortAfterMs?: number }) => {
  const controller = new AbortController()
  let abortedAt = 0
  if (request.abortAfterMs !== undefined) setTimeout(() => { abortedAt = performance.now(); controller.abort() }, request.abortAfterMs)
  return generate({ engine: pool, check: laneKCheck, verify: laneKVerify }, {
    inputs, revision: request.revision, previous: request.previous, input: { seconds: request.seconds }, by, signal: controller.signal, stoppedByWho: () => 'person',
  }).then(result => ({ result, answeredAfterAbortMs: abortedAt === 0 ? undefined : performance.now() - abortedAt }))
}

describe('cancel', () => {
  // The test runner's own memory (other test files in the same process) counts in the process RSS, so
  // the memory guard, which has its own test below, is set out of the way here.
  const pool = createSolverPool({ rssLimitMb: 4_000 })

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

  test('solves stay within the CPU cap together, and the records show it', async () => {
    const compiled = compile(inputs, { methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'allowed' })
    if (!compiled.ok) throw new Error('compiles')
    // The test runner's own memory counts in the process RSS, so the memory guard is set out of the way.
    const capped = createSolverPool({ rssLimitMb: 4_000 })
    const signal = new AbortController().signal
    // Each asks for a full core over 3 s; alone it gets the cap, 0.4 x 3 s = 1.2 CPU-s.
    const wallMs = 3_000
    const ask = { evals: Number.MAX_SAFE_INTEGER, cpuMs: wallMs, wallMs, memoryMb: 80 }
    const first = capped.solve(compiled.problem, { budget: ask, seed: 1, signal })
    await Bun.sleep(500)
    // A second solve: each now gets half the cap (0.2 x 3 s = 0.6 CPU-s), and the first is re-budgeted.
    const second = capped.solve(compiled.problem, { budget: ask, seed: 2, signal })
    const [a, b] = await Promise.all([first, second])
    const recordA = capped.records().find(record => record.id === 'solve-1'), recordB = capped.records().find(record => record.id === 'solve-2')
    expect(recordA!.grantedCpuMs).toBe(Math.floor(SOLVER_CPU_CAP_CORES * wallMs))
    expect(recordB!.grantedCpuMs).toBe(Math.floor(SOLVER_CPU_CAP_CORES / 2 * wallMs))
    // Paced: neither runs ahead of its share; together within the cap over the 3 s (plus one pacing step).
    expect(a.cpuMs + b.cpuMs).toBeLessThanOrEqual(SOLVER_CPU_CAP_CORES * (wallMs + 500) + 100)
    expect(a.cpuMs).toBeLessThan(recordA!.grantedCpuMs)
    expect(b.cpuMs).toBeLessThanOrEqual(recordB!.grantedCpuMs + 50)
  }, 30_000)

  test('shutdown cancels running solves within a second and refuses new ones', async () => {
    const compiled = compile(inputs, { methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'allowed' })
    if (!compiled.ok) throw new Error('compiles')
    const closing = createSolverPool({ rssLimitMb: 4_000 })
    const signal = new AbortController().signal
    const budget = { evals: Number.MAX_SAFE_INTEGER, cpuMs: 8_000, wallMs: 20_000, memoryMb: 80 }
    const solving = closing.solve(compiled.problem, { budget, seed: 1, signal })
    await Bun.sleep(800)
    const at = performance.now()
    await closing.shutdown()
    expect(performance.now() - at).toBeLessThan(1_000)
    expect((await solving).stoppedBy).toBe('cancelled')
    await expect(closing.solve(compiled.problem, { budget, seed: 2, signal })).rejects.toMatchObject({ code: 'planning_stopping' })
  }, 30_000)
})
