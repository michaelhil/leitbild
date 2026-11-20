// The Library beside a Run (`run` without `demo`): the plans for this Run, a new plan for it with what the
// Run offers said first, and the plans linked to no Run, folded with a count. Plans of other Runs stay with them.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import type { ModuleResourceDescriptor } from '@leitbild/contracts'
import { createPlanningClient } from './api.ts'
import type { RunOffer } from './beside-run.ts'
import { planResource, published, runResource, workspace } from './fixtures/beside-run.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: Library } = await import('./Library.svelte') as { default: Any }

const offline = createPlanningClient(workspace, async () => { throw new Error('No Host in a render test') })
const read: RunOffer = { state: 'read', kinds: [{ kind: 'pump', count: 4 }] }
const render = (resources: readonly ModuleResourceDescriptor[], offer: RunOffer = read, run: string | null = 'run-1'): string =>
  renderHtml(Library, { client: offline, onOpen: () => {}, run, initialDefinitions: published, initialResources: resources, initialOffer: offer })
const words = (html: string): string => readableText(html).replace(/\s+/g, ' ').trim()
const cardHtml = (html: string): readonly string[] => [...html.matchAll(/<article class="demo-card[^"]*">([\s\S]*?)<\/article>/g)].map(match => match[1]!)
const cards = (html: string): readonly string[] => cardHtml(html).map(words)
/** The buttons on the new-plan cards, in order. */
const buttons = (html: string): readonly string[] => cardHtml(html).flatMap(card => [...card.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(match => words(match[1]!)))
const titleOf = (id: string) => published.find(definition => definition.ref.id === id)!.title

const plans = [
  planResource('0b4b9a52-2f7e-4c1a-9d3e-000000000001', 'Week 47 for this Run', 'run-1'),
  planResource('0b4b9a52-2f7e-4c1a-9d3e-000000000002', 'Draft, not linked', null),
  planResource('0b4b9a52-2f7e-4c1a-9d3e-000000000003', 'Week 47 for another Run', 'run-9'),
]

describe('the Library beside a Run', () => {
  test('three groups in order: plans for this Run, a new plan for it, the unlinked plans folded with a count', () => {
    const html = render([runResource('run-1', 'Train A work week', 'train-a-work-week'), ...plans])
    const text = readableText(html).replace(/\s+/g, ' ')
    expect(text).toContain('Plans for “Train A work week”')
    const order = ['Plans for this Run', 'Week 47 for this Run', 'New plan for this Run', 'Planning can read 4 items', 'Unlinked plans (1)', 'Draft, not linked'].map(words => text.indexOf(words))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The unlinked plans are folded; a plan linked to another Run is not listed here.
    expect(html).toMatch(/<details class="beside-group unlinked[^"]*"><summary[^>]*>Unlinked plans \(1\)<\/summary>/)
    expect(text).not.toContain('Week 47 for another Run')
    expect(text).not.toContain('Plans in this Workspace')
  })

  test('a Train A Run offers the blank plan and Train A, each started for this Run; nothing else, and no World demo link', () => {
    const html = render([runResource('run-1', 'Train A work week', 'train-a-work-week'), ...plans])
    expect(cards(html)).toHaveLength(2)
    expect(cards(html)[0]).toStartWith(titleOf('blank'))
    expect(cards(html)[1]).toStartWith(titleOf('train-a-work-week'))
    expect(buttons(html)).toEqual(['New plan', 'Start this plan for this Run'])
    expect(html).not.toContain('Open World demo')
    expect(readableText(html)).not.toContain(titleOf('supply-run'))
  })

  test('a Run of a guided Scenario opens that Run\'s own plan, never its World demo; other guided plans are not offered', () => {
    const html = render([runResource('run-1', 'Halden: plan two deliveries', 'halden-delivery-planning')])
    expect(cards(html)).toHaveLength(2)
    expect(cards(html)[1]).toStartWith(titleOf('halden-delivery-planning'))
    expect(buttons(html)).toEqual(['New plan', 'Open this Run\'s plan'])
    expect(readableText(html)).not.toContain(titleOf('nuclear-maintenance-planning'))
    expect(html).not.toContain('Open World demo')
  })

  test('a Run of another Scenario offers the blank plan only, and says what Planning can read, or why not', () => {
    const grid = render([runResource('run-1', 'Nordic grid', 'nordic-grid')], { state: 'read', kinds: [] })
    expect(buttons(grid)).toEqual(['New plan'])
    expect(readableText(grid)).toContain('This simulation has nothing Planning can read. A plan can still use the planner\'s own figures.')
    expect(readableText(grid)).toContain('No plan is linked to this Run yet.')
    // No unlinked plans: no folded group.
    expect(grid).not.toContain('Unlinked plans')
    const roles = render([runResource('run-1', 'Exercise with roles', 'einsatz-exercise')], { state: 'not-read', text: 'Planning facts are read only from Runs without roles' })
    expect(readableText(roles)).toContain('Planning facts are read only from Runs without roles. A plan can still use the planner\'s own figures.')
    expect(buttons(roles)).toEqual(['New plan'])
  })

  test('a Run the catalogue does not list starts no plan, and says so', () => {
    const html = render(plans)
    expect(readableText(html)).toContain('Planning cannot find this Run in the Workspace, so it cannot start a plan for it.')
    expect(cards(html)).toEqual([])
    expect(readableText(html)).toContain('Week 47 for this Run')
  })

  test('the new plan form beside a Run says it links this Run; beside no Run it is as before', async () => {
    const { default: NewPlanForm } = await import('./NewPlanForm.svelte') as { default: Any }
    const props = { defaultZone: 'Europe/Oslo', defaultStart: '2026-11-23T07:00', defaultEnd: '2026-11-28T07:00', onCreate: () => {}, onCancel: () => {} }
    const forRun = words(renderHtml(NewPlanForm, { ...props, forRun: true }))
    expect(forRun).toStartWith('New plan for this Run')
    expect(forRun).toContain('Create the plan and link this Run')
    const alone = words(renderHtml(NewPlanForm, props))
    expect(alone).toStartWith('New plan Name')
    expect(alone).toContain('Create the plan Cancel')
  })

  test('beside no Run the Library is as before: every card, and every plan in the Workspace', () => {
    const html = render([runResource('run-1', 'Train A work week', 'train-a-work-week'), ...plans], read, null)
    const text = words(html)
    expect(cards(html)).toHaveLength(published.length)
    expect(text).toContain('Plans in this Workspace')
    for (const plan of plans) expect(text).toContain(plan.title)
    expect(text).not.toContain('New plan for this Run')
    expect(text).not.toContain('Planning can read')
  })
})
