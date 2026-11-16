// V4 / T12 (maint's walk): an estimate preview on the option on the timeline re-times it by the same repair as
// the pessimistic card (decode.ts repair), so the two agree, and a job left with no slot is a finding of the
// preview, never a 409 "generate again". Lane K's own check and judgement give every figure.
import { describe, expect, test } from 'bun:test'
import { checkPlan } from '../check/check.ts'
import type { PlanInputs } from '../plan/schema.ts'
import { generate, type GenerateDeps } from './generate.ts'
import { previewOption } from './preview.ts'
import { robustOf } from './retime.ts'
import { searchEngine } from './search.ts'
import { laneKCheck, laneKJudgeRetimed, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

const by = { kind: 'service' as const, name: 'test' }
const deps: GenerateDeps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }
const flagship = trainAInputs({ read: true })
const set = (await generate(deps, { inputs: flagship, revision: 1, previous: null, input: {}, by, signal: new AbortController().signal, seed: 1, evals: 600 })).optionSet
const optionOf = (method: string) => set.options.find(option => option.variant.methods.some(pick => pick.option === method))!
/** The plan with one job's estimate set to its high value (the walk's edits: 20 h to 30 h, 10 h to 14 h). */
const atItsHigh = (job: string): PlanInputs => ({ ...flagship, jobs: flagship.jobs.map(entry => (entry.key === job ? { ...entry, duration: { ...entry.duration, value: entry.duration.range!.high } } : entry)) })
/** The pessimistic card's outcome for that job alone at its high estimate, as lane K judged it. */
const cardFor = (option: ReturnType<typeof optionOf>, job: string) => {
  const field = robustOf(flagship, option, laneKJudgeRetimed)
  if (field === undefined || 'notWorkedOut' in field) throw new Error('a robust record')
  return field.single.find(entry => entry.job === job)!.outcome
}
const testsOf = (rows: ReadonlyArray<{ readonly job: string; readonly finish: string }>) => Math.max(...rows.filter(row => flagship.jobs.find(job => job.key === row.job)?.kind === 'test').map(row => Date.parse(row.finish)))

describe('the estimate preview on the option on the timeline', () => {
  test('Rebuild, the workshop rebuild at 30 h: it previews (no 409), the job and the chain\'s finish move, and its finding is the card\'s', () => {
    const rebuild = optionOf('rebuild')
    const edited = atItsHigh('SWA-REBUILD')
    const preview = previewOption(edited, rebuild)
    expect(preview.unplaced).toBeUndefined()
    const job = (rows: ReadonlyArray<{ readonly job: string; readonly finish: string }>) => Date.parse(rows.find(row => row.job === 'SWA-REBUILD')!.finish)
    expect(job(preview.rows)).toBeGreaterThan(job(rebuild.rows))
    expect(testsOf(preview.rows)).toBeGreaterThan(testsOf(rebuild.rows))
    // The preview's findings are lane K's own check of its rows, and they name what the card names.
    expect(preview.violations.map(violation => violation.code)).toEqual(checkPlan(edited, rebuild.variant, preview.rows).violations.map(violation => violation.code))
    const card = cardFor(rebuild, 'SWA-REBUILD')
    if (card.holds) expect(preview.violations).toEqual([])
    else if ('rule' in card) expect(preview.violations.some(violation => violation.about.includes(card.rule))).toBe(true)
  }, 60_000)

  test('Swap: a job its re-timing leaves without a slot is a finding with lane K\'s crew and time, matching the card', () => {
    const swap = optionOf('swap')
    for (const job of ['CCWA-SEAL', 'CCWHXA-CLEAN']) {
      const preview = previewOption(atItsHigh(job), swap)
      const card = cardFor(swap, job)
      if (!card.holds && 'unplaced' in card) {
        expect(preview.unplaced).toEqual(card.unplaced)
        expect(preview.rows.some(row => row.job === card.unplaced.job)).toBe(false)
        expect(preview.violations.some(violation => violation.code === 'not-scheduled')).toBe(false)
      } else {
        expect(preview.unplaced).toBeUndefined()
        if (!card.holds && 'rule' in card) expect(preview.violations.some(violation => violation.about.includes(card.rule))).toBe(true)
      }
    }
    // Checked run: the cleaning at its high estimate leaves the eddy-current test without its team's time.
    expect(previewOption(atItsHigh('CCWHXA-CLEAN'), swap).unplaced?.job).toBe('CCWHXA-ECT')
  }, 60_000)
})

describe('L2: after an edit each row keeps its own bought time need by need, not just whether it bought any', () => {
  test('a lift on overtime with the crane in its own hours, beside a lift in the crane\'s extra Friday, keeps each (checked run: crane booked Wed and Thu only, seed 1)', async () => {
    const { compile } = await import('./compile.ts')
    const { prepare } = await import('./decode.ts')
    const { undate } = await import('./date.ts')
    // One crane day less, so the rebuild buys the crane's extra Friday and lifts can buy time on either need.
    const short: PlanInputs = { ...flagship, calendars: flagship.calendars.map(entry => (entry.key === 'crane' ? { ...entry, periods: entry.periods.slice(1) } : entry)) }
    const rebuild = (await generate(deps, { inputs: short, revision: 1, previous: null, input: {}, by, signal: new AbortController().signal, seed: 1, evals: 600 })).optionSet
      .options.find(option => option.variant.methods.some(pick => pick.option === 'rebuild'))!
    const boughtOn = (job: PlanInputs['jobs'][number], row: (typeof rebuild.rows)[number]) =>
      job.needs.map(need => row.uses.some(use => need.anyOf.includes(use.resource) && use.purchase !== undefined))
    const mixed = rebuild.rows.flatMap(row => {
      const job = short.jobs.find(entry => entry.key === row.job)!
      const perNeed = boughtOn(job, row)
      return perNeed.includes(true) && perNeed.includes(false) && job.duration.range !== undefined ? [{ job, perNeed }] : []
    })
    // The run has both kinds: bought time on the crew only, and on the crane only.
    expect(mixed.map(entry => entry.perNeed.indexOf(true)).sort()).toEqual([0, 1])
    for (const { job, perNeed } of mixed) {
      const edited: PlanInputs = { ...short, jobs: short.jobs.map(entry => (entry.key === job.key ? { ...entry, duration: { ...entry.duration, value: entry.duration.range!.high } } : entry)) }
      const compiled = compile(edited, { methods: rebuild.variant.methods, buy: rebuild.variant.purchases })
      if (!compiled.ok) throw new Error('compiles')
      const found = undate(prepare(compiled.problem), compiled.index, rebuild.rows, true)
      if (!found.ok) throw new Error('reads back')
      const a = compiled.index.jobs.indexOf(job.key)
      expect([job.key, compiled.index.modes[a]![found.schedule.mode[a]!]!.needs.map(need => need.purchased)]).toEqual([job.key, perNeed])
    }
  }, 120_000)
})
