// What-ifs on the screen (design §0.3, §8 Adv 1; T8, T12, T17): the builder asks "at most … h out", "finish
// this group first" and "cheapest that keeps every rule" as one Generate request kept beside the options; each
// answer is a card that says plainly it is a what-if and not the plan's ranking. A what-if is never a row of
// the options table, never recommended, never in the banner; its lead is read from status.lead and every goal
// is named by the plan's id, never by its place.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { createPlanningClient } from './api.ts'
import { attentionCards } from './attention.ts'
import { identifiers, modelOf, optionOf, runBasis, status, trainACaseInputs } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml, routineBreaches } from './fixtures/svelte-ssr.ts'
import { createTimeFormat, moneyText, quantityText } from './format.ts'
import { createNames, isWhatIf, planOptions, type OptionView, type PlanModel } from './model.ts'
import { optionsGlance } from './options-glance.ts'
import { outcomeBanner } from './outcome.ts'
import type { Context } from './status-text.ts'
import { whatIfApart, whatIfCard, whatIfRequest, whatIfVariant } from './what-if.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: OptionsTable } = await import('./OptionsTable.svelte') as { default: Any }
const { default: PlanScreen } = await import('./PlanScreen.svelte') as { default: Any }
const { default: WhatIfCard } = await import('./WhatIfCard.svelte') as { default: Any }
const { default: WhatIfPanel } = await import('./WhatIfPanel.svelte') as { default: Any }

const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const none = () => {}
const offline = createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => { throw new Error('No Host in a render test') })

const inputs = trainACaseInputs()
const context: Context = { inputs, names: createNames(inputs), format: createTimeFormat(inputs.settings.timeZone) }
const grid = inputs.settings.grid
const costGoal = inputs.goals.findIndex(goal => goal.metric === 'extra-cost')
const swap = inputs.methods[0]!.options.find(option => option.key === 'swap')!
const afw = inputs.groups.find(group => group.key === 'AFW-A')!
const cool = inputs.groups.find(group => group.key === 'COOL-A')!
const built = (ask: Parameters<typeof whatIfVariant>[0]) => {
  const answer = whatIfVariant(ask, context)
  if (!answer.ok) throw new Error(answer.problems.join(' '))
  return answer
}
const variantOf = (ask: Parameters<typeof whatIfVariant>[0]): OptionView['variant'] => {
  const { variant } = built(ask)
  return { methods: [], purchases: [], ...variant.also === undefined ? {} : { also: variant.also }, ...variant.lead === undefined ? {} : { lead: variant.lead } }
}

/**
 * Three what-ifs beside one plan option (statuses as the schema allows them; values are fixture facts):
 * - cheapest: extra cost solved first and proven at the swap's own fixed cost, a cost every such plan pays;
 * - finish AFW A first: its outage proven at 7.5 h, or's X5 figure (R/or/report.md: tagged at 08:00, back Thu 15:30);
 * - at most 48 h out for the cooling chain: proven infeasible.
 */
const withWhatIfs = (): PlanModel => {
  const plan = optionOf('plan-1', 'Swap in refurbished spare', status({ word: 'validated feasible', run: runBasis(grid), goals: [{ word: 'best found under budget', goal: 0, value: 0, unit: 'h' }] }), { variant: { methods: [{ choice: 'SWA-method', option: 'swap' }], purchases: [] } })
  const fixed = { value: swap.fixedCost, source: 'fixed-costs', certificate: { kind: 'fixed-costs', items: [{ key: 'SWA-method', amount: swap.fixedCost }] } }
  const cheapest = optionOf('w-cheapest', built({ kind: 'cheapest' }).label, status({
    word: 'validated feasible', run: runBasis(grid), lead: { goal: costGoal },
    goals: [{ word: 'best found under budget', goal: 0, value: 0, unit: 'h' }, { word: 'proven optimal', goal: 1, value: swap.fixedCost, unit: 'NOK', bound: fixed }, { word: 'best found under budget', goal: 2, value: 0, unit: 'h' }],
  }), { variant: { ...variantOf({ kind: 'cheapest' }), methods: [{ choice: 'SWA-method', option: 'swap' }] } })
  const first = optionOf('w-afw', built({ kind: 'first', group: 'AFW-A' }).label, status({
    word: 'validated feasible', run: runBasis(grid),
    lead: { word: 'proven optimal', group: 'AFW-A', value: 7.5, unit: 'h', bound: { value: 7.5, source: 'logic+calendars', certificate: { kind: 'least-span', spans: [{ group: 'AFW-A', hours: 7.5 }] } } },
    goals: [{ word: 'best found under budget', goal: 0, value: 0, unit: 'h' }, { word: 'best found under budget', goal: 1, value: swap.fixedCost, unit: 'NOK' }],
  }), { variant: variantOf({ kind: 'first', group: 'AFW-A' }) })
  const out = optionOf('w-48', built({ kind: 'out', group: 'COOL-A', hours: '48' }).label, status({
    word: 'proven infeasible', run: runBasis(grid), cause: { kind: 'temporal', steps: [{ job: 'SWA-TAG', via: 'span-limit' }, { job: 'SWA-RTS', via: 'link' }] },
  }), { variant: variantOf({ kind: 'out', group: 'COOL-A', hours: '48' }) })
  return modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: 'plan-1', items: [plan, cheapest, first, out] } })
}

describe('the what-if builder', () => {
  test('"at most … h out" adds one extra hard rule with a key no plan rule has, and less than the plan allows', () => {
    const { variant, label } = built({ kind: 'out', group: 'COOL-A', hours: '48' })
    expect(label).toBe(`At most 48 h out: ${cool.label}`)
    const rule = variant.also![0]!
    const own = inputs.rules.find(item => item.kind === 'span-limit' && item.group === 'COOL-A')!
    expect(rule).toMatchObject({ kind: 'span-limit', group: 'COOL-A', limit: { value: 48, unit: 'h' }, singleEntry: own.kind === 'span-limit' && own.singleEntry })
    expect(inputs.rules.some(item => item.key === rule.key)).toBe(false)
    // Kept beside the plan's own options: one request, keep true; the plan's goals and rules are not edited.
    expect(whatIfRequest(variant)).toEqual({ variants: [variant], keep: true })
    expect(whatIfVariant({ kind: 'out', group: 'COOL-A', hours: '72' }, context)).toEqual({ ok: false, problems: [`The plan's own rule already allows 72 h for ${cool.label}; a what-if asks for less.`] })
    expect(whatIfVariant({ kind: 'out', group: 'COOL-A', hours: 'soon' }, context).ok).toBe(false)
  })

  test('"finish this group first" leads with the group; "cheapest that keeps every rule" leads with the plan\'s extra-cost goal, by its id', () => {
    expect(built({ kind: 'first', group: 'AFW-A' }).variant).toEqual({ label: `${afw.label} first, with its shortest outage`, lead: { group: 'AFW-A' } })
    expect(built({ kind: 'cheapest' }).variant).toEqual({ label: 'Cheapest that keeps every rule', lead: { goal: costGoal } })
    // The id follows the goal, wherever it stands in the order.
    const reordered = { ...inputs, goals: [inputs.goals[costGoal]!, ...inputs.goals.filter((_, index) => index !== costGoal)] }
    expect(whatIfVariant({ kind: 'cheapest' }, { ...context, inputs: reordered })).toMatchObject({ ok: true, variant: { lead: { goal: 0 } } })
  })
})

describe('a what-if is a card, never a row', () => {
  test('no what-if is a row of the options table, in the Options view, in the banner or among the attention cards', () => {
    const model = withWhatIfs()
    const ctx = contextOf(model)
    expect(planOptions(model).map(option => option.key)).toEqual(['plan-1'])
    expect(optionsGlance(model, ctx)!.rows.map(row => row.key)).toEqual(['plan-1'])
    const table = readableText(renderHtml(OptionsTable, { options: planOptions(model), whatIfs: 3, recommended: 'plan-1', context: ctx, onSelect: none, onBaseline: none }))
    for (const option of model.options!.items.filter(isWhatIf)) expect(table).not.toContain(option.label)
    expect(table).toContain('3 what-ifs are kept apart from these options')
    // The refused 48 h what-if does not make the plan "not possible", and no card speaks for it.
    expect(outcomeBanner(model, ctx)!.title).toBe('Recommended: Swap in refurbished spare, validated feasible.')
    expect(attentionCards(model, ctx).some(card => card.title.startsWith('At most'))).toBe(false)
    const screen = readableText(renderHtml(PlanScreen, { client: offline, planId: model.id, initial: model, onChanged: none, onOpenWorkspace: none, onOpenLibrary: none }))
    expect(screen).toContain('What-ifs (3)')
    for (const option of model.options!.items.filter(isWhatIf)) expect(screen).not.toContain(option.label)
  })

  test('cheapest first: the lead is the extra-cost goal by its id, proven at its bound; the rest read "best found at that cost"', () => {
    const model = withWhatIfs()
    const card = whatIfCard(model.options!.items[1]!, model, contextOf(model))
    expect(card.status.goals.map(goal => [goal.name, goal.value, goal.mark.word])).toEqual([
      ['Extra cost (solved first)', moneyText(swap.fixedCost, 'NOK'), 'proven optimal'],
      ['Over the 54 h guideline', '0 h', 'best found at that cost'],
      ['Equipment-hours out of service', '0 h', 'best found at that cost'],
    ])
    const text = readableText(renderHtml(WhatIfCard, { card, onSelect: none }))
    expect(text).toContain(whatIfApart)
    expect(text).toContain('Asked: the cheapest plan that keeps every hard rule, then the plan\'s other goals in order.')
    expect(text).toContain(`Extra cost (solved first): ${moneyText(swap.fixedCost, 'NOK')} ✓ proven optimal Over the 54 h guideline: 0 h ≈ best found at that cost`)
    // Unpriced: the swap's own caveat, from the frozen case, beside the what-if that uses the swap.
    const caveat = swap.caveats![0]!
    expect(text).toContain(`○ Unpriced ${caveat.label}: ${quantityText(caveat.value!, caveat.unit!)}`)
    expect(text).not.toMatch(/Recommended|Goal \d/)
    expect(routineBreaches(text, identifiers(model.inputs), [])).toEqual([])
  })

  test('finish a group first: the card reads status.lead, the group\'s outage, proven; no plan goal is proven', () => {
    const model = withWhatIfs()
    const card = whatIfCard(model.options!.items[2]!, model, contextOf(model))
    expect(card.status.goals[0]).toEqual({ name: `Shortest outage for ${afw.label} (solved first)`, value: '7.5 h', mark: { shape: '✓', word: 'proven optimal' }, distance: '' })
    expect(card.status.goals.slice(1).map(goal => goal.mark.word)).toEqual([`best found with ${afw.label} first`, `best found with ${afw.label} first`])
    expect(card.question).toBe(`Asked: the shortest outage for ${afw.label} first, then the plan's goals in order.`)
    const text = readableText(renderHtml(WhatIfCard, { card, onSelect: none }))
    expect(text.split('proven optimal').length - 1).toBe(1)
  })

  test('at most 48 h out, refused: the card says it is not possible and why, and what was asked', () => {
    const model = withWhatIfs()
    const card = whatIfCard(model.options!.items[3]!, model, contextOf(model))
    expect(card.question).toBe(`Asked: every hard rule of the plan, and ${cool.label} out for at most 48 h.`)
    const text = readableText(renderHtml(WhatIfCard, { card, onSelect: none }))
    expect(text).toContain('✕ proven infeasible')
    expect(text).toContain('No plan can keep every hard rule. The proof:')
  })

  test('the panel shows the cards under the question; before the solver builds it, a what-if is "not available yet"', () => {
    const model = withWhatIfs()
    const ctx = contextOf(model)
    const cards = model.options!.items.filter(isWhatIf).map(option => whatIfCard(option, model, ctx))
    const text = readableText(renderHtml(WhatIfPanel, { context: ctx, cards, missing: 'What-ifs are not available yet in this version of Planning.', onAsk: none, onSelect: none, onClose: none }))
    for (const word of ['At most … h out', 'Finish this group first', 'Cheapest that keeps every rule', 'What-ifs asked', 'What-ifs are not available yet in this version of Planning.']) expect(text).toContain(word)
    expect(text).not.toMatch(/501|not_built/)
    expect(text.split(whatIfApart).length - 1).toBe(3)
  })
})
