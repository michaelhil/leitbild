// One test per defect maint's increment 1 walk found on the screen (maint/walk-inc1.md), named by its
// screenshot ids. Each would have failed on the walked build.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Component } from 'svelte'
import { workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createPlanningClient } from './api.ts'
import { attentionCards } from './attention.ts'
import { hourMs, identifiers, modelOf, optionOf, runBasis, status, supplyRunPlanned, trainAInputs, trainAPlanned } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml, routineBreaches } from './fixtures/svelte-ssr.ts'
import { createTimeFormat } from './format.ts'
import { createNames, type PlanModel, type PlanView } from './model.ts'
import { outcomeBanner } from './outcome.ts'
import type { Preview } from './preview.ts'
import type { Context } from './status-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: PlanScreen } = await import('./PlanScreen.svelte') as { default: Any }
const { default: EditPreview } = await import('./EditPreview.svelte') as { default: Any }
const { default: JobPanel } = await import('./JobPanel.svelte') as { default: Any }
const { default: Choice } = await import('./Choice.svelte') as { default: Any }

const offline = createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => { throw new Error('No Host in a render test') })
const screen = (model: PlanModel, view: PlanView = 'schedule') => readableText(renderHtml(PlanScreen, {
  client: offline, planId: model.id, initial: model, initialView: view, onChanged: () => {}, onOpenWorkspace: () => {}, onOpenLibrary: () => {},
}))
const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const none = () => {}

/** Train A with both days-only options proven infeasible, and the Module's refusal lines for each. */
const daysOnly = (): PlanModel => {
  const base = trainAInputs()
  const run = runBasis(base.settings.grid)
  const chain = status({ word: 'proven infeasible', run, cause: { kind: 'chain', jobs: ['SWA-PUMP-OUT', 'SWA-REBUILD', 'SWA-RTS'], workHours: 37, calendars: ['day'], availableHours: 32, from: '2026-11-16T06:00:00Z', by: '2026-11-20T14:00:00Z' } })
  const temporal = status({ word: 'proven infeasible', run, cause: { kind: 'temporal', steps: [{ job: 'SWA-TAG', via: 'span-limit' }, { job: 'SWA-RTS', via: 'link' }] } })
  return modelOf(base, {
    options: { at: '2026-11-12T09:05:00.000Z', recommended: null, items: [optionOf('v1', 'Rebuild in place, days only', chain), optionOf('v2', 'Swap in refurbished spare, days only', temporal)] },
    // Hand-written stand-ins for explain (ask refusal) answers, in the Module's form.
    refusals: {
      v1: ['Not possible: 3 jobs must run one after another and need 37 h of work, but from Mon 07:00 to Fri 15:00 their crews and tools are on duty together for only 32 h.'],
      v2: ['Not possible: the cooling chain must be back within 72 h.', 'The shortest span this plan allows is 80 h, against 72 h: first tag-out Mon 07:00, last test passed Thu 15:00.'],
    },
  })
}

describe('maint walk defects on the plan screen', () => {
  test('T5-01, T5-02: every refused option says its cause in hours on the plan screen: one line in the options table, in full in its detail (walk 7)', () => {
    const model = daysOnly()
    const banner = outcomeBanner(model, contextOf(model))!
    // The banner says there is none and where the reason is; it repeats no cause.
    expect(banner.title).toBe('No option can be recommended: both are not possible. See why on the right.')
    expect(banner.lines).toEqual([])
    expect(outcomeBanner(model, contextOf(model), 'below')!.title).toBe('No option can be recommended: both are not possible. See why below.')
    const cards = attentionCards(model, contextOf(model)).map(card => `${card.title} ${card.text}`)
    expect(cards).toContain('Rebuild in place, days only: proven infeasible. Not possible. The options table says why.')
    expect(cards).toContain('Swap in refurbished spare, days only: proven infeasible. Not possible. The options table says why.')
    const text = screen(model)
    expect(text).toContain('No option can be recommended: both are not possible.')
    // The table: each cause as one short line with its hours.
    expect(text).toContain('Not possible: 37 h of work one after another, only 32 h of working time.')
    expect(text).toContain('Not possible: The shortest span this plan allows is 80 h, against 72 h.')
    // The first refused option's proof is open in full; so its hours are on the screen twice, the other's once.
    expect(text).toContain('Not possible: 3 jobs must run one after another and need 37 h of work, but from Mon 07:00 to Fri 15:00 their crews and tools are on duty together for only 32 h.')
    expect(text.split('only 32 h').length - 1).toBe(2)
    expect(text.split('80 h, against 72 h').length - 1).toBe(1)
  })

  test('T20-02: a refused edit shows the rule in words and the nearest allowed time, moves nothing, and never shows raw kinds', () => {
    const model = trainAPlanned()
    const context = contextOf(model)
    const nearest = new Date(Date.parse(model.inputs.settings.window!.start) + 30 * hourMs).toISOString()
    const write = { plan: { id: model.id, title: model.title, revision: 3 }, target: { kind: 'resource' as const, ref: workspaceResourceReferenceSchema.parse({ workspaceId: '0b4b9a52-2f7e-4c1a-9d3e-00000000000a', moduleId: 'planning', type: 'planning.plan', id: model.id }) }, changed: [], attention: [], problems: [] }
    // The Module refuses an edit that is itself invalid with the rule in its words and the nearest allowed time.
    const preview: Preview = { label: 'Fix the start of the CCW A test', result: null, asks: null, refusal: { text: 'The CCW A test must wait until the CCW HX A heads are closed.', needsAuthority: false, nearestAllowed: nearest } }
    const text = readableText(renderHtml(EditPreview, { preview, context, onApply: none, onDiscard: none, onUseTime: none }))
    expect(text).toContain('This change cannot be saved.')
    expect(text).toContain('The CCW A test must wait until the CCW HX A heads are closed.')
    expect(text).toContain('Nearest allowed start: Tue 17 Nov 13:00')
    expect(text).not.toContain('jobs move')
    expect(text).not.toMatch(/\b(link|bracket):/)
    void write
    // An error refusal carries the same three things.
    const refused: Preview = { label: 'Shorten the SW A test', result: null, refusal: { text: 'The SW A test may not run shorter than 2.5 h. Name the person who agreed and their reason. Ask them; never fill this in yourself.', needsAuthority: true, nearestAllowed: null }, asks: null }
    const asked = readableText(renderHtml(EditPreview, { preview: refused, context, onApply: none, onDiscard: none, onUseTime: none }))
    expect(asked).toContain('Ask them; never fill this in yourself.')
    expect(asked).toContain('Who agreed')
  })

  test('J-05, T1-04, S-03: model digests, World locators and bare step numbers stay off routine screens', () => {
    const inputs = trainAInputs()
    const swb = inputs.equipment.find(item => item.key === 'SWB')!
    const at = '2026-11-12T09:00:00Z'
    // Test inputs standing in for a World read: a model digest and a step list next to a planner value.
    const facts = [
      { locator: swb.locator!, id: 'digest', label: 'Plant model revision', quantity: 'digest', value: 'b7d6924f768f44bf2b7c965b85aae723386c7e47dff6908b95bb1ae581425cb5', basis: 'design' as const, at },
      { locator: swb.locator!, id: 'steps', label: 'Committed job steps', quantity: 'list', value: '0 1', basis: 'observed' as const, at },
      { locator: swb.locator!, id: 'where', label: 'Task', quantity: 'item', value: 'einsatz/task/task%3Afield-kitchen', basis: 'observed' as const, at },
      { locator: swb.locator!, id: 'running', label: 'Running', quantity: 'state', value: true, basis: 'observed' as const, at },
    ]
    const model = modelOf({ ...inputs, settings: { ...inputs.settings, run: { id: 'run-1', linkedAt: at } }, world: { refreshedAt: at, facts } })
    for (const view of ['schedule', 'equipment', 'rules', 'crews'] as const) {
      const text = screen(model, view)
      expect({ view, breaches: routineBreaches(text, identifiers(model.inputs), [...inputs.equipment.map(item => item.label), ...inputs.jobs.map(job => job.title)]).filter(breach => !breach.startsWith('id ')) }).toEqual({ view, breaches: [] })
    }
    expect(screen(model, 'equipment')).toContain('Running: yes · observed · read Thu 12 Nov 10:00 (simulation time)')
    // The checker itself catches each of them.
    expect(routineBreaches('Plant model revision: b7d6924f768f44bf2b7c965b85aae723386c7e47dff6908b95bb1ae581425cb5', [], [])).toContain('hex digest')
    expect(routineBreaches('Read einsatz/task/task%3Afield-kitchen: Priority', [], [])).toContain('World locator')
    expect(routineBreaches('Truck 1: Committed job steps 0 1 (observed)', [], [])).toContain('bare step numbers')
  })

  test('J-03, S-02, J-05: World times say simulation time; no wall-clock read time is shown', () => {
    const model = supplyRunPlanned()
    const equipment = screen(model, 'equipment')
    expect(equipment).toContain('Values describe simulation time Thu 3 Sep 10:00.')
    expect(equipment).not.toMatch(/Values read [A-Z][a-z]{2} \d\d:\d\d/)
    expect(screen(model, 'crews')).toContain('read Thu 3 Sep 10:00 (simulation time)')
    expect(screen(model)).toContain('Times in Europe/Oslo')
  })

  test('S-05: the Supply run job panel names the truck the plan uses', () => {
    const model = supplyRunPlanned()
    const row = model.rows['opt-1']!.find(entry => entry.job === 'U-1')!
    const truck = model.inputs.resources.find(resource => resource.key === row.uses[0]!.resource)!.label
    const text = readableText(renderHtml(JobPanel, { jobKey: 'U-1', context: contextOf(model), row, why: null, onWhy: none, onPreview: none, onClose: none }))
    expect(text).toContain(`With ${truck}.`)
  })

  test('T0p-11: no native select anywhere; a choice is radio buttons or a list of plain buttons', () => {
    const sources = readdirSync(import.meta.dir).filter(name => name.endsWith('.svelte'))
    expect(sources.filter(name => /<select[\s>]/.test(readFileSync(join(import.meta.dir, name), 'utf8')))).toEqual([])
    const few = renderHtml(Choice, { label: 'Unit', value: 'h', options: [{ value: 'h', label: 'hours' }, { value: 'min', label: 'minutes' }] })
    expect(few).toContain('type="radio"')
    expect(few).toMatch(/value="h" checked/)
    const many = renderHtml(Choice, { label: 'First job', value: '', options: [{ value: '', label: 'Choose…' }, ...trainAInputs().jobs.map(job => ({ value: job.key, label: job.title }))] })
    expect(many).toContain('aria-expanded="false"')
    expect(readableText(many)).toContain('First job Choose…')
  })
})
