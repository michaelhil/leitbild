import { describe, expect, test } from 'bun:test'
import { counterfactualCheck } from '../../tests/harness/counterfactual.ts'
import { createRealSolver } from '../api/wiring.ts'
import { createSolverPool } from './pool.ts'
import { generate } from './generate.ts'
import { laneKCheck, laneKVerify } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

// "Why it starts then" passes lane K's counterfactual check (acceptance row 7) on every job of a flagship
// plan: relaxing the named cause (or the joint set together) lets the job start earlier with every other
// job fixed, judged by lane K's checker; no single member of a joint set does it alone. A reproducible
// plan (evaluation budget); the full acceptance run is tests/harness/acceptance-run.ts.
describe('why-start names the causes that hold each job', () => {
  test('every job of the flagship plan: 0 counterfactual failures, joint sets minimal', async () => {
    const inputs = trainAInputs({ read: true })
    const pool = createSolverPool({ rssLimitMb: 4_000 })
    const result = await generate({ engine: pool, check: laneKCheck, verify: laneKVerify }, { inputs, revision: 1, previous: null, input: {}, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed: 1, evals: 1_500 })
    const option = result.optionSet.options.find(candidate => candidate.key === result.optionSet.recommended)!
    expect(option.status.word).toBe('validated feasible')
    const solver = createRealSolver(pool)
    let joint = 0
    for (const row of option.rows) {
      const answer = await solver.explain({ inputs, option, ask: 'why-start', job: row.job, cursor: undefined })
      const items = answer.items.filter(item => item.job === row.job)
      expect(items.length).toBe(1)
      expect(counterfactualCheck(inputs, option.variant, option.rows, items)).toEqual([])
      const item = items[0]!
      if (!item.joint) continue
      joint++
      for (const cause of item.because) expect(counterfactualCheck(inputs, option.variant, option.rows, [{ ...item, because: [cause], joint: false }]).length).toBe(1)
    }
    expect(joint).toBeGreaterThan(0)
    await pool.shutdown()
  }, 300_000)
})
