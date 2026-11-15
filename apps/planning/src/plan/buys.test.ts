// "What overtime buys" (design §4.1, §8 row C7 words): the rungs from plan data, and the rows from stored
// options only, each word standing on the two ends lane K's rungStanding gives (coordinator, lane K batch 2).
// The last part runs lane K's own judge, buysHonesty, on increment 1's real Train A options.
import { describe, expect, test } from 'bun:test'
import { buysRowSchema, sectionDataSchemas } from '../api/contract.ts'
import { planWith, rebuild, refusedWith, swap, trainAInputs, variantOf } from '../api/fixtures/choose.ts'
import { formulationOf } from '../solve/compile.ts'
import { buysHonesty, rungStanding } from '../../tests/harness/buys-honesty.ts'
import { buysItems, ladderOf, rungsOf, type FinishCause, type Standing } from './buys.ts'
import type { PlanInputs } from './schema.ts'

const rungs = rungsOf(trainAInputs)
const cause: FinishCause = { kind: 'shift', about: [{ kind: 'resource', key: 'crane' }] }
const solvedAt = (end: 'proven' | 'found', outage: number, cost: number): Standing => ({ end, outage, cost, bought: [] })
const ladder = (standings: ReadonlyArray<Standing | undefined>, finish: ReadonlyMap<string, FinishCause> = new Map()) =>
  buysItems(ladderOf(rungs.map((rung, index) => ({ ...rung, ...(standings[index] === undefined ? {} : { option: { key: `r${index}`, standing: standings[index]! } }) }))), finish)
const rows = (items: ReturnType<typeof ladder>) => items.flatMap(item => 'row' in item ? [item.row] : [])
const refusedEnd: Standing = { end: 'refused', bought: [] }
const unsolvedEnd: Standing = { end: 'unsolved', bought: [] }

describe('the rungs come from plan data: crew time by price form, everything else on every rung', () => {
  test('Train A: rebookings and tool days on every rung; overtime per person-hour on rung 1; the contractor nights on rung 2', () => {
    // Crew time is what "days only" removes: a planner-allowed purchase on a crew that replaces nothing.
    const crew = new Set(trainAInputs.resources.filter(resource => resource.kind === 'crew').map(resource => resource.key))
    const time = trainAInputs.purchases.filter(purchase => purchase.allowed && crew.has(purchase.resource) && purchase.replaces.length === 0)
    const others = trainAInputs.purchases.filter(purchase => purchase.allowed && !time.includes(purchase)).map(purchase => purchase.key)
    const perHour = time.filter(purchase => purchase.price.perPersonHour !== undefined).map(purchase => purchase.key)
    expect([others, perHour, time.map(purchase => purchase.key)]).toEqual([['crane-fri', 'ect-friday'], ['ot-mech', 'ot-elec'], ['ot-mech', 'ot-elec', 'contractor-nights']])
    const sorted = (keys: readonly string[]) => [...keys].sort()
    expect(rungs.map(rung => ({ rung: rung.rung, buy: sorted(rung.buy) }))).toEqual([
      { rung: 0, buy: sorted(others) }, { rung: 1, buy: sorted([...others, ...perHour]) }, { rung: 2, buy: sorted([...others, ...time.map(purchase => purchase.key)]) },
    ])
  })

  test('one price form gives rungs 0 and 1; an ordered crew-time purchase is on every rung; a lapsed one on none; no crew time, rung 0 alone', () => {
    const only = (keep: (key: string) => boolean): PlanInputs => ({ ...trainAInputs, purchases: trainAInputs.purchases.filter(purchase => keep(purchase.key)) })
    expect(rungsOf(only(key => key !== 'contractor-nights')).map(rung => rung.buy)).toEqual([['crane-fri', 'ect-friday'], ['ot-mech', 'ot-elec', 'crane-fri', 'ect-friday']])
    const changed = (patch: object): PlanInputs => ({ ...trainAInputs, purchases: trainAInputs.purchases.map(purchase => purchase.key !== 'ot-elec' ? purchase : { ...purchase, ...patch }) })
    expect(rungsOf(changed({ ordered: { at: trainAInputs.settings.dataDate!, by: { kind: 'human' } } })).map(rung => rung.buy.includes('ot-elec'))).toEqual([true, true, true])
    expect(rungsOf(changed({ orderBy: new Date(Date.parse(trainAInputs.settings.dataDate!) - 3_600_000).toISOString() })).map(rung => rung.buy.includes('ot-elec'))).toEqual([false, false, false])
    expect(rungsOf(only(key => key === 'crane-fri'))).toEqual([{ rung: 0, buy: ['crane-fri'] }])
  })
})

describe('a row\'s word stands on the two ends it is given', () => {
  test('a rung not solved on this revision lists its buy list and gives no row', () => {
    const items = ladder([solvedAt('found', 60, 1_000), undefined, undefined])
    expect(items).toEqual(rungs.map((rung, index) => ({ rung: { rung: rung.rung, buy: [...rung.buy], ...(index === 0 ? { option: 'r0' } : {}), bought: [] } })))
    expect(sectionDataSchemas.buys.parse({ items }).items).toHaveLength(3)
  })

  test('a refused lower rung: "makes it possible", without differences; an unsolved end: "not solved"; no word fits a solved rung below a refused one', () => {
    expect(rows(ladder([refusedEnd, solvedAt('found', 60, 1_000), unsolvedEnd]))).toEqual([
      { from: 0, to: 1, ends: { from: 'refused', to: 'found' }, word: 'makes it possible' },
      { from: 1, to: 2, ends: { from: 'found', to: 'unsolved' }, word: 'not solved' },
    ])
    expect(rows(ladder([refusedEnd, refusedEnd, refusedEnd]))).toEqual([])
    expect(rows(ladder([solvedAt('found', 60, 1_000), refusedEnd, undefined]))).toEqual([])
    expect(rows(ladder([refusedEnd, unsolvedEnd, undefined]))[0]!.word).toBe('not solved')
  })

  test('a shorter outage above reads "proven" only with both ends proven, else "found"; the differences are the higher rung minus the lower', () => {
    expect(rows(ladder([solvedAt('proven', 65, 200_000), solvedAt('proven', 59.5, 260_000), undefined]))).toEqual([{ from: 0, to: 1, ends: { from: 'proven', to: 'proven' }, word: 'proven', outage: 59.5 - 65, cost: 260_000 - 200_000 }])
    expect(rows(ladder([solvedAt('proven', 65, 200_000), solvedAt('found', 59.5, 260_000), undefined]))[0]!.word).toBe('found')
    expect(rows(ladder([solvedAt('found', 65, 200_000), solvedAt('found', 65, 260_000), undefined]))[0]!.word).toBe('not found better')
  })

  test('"proven: no gain" needs both ends proven, equal outages and the higher rung\'s cause of the finish; without that cause, no row', () => {
    const [lower, upper] = [solvedAt('proven', 65, 200_000), solvedAt('proven', 65, 200_000)]
    expect(rows(ladder([lower, upper, undefined], new Map([['r1', cause]])))).toEqual([{ from: 0, to: 1, ends: { from: 'proven', to: 'proven' }, word: 'proven: no gain', outage: 0, cost: 0, finish: cause }])
    expect(rows(ladder([lower, upper, undefined], new Map([['r0', cause]])))).toEqual([])
    expect(rows(ladder([lower, solvedAt('found', 65, 200_000), undefined]))).toEqual([{ from: 0, to: 1, ends: { from: 'proven', to: 'found' }, word: 'not found better', outage: 0, cost: 0 }])
  })

  test('a solved standing without its figures gives no row, never a guessed one; every row parses the contract; never "buys nothing"', () => {
    expect(rows(ladder([solvedAt('found', 60, 1_000), { end: 'found', outage: 55, bought: [] }, undefined]))).toEqual([])
    const items = ladder([refusedEnd, solvedAt('found', 60, 1_000), solvedAt('found', 60, 3_000)])
    for (const row of rows(items)) expect(buysRowSchema.safeParse(row).success).toBe(true)
    expect(JSON.stringify(items)).not.toContain('buys nothing')
  })
})

describe('on increment 1\'s real Train A options, lane K finds every word honest', () => {
  const formulation = formulationOf(trainAInputs.settings.grid)
  // Rung 0 days only, refused with the bounds' certificate; rungs 1 and 2 the stored Rebuild and Swap.
  const options = [refusedWith(variantOf(rebuild, { key: 'rung-0' }), rungs[0]!.buy), variantOf(rebuild, { key: 'rung-1' }), variantOf(swap, { key: 'rung-2' })]
  const plan = planWith(crypto.randomUUID(), options)
  const items = buysItems(ladderOf(rungs.map((rung, index) => ({ ...rung, option: { key: options[index]!.key, standing: rungStanding(plan, options[index], formulation) } }))), new Map())

  test('the ends, figures and bought time are lane K\'s, and buysHonesty has no finding', () => {
    expect(buysHonesty(plan, items, formulation)).toEqual([])
    expect(rows(items).map(row => [row.word, row.ends])).toEqual([['makes it possible', { from: 'refused', to: 'found' }], ['found', { from: 'found', to: 'found' }]])
    // Each rung's bought time is the checker's own count on its rows.
    const bought = items.flatMap(item => 'rung' in item ? [item.rung.bought] : [])
    expect(bought).toEqual(options.map(option => [...rungStanding(plan, option, formulation).bought]))
    expect(bought[1]!.length).toBeGreaterThan(0)
  })

  test('Swap is proven optimal at 0 h over the 54 h target, which does not prove its outage: its end is found', () => {
    expect(swap.status.word === 'validated feasible' && swap.status.goals[0]!.word).toBe('proven optimal')
    expect(rungStanding(plan, options[2], formulation).end).toBe('found')
  })

  test('an option of another revision is never a rung\'s: lane K calls a rung naming it a finding', () => {
    const older = planWith(crypto.randomUUID(), [options[0]!, variantOf(rebuild, { key: 'rung-1', revision: 2 }), options[2]!])
    const named = buysItems(ladderOf(rungs.map((rung, index) => ({ ...rung, option: { key: older.options!.options[index]!.key, standing: rungStanding(older, older.options!.options[index], formulation) } }))), new Map())
    expect(buysHonesty(older, named, formulation).map(finding => finding.kind)).toContain('rung')
  })
})
