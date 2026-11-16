// The re-walk's screen items (impl/inc23/batch2-rewalk-fixes.md N1, N3, N5, N6; maint/walk-inc2.md, "Re-walk
// after the fix round"), each test written from the walk's own case.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Component } from 'svelte'
import { createPlanningClient } from './api.ts'
import { modelOf, optionOf, runBasis, status, trainACaseInputs } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'
import { createTimeFormat } from './format.ts'
import { createNames, type OptionView, type PlanModel } from './model.ts'
import { optionsGlance } from './options-glance.ts'
import { createPlanActions } from './plan-actions.ts'
import type { Context } from './status-text.ts'
import { whatIfCard } from './what-if.ts'
import { carryOver, panelClosedNotice } from './why-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: OptionsGlance } = await import('./OptionsGlance.svelte') as { default: Any }
const { default: WhyRecommended } = await import('./WhyRecommended.svelte') as { default: Any }

const inputs = trainACaseInputs()
const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const grid = inputs.settings.grid
const method = inputs.methods[0]!
const picks = (option: string) => [{ choice: method.key, option }]
const label = (option: string) => method.options.find(entry => entry.key === option)!.label
const feasible = (goals: unknown[]) => status({ word: 'validated feasible', run: runBasis(grid), goals })
const plain = (key: string, option: string, extra: Partial<OptionView> = {}) => optionOf(key, label(option), feasible([]), { variant: { methods: picks(option), purchases: [] }, ...extra })
const none = () => {}

describe('N1: an open panel moves to the new option set, or closes with a plain notice', () => {
  test('the option "Why recommended" weighs against moves to the same method in the new set; with none, to the next in rank', () => {
    // The walk: Rebuild named under "Weigh it against", then an estimate change and Generate: every key gets a new set suffix.
    const fresh = [plain('swap.1d8017c1', 'swap'), plain('rebuild.1d8017c1', 'rebuild')]
    expect(carryOver('rebuild.55ac0be0', fresh)).toBe('rebuild.1d8017c1')
    expect(carryOver('rebuild.55ac0be0', [plain('swap.1d8017c1', 'swap')])).toBeNull()
    expect(carryOver(null, fresh)).toBeNull()
  })
  test('a request a Generate made stale closes its panel with a plain notice, never a red request error', () => {
    expect(panelClosedNotice('why')).toBe('The options changed, so “Why recommended” was closed. Open it again for the new options.')
    const source = readFileSync(join(import.meta.dir, 'PlanScreen.svelte'), 'utf8')
    // Every question is asked with the carried-over keys, and a refusal naming a replaced key closes the panel.
    expect(source).toMatch(/whyAgainst = carryOver\(whyAgainst === '' \? null : whyAgainst, planOptions\(model\)\.filter\(option => option\.fresh\)\) \?\? ''/)
    expect(source).toMatch(/cause\.code === 'unknown_reference' \|\| cause\.code === 'option_stale'/)
  })
})

describe('N3: one click shows every remaining moved job', () => {
  test('the pages are read until there is no more, in one action', async () => {
    const answers = [
      { versus: { moved: [1, 2] }, more: 'c2' }, { versus: { moved: [3] }, more: 'c3' }, { versus: { moved: [4, 5] } },
    ]
    const sent: unknown[] = []
    const plan = modelOf(inputs)
    const at = (hours: number) => new Date(Date.parse(inputs.settings.window!.start) + hours * 3_600_000).toISOString()
    const move = (index: number) => ({ job: inputs.jobs[index]!.key, now: { start: at(index + 1), finish: at(index + 2) }, was: { start: at(index), finish: at(index + 1) } })
    const facts = (moved: number[], left: number) => ({ option: 'a', previous: 'b', from: 1, to: 2, complete: true, changes: [], methods: [], buys: { added: [], dropped: [] }, moved: moved.map(move), movedMore: left, added: [], removed: [] })
    const client = createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async (_path, init) => {
      sent.push((JSON.parse(String(init?.body)) as { input: unknown }).input)
      const next = answers.shift()!
      const left = answers.reduce((sum, answer) => sum + answer.versus.moved.length, 0)
      return Response.json({ result: { lines: [], items: [], versus: facts(next.versus.moved, left), ...(next.more === undefined ? {} : { more: next.more }) } })
    })
    const moved = await createPlanActions(client, plan.id).allMoved('a', 'b', 'c1')
    expect(moved.map(entry => entry.job)).toEqual([1, 2, 3, 4, 5].map(index => inputs.jobs[index]!.key))
    expect(sent.map(input => (input as { cursor?: string }).cursor)).toEqual(['c1', 'c2', 'c3'])
  })
})

describe('N5: the star agrees with "Why recommended" while the plan is out of date', () => {
  test('"★ Recommended before your latest change" in the table, and the panel says the same', () => {
    const stale = plain('swap.55ac0be0', 'swap', { fresh: false })
    const model = modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: 'swap.55ac0be0', items: [stale] } })
    const text = readableText(renderHtml(OptionsGlance, { glance: optionsGlance(model, contextOf(model))!, onSelect: none }))
    expect(text).toContain('★ Recommended before your latest change')
    const panel = readableText(renderHtml(WhyRecommended, { title: `Why “${label('swap')}” was recommended before your latest change`, policy: [], answer: { state: 'none' }, outOfDate: true, onClose: none }))
    expect(panel).toContain('Out of date: these are the reasons on the plan before your latest change. Generate again to know for the plan as it is now.')
    expect(panel).not.toContain('No option is recommended')
  })
})

describe('N6: a what-if\'s difference inside the plan\'s cost band says so', () => {
  test('"−NOK 6,300 extra cost (within the NOK 25,000 the plan counts as equal cost)"', () => {
    // The walk's AFW-first card against the recommended swap: NOK 466,350 against NOK 472,650, the same outage.
    const goals = (cost: number) => [{ word: 'best found under budget', goal: 0, value: 0, unit: 'h' }, { word: 'best found under budget', goal: 1, value: cost, unit: 'NOK' }]
    const recommended = plain('swap', 'swap', { status: feasible(goals(472_650)) })
    const afw = optionOf('afw', 'AFW A first', status({ word: 'validated feasible', run: runBasis(grid), lead: { word: 'best found under budget', group: 'AFW-A', value: 7.5, unit: 'h' }, goals: goals(466_350) }), { variant: { methods: [], purchases: [], lead: { group: 'AFW-A' } } })
    const model = modelOf(inputs, { options: { at: '2026-11-12T09:05:00.000Z', recommended: 'swap', items: [recommended, afw] } })
    expect(whatIfCard(afw, model, contextOf(model)).against).toBe(`Against ${label('swap')} (recommended): −NOK 6,300 extra cost (within the NOK 25,000 the plan counts as equal cost).`)
  })
})
