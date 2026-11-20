// The plan screen beside a Run: the back link returns to this Run's plans; an unlinked plan links this Run in
// one step; a plan linked to another Run says so by that Run's title and opens beside it; a plan linked to this
// Run is as before. A linked plan never read reads its World values when it opens beside its Run.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { createPlanningClient } from './api.ts'
import { attentionCards } from './attention.ts'
import { modelOf, supplyRunInputs } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'
import { createTimeFormat } from './format.ts'
import { createNames, type PlanModel, type RunChoice } from './model.ts'
import { readsOnOpen } from './plan-actions.ts'
import type { Context } from './status-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: EquipmentPicker } = await import('./EquipmentPicker.svelte') as { default: Any }
const { default: AttentionColumn } = await import('./AttentionColumn.svelte') as { default: Any }
const { default: PlanScreen } = await import('./PlanScreen.svelte') as { default: Any }

const offline = createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => { throw new Error('No Host in a render test') })
const none = () => {}
const at = '2026-11-20T09:00:00.000Z'
const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const runs: readonly RunChoice[] = [
  { id: 'run-1', title: 'Supply run, this one', status: 'Running', matches: true },
  { id: 'run-9', title: 'Supply run, Tuesday', status: 'Paused', matches: true },
]
const linkedTo = (run: string | null, refreshedAt: string | null = at): PlanModel => {
  const inputs = supplyRunInputs()
  return modelOf({ ...inputs, settings: { ...inputs.settings, run: run === null ? null : { id: run, linkedAt: at } }, world: { refreshedAt, facts: [] } })
}
const words = (html: string): string => readableText(html).replace(/\s+/g, ' ')
const buttons = (html: string): readonly string[] => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(match => words(match[1]!).trim())
const picker = (model: PlanModel, besideRun: string | null, linkedRun: string | null = null): string => renderHtml(EquipmentPicker, {
  context: contextOf(model), runs, linkedRun, besideRun, onLink: none, onOpenBeside: none, onRefresh: none, onOpenWorkspace: none, onFindRuns: none,
  onSearch: async () => [], onDetail: async () => { throw new Error('none') }, onPreview: none,
})

describe('the plan screen beside a Run', () => {
  test('an unlinked plan offers one action, Link this Run, instead of the list of running simulations', () => {
    const html = picker(linkedTo(null), 'run-1')
    expect(buttons(html)).toEqual(['Link this Run'])
    expect(words(html)).toContain('Link this Run to read its values into the plan.')
    for (const gone of ['Supply run, Tuesday', 'Link the running simulation', 'Open the Workspace', 'Look for running simulations again']) expect(words(html)).not.toContain(gone)
    // Its attention card links this Run in one step too.
    const model = linkedTo(null)
    const card = attentionCards(model, contextOf(model), Date.now(), true)[0]!
    expect([card.title, card.actions]).toEqual(['This plan is not linked to a Run yet.', ['link-this-run']])
    expect(buttons(renderHtml(AttentionColumn, { cards: [card], onAction: none }))).toEqual(['Link this Run'])
  })

  test('beside no Run an unlinked plan is as before', () => {
    const html = picker(linkedTo(null), null)
    expect(buttons(html)).toEqual(['Open the Workspace', 'Look for running simulations again', 'Link and read its values'])
    expect(words(html)).toContain('Supply run, Tuesday')
    const model = linkedTo(null)
    expect(attentionCards(model, contextOf(model))[0]!.actions).toEqual(['open-workspace', 'link-run'])
  })

  test('a plan linked to another Run says so by its title and opens beside that Run', () => {
    const html = picker(linkedTo('run-9'), 'run-1', 'Supply run, Tuesday')
    expect(words(html)).toContain('This plan is linked to “Supply run, Tuesday”, not to this Run.')
    expect(buttons(html)).toContain('Open this plan beside “Supply run, Tuesday”')
    // A Run the catalogue does not list cannot be opened: it is said without a title, and nothing is offered.
    const unlisted = picker(linkedTo('run-gone'), 'run-1', null)
    expect(words(unlisted)).toContain('This plan is linked to another simulation, not to this Run.')
    expect(buttons(unlisted).some(button => button.startsWith('Open this plan beside'))).toBe(false)
  })

  test('a plan linked to this Run is as before', () => {
    const beside = picker(linkedTo('run-1'), 'run-1', 'Supply run, this one')
    const alone = picker(linkedTo('run-1'), null, 'Supply run, this one')
    expect(beside).toBe(alone)
    expect(words(beside)).toContain('Values read; this plan names no World items yet.')
    expect(words(beside)).not.toContain('not to this Run')
  })

  test('the back link returns to the plans for this Run', () => {
    const props = { client: offline, planId: '0b4b9a52-2f7e-4c1a-9d3e-0000000000aa', initial: linkedTo('run-1'), onChanged: none, onOpenWorkspace: none, onOpenLibrary: none, onOpenBeside: none }
    expect(words(renderHtml(PlanScreen, { ...props, besideRun: 'run-1' }))).toContain('← Plans for this Run')
    expect(words(renderHtml(PlanScreen, props))).toContain('← All plans')
    expect(words(renderHtml(PlanScreen, props))).not.toContain('Plans for this Run')
  })

  test('a linked plan never read reads its values when it opens beside its own Run, and only then', () => {
    expect(readsOnOpen(linkedTo('run-1', null), 'run-1')).toBe(true)
    expect(readsOnOpen(linkedTo('run-1', at), 'run-1')).toBe(false)
    expect(readsOnOpen(linkedTo('run-9', null), 'run-1')).toBe(false)
    expect(readsOnOpen(linkedTo(null, null), 'run-1')).toBe(false)
    expect(readsOnOpen(linkedTo('run-1', null), null)).toBe(false)
  })
})
