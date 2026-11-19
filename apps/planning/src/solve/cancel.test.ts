import { describe, expect, test } from 'bun:test'
import { compile } from './compile.ts'
import { GENERATE_DEADLINE_MS, generate, rawOf } from './generate.ts'
import { createSolverPool, PREVIEW_TOO_LONG_WORDS, SOLVER_BUSY_WORDS, SOLVER_CPU_CAP_CORES } from './pool.ts'
import { goalKeys, compareKeys } from './rank.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
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
  return generate({ engine: pool, check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }, {
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

  test('a second solve while one runs is refused as busy, never queued; the memory guard stops a solve', async () => {
    const compiled = compile(inputs, { methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'allowed' })
    if (!compiled.ok) throw new Error('compiles')
    const budget = { evals: Number.MAX_SAFE_INTEGER, cpuMs: 1_000, wallMs: 2_000, memoryMb: 80 }
    const busyPool = createSolverPool()
    const signal = new AbortController().signal
    const running = busyPool.solve(compiled.problem, { budget, seed: 1, signal })
    await expect(busyPool.solve(compiled.problem, { budget, seed: 2, signal })).rejects.toMatchObject({ status: 409, code: 'solver_busy', message: SOLVER_BUSY_WORDS })
    await running
    const tight = createSolverPool({ rssLimitMb: 1 })
    expect((await tight.solve(compiled.problem, { budget, seed: 1, signal })).stoppedBy).toBe('memory')
    await expect(busyPool.solve(compiled.problem, { budget: { ...budget, memoryMb: 0.01 }, seed: 1, signal })).rejects.toMatchObject({ code: 'above_certified_size' })
  }, 30_000)

  test('solves stay within the CPU cap together, and the records show it', async () => {
    const compiled = compile(inputs, { methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'allowed' })
    if (!compiled.ok) throw new Error('compiles')
    // The pool can still run two at once when asked to (the service runs one); the cap holds across both.
    const capped = createSolverPool({ rssLimitMb: 4_000, maxSolves: 2 })
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

  test('a solver process that ends without answering is said as such, never hidden', async () => {
    const compiled = compile(inputs, { methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'allowed' })
    if (!compiled.ok) throw new Error('compiles')
    const ending = createSolverPool({ childEntry: new URL('./fixtures/child-ends.ts', import.meta.url).pathname })
    const result = await ending.solve(compiled.problem, { budget: { evals: 100, cpuMs: 2_000, wallMs: 4_000, memoryMb: 80 }, seed: 1, signal: new AbortController().signal })
    expect([result.stoppedBy, result.candidates.length]).toEqual(['ended', 0])
    // Leave enough time for both methods to reach the child process after their setup and checks.
    const generated = await generate({ engine: ending, check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }, { inputs, revision: 1, previous: null, input: { seconds: 5 }, by, signal: new AbortController().signal })
    for (const option of generated.optionSet.options) expect(option.status).toMatchObject({ word: 'unresolved', run: { stoppedBy: 'ended' } })
  }, 30_000)

  test('a child that never answers, or dies, frees the solver slot by its deadline; a Generate right after runs and keeps the stored set', async () => {
    const { createRealSolver } = await import('../api/wiring.ts')
    const real = createSolverPool()
    const request = (stored: Awaited<ReturnType<ReturnType<typeof createRealSolver>['generate']>> | null) => ({ inputs, inputsRevision: 1, variants: undefined, seconds: 2, stored, at: new Date().toISOString(), by, signal: new AbortController().signal })
    const stored = await createRealSolver(real).generate(request(null))
    await real.shutdown()
    const option = stored.options.find(candidate => candidate.key === stored.recommended)!
    for (const child of ['child-silent', 'child-crash']) {
      const pool = createSolverPool({ childEntry: new URL(`./fixtures/${child}.ts`, import.meta.url).pathname, previewDeadlineMs: 1_000, deadlineMarginMs: 1_000 })
      const solver = createRealSolver(pool)
      try {
        // The preview: the silent child is killed at the preview deadline, the crashing one at once; 503 either way.
        const at = performance.now()
        const refused = await solver.preview({ inputs, option }).catch((error: unknown) => error as { status: number; code: string; message: string })
        expect(refused).toMatchObject({ status: 503, code: 'preview_unavailable' })
        if (child === 'child-silent') expect((refused as { message: string }).message).toBe(PREVIEW_TOO_LONG_WORDS)
        expect(performance.now() - at).toBeLessThan(1_000 + 500)
        expect(pool.active()).toBe(0)
        // A Generate right after is admitted (no solver_busy); each sub-solve ends by its deadline, and never-demote keeps the stored set.
        const again = await solver.generate(request(stored))
        expect(again.recommended).toBe(stored.recommended)
        expect(again.options.find(candidate => candidate.key === stored.recommended)).toEqual(option)
        expect(pool.active()).toBe(0)
      } finally { await pool.shutdown() }
    }
    // The request's own signal cancels a preview whose child never answers.
    const silent = createSolverPool({ childEntry: new URL('./fixtures/child-silent.ts', import.meta.url).pathname })
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 200)
      const at = performance.now()
      await expect(createRealSolver(silent).preview({ inputs, option, signal: controller.signal })).rejects.toMatchObject({ status: 503, code: 'preview_unavailable' })
      expect(performance.now() - at).toBeLessThan(200 + 1_000 + 300)
      expect(silent.active()).toBe(0)
    } finally { await silent.shutdown() }
  }, 60_000)

  test('a Generate of 8 sub-solves whose children all hang answers within its 20 s deadline and frees the slot', async () => {
    const { createRealSolver } = await import('../api/wiring.ts')
    const pool = createSolverPool({ childEntry: new URL('./fixtures/child-silent.ts', import.meta.url).pathname })
    try {
      const variants = Array.from({ length: 8 }, (_, k) => ({ label: `What-if ${k + 1}`, methods: [{ choice: 'SWA-method', option: k % 2 === 0 ? 'swap' : 'rebuild' }] }))
      const at = performance.now()
      const set = await createRealSolver(pool).generate({ inputs, inputsRevision: 1, variants, seconds: 20, stored: null, at: new Date().toISOString(), by, signal: new AbortController().signal })
      expect(performance.now() - at).toBeLessThan(GENERATE_DEADLINE_MS + 1_000)
      expect(pool.active()).toBe(0)
      // Every option says how it stopped: the hung ones 'ended' (killed), the ones past the deadline 'wall' (not run).
      expect(set.options).toHaveLength(8)
      for (const option of set.options) expect(option.status).toMatchObject({ word: 'unresolved' })
      const stops = set.options.map(option => ('run' in option.status ? option.status.run.stoppedBy : 'none'))
      expect(stops).toContain('ended')
      expect(stops).toContain('wall')
    } finally { await pool.shutdown() }
  }, 40_000)

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
