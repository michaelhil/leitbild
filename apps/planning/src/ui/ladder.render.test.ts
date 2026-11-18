// "What overtime buys" on the screen (design §4.1, §8 C7 words and Goals 2; T9): each rung named by what it
// buys, each row's word exactly as the read buys contract gives it, the hours and money between two rungs,
// the person-hours and nights a rung uses, "proven: no gain" followed by the higher rung's "what sets the
// finish", the pointer to a finer trade, and a part of Planning not built yet said as "not available yet".
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { sectionDataSchemas } from '../api/contract.ts'
import { createPlanningClient, isNotBuilt, refusalText } from './api.ts'
import { hourMs, identifiers, modelOf, optionOf, runBasis, status, trainACaseInputs, trainAInputs, trainAPlanned, trainARows } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml, routineBreaches } from './fixtures/svelte-ssr.ts'
import { createTimeFormat, hoursText, moneyText } from './format.ts'
import { ladderView, rungRequest, type BuysPage } from './ladder.ts'
import { createNames, type OptionView, type PlanModel } from './model.ts'
import { crewHourPurchases } from './request.ts'
import type { Context } from './status-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: Ladder } = await import('./Ladder.svelte') as { default: Any }
const { default: PlanScreen } = await import('./PlanScreen.svelte') as { default: Any }

const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const none = () => {}
const offline = createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => { throw new Error('No Host in a render test') })
const page = (items: unknown[]): BuysPage => sectionDataSchemas.buys.parse({ items })

/** The plan's buy lists, rung by rung, from its own purchases: rung 0 without crew time, then per person-hour, then all. */
const buyLists = (inputs: PlanModel['inputs']) => {
  const crewTime = crewHourPurchases(inputs)
  const days = inputs.purchases.filter(purchase => purchase.allowed && !crewTime.includes(purchase)).map(purchase => purchase.key)
  const perHour = crewTime.filter(purchase => purchase.price.perPersonHour !== undefined).map(purchase => purchase.key)
  const rest = crewTime.filter(purchase => purchase.price.perPersonHour === undefined).map(purchase => purchase.key)
  return [days, [...days, ...perHour], [...days, ...perHour, ...rest]] as const
}

/**
 * The flagship's swap ladder as `or` measured it on the frozen case (R/or/report.md, "Frozen case (v0.2)"):
 * days only proven infeasible; overtime 56.5 h at NOK 398,800; overtime and nights 54 h at NOK 464,250, with
 * one contractor night. These are or's checked figures, used as presenter input; the screen computes nothing.
 * or's report gives no person-hours of overtime, so no overtime figure is made up here: the person-hours are
 * tested on their own below, from a hand calculation.
 */
const or = { overtime: { span: 56.5, cost: 398_800 }, nights: { span: 54, cost: 464_250, nights: 1 } }
/** The swap ladder: its rungs and rows name the swap method, as the buys section pages them. */
const swapPicks = [{ choice: 'SWA-method', option: 'swap' }]
const swapLadder = (): { model: PlanModel; pages: BuysPage[] } => {
  const inputs = trainACaseInputs()
  const grid = inputs.settings.grid
  const guideline = inputs.goals[0]!.threshold!.value
  const feasible = (key: string, span: number, cost: number): OptionView => optionOf(key, key, status({
    word: 'validated feasible', run: runBasis(grid),
    goals: [{ word: 'best found under budget', goal: 0, value: Math.max(0, span - guideline), unit: 'h' }, { word: 'best found under budget', goal: 1, value: cost, unit: inputs.settings.currency }],
  }), { metrics: [{ id: 'goal:0:COOL-A', value: span, unit: 'h' }], variant: { methods: swapPicks, purchases: [] } })
  const refused = optionOf('rung-0', 'Days only', status({ word: 'proven infeasible', run: runBasis(grid), cause: { kind: 'temporal', steps: [{ job: 'SWA-TAG', via: 'span-limit' }, { job: 'SWA-RTS', via: 'link' }] } }), { variant: { methods: swapPicks, purchases: [] } })
  const options = [refused, feasible('rung-1', or.overtime.span, or.overtime.cost), feasible('rung-2', or.nights.span, or.nights.cost)]
  const model = modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: 'rung-2', items: options } })
  const [days, overtime, all] = buyLists(inputs)
  const pages = [page([
    { rung: { rung: 0, methods: swapPicks, buy: days, option: 'rung-0', bought: [] } },
    { rung: { rung: 1, methods: swapPicks, buy: overtime, option: 'rung-1', bought: [] } },
    { rung: { rung: 2, methods: swapPicks, buy: all, option: 'rung-2', bought: [{ id: 'bought:contractor-nights', value: or.nights.nights, unit: 'periods' }] } },
    { row: { methods: swapPicks, from: 0, to: 1, ends: { from: 'refused', to: 'found' }, word: 'makes it possible' } },
    { row: { methods: swapPicks, from: 1, to: 2, ends: { from: 'found', to: 'found' }, word: 'found', outage: or.nights.span - or.overtime.span, cost: or.nights.cost - or.overtime.cost } },
  ])]
  return { model, pages }
}

describe('what overtime buys', () => {
  test('each rung is named by what it buys, from the plan\'s purchases; ordered crew time is said on the lowest rung', () => {
    const { model, pages } = swapLadder()
    const context = contextOf(model)
    const view = ladderView(pages, model, context, null)
    const label = (key: string) => model.inputs.purchases.find(purchase => purchase.key === key)!.label
    expect(view.rungs.map(rung => rung.name)).toEqual(['Days only', `+ ${label('ot-mech')} and ${label('ot-elec')}`, `+ ${label('contractor-nights')}`])
    // A night crew already ordered is in every rung; the lowest rung says so.
    const inputs = { ...model.inputs, purchases: model.inputs.purchases.map(purchase => purchase.key === 'contractor-nights' ? { ...purchase, ordered: { at: '2026-11-12T08:00:00Z', by: { kind: 'human' as const } } } : purchase) }
    const ordered = modelOf(inputs)
    const [days] = buyLists(inputs)
    expect(ladderView([page([{ rung: { rung: 0, methods: [], buy: [...days, 'contractor-nights'], bought: [] } }])], ordered, contextOf(ordered), null).rungs[0]!.name).toBe(`Days only, with ${label('contractor-nights')} already ordered`)
    // Each rung is solved by one Generate with its own buy list, kept beside the options already there.
    // The top rung is a plain Generate kept beside the rest: the default options (lane S, U1).
    expect(rungRequest(view.rungs[2]!, contextOf(model))).toEqual({ keep: true })
  })

  test('a row says the Module\'s word exactly, then the hours and money between the two rungs', () => {
    const { model, pages } = swapLadder()
    const view = ladderView(pages, model, contextOf(model), null)
    expect(view.rows.map(row => row.word)).toEqual(['makes it possible', 'found'])
    // 54 h against 56.5 h is 2.5 h shorter; NOK 464,250 against NOK 398,800 is NOK 65,450 more.
    expect(view.rows[1]!.differences).toBe(`longest outage ${hoursText(or.overtime.span - or.nights.span)} shorter · extra cost ${moneyText(or.nights.cost - or.overtime.cost, 'NOK')} more`)
    expect(view.rows[1]!.differences).toBe('longest outage 2.5 h shorter · extra cost NOK 65,450 more')
    expect(view.rows[0]!.differences).toBeNull()
    const text = readableText(renderHtml(Ladder, { view, state: 'ready', onSolve: none, onFiner: none, onSelect: none, onClose: none }))
    expect(text).toMatch(/makes it possible\s+2 Rung 2: \+ /)
    // The ladder names the method it is for.
    expect(text).toContain(`For ${model.inputs.methods[0]!.options.find(option => option.key === 'swap')!.label}`)
    expect(text).toContain('found: longest outage 2.5 h shorter · extra cost NOK 65,450 more')
    expect(text).not.toMatch(/buys nothing/i)
    // The rung's own outcome: its status word, its longest outage against the plan's limit, and its extra cost.
    expect(text).toContain(`Longest outage ${hoursText(or.nights.span)} of 72 h · Extra cost ${moneyText(or.nights.cost, 'NOK')}`)
    expect(text).toContain('Not possible: ')
    expect(text).toContain('For a finer trade, ask for “at most … h out”.')
    expect(routineBreaches(text, identifiers(model.inputs), [])).toEqual([])
  })

  test('a rung says the person-hours and nights it uses; one that may buy crew time and uses none says so', () => {
    const { model } = swapLadder()
    const context = contextOf(model)
    const label = (key: string) => model.inputs.purchases.find(purchase => purchase.key === key)!.label
    // One evening of overtime on one station crew: 15:00 to 19:00 is 4 h, for a crew of 3, so 12 person-hours.
    const overtime = model.inputs.calendars.find(calendar => calendar.key === 'overtime')!.weekly[0]!
    const evening = (Date.parse(`2026-11-16T${overtime.to}:00Z`) - Date.parse(`2026-11-16T${overtime.from}:00Z`)) / hourMs
    const crew = model.inputs.resources.find(resource => resource.key === 'mech-station')!.crewSize!
    expect(evening * crew).toBe(12)
    const [, , all] = buyLists(model.inputs)
    const uses = (bought: unknown[]) => ladderView([page([{ rung: { rung: 0, methods: [], buy: [...buyLists(model.inputs)[0]], option: 'rung-1', bought: [] } }, { rung: { rung: 1, methods: [], buy: [...all], option: 'rung-2', bought } }])], model, context, null).rungs[1]!.uses
    expect(uses([{ id: 'bought:ot-mech', value: evening * crew, unit: 'person-h' }, { id: 'bought:contractor-nights', value: 1, unit: 'periods' }]))
      .toEqual([`${label('ot-mech')}: 12 person-hours`, `${label('contractor-nights')}: 1 night`])
    // The nights are overnight periods in the plan zone (19:00 to 07:00 local), so they are said as nights.
    expect(uses([{ id: 'bought:contractor-nights', value: 2, unit: 'periods' }])).toEqual([`${label('contractor-nights')}: 2 nights`])
    expect(uses([])).toEqual(['Uses none of the crew time it may buy.'])
  })

  test('"proven: no gain" is followed by the higher rung\'s "what sets the finish", and is never "buys nothing"', () => {
    // Both rungs carry the hand-placed Train A schedule (32.5 h, fixtures/plans.ts), proven on the guideline:
    // the higher rung buys night crews that the crane's daylight hours cannot use (the frozen case's T9 point).
    const planned = trainAPlanned()
    const proven = planned.options!.items[0]!
    const span = (Date.parse(trainARows(planned.inputs)[2]!.finish) - Date.parse(trainARows(planned.inputs)[0]!.start)) / hourMs
    const lower = { ...proven, key: 'r1', label: 'r1', metrics: [{ id: 'goal:0:COOL-A', value: span, unit: 'h' }] }
    const model: PlanModel = { ...planned, options: { ...planned.options!, recommended: 'r2', items: [lower, { ...lower, key: 'r2', label: 'r2' }] } }
    const [days, overtime, all] = buyLists(model.inputs)
    const crane = { kind: 'shift', about: [{ kind: 'resource', key: 'crane' }] }
    const pages = [page([
      { rung: { rung: 0, methods: [], buy: days, bought: [] } }, { rung: { rung: 1, methods: [], buy: overtime, option: 'r1', bought: [] } }, { rung: { rung: 2, methods: [], buy: all, option: 'r2', bought: [] } },
      { row: { methods: [], from: 0, to: 1, ends: { from: 'unsolved', to: 'proven' }, word: 'not solved' } },
      { row: { methods: [], from: 1, to: 2, ends: { from: 'proven', to: 'proven' }, word: 'proven: no gain', outage: 0, cost: 0, finish: crane } },
    ])]
    const context = contextOf(model)
    const view = ladderView(pages, model, context, null)
    const text = readableText(renderHtml(Ladder, { view, state: 'ready', onSolve: none, onFiner: none, onSelect: none, onClose: none }))
    const craneName = model.inputs.resources.find(resource => resource.key === 'crane')!.label
    expect(text).toMatch(new RegExp(`proven: no gain: the same longest outage · the same extra cost What sets the finish: ${craneName.replace(/[()]/g, '\\$&')} is not on shift`))
    expect(text).toContain('not solved')
    expect(text).not.toMatch(/buys nothing/i)
    // The rung still to work out says so, and one button works out the missing rung, lowest first.
    expect(view.toSolve.map(rung => rung.rung)).toEqual([0])
    expect(text).toContain('Not worked out yet on this plan.')
    expect(text).toContain('Work out the missing rung')
  })

  test('before the service builds it, the ladder says "not available yet", never a code or a fault', () => {
    const error = Object.assign(new Error('What overtime buys is not built in this version of Planning'), { status: 501, code: 'not_built', details: null })
    expect(isNotBuilt(error)).toBe(true)
    expect(refusalText(error)).toBe('This is not available yet in this version of Planning.')
    const text = readableText(renderHtml(Ladder, { view: null, state: 'not-built', onSolve: none, onFiner: none, onSelect: none, onClose: none }))
    expect(text).toContain('What overtime buys is not available yet in this version of Planning.')
    expect(text).not.toMatch(/501|not_built|not built/)
  })

  test('the question sits under the options table, offered only where the plan buys crew time', () => {
    const { model } = swapLadder()
    const text = readableText(renderHtml(PlanScreen, { client: offline, planId: model.id, initial: model, onChanged: none, onOpenWorkspace: none, onOpenLibrary: none }))
    for (const question of ['What overtime buys', 'Ask a what-if', 'Why recommended?', 'Compare with the earlier options']) expect(text).toContain(question)
    const noCrewTime = modelOf({ ...trainAInputs(), purchases: [] }, { options: model.options })
    expect(readableText(renderHtml(PlanScreen, { client: offline, planId: model.id, initial: noCrewTime, onChanged: none, onOpenWorkspace: none, onOpenLibrary: none }))).not.toContain('What overtime buys')
  })
})
