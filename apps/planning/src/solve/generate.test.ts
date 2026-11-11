import { describe, expect, test } from 'bun:test'
import { formulationOf, methodCombinations } from './compile.ts'
import { CERTIFIED_SIZE, generate } from './generate.ts'
import { certifiedSizeWords, jobsPerSolve, measuredSizeWords, withinCertifiedSize } from '../plan/summary.ts'
import { twinPlan, twinV3Options } from '../../tests/harness/twin-plan.ts'
import { supplyRun } from './fixtures/supply-run.ts'
import twinJson from './fixtures/twin-v3.json'
import { showStatus } from './status.ts'
import { searchEngine } from './search.ts'
import { laneKCheck, laneKVerify, laneKVerifyBound } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

// Generate against lane K's REAL checker and certificate re-verification (adversary fixes 5-7).
const by = { kind: 'service' as const, name: 'test' }
const run = (inputs: ReturnType<typeof trainAInputs>, input: Parameters<typeof generate>[1]['input'], verify = laneKVerify) =>
  generate({ engine: searchEngine(), check: laneKCheck, verify, verifyBound: laneKVerifyBound }, { inputs, revision: 1, previous: null, input, by, signal: new AbortController().signal, seed: 1 })
const daysOnly = [
  { label: 'V1 days only rebuild', methods: [{ choice: 'SWA-method', option: 'rebuild' }], buy: 'no-extra-crew-hours' as const },
  { label: 'V2 days only swap', methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'no-extra-crew-hours' as const },
]

describe('generate with the real checker', () => {
  test('a precondition not read from World blocks before search: invalid input with its cause', async () => {
    const at = performance.now()
    const result = await run(trainAInputs(), { seconds: 20 })
    // Every precondition of the plan (from the fixture) is unread: each is named as the cause.
    const expected = trainAInputs().jobs.flatMap(job => job.checks.map(check => ({ about: [job.key, check.equipment], code: 'precondition-unread' })))
    expect(expected.length).toBeGreaterThan(0)
    for (const option of result.optionSet.options) expect(option.status).toEqual({ word: 'invalid input', problems: expected })
    expect(performance.now() - at).toBeLessThan(2_000)   // no search ran
  })

  test('V1 and V2 are stored as proven only because lane K re-verifies them', async () => {
    const proven = await run(trainAInputs({ read: true }), { variants: daysOnly, seconds: 2 })
    expect(proven.optionSet.options.map(option => [option.label, option.status.word, option.status.word === 'proven infeasible' ? option.status.cause.kind : ''])).toEqual([
      ['V1 days only rebuild', 'proven infeasible', 'chain'], ['V2 days only swap', 'proven infeasible', 'temporal'],
    ])
    // "Days only" names what it assumes: the crane's Friday and the ECT rebooking, no crew hours.
    expect(proven.optionSet.options.map(option => option.variant.purchases.toSorted())).toEqual([['crane-fri', 'ect-friday'], ['crane-fri', 'ect-friday']])
    // Dropped: every purchase that adds hours to a crew without replacing booked time, read from the fixture.
    const fixture = trainAInputs()
    const crewHours = fixture.purchases.filter(purchase => fixture.resources.find(resource => resource.key === purchase.resource)?.kind === 'crew' && purchase.replaces.length === 0).map(purchase => purchase.key)
    expect(crewHours.length).toBeGreaterThan(0)
    expect(proven.dropped.map(entry => [entry.purchase, entry.code]).toSorted()).toEqual(crewHours.map(key => [key, 'adds_crew_hours']).toSorted())
    // A verifier that does not confirm: never stored as proof; the search then finds no plan in the window.
    const refused = await run(trainAInputs({ read: true }), { variants: daysOnly, seconds: 2 }, () => ({ proves: false }))
    expect(refused.optionSet.options.map(option => option.status.word)).toEqual(['unresolved', 'unresolved'])
  }, 30_000)

  test('a feasible option lists only the purchases its rows use; one train in series is not redundancy', async () => {
    const inputs = trainAInputs({ read: true })
    const result = await run(inputs, { variants: [{ label: 'swap', methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'allowed' }], seconds: 3 })
    const option = result.optionSet.options[0]!
    expect(option.status.word).toBe('validated feasible')
    // The cooling chain's five items are out together, but they are one train in series, not backups.
    expect(showStatus(option, { inputs, revision: 1, formulation: formulationOf(inputs.settings.grid) }, laneKCheck, laneKVerify).warnings).toEqual([])
    const used = new Set(option.rows.flatMap(row => row.uses.flatMap(use => (use.purchase === undefined ? [] : [use.purchase]))))
    expect(option.variant.purchases.toSorted()).toEqual([...used].toSorted())
  }, 30_000)

  test('every "proven optimal" carries its bound certificate and stands only when lane K re-derives the bound', async () => {
    const proven = (result: Awaited<ReturnType<typeof generate>>) => result.optionSet.options.flatMap(option => (option.status.word === 'validated feasible' ? option.status.goals : []))
    const supply = await generate({ engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }, { inputs: supplyRun, revision: 1, previous: null, input: {}, by, signal: new AbortController().signal, evals: 200 })
    const claims = proven(supply).filter(goal => goal.word === 'proven optimal')
    expect(claims.length).toBeGreaterThan(0)
    for (const goal of claims) {
      expect(goal.bound.certificate).toEqual({ kind: 'zero' })
      expect(laneKVerifyBound(supplyRun, supply.optionSet.options[0]!.variant, goal.goal, goal.bound).proves).toBe(true)
    }
    // A bound lane K does not re-derive: that goal and every later one read "best found", the unproven bound dropped.
    const refused = await generate({ engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: () => ({ proves: false }) }, { inputs: supplyRun, revision: 1, previous: null, input: {}, by, signal: new AbortController().signal, evals: 200 })
    for (const goal of proven(refused)) expect(goal).toEqual({ word: 'best found under budget', goal: goal.goal, value: goal.value, unit: goal.unit })
  })

  test('the certified size: pending the owner, 33 jobs per solve as measured; the flagship and Supply run run, twin v3 is refused', async () => {
    expect(certifiedSizeWords(CERTIFIED_SIZE)).toBe('Certified plan size: pending the owner\'s decision')
    expect(measuredSizeWords(CERTIFIED_SIZE)).toBe('Measured: up to 33 jobs')
    // The evidence is detail, in planner words: no review names.
    expect(CERTIFIED_SIZE.evidence).toBe('Measured 11 Nov on single-train work weeks: 9 of 9 runs within 5 % of the proven optimum at 33 jobs; 7 of 9 at 60; 4 of 9 at 100; 0 of 9 at 130.')
    expect(CERTIFIED_SIZE.evidence).not.toMatch(/\b(or|maint|twin)\b/i)
    // Jobs per solve, after method selection: the flagship's 34 job records (both SW A methods) are 33 per solve.
    const flagship = trainAInputs({ read: true })
    expect(flagship.jobs.length).toBe(34)
    expect(jobsPerSolve(flagship)).toBe(33)
    for (const combo of methodCombinations(flagship)) expect(flagship.jobs.filter(job => job.method === undefined || combo.some(pick => pick.choice === job.method!.choice && pick.option === job.method!.option)).length).toBe(33)
    expect(withinCertifiedSize(flagship, CERTIFIED_SIZE)).toBe(true)
    expect(withinCertifiedSize(supplyRun, CERTIFIED_SIZE)).toBe(true)
    const twin = twinPlan(twinJson, twinV3Options(twinJson)).inputs
    expect(jobsPerSolve(twin)).toBe(330)
    const refusal = await generate({ engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }, { inputs: twin, revision: 1, previous: null, input: {}, by, signal: new AbortController().signal }).catch((error: unknown) => error as Error)
    expect(refusal).toMatchObject({ code: 'above_certified_size' })
    expect((refusal as Error).message).toBe('This plan has 330 jobs. Planning is certified for plans of up to 33 jobs (one system window); larger plans wait for the owner\'s decision.')
    const supply = await generate({ engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }, { inputs: supplyRun, revision: 1, previous: null, input: {}, by, signal: new AbortController().signal, evals: 200 })
    expect(supply.optionSet.options[0]!.status.word).toBe('validated feasible')
  })
})
