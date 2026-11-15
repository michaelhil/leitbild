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
const placeable = ranged.filter(job => { const found = retime(flagship, [job]); return found !== undefined && found.unplaced === undefined })
const unplaced = ranged.filter(job => retime(flagship, [job])?.unplaced !== undefined)
/** The flagship with the ranges that leave a job unplaced taken off, so every re-timing has rows. */
const trimmed: PlanInputs = { ...flagship, jobs: flagship.jobs.map(job => (unplaced.includes(job.key) ? { ...job, duration: (({ range: _range, ...rest }) => rest)(job.duration) } : job)) }
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

  test('a job left without a slot with its crews is named, with the crew and the end of its last time (checked run: Train A swap)', () => {
    // CCWHXA-CLEAN at its high estimate pushes the eddy-current test past the eddy-current team's only time:
    // the team has no weekly hours, only its booked period (and the rebooked one, when the option buys it).
    expect(unplaced).toContain('CCWHXA-CLEAN')
    const found = retime(flagship, ['CCWHXA-CLEAN'])!
    const team = flagship.resources.find(resource => resource.key === found.unplaced?.resource)!
    const job = flagship.jobs.find(entry => entry.key === found.unplaced?.job)!
    expect(job.needs.map(need => need.anyOf)).toEqual([[team.key]])
    const calendar = flagship.calendars.find(entry => entry.key === team.calendar)!
    expect(calendar.weekly).toEqual([])
    const periods = [...calendar.periods, ...flagship.purchases.filter(entry => entry.resource === team.key && option.variant.purchases.includes(entry.key)).flatMap(entry => ('periods' in entry.adds ? entry.adds.periods : []))]
    expect(Date.parse(found.unplaced!.after)).toBe(Math.max(...periods.map(period => Date.parse(period.end))))
    // The rows are the placed jobs only: the unplaced job and what waits on it have none; none starts earlier.
    expect(found.rows.some(row => row.job === job.key)).toBe(false)
    for (const row of found.rows) expect(Date.parse(row.start)).toBeGreaterThanOrEqual(Date.parse(option.rows.find(planned => planned.job === row.job)!.start))
  })

  test('the unplaced item is stored as lane K judges it, never left out', () => {
    // Lane K's judgement of an unplaced job is still to land: this judge returns the claim as the outcome
    // lane K is expected to give, and leaves every other re-timing to lane K.
    const withUnplaced: JudgeRetimed = plan => (plan.unplaced === undefined ? laneKJudgeRetimed(plan) : { ok: true, outcome: { holds: false, unplaced: plan.unplaced } })
    const robust = robustOf(flagship, option, withUnplaced)!
    expect(robustSchema.safeParse(robust).success).toBe(true)
    const claim = retime(flagship, ['CCWHXA-CLEAN'])!.unplaced!
    expect(robust.single.find(entry => entry.job === 'CCWHXA-CLEAN')!.outcome).toEqual({ holds: false, unplaced: claim })
    expect(robust.single.map(entry => entry.job)).toEqual(ranged)
  })
})

describe('the robust record', () => {
  const judged: Array<readonly string[]> = []
  const recording: JudgeRetimed = plan => { judged.push(plan.high); return laneKJudgeRetimed(plan) }

  test('every ranged job together, then each alone, each outcome lane K\'s own', () => {
    judged.length = 0
    const jobs = rangedJobs(trimmed, option.rows)
    const robust = robustOf(trimmed, option, recording)!
    expect(robustSchema.safeParse(robust).success).toBe(true)
    expect(judged).toEqual([jobs, ...jobs.map(job => [job])])
    const own = (high: readonly string[]) => {
      const found = retimedRows(trimmed, atHigh(trimmed, new Set(high)), option)!
      const judgement = 'rows' in found ? judgeRetiming(trimmed, option.variant, option.rows, found.rows, high) : undefined
      if (judgement?.ok !== true) throw new Error('lane K judges each re-timing')
      return judgement.outcome
    }
    expect(robust.allPessimistic).toEqual(own(jobs))
    expect(robust.single).toEqual(jobs.map(job => ({ job, outcome: own([job]) })))
  })

  test('not computed rather than partly: past its time, or refused by lane K, nothing', () => {
    expect(robustOf(trimmed, option, laneKJudgeRetimed, Date.now() - 1)).toBeUndefined()
    expect(robustOf(trimmed, option, () => ({ ok: false, problems: ['refused'] }))).toBeUndefined()
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
