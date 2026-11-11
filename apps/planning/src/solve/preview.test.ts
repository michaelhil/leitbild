import { afterAll, describe, expect, test } from 'bun:test'
import { createRealSolver } from '../api/wiring.ts'
import { checkPlan } from '../check/check.ts'
import { planInputsSchema, type PlanInputs } from '../plan/schema.ts'
import { twinPlan, twinV3Options } from '../../tests/harness/twin-plan.ts'
import { compile } from './compile.ts'
import { prepare } from './decode.ts'
import { generate, type GenerateInput } from './generate.ts'
import { createSolverPool } from './pool.ts'
import { laneKCheck, laneKVerify } from './fixtures/lane-k.ts'
import { SIZE_CURVE_SHA256, sizeCurveSubset } from './fixtures/size-curve.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

// Preview re-timing (planning.plan.edit with preview) repairs the option's own dated schedule: with no edit
// it is the option exactly, and after an edit only the jobs the edit forces move. Options come from the real
// engine on a fixed evaluation budget (reproducible); lane K's checker judges every preview. The flagship is
// the Train A case; S60, S100 and S130 are or's frozen size-curve subsets of twin v3, rebuilt and hash-checked.
describe('preview re-timing repairs the option, never re-solves it', () => {
  const pool = createSolverPool({ rssLimitMb: 4_000 })
  const solver = createRealSolver(pool)
  afterAll(() => pool.shutdown())
  const optionOf = async (inputs: PlanInputs, variants?: GenerateInput['variants']) => {
    const result = await generate({ engine: pool, check: laneKCheck, verify: laneKVerify }, {
      inputs, revision: 1, previous: null, input: variants === undefined ? {} : { variants }, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed: 1, evals: 1_500,
    })
    const option = result.optionSet.options.find(candidate => candidate.key === result.optionSet.recommended)!
    expect(option.status.word).toBe('validated feasible')
    return option
  }

  test('with no edit the preview is the option exactly: the flagship and S60, S100, S130', async () => {
    const plans: Array<{ inputs: PlanInputs; variants?: GenerateInput['variants'] }> = [{ inputs: trainAInputs({ read: true }) }]
    for (const name of ['S60', 'S100', 'S130'] as const) {
      const { bench, sha256 } = sizeCurveSubset(name)
      expect(sha256).toBe(SIZE_CURVE_SHA256[name])
      const twin = twinPlan(bench, twinV3Options(bench))
      plans.push({ inputs: twin.inputs, variants: [{ label: name, methods: [...twin.variant.methods], buy: [...twin.variant.purchases] }] })
    }
    for (const { inputs, variants } of plans) {
      const option = await optionOf(inputs, variants)
      const preview = await solver.preview({ inputs, option })
      expect(preview.rows).toEqual(option.rows)
      expect(preview.violations).toEqual([])
      expect(checkPlan(inputs, option.variant, preview.rows).feasible).toBe(true)
    }
  }, 600_000)

  test('a seal estimate +6 h moves only the CCW chain and what it forces; the checker finds only what the edit breaks', async () => {
    const inputs = trainAInputs({ read: true })
    const option = await optionOf(inputs)
    const seal = inputs.jobs.find(job => job.key === 'CCWA-SEAL')!
    if (seal.duration.value === null) throw new Error('the flagship seal has an estimate')
    const sealed = planInputsSchema.parse({ ...inputs, jobs: inputs.jobs.map(job => (job === seal ? { ...job, duration: { ...job.duration, value: seal.duration.value! + 6 } } : job)) })
    const preview = await solver.preview({ inputs: sealed, option })
    // The preview's findings are lane K's on its rows. The repair breaks no link, crew, calendar or
    // keep-in-service rule; what the longer seal itself breaks (here the 72 h span R2: the seal works day
    // shifts in this option) is shown, not hidden by moving other jobs back.
    const check = checkPlan(sealed, option.variant, preview.rows)
    expect(preview.violations).toEqual(check.violations.map(violation => ({ code: violation.code, about: violation.about })))
    for (const violation of check.violations) expect(['span-limit', 'beyond-window', 'due']).toContain(violation.code)
    const before = new Map(option.rows.map(row => [row.job, row]))
    const moved = preview.rows.filter(row => row.start !== before.get(row.job)!.start || row.finish !== before.get(row.job)!.finish)
    const movedKeys = new Set(moved.map(row => row.job))
    expect(movedKeys.has('CCWA-SEAL')).toBe(true)
    // The seal keeps its start (still feasible) and finishes later; nothing moves earlier.
    expect(preview.rows.find(row => row.job === 'CCWA-SEAL')!.start).toBe(before.get('CCWA-SEAL')!.start)
    for (const row of moved) expect(Date.parse(row.start)).toBeGreaterThanOrEqual(Date.parse(before.get(row.job)!.start))
    // Every other moved job is forced: a predecessor that moved (a link), or a crew or tool that a job
    // starting before it now holds over its old start.
    const compiled = compile(sealed, { methods: option.variant.methods, buy: option.variant.purchases })
    if (!compiled.ok) throw new Error('the sealed plan compiles')
    const prep = prepare(compiled.problem)
    const keyOf = (a: number) => compiled.index.jobs[a]
    for (const row of moved) {
      if (row.job === 'CCWA-SEAL') continue
      const a = compiled.index.jobs.indexOf(row.job)
      const byLink = prep.preds[a]!.some(link => movedKeys.has(keyOf(link.from) ?? ''))
      const old = before.get(row.job)!
      const byCrew = old.uses.some(use => preview.rows.some(other => other.job !== row.job && movedKeys.has(other.job) && Date.parse(other.start) <= Date.parse(old.start)
        && other.uses.some(held => held.resource === use.resource && Date.parse(held.from) < Date.parse(use.to) && Date.parse(use.from) < Date.parse(held.to))))
      expect({ job: row.job, forced: byLink || byCrew }).toEqual({ job: row.job, forced: true })
    }
    // Everything done before the seal starts keeps its place and resources exactly (its float may change).
    const placed = ({ float: _float, ...row }: (typeof option.rows)[number]) => row
    for (const row of option.rows) if (row.finish <= before.get('CCWA-SEAL')!.start) expect(placed(preview.rows.find(entry => entry.job === row.job)!)).toEqual(placed(row))
    expect(movedKeys.size).toBeLessThan(option.rows.length / 2)
  }, 300_000)
})
