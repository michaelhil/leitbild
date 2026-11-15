import { describe, expect, test } from 'bun:test'
import { CHECKER_VERSION } from '../check/check.ts'
import { formulationOf, methodCombinations } from './compile.ts'
import { CERTIFIED_SIZE, generate } from './generate.ts'
import { planInputsSchema } from '../plan/schema.ts'
import { certifiedSizeWords, jobsPerSolve, measuredSizeWords, sizeBand, sizeCautionWords, withinCertifiedSize } from '../plan/summary.ts'
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

  test('a Generate stopped early (memory) never replaces a better stored option, and its run says why (walk 3, R3-3)', async () => {
    const inputs = trainAInputs({ read: true })
    const deps = { check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }
    const good = await generate({ engine: searchEngine(), ...deps }, { inputs, revision: 1, previous: null, input: {}, by, signal: new AbortController().signal, seed: 1, evals: 1_500 })
    // The same search cut short at 20 evaluations, reported as stopped by the memory guard.
    const early = { name: searchEngine().name, solve: async (...[problem, options]: Parameters<ReturnType<typeof searchEngine>['solve']>) =>
      ({ ...(await searchEngine().solve(problem, { ...options, budget: { ...options.budget, evals: 20 } })), stoppedBy: 'memory' as const }) }
    const again = await generate({ engine: early, ...deps }, { inputs, revision: 1, previous: good.optionSet, input: {}, by, signal: new AbortController().signal, seed: 2 })
    expect(again.optionSet.recommended).toBe(good.optionSet.recommended)
    const stored = good.optionSet.options.find(option => option.key === good.optionSet.recommended)!
    expect(again.optionSet.options.find(option => option.key === again.optionSet.recommended)).toEqual(stored)
    expect(again.kept).toContain(stored.key)
    // Whatever the early run did keep says it stopped early; its unproven goals read best found.
    for (const option of again.optionSet.options) {
      if (good.optionSet.options.some(old => JSON.stringify(old) === JSON.stringify(option)) || option.status.word !== 'validated feasible') continue
      expect(option.status.run.stoppedBy).toBe('memory')
    }
  }, 120_000)

  test('a change to lane K\'s rules (CHECKER_VERSION) makes every stored option out of date by formulation', async () => {
    const grid = supplyRun.settings.grid
    expect(formulationOf(grid)).toContain(CHECKER_VERSION)
    const deps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }
    const stored = (await generate(deps, { inputs: supplyRun, revision: 1, previous: null, input: {}, by, signal: new AbortController().signal, evals: 200 })).optionSet
    // The same options as checked under an older version of lane K's rules.
    const older = { ...stored, options: stored.options.map(option => ('run' in option.status ? { ...option, status: { ...option.status, run: { ...option.status.run, formulation: option.status.run.formulation.replace(CHECKER_VERSION, `${CHECKER_VERSION} (older)`) } } } : option)) }
    for (const option of older.options) {
      const shown = showStatus(option, { inputs: supplyRun, revision: 1, formulation: formulationOf(grid) }, laneKCheck, laneKVerify)
      expect(shown.stale?.codes).toContain('formulation_changed')
    }
    // Generate keeps none of them: never-demote applies only under the same rules.
    const again = await generate(deps, { inputs: supplyRun, revision: 1, previous: older, input: {}, by, signal: new AbortController().signal, evals: 200 })
    expect(again.kept).toEqual([])
    for (const option of again.optionSet.options) if ('run' in option.status) expect(option.status.run.formulation).toBe(formulationOf(grid))
  })

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

  test('size bands: 33 jobs in one solve carry no caution; 34 run with a caution on every option; 61 are refused', async () => {
    const flagship = trainAInputs({ read: true })
    // Found work: free-standing 1 h jobs for the electrical crew, added to the flagship's 33 jobs per solve.
    const found = (k: number) => ({
      key: `FOUND-${k}`, title: `Found work ${k}`, kind: 'work' as const, equipment: [], isolation: 'none' as const,
      duration: { value: 1, unit: 'h' as const, calendar: 'working' as const, origin: { by: 'planner' as const } }, durationWith: [],
      needs: [{ anyOf: ['elec-station'], amount: 1, handover: false }], continuous: false, checks: [], tags: [],
    })
    const withFound = (count: number) => planInputsSchema.parse({ ...flagship, jobs: [...flagship.jobs, ...Array.from({ length: count }, (_, k) => found(k + 1))] })
    const deps = { engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }
    const run = (inputs: ReturnType<typeof withFound>) => generate(deps, { inputs, revision: 1, previous: null, input: {}, by, signal: new AbortController().signal, seed: 1, evals: 600 })
    // 33: certified, no caution.
    expect([jobsPerSolve(flagship), sizeBand(flagship, CERTIFIED_SIZE)]).toEqual([33, 'certified'])
    const certified = await run(flagship)
    expect(certified.optionSet.options.map(option => [option.status.word, option.sizeCaution])).toEqual([['validated feasible', undefined], ['validated feasible', undefined]])
    // 34: Generate runs; every option carries the caution, and the plans still keep every hard rule.
    const plus = withFound(1)
    expect([jobsPerSolve(plus), sizeBand(plus, CERTIFIED_SIZE)]).toEqual([34, 'caution'])
    const cautioned = await run(plus)
    expect(cautioned.optionSet.options.map(option => [option.status.word, option.sizeCaution])).toEqual([['validated feasible', true], ['validated feasible', true]])
    for (const option of cautioned.optionSet.options) expect(laneKCheck({ inputs: plus, variant: option.variant, rows: option.rows }).violations).toEqual([])
    expect(sizeCautionWords(CERTIFIED_SIZE)).toBe('Above the certified size (33 jobs). This plan keeps every hard rule, but it may not be near the best: at 60 jobs, 7 of 9 test runs came within 5 % of the proven best.')
    // 60 is still taken; 61 is refused in planner words, before any solve.
    expect(sizeBand(withFound(27), CERTIFIED_SIZE)).toBe('caution')
    const over = withFound(28)
    expect([jobsPerSolve(over), sizeBand(over, CERTIFIED_SIZE)]).toEqual([61, 'refused'])
    const refusal = await run(over).catch((error: unknown) => error as Error)
    expect(refusal).toMatchObject({ code: 'above_certified_size' })
    expect((refusal as Error).message).toBe('This plan needs 61 jobs in one solve. Planning handles up to 60, and is certified for up to 33 (one system window). Split the work into system windows.')
  }, 120_000)

  test('the certified size: 33 jobs in one solve, as measured and decided; the flagship and Supply run run, twin v3 is refused', async () => {
    expect(CERTIFIED_SIZE.decided).toBe(true)
    expect(certifiedSizeWords(CERTIFIED_SIZE)).toBe('Certified for plans of up to 33 jobs in one solve; handles up to 60 with a caution.')
    expect([CERTIFIED_SIZE.maxJobs, CERTIFIED_SIZE.limitJobs]).toEqual([33, 60])
    expect(measuredSizeWords(CERTIFIED_SIZE)).toBeNull()
    // A size not yet decided still reads as pending, with its measured limit.
    expect(certifiedSizeWords({ ...CERTIFIED_SIZE, decided: false })).toBe('Certified plan size: pending the owner\'s decision')
    expect(measuredSizeWords({ ...CERTIFIED_SIZE, decided: false })).toBe('Measured: up to 33 jobs')
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
    expect((refusal as Error).message).toBe('This plan needs 330 jobs in one solve. Planning handles up to 60, and is certified for up to 33 (one system window). Split the work into system windows.')
    const supply = await generate({ engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }, { inputs: supplyRun, revision: 1, previous: null, input: {}, by, signal: new AbortController().signal, evals: 200 })
    expect(supply.optionSet.options[0]!.status.word).toBe('validated feasible')
  })
})
