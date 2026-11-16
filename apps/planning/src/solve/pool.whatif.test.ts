// A what-if keeps what it asks on every path out of the solver child (lane P's V9 finding under load): a child
// that ends or is killed without answering still gives an option with its extra rule and its lead, so it is
// never stored as a plain, ranked option.
import { describe, expect, test } from 'bun:test'
import { createSolverPool } from './pool.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

const flagship = trainAInputs({ read: true })
const at43 = { kind: 'span-limit' as const, key: 'W43', group: 'COOL-A', limit: { value: 43, unit: 'h' as const }, singleEntry: true, words: 'At most 43 h out', source: { by: 'planner' as const } }

describe('a sub-solve that never answers', () => {
  test('keeps the what-if\'s extra rule and lead on its unresolved option', async () => {
    const ending = createSolverPool({ childEntry: new URL('./fixtures/child-ends.ts', import.meta.url).pathname })
    try {
      const task = { inputs: flagship, revision: 1, variant: { key: 'plan-w43', label: 'At most 43 h out', buy: 'allowed' as const, also: [at43], lead: { goal: 1 } }, combo: [{ choice: 'SWA-method', option: 'swap' }], budget: { evals: 100, cpuMs: 400, wallMs: 1_000 }, seed: 1 }
      const outcome = await ending.subSolver(task, new AbortController().signal)
      expect(outcome.option.status.word).toBe('unresolved')
      expect(outcome.option.variant.also).toEqual([at43])
      expect(outcome.option.variant.lead).toEqual({ goal: 1 })
    } finally { await ending.shutdown() }
  }, 30_000)
})

describe('Generate never stores a what-if as a plain option', () => {
  test('a sub-solver answering a what-if without its rule is a solver fault: refused loudly, nothing returned', async () => {
    const { generate } = await import('./generate.ts')
    const { searchEngine } = await import('./search.ts')
    const { laneKCheck, laneKVerify, laneKVerifyBound } = await import('./fixtures/lane-k.ts')
    const run = { grid: '30min' as const, engine: 'test', formulation: 'test', seed: 1, budget: { evals: 0, cpuMs: 0, wallMs: 0 }, stoppedBy: 'wall' as const, evals: 0, cpuMs: 0 }
    // A faulty sub-solver: the option it answers has lost the what-if's extra rule.
    const faulty = async (task: { readonly variant: { readonly key: string; readonly label: string }; readonly revision: number; readonly combo: ReadonlyArray<{ readonly choice: string; readonly option: string }> }) => ({
      option: { key: task.variant.key, label: task.variant.label, inputsRevision: task.revision, variant: { methods: [...task.combo], purchases: [] }, status: { word: 'unresolved' as const, run }, rows: [], metrics: [] },
      rounded: [], dropped: [],
    })
    const answer = generate({ engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound, subSolver: faulty }, { inputs: flagship, revision: 1, previous: null, input: { variants: [{ label: 'At most 43 h out', also: [at43] }] }, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal })
    await expect(answer).rejects.toThrow(/what-if/)
  })
})
