// Lane U's fix round for increment 2 (impl/inc23/batch2-fix-round.md, "Lane U" and "Added from
// goals/inc2-screen-review.md"): U1/G1 per-method rung requests, U3 one ladder per method, the unplaced card
// from the checker's own judgement, G3 each row's cause, G4 the T11 words, G5 the longest outage in the
// comparison, G6 "finish this group first", G7 the smaller words and the ladder legend.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { recommendedFactsSchema, sectionDataSchemas, versusFactsSchema } from '../api/contract.ts'
import { robustSchema } from '../plan/schema.ts'
import { attentionCards, pessimisticCard } from './attention.ts'
import { identifiers, modelOf, optionOf, runBasis, status, trainACaseInputs, trainAPlanned } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml, routineBreaches } from './fixtures/svelte-ssr.ts'
import { createTimeFormat, moneyText } from './format.ts'
import { goalRows, draftOf } from './goals-editor.ts'
import { ladderLegend, ladderView, rungRequest, type BuysPage } from './ladder.ts'
import { createNames, type OptionView, type PlanModel } from './model.ts'
import type { Context } from './status-text.ts'
import { whatIfCard, whatIfChoices, whatIfVariant } from './what-if.ts'
import { compareView, policyLines, whyView } from './why-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: AttentionColumn } = await import('./AttentionColumn.svelte') as { default: Any }
const { default: Ladder } = await import('./Ladder.svelte') as { default: Any }
const { default: WhyRecommended } = await import('./WhyRecommended.svelte') as { default: Any }

const inputs = trainACaseInputs()
const context: Context = { inputs, names: createNames(inputs), format: createTimeFormat(inputs.settings.timeZone) }
const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const none = () => {}
const method = inputs.methods[0]!
const label = (key: string) => method.options.find(option => option.key === key)!.label
const purchase = (key: string) => inputs.purchases.find(item => item.key === key)!.label
const feasible = (goals: unknown[] = [{ word: 'best found under budget', goal: 0, value: 0, unit: 'h' }]) => status({ word: 'validated feasible', run: runBasis(inputs.settings.grid), goals })
const page = (items: unknown[]): BuysPage => sectionDataSchemas.buys.parse({ items })
const days = ['crane-fri', 'ect-friday'], overtime = [...days, 'ot-mech', 'ot-elec'], all = [...overtime, 'contractor-nights']

describe('U1, G1: the screen sends lane S\'s per-method rung requests', () => {
  test('a lower rung is one variant per method, labelled "<method>: <what it allows>"; the top rung is the default options', () => {
    const view = ladderView([page([{ rung: { rung: 0, methods: [], buy: days, bought: [] } }, { rung: { rung: 1, methods: [], buy: overtime, bought: [] } }, { rung: { rung: 2, methods: [], buy: all, bought: [] } }])], modelOf(inputs), context, null)
    expect(rungRequest(view.rungs[0]!, context)).toEqual({
      variants: method.options.map(option => ({ label: `${option.label}: days only`, methods: [{ choice: method.key, option: option.key }], buy: days })), keep: true,
    })
    expect(rungRequest(view.rungs[1]!, context).variants?.map(variant => variant.label)).toEqual(method.options.map(option => `${option.label}: with ${purchase('ot-mech')} and ${purchase('ot-elec')}`))
    // The top rung is a plain Generate kept beside the rest: the default options, with their own keys and labels.
    expect(rungRequest(view.rungs[2]!, context)).toEqual({ keep: true })
    expect(view.rungs.map(rung => rung.name).join(' ')).not.toMatch(/Rung \d of \d/)
  })
})

describe('U3: the ladder names its method, and the planner can switch', () => {
  /**
   * Two methods' ladders as the buys section pages them (lane P's methodLadders): each rung and row names its
   * method picks. The rows' words are test inputs in the contract's shape: the swap's days-only rung refused
   * (as on the frozen case, R/or/report.md), the rebuild's a "not solved" step, so the two ladders read differently.
   */
  const perMethod = (): { model: PlanModel; pages: BuysPage[] } => {
    const picks = (pick: string) => [{ choice: method.key, option: pick }]
    const option = (key: string, pick: string) => optionOf(key, key, feasible(), { variant: { methods: picks(pick), purchases: [] } })
    const options = [option('swap-0', 'swap'), option('swap-1', 'swap'), option('rebuild-0', 'rebuild'), option('rebuild-1', 'rebuild')]
    const pages = [page([
      { rung: { rung: 0, methods: picks('swap'), buy: days, option: 'swap-0', bought: [] } }, { rung: { rung: 1, methods: picks('swap'), buy: overtime, option: 'swap-1', bought: [] } },
      { rung: { rung: 0, methods: picks('rebuild'), buy: days, option: 'rebuild-0', bought: [] } }, { rung: { rung: 1, methods: picks('rebuild'), buy: overtime, option: 'rebuild-1', bought: [] } },
      { row: { methods: picks('swap'), from: 0, to: 1, ends: { from: 'refused', to: 'found' }, word: 'makes it possible' } },
      { row: { methods: picks('rebuild'), from: 0, to: 1, ends: { from: 'found', to: 'unsolved' }, word: 'not solved' } },
    ])]
    return { model: modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: 'swap-1', items: options } }), pages }
  }

  test('each ladder shows its own method\'s rows, never the other method\'s', () => {
    const { model, pages } = perMethod()
    const swapView = ladderView(pages, model, contextOf(model), null)
    expect(swapView.rows.map(row => row.word)).toEqual(['makes it possible'])
    const rebuildView = ladderView(pages, model, contextOf(model), swapView.methods[0]!.value)
    expect(rebuildView.rows.map(row => row.word)).toEqual(['not solved'])
    const text = readableText(renderHtml(Ladder, { view: rebuildView, state: 'ready', onSolve: none, onFiner: none, onSelect: none, onMethod: none, onClose: none }))
    expect(text).toMatch(/not solved\s+2 Rung 2/)
    expect(text).not.toContain('makes it possible 2')
    expect(text).not.toContain('not available per method')
  })

  test('each method with rungs is offered; the chosen one\'s rungs are shown, and the panel names it', () => {
    const { model, pages } = perMethod()
    const swapView = ladderView(pages, model, contextOf(model), null)
    // In plan order; until the planner switches, the recommended option's method is shown.
    expect(swapView.methods.map(entry => entry.label)).toEqual([label('rebuild'), label('swap')])
    expect(swapView.method?.label).toBe(label('swap'))
    expect(swapView.rungs.map(rung => rung.option)).toEqual(['swap-0', 'swap-1'])
    const rebuildView = ladderView(pages, model, contextOf(model), swapView.methods[0]!.value)
    expect(rebuildView.rungs.map(rung => rung.option)).toEqual(['rebuild-0', 'rebuild-1'])
    const text = readableText(renderHtml(Ladder, { view: rebuildView, state: 'ready', onSolve: none, onFiner: none, onSelect: none, onMethod: none, onClose: none }))
    expect(text).toContain(`For ${label('rebuild')}`)
    expect(text).toContain('Method')
  })
})

describe('the unplaced card, from the checker\'s own judgement', () => {
  test('"<job> could not be done: <crew> has no slot long enough left after <instant>, within <N> days after the window"', async () => {
    // The real stored record: lane S's Swap option on the flagship, re-timed and judged by lane K
    // (solve/retime.ts robustOf with lane K's judgement), as Generate stores it.
    const { generate } = await import('../solve/generate.ts')
    const { searchEngine } = await import('../solve/search.ts')
    const { laneKCheck, laneKJudgeRetimed, laneKVerify, laneKVerifyBound } = await import('../solve/fixtures/lane-k.ts')
    const { trainAInputs: flagshipOf } = await import('../solve/fixtures/train-a-case.ts')
    const { robustOf } = await import('../solve/retime.ts')
    const flagship = flagshipOf({ read: true })
    const solved = (await generate({ engine: searchEngine(), check: laneKCheck, verify: laneKVerify, verifyBound: laneKVerifyBound }, { inputs: flagship, revision: 1, previous: null, input: { variants: [{ label: 'Swap', methods: [{ choice: 'SWA-method', option: 'swap' }] }] }, by: { kind: 'service', name: 'test' }, signal: new AbortController().signal, seed: 1, evals: 600 })).optionSet.options[0]!
    const robust = robustSchema.parse(robustOf(flagship, solved, laneKJudgeRetimed))
    const entry = robust.single.find(item => item.job === 'CCWHXA-CLEAN')!
    if (entry.outcome.holds || !('unplaced' in entry.outcome)) throw new Error('lane K stores the unplaced eddy-current test')
    const { job, resource, after } = entry.outcome.unplaced
    const option: OptionView = { ...trainAPlanned().options!.items[0]!, robust }
    const flagshipContext: Context = { inputs: flagship, names: createNames(flagship), format: createTimeFormat(flagship.settings.timeZone) }
    const card = pessimisticCard(option, flagshipContext)!
    const window = flagship.settings.window!
    const windowDays = (Date.parse(window.end) - Date.parse(window.start)) / 86_400_000
    const words = `${flagshipContext.names.job(job)} could not be done: ${flagshipContext.names.resource(resource)} has no slot long enough left after ${flagshipContext.format.when(after)}, within ${windowDays} days after the window`
    expect([...card.steps, card.title].some(line => line.includes(words))).toBe(true)
    expect(card.steps.concat(card.title).join(' ')).not.toMatch(/ranged job/)
    const text = readableText(renderHtml(AttentionColumn, { cards: [card], onAction: none }))
    expect(text).toContain('job with an estimate range')
    expect(routineBreaches(text, identifiers(flagship), [])).toEqual([])
  }, 120_000)
})

describe('G3: every row whose two rungs have a plan says what sets the higher one\'s finish', () => {
  test('a "found" row carries its cause, and the row names its subject: the longest outage', () => {
    const model = modelOf(inputs)
    // A row the contract now takes (fix round G3): a found row with the higher rung's cause.
    const crane = { kind: 'shift' as const, about: [{ kind: 'resource' as const, key: 'crane' }] }
    const pages = [page([
      // or's frozen-case figures (R/or/report.md): 56.5 h at NOK 398,800 with overtime, 54 h at NOK 464,250 with a night.
      { rung: { rung: 0, methods: [], buy: days, bought: [] } }, { rung: { rung: 1, methods: [], buy: overtime, bought: [] } },
      { row: { methods: [], from: 0, to: 1, ends: { from: 'found', to: 'found' }, word: 'found', outage: 54 - 56.5, cost: 464_250 - 398_800, finish: crane } },
    ])]
    const view = ladderView(pages, model, context, null)
    expect(view.rows[0]!.finish).not.toBeNull()
    expect(view.rows[0]!.differences).toBe(`longest outage 2.5 h shorter · extra cost ${moneyText(65_450, 'NOK')} more`)
    const text = readableText(renderHtml(Ladder, { view, state: 'ready', onSolve: none, onFiner: none, onSelect: none, onClose: none }))
    expect(text).toContain(`What sets the finish: ${inputs.resources.find(resource => resource.key === 'crane')!.label} is not on shift`)
  })
})

describe('G4: the T11 words', () => {
  test('the policy uses the full goal words and explains the step', () => {
    expect(policyLines(context)).toEqual([
      'Every hard rule must hold.',
      `1. Keep the time over the 54 h guideline for ${inputs.groups.find(group => group.key === 'COOL-A')!.label} as small as possible.`,
      `2. Keep the extra cost as small as possible; costs within ${moneyText(inputs.goals[1]!.tolerance.value, 'NOK')} of each other count as equal.`,
      '3. Keep the equipment-hours out of service as small as possible.',
    ])
    // The goals editor says the same full words.
    expect(goalRows(draftOf(inputs.goals), inputs.goals, context).map(row => row.full)[1]).toBe(policyLines(context)[2]!.replace(/^2\. /, '').replace(/\.$/, ''))
  })

  test('"Decided on" is a sentence naming both options; an outage floor is said only when one is proven for the outage itself', () => {
    const model = modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: 'swap', items: [optionOf('swap', label('swap'), feasible()), optionOf('rebuild', label('rebuild'), feasible())] } })
    const facts = recommendedFactsSchema.parse({
      option: 'swap', against: 'rebuild', deciding: 0, caveats: [],
      goals: [{ goal: 0, value: 0, against: 11, unit: 'h' }, { goal: 1, value: 474_750, against: 255_800, unit: 'NOK' }],
      // No outage fact: lane K has stored no proven floor of the longest outage.
    })
    const view = whyView(facts, model, contextOf(model), false)
    expect(view.decided).toBe(`Decided on time over the 54 h guideline: 0 h here against 11 h for ${label('rebuild')}.`)
    expect(view.trade).toBe('The trade: +NOK 218,950 extra cost for −11 h over the 54 h guideline.')
    // With none stored, no outage line is said (goals review G4); with one, the floor in hours.
    expect(view.outage).toBeNull()
    // Lane S's measured 49 h on the swap (coordinator decisions, "Lane U batch 2"), standing in for a stored floor.
    expect(whyView({ ...facts, outage: { goal: 0, group: 'COOL-A', hours: 49 } }, model, contextOf(model), false).outage).toBe(`Longest outage of ${inputs.groups.find(group => group.key === 'COOL-A')!.label}: no plan can make it shorter than 49 h (proven).`)
    const text = readableText(renderHtml(WhyRecommended, { title: 'Why', policy: policyLines(contextOf(model)), answer: { state: 'answered', facts: view }, onClose: none }))
    expect(text).toContain('costs within NOK 25,000 of each other count as equal')
    expect(text).not.toContain('no plan does better than its bound')
  })
})

describe('G5: the comparison measures the longest outage of each group with a span rule', () => {
  test('each limited group\'s longest outage is shown, now and before, from the Module\'s outages facts', () => {
    // or's frozen-case figures (R/or/report.md): 54 h with a night crew, 56.5 h without; a test input in the contract's shape.
    const option = optionOf('opt-1', 'Option 1', feasible())
    const facts = versusFactsSchema.parse({ option: 'opt-1', previous: 'opt-1', from: 2, to: 3, complete: true, changes: [], goals: [{ goal: 0, now: 2.5, was: 0, unit: 'h' }], outages: [{ group: 'COOL-A', now: 56.5, was: 54 }], methods: [], buys: { added: [], dropped: [] }, moved: [], movedMore: 0, added: [], removed: [] })
    const view = compareView(facts, option, option, context)
    expect(view.outages).toEqual([{ name: `Longest outage, ${inputs.groups.find(group => group.key === 'COOL-A')!.label}`, now: '56.5 h', was: '54 h', change: '+2.5 h' }])
    expect(view.same).toBe(false)
  })
})

describe('G6: "finish this group first" says what it does', () => {
  test('the shortest outage for the group, never "back as soon as possible"', () => {
    const built = whatIfVariant({ kind: 'first', group: 'AFW-A' }, context)
    if (!built.ok) throw new Error(built.problems.join(' '))
    const afw = inputs.groups.find(group => group.key === 'AFW-A')!.label
    expect(built.label).toBe(`${afw} first, with its shortest outage`)
    expect(whatIfChoices(context).kinds.find(kind => kind.value === 'first')!.label).toBe('Finish this group first, with its shortest outage')
    const option = optionOf('w', built.label, status({ word: 'validated feasible', run: runBasis(inputs.settings.grid), lead: { word: 'best found under budget', group: 'AFW-A', value: 7.5, unit: 'h' }, goals: [{ word: 'best found under budget', goal: 0, value: 0, unit: 'h' }] }), { variant: { methods: [], purchases: [], lead: { group: 'AFW-A' } } })
    const card = whatIfCard(option, modelOf(inputs), context)
    expect(card.question).toBe(`Asked: the shortest outage for ${afw} first, then the plan's goals in order.`)
    expect(card.status.goals[0]!.name).toBe(`Shortest outage for ${afw} (solved first)`)
    expect(JSON.stringify(card)).not.toContain('as soon as possible')
  })
})

describe('G7: the ladder legend', () => {
  test('one line says what each ladder word claims', () => {
    expect(ladderLegend).toContain('found: a better plan was found, not proven best')
    const view = ladderView([page([{ rung: { rung: 0, methods: [], buy: days, bought: [] } }])], modelOf(inputs), context, null)
    expect(readableText(renderHtml(Ladder, { view, state: 'ready', onSolve: none, onFiner: none, onSelect: none, onClose: none }))).toContain(ladderLegend)
  })
})
