// One test per screen defect from maint's third walk (maint/walk-inc1-r3.md), named by screenshot id.
// Each would have failed on the walked build (6b317124d).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Component } from 'svelte'
import type { PlanningSubject } from '@leitbild/contracts'
import { applyEdits } from '../plan/edits.ts'
import { createPlanningClient } from './api.ts'
import { attentionCards } from './attention.ts'
import { alignWindowEdit, resourceFromWorld, simulationNow, wholeWindowCalendars, worldAttributes } from './edit-forms.ts'
import { finishChain, mostLimiting, whyStart, type ExplainResult } from './explain-text.ts'
import { modelOf, runBasis, status, supplyRunInputs, trainAPlanned } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml, routineBreaches } from './fixtures/svelte-ssr.ts'
import { createTimeFormat } from './format.ts'
import { createNames, type PlanModel } from './model.ts'
import { outcomeBanner } from './outcome.ts'
import type { Preview } from './preview.ts'
import type { Context } from './status-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: AttentionColumn } = await import('./AttentionColumn.svelte') as { default: Any }
const { default: EditPreview } = await import('./EditPreview.svelte') as { default: Any }
const { default: EquipmentPicker } = await import('./EquipmentPicker.svelte') as { default: Any }
const { default: PlanHeader } = await import('./PlanHeader.svelte') as { default: Any }
const { default: PlanScreen } = await import('./PlanScreen.svelte') as { default: Any }

const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const none = () => {}
const at = '2026-09-03T08:00:00Z'
const truck: PlanningSubject = {
  locator: 'einsatz/unit/unit%3Atruck-9', label: 'Truck 9', kind: 'vehicle',
  facts: [
    { id: 'unit:truck-9/property/payloadKg', label: 'Payload', quantity: 'mass', unit: 'kg', value: 900, basis: 'configured', at },
    { id: 'unit:truck-9/queued-steps', label: 'Committed job steps', quantity: 'count', unit: '1', value: 0, basis: 'observed', at },
  ],
}

describe("maint's third walk, screen defects", () => {
  test('N-B-01, N-C-03 (R3-2): a World truck takes only values the plan can use; no unusable count makes it not ready', () => {
    expect(worldAttributes(truck).map(attribute => attribute.label)).toEqual(['Payload'])
    const built = resourceFromWorld(truck, { kind: 'tool', calendar: '' }, supplyRunInputs())
    expect(JSON.stringify(built)).not.toContain('queued-steps')
  })

  test('N-C-05, N-B-02 (R3-1 screen part, R3-7): aligning the window moves the whole-window calendars with it, and the picker offers one whole-window choice', () => {
    const inputs = supplyRunInputs()
    const november = { start: '2026-11-12T07:00:00.000Z', end: '2026-11-12T07:30:00.000Z' }
    // The Supply run moved to a November window, its "exercise" calendar with it; the Run is in September.
    const moved = modelOf({
      ...inputs,
      settings: { ...inputs.settings, window: november, dataDate: null, run: { id: 'run-1', linkedAt: at } },
      calendars: inputs.calendars.map(calendar => calendar.key === 'exercise' ? { ...calendar, periods: [november] } : calendar),
      world: { refreshedAt: at, facts: [{ locator: 'einsatz/unit/unit%3Atruck-1', id: 'unit:truck-1/property/payloadKg', label: 'Payload', quantity: 'mass', unit: 'kg', value: 300, basis: 'configured', at }] },
    })
    expect(wholeWindowCalendars(moved.inputs).map(calendar => calendar.key)).toEqual(['exercise'])
    const aligned = alignWindowEdit(moved.inputs, simulationNow(moved.inputs)!)
    const september = { start: '2026-09-03T08:00:00.000Z', end: '2026-09-03T08:30:00.000Z' }
    // N-C-05: the screen sends only the window edit; the Module moves the whole-window calendar, once.
    expect(aligned.ok && aligned.edits).toEqual([{ edit: 'plan', window: september, dataDate: '2026-09-03T08:00:00.000Z' }])
    if (!aligned.ok) return
    const applied = applyEdits(moved.inputs, aligned.edits, { now: '2026-11-11T08:00:00.000Z', by: { kind: 'human' } }).inputs
    const periods = (key: string) => applied.calendars.find(calendar => calendar.key === key)!.periods.map(period => [Date.parse(period.start), Date.parse(period.end)])
    expect(periods('exercise')).toEqual([[Date.parse(september.start), Date.parse(september.end)]])
    // The announced joins are not the window: they stay where they were.
    for (const join of ['joins-0802', 'joins-08053']) expect(periods(join)).toEqual(moved.inputs.calendars.find(calendar => calendar.key === join)!.periods.map(period => [Date.parse(period.start), Date.parse(period.end)]))
    const picker = readableText(renderHtml(EquipmentPicker, {
      context: contextOf(moved), runs: [], linkedRun: 'Supply run', onLink: none, onRefresh: none, onOpenWorkspace: none, onFindRuns: none,
      onSearch: async () => [truck], onDetail: async () => truck, onPreview: none,
    }))
    expect(picker.match(/whole window/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  test('N-A-01…03 (R3-3): a search that stopped early says so in the banner and in attention', () => {
    const planned = trainAPlanned()
    const early = status({ ...planned.options!.items[0]!.status, run: { ...runBasis(planned.inputs.settings.grid), stoppedBy: 'memory' } })
    const model: PlanModel = { ...planned, options: { ...planned.options!, items: [{ ...planned.options!.items[0]!, status: early }] } }
    const context = contextOf(model)
    expect(outcomeBanner(model, context)!.lines[0]).toBe('The search stopped early, at the memory limit: this option may not be the best. Generate again.')
    const card = attentionCards(model, context).find(item => item.mark.word === 'Stopped early')!
    expect([card.title, card.actions]).toEqual(['The search stopped early, at the memory limit.', ['generate']])
    expect(outcomeBanner(planned, contextOf(planned))!.lines).toEqual([])
  })

  test('T6-01, T7-01 (R3-4, R3-5): every named job, crew or rule in an explanation is a link, and one line says what limits most', () => {
    const model = trainAPlanned()
    const context = contextOf(model)
    const rows = model.rows['opt-1']!
    const result: ExplainResult = { lines: [], items: [
      { job: 'SWA-RTS', start: rows[2]!.start, finish: rows[2]!.finish, floatHours: 0, joint: false, because: [{ kind: 'crew', about: [{ kind: 'resource', key: 'mech-station' }, { kind: 'job', key: 'SWA-PUMP-OUT' }] }] },
      { job: 'SWA-PUMP-OUT', start: rows[1]!.start, finish: rows[1]!.finish, floatHours: 0, joint: false, because: [{ kind: 'crew', about: [{ kind: 'resource', key: 'mech-station' }] }, { kind: 'tool', about: [{ kind: 'resource', key: 'crane' }] }] },
      { job: 'SWA-TAG', start: rows[0]!.start, finish: rows[0]!.finish, floatHours: 0, joint: false, because: [{ kind: 'span-limit', about: [{ kind: 'rule', key: 'R2' }] }] },
    ] }
    const html = renderHtml(AttentionColumn, { cards: [], finish: finishChain(result, context), limiting: mostLimiting(result, context), onAction: none, onPick: none })
    const names = [...html.matchAll(/<a class="name" href="[^"]*"[^>]*>([^<]*)<\/a>/g)].map(match => match[1])
    expect(names).toEqual(expect.arrayContaining(['Station mechanical crew', 'Pull SW A pump assembly', '60 t mobile crane with operator and rigger', 'Restore SW A, fill and vent, pump test']))
    expect(readableText(html)).toContain('Most limiting: Station mechanical crew (2): the finish waits for it at 2 of 3 steps.')
    const why = whyStart(result.items[0]!, context, rows[2])
    expect(why.parts.filter(part => typeof part !== 'string').map(part => typeof part === 'string' ? '' : part.kind)).toEqual(['resource', 'job'])
    // No rule key on screen; rules are named by their words (R3-6).
    expect(routineBreaches(readableText(html), ['R2', 'mech-station', 'SWA-PUMP-OUT'], [])).toEqual([])
  })

  test('R2-4-03, N6-01 (R3-6): one card for one stale state; one World-read state', () => {
    const planned = trainAPlanned()
    const stale: PlanModel = { ...planned, attention: [{ kind: 'stale', text: 'The options were made before the latest change; generate again.', about: [] }], options: { ...planned.options!, items: planned.options!.items.map(option => ({ ...option, fresh: false })) } }
    const cards = attentionCards(stale, contextOf(stale)).map(card => card.title)
    expect(cards.filter(title => /before the latest change|generate again/.test(title))).toEqual(['The options were made before the latest change; generate again.'])
    const inputs = supplyRunInputs()
    const readNone = modelOf({ ...inputs, settings: { ...inputs.settings, run: { id: 'run-1', linkedAt: at } }, world: { refreshedAt: at, facts: [] } })
    const picker = readableText(renderHtml(EquipmentPicker, {
      context: contextOf(readNone), runs: [], linkedRun: 'Supply run', onLink: none, onRefresh: none, onOpenWorkspace: none, onFindRuns: none,
      onSearch: async () => [], onDetail: async () => truck, onPreview: none,
    }))
    expect(picker).toContain('Values read; this plan names no World items yet.')
    expect(picker).not.toContain('not read yet')
  })

  test('R2-2-03, N-A-04, R2-9-01 (R3-7): drafted jobs keep their crew choice; Generate keeps its look; the size line is plain', () => {
    const model = trainAPlanned()
    const preview: Preview = { label: 'Add work', refusal: null, asks: null, result: { plan: { id: model.id, title: model.title, revision: 3 }, target: { kind: 'resource', ref: { workspaceId: '0b4b9a52-2f7e-4c1a-9d3e-00000000000a', moduleId: 'planning', type: 'planning.plan', id: model.id } } as never, changed: [], attention: [], problems: [{ about: ['SWA-TAG-2'], code: 'no-crew', text: 'The drafted tag-out needs a crew: add one.' }], preview: { saved: false, consequence: 'Adds work.', violations: [], weakens: [] } } }
    expect(readableText(renderHtml(EditPreview, { preview, context: contextOf(model), onApply: none, onDiscard: none, onUseTime: none, onAddEdits: none }))).toContain('Who does the drafted jobs Tag out Service Water Pump A')
    const css = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8')
    expect(css).toContain('button.primary:hover:not(:disabled) { background: var(--accent-strong);')
    const size = { decided: false, family: 'single-train work weeks', maxJobs: 33, evidence: 'measured 11 Nov' }
    const header = readableText(renderHtml(PlanHeader, { context: contextOf(model), title: model.title, certified: { text: "Certified plan size: pending the owner's decision", measured: 'Measured: up to 33 jobs', evidence: size.evidence, plan: 'x' }, onGenerate: none, onCancel: none }))
    expect(header).toContain('Measured: up to 33 jobs')
    const client = createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => { throw new Error('No Host in a render test') })
    const screen = readableText(renderHtml(PlanScreen, { client, planId: model.id, initial: { ...model, certifiedSize: size }, onChanged: none, onOpenWorkspace: none, onOpenLibrary: none }))
    // Hand count: the fragment's jobs, with one of the two SW A methods per solve.
    expect(screen).toMatch(/This plan: \d+ jobs in one solve, within the measured size\./)
  })
})
