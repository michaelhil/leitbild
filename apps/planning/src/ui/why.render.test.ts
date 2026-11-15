// "Why recommended" (T11) and "what differs from the earlier options" (T12), beside the timeline (design §7,
// §8 "Why recommended"; decisions "Lane U batch 2", "Lane P batch 2"): written from the Module's structured
// facts, `recommended` and `versus`, never from its lines. The deciding goal and the trade in planner words,
// each goal side by side, what each method leaves unpriced (T10), the earlier set from the previous read
// section, the measures that changed and the jobs that moved; "not available yet" and "no earlier set" in words.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { recommendedFactsSchema, sectionDataSchemas, versusFactsSchema } from '../api/contract.ts'
import { refusalText } from './api.ts'
import { hourMs, identifiers, modelOf, optionOf, runBasis, status, trainACaseInputs, trainAInputs, trainARows } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml, routineBreaches } from './fixtures/svelte-ssr.ts'
import { createTimeFormat, moneyText, quantityText } from './format.ts'
import { createNames, type DatedRow, type OptionView, type PlanModel } from './model.ts'
import { optionsGlance } from './options-glance.ts'
import type { Context } from './status-text.ts'
import { methodPicks, unpricedOf } from './unpriced.ts'
import { compareView, noPreviousWords, policyLines, previousFor, previousRows, recommendedAnswer, tradeText, versusAnswer, whyView } from './why-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: ComparePanel } = await import('./ComparePanel.svelte') as { default: Any }
const { default: WhyRecommended } = await import('./WhyRecommended.svelte') as { default: Any }

const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const none = () => {}
const inputs = trainACaseInputs()
const method = inputs.methods[0]!
const rebuild = method.options.find(option => option.key === 'rebuild')!
const swap = method.options.find(option => option.key === 'swap')!
const caveat = (option: typeof swap) => option.caveats![0]!
const caveatText = (option: typeof swap) => `${caveat(option).label}: ${quantityText(caveat(option).value!, caveat(option).unit!)}`

/** The two default options, one per SW A method, as Generate names them; the swap recommended. */
const twoMethods = (): PlanModel => {
  const feasible = status({ word: 'validated feasible', run: runBasis(inputs.settings.grid), goals: [{ word: 'best found under budget', goal: 0, value: 0, unit: 'h' }] })
  const options = [
    optionOf('swap', swap.label, feasible, { variant: { methods: [{ choice: method.key, option: 'swap' }], purchases: [] } }),
    optionOf('rebuild', rebuild.label, feasible, { variant: { methods: [{ choice: method.key, option: 'rebuild' }], purchases: [] } }),
  ]
  return modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: 'swap', items: options } })
}

/**
 * Lane S's production-speed measurement on the flagship (coordinator decisions, "Lane U batch 2"): rung 2,
 * swap 49 h proven optimal at NOK 474,750, rebuild 65 h best found at NOK 255,800. Against the 54 h guideline
 * the swap is 0 h over and the rebuild 65 − 54 = 11 h over; the caveats are the frozen case's. A test input in
 * the contract's shape, standing in for explain recommended's facts.
 */
const measured = { swap: { span: 49, cost: 474_750 }, rebuild: { span: 65, cost: 255_800 } }
const guideline = inputs.goals[0]!.threshold!.value
const over = (span: number) => Math.max(0, span - guideline)
const facts = recommendedFactsSchema.parse({
  option: 'swap', against: 'rebuild', deciding: 0,
  goals: [{ goal: 0, value: over(measured.swap.span), against: over(measured.rebuild.span), unit: 'h' }, { goal: 1, value: measured.swap.cost, against: measured.rebuild.cost, unit: 'NOK' }],
  caveats: [{ choice: method.key, option: 'swap', label: caveat(swap).label, value: caveat(swap).value, unit: caveat(swap).unit, against: caveat(rebuild).value }],
  outage: { goal: 0, word: 'proven optimal', value: 0, unit: 'h', bound: 0 },
})

describe('why recommended', () => {
  test('the plan\'s own rule in words: every hard rule, then the goals in order with their steps', () => {
    const step = inputs.goals[1]!.tolerance.value
    expect(policyLines(contextOf(twoMethods()))[2]).toBe(`2. Keep the extra cost as small as possible; costs within ${moneyText(step, 'NOK')} of each other count as equal.`)
  })

  test('the deciding goal and the trade in planner words, from the facts: "+NOK … extra cost for −11 h over the guideline"', () => {
    const model = twoMethods()
    const context = contextOf(model)
    // 474,750 − 255,800 = 218,950 more extra cost; 0 − 11 = 11 h less over the 54 h guideline.
    expect(tradeText(facts, context)).toBe(`The trade: +${moneyText(measured.swap.cost - measured.rebuild.cost, 'NOK')} extra cost for −11 h over the 54 h guideline.`)
    expect(tradeText(facts, context)).toBe('The trade: +NOK 218,950 extra cost for −11 h over the 54 h guideline.')
    const view = whyView(facts, model, context, false)
    expect(view.against).toBe(`Against “${rebuild.label}”, the next in rank.`)
    expect(view.decided).toBe(`Decided on time over the 54 h guideline: 0 h here against 11 h for ${rebuild.label}.`)
    expect(view.goals.map(goal => [goal.name, goal.value, goal.against, goal.deciding])).toEqual([
      ['Over the 54 h guideline', '0 h', '11 h', true], ['Extra cost', 'NOK 474,750', 'NOK 255,800', false],
    ])
    // The guideline goal's bound is no floor of the outage itself, so no outage line is said (goals review G4).
    expect(view.outage).toBeNull()
    const text = readableText(renderHtml(WhyRecommended, { title: `Why “${swap.label}” is recommended`, policy: policyLines(context), answer: { state: 'answered', facts: view }, onClose: none }))
    for (const part of [view.decided!, view.trade!, '◆ Decided here', caveatText(swap), `against ${quantityText(caveat(rebuild).value!, caveat(rebuild).unit!)} for “${rebuild.label}”`, caveat(swap).words]) expect(text).toContain(part)
    expect(routineBreaches(text, identifiers(model.inputs), [])).toEqual([])
  })

  test('the screen never reads lines: an answer with lines and no facts is "not available yet"', () => {
    const lines = ['A line the screen must not show.']
    expect(recommendedAnswer({ lines, items: [] })).toEqual({ state: 'not-built' })
    expect(recommendedAnswer({ lines, items: [], recommended: facts })).toEqual({ state: 'answered', facts })
    const text = readableText(renderHtml(WhyRecommended, { title: 'Why', policy: [], answer: { state: 'not-built' }, onClose: none }))
    expect(text).toContain('The deciding goal and the trade it made are not available yet in this version of Planning.')
    expect(text).not.toMatch(/501|not_built/)
  })

  test('with no other ranked option, and on a tie, it says so; it can be weighed against another option', () => {
    const model = twoMethods()
    const context = contextOf(model)
    const alone = whyView(recommendedFactsSchema.parse({ option: 'swap', goals: [{ goal: 0, value: 0, unit: 'h' }], caveats: [] }), model, context, false)
    expect([alone.against, alone.decided, alone.trade]).toEqual(['No other ranked option keeps every hard rule, so there is none to weigh it against.', null, null])
    const tie = whyView(recommendedFactsSchema.parse({ option: 'swap', against: 'rebuild', goals: [{ goal: 0, value: 0, against: 0, unit: 'h' }], caveats: [] }), model, context, true)
    expect([tie.against, tie.decided]).toEqual([`Against “${rebuild.label}”.`, 'They tie on every goal within its step, so either could be chosen; Planning lists this one first.'])
    const choices = [{ value: '', label: 'The next in rank' }, { value: 'rebuild', label: rebuild.label }]
    expect(readableText(renderHtml(WhyRecommended, { title: 'Why', policy: [], answer: { state: 'loading' }, choices, against: '', onAgainst: none, onClose: none }))).toContain('Weigh it against')
  })

  test('each option\'s unpriced caveat is in the options table; a method left to the search is read from its schedule', () => {
    const model = twoMethods()
    expect(optionsGlance(model, contextOf(model))!.rows.map(row => row.unpriced)).toEqual([[caveatText(swap)], [caveatText(rebuild)]])
    const searched = { variant: { methods: [], purchases: [] } }
    const swapJob = inputs.jobs.find(job => job.method?.option === 'swap')!
    const rows: DatedRow[] = [{ job: swapJob.key, start: inputs.settings.window!.start, finish: inputs.settings.window!.end, uses: [], float: { workingHours: 0, limitedBy: { kind: 'window-end' } } }]
    expect(methodPicks(searched, inputs, rows)).toEqual([{ choice: method.key, option: 'swap' }])
    expect(unpricedOf(searched, inputs).length).toBe(0)
  })
})

describe('what differs from the earlier options', () => {
  /**
   * T12 on the hand-placed Train A schedule (fixtures/plans.ts): the pull's estimate raised from 5 h to its
   * high, 7 h, so the pull ends 2 h later and the test that follows it moves 2 h. The span grows from 32.5 h to
   * 34.5 h, still under 54 h, so the guideline goal stays at 0 h. A test input in the contract's shape.
   */
  const t12 = () => {
    const base = trainAInputs()
    const was = trainARows(base)
    const pull = base.jobs.find(job => job.key === 'SWA-PUMP-OUT')!
    const later = (pull.duration.range!.high - pull.duration.value!) * hourMs
    const shift = (row: DatedRow, start: number, finish: number) => ({ start: new Date(Date.parse(row.start) + start).toISOString(), finish: new Date(Date.parse(row.finish) + finish).toISOString() })
    const moved = [
      { job: 'SWA-PUMP-OUT', was: shift(was[1]!, 0, 0), now: shift(was[1]!, 0, later) },
      { job: 'SWA-RTS', was: shift(was[2]!, 0, 0), now: shift(was[2]!, later, later) },
    ]
    const versus = versusFactsSchema.parse({
      option: 'opt-1', previous: 'opt-1', from: 2, to: 3, complete: true,
      changes: [{ revision: 3, summary: `Changed job ${pull.title}: duration` }],
      goals: [{ goal: 0, now: 0, was: 0, unit: 'h' }, { goal: 1, now: 0, was: 0, unit: 'NOK' }],
      methods: [], buys: { added: [], dropped: [] }, moved, movedMore: 0, added: [], removed: [],
    })
    const option = optionOf('opt-1', 'Option 1', status({ word: 'validated feasible', run: runBasis(base.settings.grid), goals: [{ word: 'best found under budget', goal: 0, value: 0, unit: 'h' }] }))
    return { model: modelOf(base, { options: { at: '2026-11-12T09:05:00.000Z', recommended: 'opt-1', items: [option] } }), versus, option, pull }
  }

  test('the measures that changed and the jobs that moved, from the facts', () => {
    const { model, versus, option, pull } = t12()
    const context = contextOf(model)
    const view = compareView(versus, option, option, context)
    expect(view.changes).toEqual([`Changed job ${pull.title}: duration`])
    expect(view.goals!.map(goal => [goal.name, goal.now, goal.was, goal.change])).toEqual([['Over the 54 h guideline', '0 h', '0 h', 'the same'], ['Extra cost', 'NOK 0', 'NOK 0', 'the same']])
    expect(view.moved.map(entry => [entry.job, entry.shift])).toEqual([[pull.title, 'finishes 2 h later'], [model.inputs.jobs.find(job => job.key === 'SWA-RTS')!.title, 'starts 2 h later']])
    const text = readableText(renderHtml(ComparePanel, { answer: { state: 'answered', facts: view }, previous: previousRows({ items: [option], recommended: 'opt-1' }), against: 'opt-1', onClose: none }))
    for (const part of ['The earlier set', '★ Recommended then', 'Changes since then', 'Measures', 'Jobs that moved', 'finishes 2 h later', 'starts 2 h later', `“Option 1” now, against “Option 1” in the set made before the latest changes.`]) expect(text).toContain(part)
    expect(routineBreaches(text, identifiers(model.inputs), [])).toEqual([])
  })

  test('a changed measure is signed in its unit; changed goals, methods, purchases and removed jobs are said', () => {
    const { model, option } = t12()
    const context = contextOf(model)
    const purchase = model.inputs.purchases[0]!
    const changed = versusFactsSchema.parse({
      option: 'opt-1', previous: 'opt-1', from: 2, to: 5, complete: false, changes: [],
      methods: [{ choice: method.key, now: 'swap', was: 'rebuild' }],
      buys: { added: [purchase.key], dropped: [] }, moved: [], movedMore: 3, added: [], removed: ['GONE-1', 'GONE-2'],
    })
    const view = compareView(changed, option, option, context)
    expect(view.goals).toBeNull()
    expect(view.goalsNote).toBe('The goals themselves changed, so their values are not compared.')
    expect(view.methods).toEqual([`${method.label}: ${model.inputs.methods[0]!.options.find(entry => entry.key === 'swap')!.label}, was ${model.inputs.methods[0]!.options.find(entry => entry.key === 'rebuild')!.label}.`])
    expect(view.buys).toEqual([`Now buys ${purchase.label}.`])
    expect([view.more, view.removed, view.incomplete]).toEqual(['3 more jobs moved.', '2 jobs of the earlier set are no longer in the plan.', 'Some earlier changes are no longer in the plan\'s history, so this list is not complete.'])
    expect(compareView(versusFactsSchema.parse({ ...changed, goals: [{ goal: 1, now: 474_750, was: 464_250, unit: 'NOK' }], buys: { added: [], dropped: [] }, movedMore: 0, removed: [] }), option, option, context).goals)
      .toEqual([{ name: 'Extra cost', now: 'NOK 474,750', was: 'NOK 464,250', change: '+NOK 10,500' }])
  })

  test('the earlier set comes from the previous read section; the same option is compared when it has it, else the one it recommended', () => {
    const { option } = t12()
    const page = sectionDataSchemas.previous.parse({ items: [{ ...option, key: 'old-a', fresh: false }, { ...option, key: 'old-b', fresh: false }], at: '2026-11-12T08:00:00.000Z', recommended: 'old-b' })
    const items = page.items as unknown as readonly OptionView[]
    expect(previousFor('old-a', { items, recommended: page.recommended }, null)).toBe('old-a')
    expect(previousFor('opt-1', { items, recommended: page.recommended }, null)).toBe('old-b')
    expect(previousFor('opt-1', { items, recommended: page.recommended }, 'old-a')).toBe('old-a')
    expect(previousFor('opt-1', { items: [], recommended: null }, null)).toBeNull()
  })

  test('no earlier set, and a part not built yet, are said in planner words', () => {
    const refusal = Object.assign(new Error('There is no earlier set of options to compare with'), { status: 409, code: 'no_previous_options', details: null })
    expect(refusalText(refusal)).toBe(noPreviousWords)
    expect(readableText(renderHtml(ComparePanel, { answer: { state: 'none' }, onClose: none }))).toContain('There is no earlier set of options to compare with yet. Planning keeps one when you change the plan and Generate again.')
    expect(readableText(renderHtml(ComparePanel, { answer: { state: 'not-built' }, onClose: none }))).toContain('Comparing with the earlier options is not available yet in this version of Planning.')
    expect(versusAnswer({ lines: ['A line the screen must not show.'], items: [] })).toEqual({ state: 'not-built' })
  })
})
