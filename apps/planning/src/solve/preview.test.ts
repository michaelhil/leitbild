import { afterAll, describe, expect, test } from 'bun:test'
import { createHarness } from '../api/fixtures/harness.ts'
import { createRealSolver } from '../api/wiring.ts'
import { checkPlan } from '../check/check.ts'
import { planInputsSchema, planSchema, type PlanInputs } from '../plan/schema.ts'
import { twinPlan, twinV3Options } from '../../tests/harness/twin-plan.ts'
import { compile } from './compile.ts'
import { prepare } from './decode.ts'
import { dateSchedule, undate } from './date.ts'
import { CERTIFIED_SIZE, generate, type GenerateInput } from './generate.ts'
import { createSolverPool } from './pool.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
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
  const generated = async (inputs: PlanInputs, variants?: GenerateInput['variants'], seed = 1, evals = 1_500) => {
    // S60 to S130 are above the certified size (33 jobs): solved directly here, the size lifted, as or's size curve did.
    const result = await generate({ engine: pool, check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound, certifiedSize: { ...CERTIFIED_SIZE, maxJobs: 130 } }, {
      inputs, revision: 1, previous: null, input: variants === undefined ? {} : { variants }, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed, evals,
    })
    const option = result.optionSet.options.find(candidate => candidate.key === result.optionSet.recommended)!
    expect(option.status.word).toBe('validated feasible')
    return { optionSet: result.optionSet, option }
  }
  const optionOf = async (inputs: PlanInputs, variants?: GenerateInput['variants']) => (await generated(inputs, variants)).option

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

  test('a lock too early is judged against the saved plan: its findings and its nearest allowed time (walk 2, R2-5)', async () => {
    const inputs = trainAInputs({ read: true })
    const option = await optionOf(inputs)
    const job = 'SWA-MOTOR-IN'
    const saved = option.rows.find(row => row.job === job)!
    const window = Date.parse(inputs.settings.window!.start)
    const lockAt = new Date(Math.max(window, Date.parse(saved.start) - 28 * 3_600_000)).toISOString()
    const locked = planInputsSchema.parse({ ...inputs, jobs: inputs.jobs.map(entry => (entry.key === job ? { ...entry, lock: { start: lockAt } } : entry)) })
    const preview = await solver.preview({ inputs: locked, option }) as Awaited<ReturnType<typeof solver.preview>> & { lockFindings?: ReadonlyArray<{ code: string; about: readonly string[]; words?: string }> }
    // The findings are lane K's on the SAVED rows with only the locked job at its lock, no other job moved:
    // every violation the move brings that the saved plan does not have (a finding naming only a crew or a
    // rule counts when the move causes it).
    const free = planInputsSchema.parse({ ...inputs })
    const identity = (violation: { readonly code: string; readonly about: readonly string[] }) => `${violation.code} ${violation.about.join(' ')}`
    const before = new Set(checkPlan(free, option.variant, option.rows).violations.filter(violation => !violation.about.includes(job)).map(identity))
    const brought = (violation: { readonly code: string; readonly about: readonly string[] }) => violation.about.includes(job) || !before.has(identity(violation))
    const atLockRows = option.rows.map(row => (row.job === job ? preview.rows.find(entry => entry.job === job)! : row))
    expect(preview.lockFindings!.length).toBeGreaterThan(0)
    expect(preview.lockFindings).toEqual(checkPlan(locked, option.variant, atLockRows).violations.filter(brought).map(violation => ({ code: violation.code, about: violation.about, words: violation.words })))
    // The nearest allowed time: the job brings nothing new beside the saved plan there (lane K's check).
    const nearest = preview.nearestAllowed!
    expect(nearest.job).toBe(job)
    const compiled = compile(free, { methods: option.variant.methods, buy: option.variant.purchases })
    if (!compiled.ok) throw new Error('the flagship compiles')
    const prep = prepare(compiled.problem)
    const found = undate(prep, compiled.index, option.rows)
    if (!found.ok) throw new Error('the option fits its plan')
    const a = compiled.index.jobs.indexOf(job)
    const rowAt = (iso: string) => {
      const start = Int32Array.from(found.schedule.start)
      start[a] = (Date.parse(iso) - compiled.index.origin) / compiled.index.slotMs
      return option.rows.map(row => (row.job === job ? dateSchedule(prep, compiled.index, { start, mode: found.schedule.mode }).find(entry => entry.job === job)! : row))
    }
    expect(checkPlan(free, option.variant, rowAt(nearest.at)).violations.filter(brought)).toEqual([])
    expect(Date.parse(nearest.at)).toBeGreaterThan(Date.parse(lockAt))
  }, 300_000)

  // Two options of the flagship, two kinds of seal: on day shifts (seed 1, 1,500 evaluations; the longer seal
  // breaks the 72 h span R2, 82 h) and in bought time (lane K's case, the adversary's item 22: seed 2,
  // 15,000 evaluations, span 49 h; the repair moves the seal's start later and R2 holds, 65.5 h). Only what
  // must hold for any option is asserted: only forced jobs move, nothing earlier; each moved job carries the
  // edit as its cause; the checker's verdict on the previewed rows is the preview's.
  for (const { name, seed, evals, bought } of [
    { name: 'the seal on day shifts', seed: 1, evals: 1_500, bought: false },
    { name: 'the seal in bought time (lane K\'s case)', seed: 2, evals: 15_000, bought: true },
  ]) test(`a seal estimate +6 h, ${name}: only what it forces moves, each moved job carries the edit, the checker's verdict is the preview's`, async () => {
    const inputs = trainAInputs({ read: true })
    const { optionSet, option } = await generated(inputs, undefined, seed, evals)
    const before = new Map(option.rows.map(row => [row.job, row]))
    expect(before.get('CCWA-SEAL')!.uses.some(use => use.purchase !== undefined)).toBe(bought)
    const seal = inputs.jobs.find(job => job.key === 'CCWA-SEAL')!
    if (seal.duration.value === null) throw new Error('the flagship seal has an estimate')
    const longer = seal.duration.value + 6
    const sealed = planInputsSchema.parse({ ...inputs, jobs: inputs.jobs.map(job => (job === seal ? { ...job, duration: { ...job.duration, value: longer } } : job)) })
    const preview = await solver.preview({ inputs: sealed, option })
    // Truthful: the preview's findings are lane K's on its rows. The repair breaks no link, crew, calendar or
    // keep-in-service rule; what the longer seal itself breaks is shown, not hidden by moving other jobs back.
    const check = checkPlan(sealed, option.variant, preview.rows)
    expect(preview.violations).toEqual(check.violations.map(violation => ({ code: violation.code, about: violation.about, words: violation.words })))
    for (const violation of check.violations) expect(['span-limit', 'beyond-window', 'due']).toContain(violation.code)
    const moved = preview.rows.filter(row => row.start !== before.get(row.job)!.start || row.finish !== before.get(row.job)!.finish)
    const movedKeys = new Set(moved.map(row => row.job))
    expect(movedKeys.has('CCWA-SEAL')).toBe(true)
    for (const row of moved) expect(Date.parse(row.start)).toBeGreaterThanOrEqual(Date.parse(before.get(row.job)!.start))
    // Every other moved job is forced: a predecessor that moved (a link), or a crew or tool that a moved job
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
    // Through the operations (planning.plan.edit with preview): what moved, each with the edit as its cause.
    const harness = await createHarness({ solver })
    try {
      const at = new Date().toISOString()
      const plan = planSchema.parse({
        id: crypto.randomUUID(), workspaceId: harness.workspaceId, revision: 1, createdAt: at, updatedAt: at, inputs, options: optionSet, baselines: [],
        changes: [{ seq: 1, at, by: { kind: 'human' }, revision: 1, summary: `Created '${inputs.settings.title}'`, kinds: [] }], droppedChanges: 0,
      })
      const id = (await harness.store.create(harness.workspaceId, plan)).id
      const answer = await harness.call('planning.plan.edit', { resource: id, input: { edits: [{ edit: 'job', key: 'CCWA-SEAL', duration: { value: longer } }], preview: true } })
      expect(answer.status).toBe(200)
      const shown: Array<{ job: string; because: number[] }> = answer.body.result.preview.moved
      expect(shown.length).toBe(Math.min(6, moved.length))
      for (const entry of shown) expect({ job: entry.job, moved: movedKeys.has(entry.job), because: entry.because }).toEqual({ job: entry.job, moved: true, because: [0] })
      expect(answer.body.result.preview.violations.length).toBe(check.violations.length)
    } finally { await harness.close() }
  }, 300_000)
})
