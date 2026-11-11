import { describe, expect, test } from 'bun:test'
import { formulationOf } from './compile.ts'
import { CERTIFIED_SIZE, certifiedSizeText, generate } from './generate.ts'
import { showStatus } from './status.ts'
import { searchEngine } from './search.ts'
import { laneKCheck, laneKVerify } from './fixtures/lane-k.ts'
import { trainAInputs } from './fixtures/train-a-case.ts'

// Generate against lane K's REAL checker and certificate re-verification (adversary fixes 5-7).
const by = { kind: 'service' as const, name: 'test' }
const run = (inputs: ReturnType<typeof trainAInputs>, input: Parameters<typeof generate>[1]['input'], verify = laneKVerify) =>
  generate({ engine: searchEngine(), check: laneKCheck, verify }, { inputs, revision: 1, previous: null, input, by, signal: new AbortController().signal, seed: 1 })
const daysOnly = [
  { label: 'V1 days only rebuild', methods: [{ choice: 'SWA-method', option: 'rebuild' }], buy: 'no-extra-crew-hours' as const },
  { label: 'V2 days only swap', methods: [{ choice: 'SWA-method', option: 'swap' }], buy: 'no-extra-crew-hours' as const },
]

describe('generate with the real checker', () => {
  test('a precondition not read from World blocks before search: invalid input with its cause', async () => {
    const at = performance.now()
    const result = await run(trainAInputs(), { seconds: 20 })
    // SW A's tag-out needs "World shows SW B running", which this plan has not read.
    for (const option of result.optionSet.options) expect(option.status).toEqual({ word: 'invalid input', problems: [{ about: ['SWA-TAG', 'SWB'], code: 'precondition-unread' }] })
    expect(performance.now() - at).toBeLessThan(2_000)   // no search ran
  })

  test('V1 and V2 are stored as proven only because lane K re-verifies them', async () => {
    const proven = await run(trainAInputs({ read: true }), { variants: daysOnly, seconds: 2 })
    expect(proven.optionSet.options.map(option => [option.label, option.status.word, option.status.word === 'proven infeasible' ? option.status.cause.kind : ''])).toEqual([
      ['V1 days only rebuild', 'proven infeasible', 'chain'], ['V2 days only swap', 'proven infeasible', 'temporal'],
    ])
    // "Days only" names what it assumes: the crane's Friday and the ECT rebooking, no crew hours.
    expect(proven.optionSet.options.map(option => option.variant.purchases.toSorted())).toEqual([['crane-fri', 'ect-friday'], ['crane-fri', 'ect-friday']])
    expect(proven.dropped.map(entry => [entry.purchase, entry.code]).toSorted()).toEqual([['contractor-nights', 'adds_crew_hours'], ['ot-elec-station', 'adds_crew_hours'], ['ot-mech', 'adds_crew_hours']])
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

  test('the certified size is pending the owner and never said as "certified up to"', async () => {
    expect(certifiedSizeText()).toBe(`certified size: pending the owner's decision; measured family: ${CERTIFIED_SIZE.family}; plans above ${CERTIFIED_SIZE.maxJobs} jobs are refused until then`)
    const small = { ...CERTIFIED_SIZE, maxJobs: 10 }
    const refusal = await generate({ engine: searchEngine(), check: laneKCheck, verify: laneKVerify, certifiedSize: small }, { inputs: trainAInputs({ read: true }), revision: 1, previous: null, input: {}, by, signal: new AbortController().signal }).catch((error: unknown) => error as Error)
    expect(refusal).toMatchObject({ code: 'above_certified_size' })
    expect((refusal as Error).message).not.toMatch(/certified for|certified .* up to/)
  })
})
