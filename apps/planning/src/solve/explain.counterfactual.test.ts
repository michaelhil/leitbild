import { describe, expect, test } from 'bun:test'
import { counterfactualCheck } from '../../tests/harness/counterfactual.ts'
import { createRealSolver } from '../api/wiring.ts'
import { createSolverPool } from './pool.ts'
import { generate } from './generate.ts'
import { laneKCheck, laneKVerify } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'
import { lateTruck, supplyRun } from './fixtures/supply-run.ts'

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

  test('Supply run (case2 v1.1): U-1 names Truck 2 off shift and the coverage rule, never the window', async () => {
    const pool = createSolverPool({ rssLimitMb: 4_000 })
    const solver = createRealSolver(pool)
    for (const inputs of [supplyRun, lateTruck]) {
      const result = await generate({ engine: pool, check: laneKCheck, verify: laneKVerify }, { inputs, revision: 1, previous: null, input: {}, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed: 1, evals: 1_500 })
      const option = result.optionSet.options[0]!
      expect(option.status.word).toBe('validated feasible')
      const keys = new Set([...inputs.jobs.map(job => job.key), ...inputs.resources.map(resource => resource.key), ...inputs.rules.map(rule => rule.key), ...inputs.equipment.map(item => item.key), ...inputs.purchases.map(purchase => purchase.key)])
      for (const row of option.rows) {
        const answer = await solver.explain({ inputs, option, ask: 'why-start', job: row.job, cursor: undefined })
        const item = answer.items.find(entry => entry.job === row.job)!
        // Every named item is in this plan (screenshot S-06 named "an item no longer in this plan").
        for (const cause of item.because) for (const key of cause.about) expect(keys.has(key)).toBe(true)
        if (row.job === 'U-1') {
          // U-1 waits for Truck 4 to be released by Truck 2's join, or for Truck 2 itself: each alone moves it.
          expect(item.because.map(cause => cause.kind).toSorted()).toEqual(['availability', 'shift'])
          expect(item.because.map(cause => cause.kind)).not.toContain('window')
          expect(counterfactualCheck(inputs, option.variant, option.rows, [item])).toEqual([])
        } else {
          // R-1 starts at the plan's first slot, which is its data date (10:00): nothing earlier is planned.
          expect(row.start).toBe(inputs.settings.dataDate === null ? '' : new Date(inputs.settings.dataDate).toISOString())
          expect(item.because).toEqual([{ kind: 'data-date', about: [] }])
        }
      }
    }
    await pool.shutdown()
  }, 300_000)
})
