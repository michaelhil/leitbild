// Dominated options are folded (decision "Lane U batch 2", 4; design §4.1 dominance): an option item with
// `dominated: {by}` is collapsed under the options table and in the Options view, says "Dominated by …", and
// opens. The option shown on the timeline is never hidden.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { optionItemSchema } from '../api/contract.ts'
import { modelOf, optionOf, trainAPlanned } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'
import { createTimeFormat } from './format.ts'
import { createNames, type OptionView, type PlanModel } from './model.ts'
import { optionsGlance } from './options-glance.ts'
import type { Context } from './status-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: OptionsGlance } = await import('./OptionsGlance.svelte') as { default: Any }
const { default: OptionsTable } = await import('./OptionsTable.svelte') as { default: Any }

const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const none = () => {}

/** The hand-placed Train A option and a second one it dominates, as the options section pages them. */
const withDominated = (): PlanModel => {
  const planned = trainAPlanned()
  const first = planned.options!.items[0]!
  const item = (option: OptionView, extra: object) => optionItemSchema.parse({ ...option, ...extra }) as unknown as OptionView
  const better = item({ ...first, label: 'Swap in refurbished spare' }, {})
  const worse = item(optionOf('opt-2', 'Swap in refurbished spare, crane Friday', first.status), { dominated: { by: 'opt-1' } })
  return modelOf(planned.inputs, { options: { ...planned.options!, items: [better, worse] }, rows: planned.rows })
}

describe('dominated options', () => {
  test('the row says which option dominates it, and is folded under the table until opened', () => {
    const model = withDominated()
    const glance = optionsGlance(model, contextOf(model))!
    expect(glance.rows.map(row => row.dominatedBy)).toEqual([null, 'Swap in refurbished spare'])
    const folded = readableText(renderHtml(OptionsGlance, { glance, selected: 'opt-1', onSelect: none }))
    expect(folded).not.toContain('Swap in refurbished spare, crane Friday')
    expect(folded).toContain('Show 1 dominated option')
    expect(folded).toContain('Dominated: another option is no worse on every goal and better on one.')
    // Shown on the timeline, it is never hidden, and says what dominates it.
    const shown = readableText(renderHtml(OptionsGlance, { glance, selected: 'opt-2', onSelect: none }))
    expect(shown).toContain('Swap in refurbished spare, crane Friday')
    expect(shown).toContain('Dominated by “Swap in refurbished spare”')
  })

  test('the Options view folds it too', () => {
    const model = withDominated()
    const text = readableText(renderHtml(OptionsTable, { options: model.options!.items, recommended: 'opt-1', context: contextOf(model), selected: 'opt-1', onSelect: none, onBaseline: none }))
    expect(text).not.toContain('Swap in refurbished spare, crane Friday')
    expect(text).toContain('Show 1 dominated option')
  })
})
