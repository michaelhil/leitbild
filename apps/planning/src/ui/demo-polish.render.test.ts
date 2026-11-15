// The demo polish items from maint's fifth walk (maint/walk-inc1-r5.md, "would embarrass a demo"), one
// test each. The whole-seconds wording of the rounding card is the Module's; the screen's check for it is here.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Component } from 'svelte'
import { whyStart } from './explain-text.ts'
import { modelOf, optionOf, runBasis, status, supplyRunPlanned, trainAInputs, trainAPlanned } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml, routineBreaches } from './fixtures/svelte-ssr.ts'
import { createTimeFormat } from './format.ts'
import { createNames, type PlanModel } from './model.ts'
import { outcomeBanner } from './outcome.ts'
import { crewHourPurchases, requestLabel, requestText } from './request.ts'
import { statusView, type Context } from './status-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: JobPanel } = await import('./JobPanel.svelte') as { default: Any }
const { default: PlanHeader } = await import('./PlanHeader.svelte') as { default: Any }
const { default: OptionsTable } = await import('./OptionsTable.svelte') as { default: Any }

const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const none = () => {}
const css = /<style>([\s\S]*)<\/style>/.exec(readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8'))?.[1] ?? ''

describe('demo polish', () => {
  test('1. the job panel\'s Close button never wraps or shrinks beside a long title', () => {
    expect(css).toMatch(/\.panel-heading button, button\.quiet \{ white-space: nowrap; flex: none; \}/)
    expect(css).toMatch(/\.panel-heading h2 \{ min-width: 0; \}/)
  })

  test('2. "why does it start then" says the joint-cause sentence once', () => {
    const model = trainAPlanned()
    const context = contextOf(model)
    const row = model.rows['opt-1']![2]!
    const why = whyStart({ job: 'SWA-RTS', start: row.start, finish: row.finish, floatHours: 0, joint: true, because: [{ kind: 'link', about: [{ kind: 'job', key: 'SWA-PUMP-OUT' }] }, { kind: 'crew', about: [{ kind: 'resource', key: 'test-team' }] }] }, context, row)
    const text = readableText(renderHtml(JobPanel, { jobKey: 'SWA-RTS', context, row, why, onWhy: none, onPreview: none, onClose: none }))
    expect(text.match(/easing only one/g)?.length).toBe(1)
  })

  test('3. a bound that says nothing gives no gap; a fixed-cost bound is said as the bound itself', () => {
    const model = trainAPlanned()
    const run = runBasis(model.inputs.settings.grid)
    const view = statusView(status({ word: 'validated feasible', run, goals: [
      { word: 'proven optimal', goal: 0, value: 0, unit: 'h', bound: { value: 0, source: 'logic+calendars', certificate: { kind: 'zero' } } },
      // Fixed costs of NOK 340,000 are paid by every plan: the bound is said, not NOK 472,650 - 340,000 as doubt.
      { word: 'best found under budget', goal: 1, value: 472650, unit: 'NOK', bound: { value: 340000, source: 'fixed-costs', certificate: { kind: 'fixed-costs', items: [{ key: 'charged', amount: 340000 }] } } },
      // The trivial bound: 0 h out of service, so the "gap" would be the whole 242.5 h.
      { word: 'best found under budget', goal: 2, value: 242.5, unit: 'h', bound: { value: 0, source: 'logic+calendars', certificate: { kind: 'zero' } } },
    ] }), contextOf(model))
    expect(view.goals.map(goal => [goal.mark.word, goal.distance])).toEqual([['proven optimal', ''], ['best found', 'no plan can cost less than NOK 340,000'], ['best found', '']])
  })

  test('4. fractional seconds on a routine screen are caught', () => {
    expect(routineBreaches('rounded up from 3 min 29.8 s to 3 min 30 s', [], [])).toContain('fractional seconds')
    expect(routineBreaches('rounded up from about 3 min 30 s to 3 min 30 s; 2.5 h; NOK 1.5', [], [])).toEqual([])
  })

  test('5. "Days only" is offered only when the plan has crew hours to buy', () => {
    const flagship = trainAPlanned()
    expect(crewHourPurchases(flagship.inputs).map(purchase => purchase.key)).toEqual(['ot-mech', 'contractor-nights'])
    expect(readableText(renderHtml(PlanHeader, { context: contextOf(flagship), title: flagship.title, size: null, onGenerate: none, onCancel: none }))).toContain('Days only')
    const trucks = supplyRunPlanned()
    expect(crewHourPurchases(trucks.inputs)).toEqual([])
    expect(readableText(renderHtml(PlanHeader, { context: contextOf(trucks), title: trucks.title, size: null, onGenerate: none, onCancel: none }))).not.toContain('Days only')
  })

  test('7. each result says which request made it, also after the controls have reset', () => {
    const inputs = trainAInputs()
    const run = runBasis(inputs.settings.grid)
    const unresolved = status({ word: 'unresolved', run })
    const swap = { methods: [{ choice: 'SWA-method', option: 'swap' }], purchases: [] }
    const swapLabel = inputs.methods[0]!.options.find(option => option.key === 'swap')!.label
    const daysOnly = optionOf('v2', requestLabel([swapLabel], true), unresolved, { variant: swap })
    const plain = optionOf('swap', swapLabel, unresolved, { variant: swap })
    const named = optionOf('w1', 'What if the spare is late', unresolved, { variant: swap })
    expect(requestText(daysOnly, inputs)).toBe(`Requested: days only; ${swapLabel}.`)
    expect(requestText(plain, inputs)).toBe(`Requested: ${swapLabel}; overtime and night crews allowed.`)
    expect(requestText(named, inputs)).toBe('Requested as “What if the spare is late”.')
    const model = modelOf(inputs)
    const table = readableText(renderHtml(OptionsTable, { options: [daysOnly, plain], recommended: null, context: contextOf(model), onSelect: none, onBaseline: none }))
    expect(table).toContain(`Requested: days only; ${swapLabel}.`)
    // A plan with nothing to choose says nothing about a request.
    const trucks = supplyRunPlanned()
    expect(requestText(trucks.options!.items[0]!, trucks.inputs)).toBe('Requested as “Option 1”.')
    expect(requestText({ label: trucks.inputs.settings.title, variant: { methods: [], purchases: [] } }, trucks.inputs)).toBeNull()
  })

  test('8. two refused options read "both are", three "all 3 are"', () => {
    const inputs = trainAInputs()
    const refused = status({ word: 'proven infeasible', run: runBasis(inputs.settings.grid), cause: { kind: 'chain', jobs: ['SWA-RTS'], workHours: 37, calendars: ['day'], availableHours: 32, from: '2026-11-16T06:00:00Z', by: '2026-11-20T14:00:00Z' } })
    const set = (count: number): PlanModel => modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: null, items: Array.from({ length: count }, (_, index) => optionOf(`v${index}`, `Option ${index + 1}`, refused)) } })
    expect(outcomeBanner(set(2), contextOf(set(2)))!.title).toBe('No option can be recommended: both are proven infeasible.')
    expect(outcomeBanner(set(3), contextOf(set(3)))!.title).toBe('No option can be recommended: all 3 are proven infeasible.')
    expect(outcomeBanner(set(1), contextOf(set(1)))!.title).toBe('No option can be recommended: it is proven infeasible.')
  })
})
