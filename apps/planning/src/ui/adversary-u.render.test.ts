// The adversary fixes on the pessimistic card (impl/inc23/batch2-adversary-fixes.md, B2 and M1), on real
// records: lane S's Generate on the flagship with lane K's judgement, as the store keeps them.
import { describe, expect, test } from 'bun:test'
import { judgeRetiming } from '../check/retime.ts'
import { robustNotWorkedOutSchema, robustSchema, type PlanInputs } from '../plan/schema.ts'
import { generate, type GenerateDeps } from '../solve/generate.ts'
import { laneKCheck, laneKJudgeRetimed, laneKVerify, laneKVerifyBound } from '../solve/fixtures/lane-k.ts'
import { trainAInputs } from '../solve/fixtures/train-a-case.ts'
import { searchEngine } from '../solve/search.ts'
import { pessimisticCard } from './attention.ts'
import { identifiers } from './fixtures/plans.ts'
import { routineBreaches } from './fixtures/svelte-ssr.ts'
import { createTimeFormat } from './format.ts'
import { createNames, type OptionView } from './model.ts'
import type { Context } from './status-text.ts'

const deps: GenerateDeps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound, judgeRetimed: laneKJudgeRetimed }
const flagship = trainAInputs({ read: true })
const solve = async (inputs: PlanInputs, option: 'swap' | 'rebuild') => (await generate(deps, { inputs, revision: 1, previous: null, input: { variants: [{ label: option, methods: [{ choice: 'SWA-method', option }] }] }, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed: 1, evals: 600 })).optionSet.options[0]!
const contextOf = (inputs: PlanInputs): Context => ({ inputs, names: createNames(inputs), format: createTimeFormat(inputs.settings.timeZone) })
const viewOf = (stored: Awaited<ReturnType<typeof solve>>, label: string): OptionView => ({ key: stored.key, label, variant: stored.variant, status: stored.status, metrics: stored.metrics, inputsRevision: 1, fresh: true, warnings: [], ...(stored.robust === undefined ? {} : { robust: stored.robust }) })
const lines = (card: ReturnType<typeof pessimisticCard>) => card === null ? [] : [card.title, card.text, ...card.steps]
const title = (inputs: PlanInputs, key: string) => inputs.jobs.find(job => job.key === key)!.title

describe('B2: a locked job the re-timing pushes past its fixed start', () => {
  test('"<job> could not keep its fixed start, <time>: <job before> would finish N h too late for it" (the locked repro)', async () => {
    const locked: PlanInputs = { ...flagship, jobs: flagship.jobs.map(job => (job.key === 'CCWHXA-ECT' ? { ...job, lock: { start: '2026-11-18T08:00:00Z' } } : job)) }
    const stored = await solve(locked, 'swap')
    const robust = robustSchema.parse(stored.robust)
    const entry = [robust.allPessimistic, ...robust.single.map(item => item.outcome)].find(outcome => !outcome.holds && 'lock' in outcome)
    if (entry === undefined || entry.holds || !('lock' in entry)) throw new Error('lane K judges the locked repro as a lock outcome')
    const context = contextOf(locked)
    const words = `${title(locked, entry.lock.job)} could not keep its fixed start, ${context.format.when('2026-11-18T08:00:00Z')}: ${title(locked, entry.lock.after)} would finish ${entry.by.value} h too late for it`
    const card = pessimisticCard(viewOf(stored, 'Swap in refurbished spare'), context)
    expect(lines(card).some(line => line.includes(words))).toBe(true)
    expect(routineBreaches(lines(card).join(' '), identifiers(locked), [])).toEqual([])
  }, 120_000)

  test('a re-timing the checker cannot judge says so, with the checker\'s own reason as one sentence', async () => {
    const stored = await solve(flagship, 'swap')
    // A real refusal of lane K's: a re-timing that starts a job earlier than planned.
    const early = stored.rows.map((row, index) => index === 0 ? { ...row, start: new Date(Date.parse(row.start) - 3_600_000).toISOString() } : row)
    const judged = judgeRetiming(flagship, stored.variant, stored.rows, early, [])
    if (judged.ok) throw new Error('lane K refuses a re-timing that starts a job earlier')
    const reason = judged.problems.join(' ')
    const card = pessimisticCard({ ...viewOf(stored, 'Swap in refurbished spare'), robust: robustNotWorkedOutSchema.parse({ notWorkedOut: 'refused', reason }) }, contextOf(flagship))!
    expect(card.title).toBe('For Swap in refurbished spare, the pessimistic estimates were not worked out: the re-timing could not be judged.')
    expect(card.text).toBe(`${reason} Nothing is said about how this option holds at the high estimates.`)
    expect(lines(card).join(' ')).not.toMatch(/\.\.|: [^.]*: /)
  }, 120_000)
})

describe('M1: the extra use of what the option buys, and its cost, beside each verdict', () => {
  test('a verdict with extra use says it in the ladder\'s units, with one cost (checked run: Rebuild, evals 600)', async () => {
    const stored = await solve(flagship, 'rebuild')
    const robust = robustSchema.parse(stored.robust)
    const outcomes = [robust.allPessimistic, ...robust.single.map(item => item.outcome)]
    const extra = outcomes.find(outcome => outcome.extra !== undefined && outcome.extra.bought.some(item => item.value > 0))?.extra
    if (extra === undefined) throw new Error('lane K stores an extra use on the Rebuild')
    const card = pessimisticCard(viewOf(stored, 'Rebuild in place'), contextOf(flagship))
    const text = lines(card).join(' ')
    const purchase = flagship.purchases.find(item => item.key === extra.bought.find(entry => entry.value > 0)!.purchase)!
    expect(text).toContain(`using `)
    expect(text).toContain(purchase.label)
    expect(text).toMatch(/\(\+NOK [\d,]+\)/)
    // With no extra use, nothing extra is said.
    const none = robustSchema.parse({ allPessimistic: { holds: true, extra: { cost: 0, bought: [] } }, single: [] })
    expect(lines(pessimisticCard({ ...viewOf(stored, 'Rebuild in place'), robust: none }, contextOf(flagship))).join(' ')).not.toContain('using')
  }, 120_000)
})
