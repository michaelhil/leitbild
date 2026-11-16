// Pessimistic re-timing (design §4.2, §8 S4): the option's own schedule, ranged jobs at their high estimate,
// re-timed by the repair path. Same crews and bought time, nothing earlier; lane K judges each re-timing, so
// the first rule broken, its job and by how much are lane K's own figures.
import { describe, expect, test } from 'bun:test'
import { judgeRetiming } from '../check/retime.ts'
import { robustSchema, type PlanInputs } from '../plan/schema.ts'
import { generate, type GenerateDeps } from './generate.ts'
import { atHigh, rangedJobs, retimedRows, robustOf, type JudgeRetimed } from './retime.ts'
import { searchEngine } from './search.ts'
import { laneKCheck, laneKJudgeRetimed, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

const by = { kind: 'service' as const, name: 'test' }
const deps: GenerateDeps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }
const flagship = trainAInputs({ read: true })
const swap = [{ choice: 'SWA-method', option: 'swap' }]
const solveSwap = async (inputs: PlanInputs, extra: Partial<GenerateDeps> = {}) => (await generate({ ...deps, ...extra }, { inputs, revision: 1, previous: null, input: { variants: [{ label: 'Swap', methods: swap }] }, by, signal: new AbortController().signal, seed: 1, evals: 600 })).optionSet.options[0]!
const option = await solveSwap(flagship)
const ranged = rangedJobs(flagship, option.rows)
const retime = (inputs: PlanInputs, high: readonly string[]) => retimedRows(inputs, atHigh(inputs, new Set(high)), option)
// A job left without a slot has no row in the re-timing.
const placesAll = (job: string): boolean => retime(flagship, [job])?.rows.length === option.rows.length
const placeable = ranged.filter(placesAll)
const unplaced = ranged.filter(job => retime(flagship, [job]) !== undefined && !placesAll(job))
/** The flagship with the ranges that leave a job unplaced taken off, so every re-timing has rows. */
const trimmed: PlanInputs = { ...flagship, jobs: flagship.jobs.map(job => (unplaced.includes(job.key) ? { ...job, duration: (({ range: _range, ...rest }) => rest)(job.duration) } : job)) }
/** The robust record itself, not the word that it was not worked out. */
const record = (field: ReturnType<typeof robustOf>) => {
  if (field === undefined || 'notWorkedOut' in field) throw new Error('a robust record')
  return field
}
const crewsOf = (rows: ReadonlyArray<{ readonly job: string; readonly uses: ReadonlyArray<{ readonly resource: string }> }>) => new Map(rows.map(row => [row.job, [...new Set(row.uses.map(use => use.resource))].toSorted()]))

describe('the ranged jobs', () => {
  test('those the option schedules with an estimate range of their own above the planned value, in plan order', () => {
    const scheduled = new Set(option.rows.map(row => row.job))
    const expected = flagship.jobs.filter(job => scheduled.has(job.key) && job.duration.origin.by !== 'world' && job.durationWith.length === 0 && job.duration.range !== undefined && job.duration.value !== null && job.duration.range.high > job.duration.value).map(job => job.key)
    expect(expected.length).toBeGreaterThan(1)
    expect(ranged).toEqual(expected)
  })
})

describe('re-timed by the repair path', () => {
  test('one job high: the same crews, nothing earlier, the same jobs, and lane K takes it as a re-timing', () => {
    expect(option.status.word).toBe('validated feasible')
    expect(placeable.length).toBeGreaterThan(0)
    for (const job of placeable) {
      const found = retime(flagship, [job])!
      expect(found.rows.map(row => row.job).toSorted()).toEqual(option.rows.map(row => row.job).toSorted())
      for (const row of found.rows) expect(Date.parse(row.start)).toBeGreaterThanOrEqual(Date.parse(option.rows.find(planned => planned.job === row.job)!.start))
      expect(crewsOf(found.rows)).toEqual(crewsOf(option.rows))
      expect(judgeRetiming(flagship, option.variant, option.rows, found.rows, [job]).ok).toBe(true)
    }
  })

  test('with nothing raised, the rows come back as planned', () => {
    const found = retime(flagship, [])!
    expect(found).toEqual({ rows: option.rows.map(({ float: _float, ...row }) => row) })
  })

  test('a job left without a slot with its crews has no row, nor what waits on it; none placed starts earlier (checked run: Train A swap)', () => {
    // CCWHXA-CLEAN at its high estimate pushes the eddy-current test past the eddy-current team's only time:
    // the team has no weekly hours, only its booked period (and the rebooked one, when the option buys it).
    expect(unplaced).toContain('CCWHXA-CLEAN')
    const found = retime(flagship, ['CCWHXA-CLEAN'])!
    const missing = option.rows.map(row => row.job).filter(job => !found.rows.some(row => row.job === job))
    const periodsOnly = (key: string) => flagship.calendars.find(entry => entry.key === flagship.resources.find(resource => resource.key === key)?.calendar)?.weekly.length === 0
    expect(missing.some(key => flagship.jobs.find(job => job.key === key)!.needs.some(need => need.anyOf.every(periodsOnly)))).toBe(true)
    for (const row of found.rows) expect(Date.parse(row.start)).toBeGreaterThanOrEqual(Date.parse(option.rows.find(planned => planned.job === row.job)!.start))
  })

  test('lane K names the job that could not be placed, its crew and from when; Generate stores it', async () => {
    const found = retime(flagship, ['CCWHXA-CLEAN'])!
    const own = judgeRetiming(flagship, option.variant, option.rows, found.rows, ['CCWHXA-CLEAN'])
    expect(own.ok).toBe(true)
    const outcome = own.ok ? own.outcome : undefined
    if (outcome === undefined || !('unplaced' in outcome)) throw new Error('lane K names the unplaced job')
    // The job is the one that needs the eddy-current team, and the crew is that team (from the fixture).
    const job = flagship.jobs.find(entry => entry.key === outcome.unplaced.job)!
    expect(job.needs.map(need => need.anyOf)).toEqual([[outcome.unplaced.resource]])
    const robust = record(robustOf(flagship, option, laneKJudgeRetimed))
    expect(robustSchema.safeParse(robust).success).toBe(true)
    expect(robust.single.map(entry => entry.job)).toEqual(ranged)
    expect(robust.single.find(entry => entry.job === 'CCWHXA-CLEAN')!.outcome).toEqual(outcome)
    // In Generate, on the flagship itself: the record is stored, with lane K's outcome for every re-timing.
    const stored = await solveSwap(flagship, { judgeRetimed: laneKJudgeRetimed })
    expect(stored.robust).toBeDefined()
    expect(stored.robust).toEqual(robustOf(flagship, stored, laneKJudgeRetimed))
  }, 60_000)
})

describe('the robust record', () => {
  const judged: Array<readonly string[]> = []
  const recording: JudgeRetimed = plan => { judged.push(plan.high); return laneKJudgeRetimed(plan) }

  test('every ranged job together, then each alone, each outcome lane K\'s own', () => {
    judged.length = 0
    const jobs = rangedJobs(trimmed, option.rows)
    const robust = record(robustOf(trimmed, option, recording))
    expect(robustSchema.safeParse(robust).success).toBe(true)
    expect(judged).toEqual([jobs, ...jobs.map(job => [job])])
    const own = (high: readonly string[]) => {
      const found = retimedRows(trimmed, atHigh(trimmed, new Set(high)), option)!
      const judgement = 'rows' in found ? judgeRetiming(trimmed, option.variant, option.rows, found.rows, high) : undefined
      if (judgement?.ok !== true) throw new Error('lane K judges each re-timing')
      // Stored as lane K gives it: a holding re-timing with lane K's spans against their limits (V12).
      return judgement.outcome.holds && judgement.spans !== undefined ? { ...judgement.outcome, spans: [...judgement.spans] } : judgement.outcome
    }
    expect(robust.allPessimistic).toEqual(own(jobs))
    expect(robust.single).toEqual(jobs.map(job => ({ job, outcome: own([job]) })))
  })

  test('never partly: past its time it says so ("not worked out: the time ran out"); refused by lane K, with its reason', () => {
    expect(robustOf(trimmed, option, laneKJudgeRetimed, Date.now() - 1)).toEqual({ notWorkedOut: 'time' })
    expect(robustOf(trimmed, option, () => ({ ok: false, problems: ['refused'] }))).toEqual({ notWorkedOut: 'refused', reason: 'refused' })
  })

  test('nothing ranged: re-timing changes nothing, so the validated plan holds, unjudged', () => {
    judged.length = 0
    const fixed: PlanInputs = { ...flagship, jobs: flagship.jobs.map(job => (job.duration.range === undefined ? job : { ...job, duration: (({ range: _range, ...rest }) => rest)(job.duration) })) }
    expect(robustOf(fixed, option, recording)).toEqual({ allPessimistic: { holds: true }, single: [] })
    expect(judged).toEqual([])
  })

  test('Generate stores it on a feasible option when lane K\'s judgement is given, and not otherwise', async () => {
    const plain = await solveSwap(trimmed)
    expect(plain.robust).toBeUndefined()
    const judgedOption = await solveSwap(trimmed, { judgeRetimed: laneKJudgeRetimed })
    expect(judgedOption.status.word).toBe('validated feasible')
    expect(judgedOption.robust).toEqual(robustOf(trimmed, judgedOption, laneKJudgeRetimed))
    expect(judgedOption.robust).toBeDefined()
  }, 60_000)
})

describe('re-timings within the sub-solve\'s time (fix round F3, lane S\'s part)', () => {
  test('the first re-timing is checked against the time left too, from the estimate it is given', () => {
    let calls = 0
    const counting: JudgeRetimed = plan => { calls++; return laneKJudgeRetimed(plan) }
    // An estimate longer than the time left: not even the first re-timing starts.
    expect(robustOf(trimmed, option, counting, Date.now() + 60_000, Date.now, 120_000)).toEqual({ notWorkedOut: 'time' })
    expect(calls).toBe(0)
    expect(robustOf(trimmed, option, counting, Date.now() + 60_000, Date.now, 1)).toBeDefined()
    expect(calls).toBe(1 + rangedJobs(trimmed, option.rows).length)
  })
})

describe('a job its own mode cannot place, and what the record then says', () => {
  test('the same crews take their widest mode: a weak swap (checked run, evals 500) gets lane K\'s full record', async () => {
    const weak = (await generate(deps, { inputs: flagship, revision: 1, previous: null, input: { variants: [{ label: 'Swap', methods: swap }] }, by, signal: new AbortController().signal, seed: 1, evals: 500 })).optionSet.options[0]!
    expect(weak.status.word).toBe('validated feasible')
    const jobs = rangedJobs(flagship, weak.rows)
    const field = robustOf(flagship, weak, laneKJudgeRetimed)
    expect(field !== undefined && !('notWorkedOut' in field)).toBe(true)
    // Every re-timing keeps the crews and starts nothing earlier, as lane K itself accepts it.
    for (const high of [jobs, ...jobs.map(job => [job])]) {
      const found = retimedRows(flagship, atHigh(flagship, new Set(high)), weak)!
      expect(judgeRetiming(flagship, weak.variant, weak.rows, found.rows, high).ok).toBe(true)
    }
  }, 60_000)

  test('a re-timing that leaves a job unplaced, which lane K will not pin on a crew, says so: "re-timing could not place" it', () => {
    const found = retime(flagship, ['CCWHXA-CLEAN'])!
    expect(found.unplaced).toBeDefined()
    const job = retime(flagship, rangedJobs(flagship, option.rows))!.unplaced!
    expect(robustOf(flagship, option, () => ({ ok: false, problems: ['no crew or tool named'] }))).toEqual({ notWorkedOut: 'unplaced', job })
  })
})

describe('V12: a re-timing that holds keeps lane K\'s spans against their limits', () => {
  test('each holding outcome carries lane K\'s own spans, as given; none is computed here (checked run: swap, evals 1,500)', async () => {
    const longer = (await generate(deps, { inputs: flagship, revision: 1, previous: null, input: { variants: [{ label: 'Swap', methods: swap }] }, by, signal: new AbortController().signal, seed: 1, evals: 1_500 })).optionSet.options[0]!
    const robust = record(robustOf(flagship, longer, laneKJudgeRetimed))
    const holding = robust.single.filter(each => each.outcome.holds)
    expect(holding.length).toBeGreaterThan(0)
    for (const entry of holding) {
      const found = retimedRows(flagship, atHigh(flagship, new Set([entry.job])), longer)!
      const judgement = judgeRetiming(flagship, longer.variant, longer.rows, found.rows, [entry.job])
      if (!judgement.ok || judgement.spans === undefined) throw new Error('lane K gives the spans of a re-timing that holds')
      expect(judgement.spans.length).toBeGreaterThan(0)
      expect(entry.outcome).toEqual({ holds: true, spans: [...judgement.spans] })
    }
  }, 60_000)
})

describe('M2: the re-timings stop before the process would be killed', () => {
  test('a sub-solve whose slot outlasts its kill time answers before the kill, with its plan, the record "time ran out"', async () => {
    const { subSolve } = await import('./generate.ts')
    // A slow judgement, as lane K's on a loaded machine: every re-timing takes most of a second.
    const slow: JudgeRetimed = plan => { const until = performance.now() + 700; while (performance.now() < until) { /* busy */ } return laneKJudgeRetimed(plan) }
    const now = Date.now()
    const killAt = now + 4_000
    const outcome = await subSolve({ ...deps, judgeRetimed: slow })({
      inputs: flagship, revision: 1, variant: { key: 'swap', label: 'Swap', buy: 'allowed' }, combo: swap, budget: { evals: 600, cpuMs: 1_200, wallMs: 1_500 }, seed: 1,
      // A refused first sub-solve leaves the second a slot of nearly the whole Generate, far past its kill.
      answerBy: now + 20_000, deadlineAt: now + 20_000, killAt,
    }, new AbortController().signal)
    expect(Date.now()).toBeLessThan(killAt)
    expect(outcome.option.status.word).toBe('validated feasible')
    expect(outcome.option.robust).toEqual({ notWorkedOut: 'time' })
  }, 30_000)
})

describe('B2: lane K\'s refusal is said, never left out', () => {
  test('Train A with the eddy-current test locked Wed 08:00Z: Swap validated feasible, its record never missing', async () => {
    const locked: PlanInputs = { ...flagship, jobs: flagship.jobs.map(job => (job.key === 'CCWHXA-ECT' ? { ...job, lock: { start: '2026-11-18T08:00:00Z' } } : job)) }
    const result = await generate({ ...deps, judgeRetimed: laneKJudgeRetimed }, { inputs: locked, revision: 1, previous: null, input: { variants: [{ label: 'Swap', methods: swap }] }, by, signal: new AbortController().signal, seed: 1, evals: 600 })
    const option = result.optionSet.options[0]!
    expect(option.status.word).toBe('validated feasible')
    expect(option.robust).toBeDefined()
    // A refusal carries lane K's own reason: the same words lane K gives for that re-timing.
    if (option.robust !== undefined && 'notWorkedOut' in option.robust && option.robust.notWorkedOut === 'refused') {
      const jobs = rangedJobs(locked, option.rows)
      const reasons = [jobs, ...jobs.map(job => [job])].flatMap(high => {
        const found = retimedRows(locked, atHigh(locked, new Set(high)), option)
        const judged = found === undefined ? undefined : judgeRetiming(locked, option.variant, option.rows, found.rows, high)
        return judged?.ok === false ? [judged.problems.join(' ')] : []
      })
      expect(reasons).toContain(option.robust.reason)
    }
  }, 60_000)

  test('any refusal of lane K\'s that is not an unplaced job is stored with its reason', () => {
    expect(robustOf(trimmed, option, () => ({ ok: false, problems: ['The re-timing breaks a link into a locked job.'] }))).toEqual({ notWorkedOut: 'refused', reason: 'The re-timing breaks a link into a locked job.' })
  })
})
