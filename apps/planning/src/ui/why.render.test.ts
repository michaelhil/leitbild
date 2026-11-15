// "Why recommended" (T11) and "what differs from the earlier options" (T12), beside the timeline (design §7,
// §8 "Why recommended"): the plan's own rule in words, the Module's answer with the deciding goal, what each
// method leaves unpriced (T10), and a part of Planning not built yet said as "not available yet".
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { identifiers, modelOf, optionOf, runBasis, status, trainACaseInputs } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml, routineBreaches } from './fixtures/svelte-ssr.ts'
import { createTimeFormat, moneyText, quantityText } from './format.ts'
import { createNames, type DatedRow, type PlanModel } from './model.ts'
import { optionsGlance } from './options-glance.ts'
import type { Context } from './status-text.ts'
import { methodPicks, unpricedOf } from './unpriced.ts'
import { answered, compareView, policyText, whyView } from './why-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: ComparePanel } = await import('./ComparePanel.svelte') as { default: Any }
const { default: WhyRecommended } = await import('./WhyRecommended.svelte') as { default: Any }

const inputs = trainACaseInputs()
const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const none = () => {}
const method = inputs.methods[0]!
const rebuild = method.options.find(option => option.key === 'rebuild')!
const swap = method.options.find(option => option.key === 'swap')!
const caveatText = (option: typeof swap) => `${option.caveats![0]!.label}: ${quantityText(option.caveats![0]!.value!, option.caveats![0]!.unit!)}`

/** The two default options, one per SW A method, as Generate names them; the swap recommended. */
const twoMethods = (): PlanModel => {
  const feasible = status({ word: 'validated feasible', run: runBasis(inputs.settings.grid), goals: [{ word: 'best found under budget', goal: 0, value: 0, unit: 'h' }] })
  const options = [
    optionOf('swap', swap.label, feasible, { variant: { methods: [{ choice: method.key, option: 'swap' }], purchases: [] } }),
    optionOf('rebuild', rebuild.label, feasible, { variant: { methods: [{ choice: method.key, option: 'rebuild' }], purchases: [] } }),
  ]
  return modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: 'swap', items: options } })
}

describe('why recommended', () => {
  test('the plan\'s own rule in words: every hard rule, then the goals in order with their steps', () => {
    const context = contextOf(twoMethods())
    const step = inputs.goals[1]!.tolerance.value
    expect(policyText(context)).toBe(`Every hard rule must hold. Then, in order: 1. Over the 54 h guideline · 2. Extra cost, compared in steps of ${moneyText(step, 'NOK')} · 3. Equipment-hours out of service.`)
  })

  test('the recommended option\'s unpriced caveat is shown, beside the other method\'s, from the frozen case', () => {
    const model = twoMethods()
    const view = whyView(model.options!.items[0]!, model, contextOf(model))
    expect(view.unpriced.map(item => `${item.label}: ${item.value}`)).toEqual([caveatText(swap)])
    expect(view.otherMethods).toEqual([{ method: `${method.label}: ${rebuild.label}`, items: [expect.objectContaining({ value: quantityText(rebuild.caveats![0]!.value!, rebuild.caveats![0]!.unit!) })] }])
    const text = readableText(renderHtml(WhyRecommended, { view, answer: { state: 'loading' }, onClose: none }))
    expect(text).toContain(`Why “${swap.label}” is recommended`)
    expect(text).toContain(caveatText(swap))
    expect(text).toContain(swap.caveats![0]!.words)
    expect(text).toContain(`${method.label}: ${rebuild.label}: ${caveatText(rebuild)}`)
    // The options table says it too, beside each option (T10).
    expect(optionsGlance(model, contextOf(model))!.rows.map(row => row.unpriced)).toEqual([[caveatText(swap)], [caveatText(rebuild)]])
  })

  test('the Module\'s answer is shown as it gives it; until it is built, "not available yet", never a code', () => {
    const model = twoMethods()
    const view = whyView(model.options!.items[0]!, model, contextOf(model))
    // A test input standing in for explain's answer: the screen gives it its form only.
    const lines = ['Decided on goal 2, extra cost: a test input standing in for the Module\'s words.']
    const text = readableText(renderHtml(WhyRecommended, { view, answer: answered({ lines, items: [] }), onClose: none }))
    expect(text).toContain(lines[0]!)
    const later = readableText(renderHtml(WhyRecommended, { view, answer: { state: 'not-built' }, onClose: none }))
    expect(later).toContain('The deciding goal and the trade it made are not available yet in this version of Planning.')
    expect(later).not.toMatch(/501|not_built/)
    expect(routineBreaches(later, identifiers(model.inputs), [])).toEqual([])
  })

  test('a method left to the search is read from the schedule: the swap\'s jobs give the swap\'s caveat', () => {
    const model = twoMethods()
    const searched = { variant: { methods: [], purchases: [] } }
    const swapJob = inputs.jobs.find(job => job.method?.option === 'swap')!
    const rows: DatedRow[] = [{ job: swapJob.key, start: inputs.settings.window!.start, finish: inputs.settings.window!.end, uses: [], float: { workingHours: 0, limitedBy: { kind: 'window-end' } } }]
    expect(methodPicks(searched, inputs, rows)).toEqual([{ choice: method.key, option: 'swap' }])
    expect(unpricedOf(searched, inputs).length).toBe(0)
    expect(unpricedOf(searched, inputs, rows).map(item => item.label)).toEqual([swap.caveats![0]!.label])
  })
})

describe('what differs from the earlier options', () => {
  test('the shown option against the same option in the earlier set, in the Module\'s words, or "not available yet"', () => {
    const model = twoMethods()
    const view = compareView(model.options!.items[0]!)
    const lines = ['A test input standing in for explain versus.']
    const text = readableText(renderHtml(ComparePanel, { view, answer: answered({ lines, items: [] }), onClose: none }))
    expect(text).toContain('What differs from the earlier options')
    expect(text).toContain(`“${swap.label}” now, against the same option in the set made before the latest change.`)
    expect(text).toContain(lines[0]!)
    expect(readableText(renderHtml(ComparePanel, { view, answer: { state: 'not-built' }, onClose: none }))).toContain('Comparing with the earlier options is not available yet in this version of Planning.')
  })
})
