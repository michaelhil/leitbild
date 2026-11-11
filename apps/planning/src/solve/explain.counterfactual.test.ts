import { describe, expect, test } from 'bun:test'
import { counterfactualCheck } from '../../tests/harness/counterfactual.ts'
import { createRealSolver } from '../api/wiring.ts'
import { createSolverPool } from './pool.ts'
import { generate } from './generate.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'
import { lateTruck, supplyRun } from './fixtures/supply-run.ts'
import { checkPlan } from '../check/check.ts'
import type { Plan, PlanInputs } from '../plan/schema.ts'
import { compile } from './compile.ts'
import { dateSchedule, undate } from './date.ts'
import { makeDecoder, precedenceOrder, prepare } from './decode.ts'
import type { ExplainItem } from './explain.ts'
import { totalFloat, withFloat } from './float.ts'

type Option = NonNullable<Plan['options']>['options'][number]

// "Why it starts then" passes lane K's counterfactual check (acceptance row 7) on every job of a flagship
// plan: relaxing the named cause (or the joint set together) lets the job start earlier with every other
// job fixed, judged by lane K's checker; no single member of a joint set does it alone. A reproducible
// plan (evaluation budget); the full acceptance run is tests/harness/acceptance-run.ts.
describe('why-start names the causes that hold each job', () => {
  test('every job of the flagship plan: 0 counterfactual failures, joint sets minimal', async () => {
    const inputs = trainAInputs({ read: true })
    const pool = createSolverPool({ rssLimitMb: 4_000 })
    const result = await generate({ engine: pool, check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }, { inputs, revision: 1, previous: null, input: {}, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed: 1, evals: 1_500 })
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

  test('Supply run (case2 v1.1): every cause is in the plan and passes; U-1 names Truck 2 off shift and the coverage rule, never the window', async () => {
    const pool = createSolverPool({ rssLimitMb: 4_000 })
    const solver = createRealSolver(pool)
    for (const inputs of [supplyRun, lateTruck]) {
      const option = await supplyOption(pool, inputs)
      const keys = keysOf(inputs)
      for (const row of option.rows) {
        const answer = await solver.explain({ inputs, option, ask: 'why-start', job: row.job, cursor: undefined })
        const item = answer.items.find(entry => entry.job === row.job)!
        // Every named item is in this plan (screenshot S-06 named "an item no longer in this plan").
        for (const cause of item.because) for (const key of cause.about) expect(keys.has(key)).toBe(true)
        // "The window opens then" only for a start at the window's first slot (S-06 said it for 10:02).
        if (row.start !== new Date(inputs.settings.window!.start).toISOString()) expect(item.because.map(cause => cause.kind)).not.toContain('window')
        expect(relaxedCheck(inputs, item, option.variant, option.rows)).toEqual([])
        // U-1 waits for Truck 4 to be released by Truck 2's join, or for Truck 2 itself: each alone moves it.
        if (row.job === 'U-1') expect(item.because.map(cause => cause.kind).toSorted()).toEqual(['availability', 'shift'])
      }
    }
    await pool.shutdown()
  }, 300_000)

  test('Supply run: a job at the window start, which is the data date, names its whole binding set', async () => {
    const pool = createSolverPool({ rssLimitMb: 4_000 })
    const solver = createRealSolver(pool)
    const inputs = supplyRun
    const option = await supplyOption(pool, inputs)
    // The engine may place R-1 later (two plans tie); the product decoder places it first, at the window start.
    const rows = firstAtWindowStart(inputs, option, 'R-1')
    expect(checkPlan(inputs, option.variant, rows).feasible).toBe(true)
    const placed = { ...option, rows }
    const row = rows.find(entry => entry.job === 'R-1')!
    expect(row.start).toBe(new Date(inputs.settings.dataDate!).toISOString())
    const item = (await solver.explain({ inputs, option: placed, ask: 'why-start', job: 'R-1', cursor: undefined })).items.find(entry => entry.job === 'R-1')!
    // The window, the data date, its truck coming on duty then and the heavy-truck rule (no heavy truck is on
    // duty before the window) hold it there together.
    expect(item.joint).toBe(true)
    expect(item.because.map(cause => cause.kind)).toEqual(['window', 'data-date', 'shift', 'availability'])
    expect(item.because[2]!.about).toEqual(row.uses.map(use => use.resource))
    expect(relaxedCheck(inputs, item, option.variant, rows)).toEqual([])
    await pool.shutdown()
  }, 300_000)
})

const supplyOption = async (pool: ReturnType<typeof createSolverPool>, inputs: PlanInputs) => {
  const result = await generate({ engine: pool, check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }, { inputs, revision: 1, previous: null, input: {}, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed: 1, evals: 1_500 })
  const option = result.optionSet.options[0]!
  expect(option.status.word).toBe('validated feasible')
  return option
}
const keysOf = (inputs: PlanInputs) => new Set([...inputs.jobs.map(job => job.key), ...inputs.resources.map(resource => resource.key), ...inputs.rules.map(rule => rule.key), ...inputs.equipment.map(item => item.key), ...inputs.purchases.map(purchase => purchase.key)])
/**
 * Lane K's harness does not yet relax a data date: for a cause set naming one, the data date moves a day
 * earlier here and the harness relaxes the rest. Otherwise the inputs and item as they are.
 */
const relaxedCheck = (inputs: PlanInputs, item: ExplainItem, variant: Option['variant'], rows: Option['rows']) => {
  if (!item.because.some(cause => cause.kind === 'data-date')) return counterfactualCheck(inputs, variant, rows, [item])
  const earlier = { ...inputs, settings: { ...inputs.settings, dataDate: new Date(Date.parse(inputs.settings.dataDate!) - 86_400_000).toISOString() } }
  return counterfactualCheck(earlier, variant, rows, [{ ...item, because: item.because.filter(cause => cause.kind !== 'data-date') }])
}
/** The option's schedule with `job` decoded first, in the first of its modes that puts it at the window start. */
const firstAtWindowStart = (inputs: PlanInputs, option: Option, job: string): Option['rows'] => {
  const compiled = compile(inputs, { methods: option.variant.methods, buy: option.variant.purchases })
  if (!compiled.ok) throw new Error('the Supply run compiles')
  const prep = prepare(compiled.problem)
  const found = undate(prep, compiled.index, option.rows)
  if (!found.ok) throw new Error('the option fits its plan')
  const a = compiled.index.jobs.indexOf(job)
  const decoder = makeDecoder(prep)
  for (let m = 0; m < compiled.problem.activities[a]!.modes.length; m++) {
    const modes = Int32Array.from(found.schedule.mode)
    modes[a] = m
    const decoded = decoder.decode(precedenceOrder(prep, [a, ...[...prep.topo].filter(b => b !== a)]), modes)
    if (decoded.penalty > 0 || decoded.start[a] !== 0) continue
    const schedule = { start: decoded.start, mode: decoded.mode }
    return withFloat(dateSchedule(prep, compiled.index, schedule), totalFloat(prep, compiled.index, schedule), compiled.index)
  }
  throw new Error(`no mode puts ${job} at the window start`)
}
