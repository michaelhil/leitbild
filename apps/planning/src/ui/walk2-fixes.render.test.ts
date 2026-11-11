// One test per screen defect from maint's second walk (maint/walk-inc1-r2.md), named by screenshot id.
// Each would have failed on the walked build (83976f92f).
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { attentionCards } from './attention.ts'
import { alignWindowEdit, crewEdit, simulationNow } from './edit-forms.ts'
import { finishChain, whyStart } from './explain-text.ts'
import { modelOf, supplyRunInputs, trainAInputs, trainAPlanned } from './fixtures/plans.ts'
import { cutShort, readableText, registerSvelte, renderHtml, routineBreaches } from './fixtures/svelte-ssr.ts'
import { changedText, createTimeFormat, factText, routineFact } from './format.ts'
import { createNames, type PlanModel } from './model.ts'
import { outcomeBanner } from './outcome.ts'
import type { Preview } from './preview.ts'
import type { Context } from './status-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: EditPreview } = await import('./EditPreview.svelte') as { default: Any }
const { default: JobPanel } = await import('./JobPanel.svelte') as { default: Any }
const { default: AttentionColumn } = await import('./AttentionColumn.svelte') as { default: Any }

const contextOf = (model: PlanModel): Context => ({ inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) })
const none = () => {}
const writeOf = (model: PlanModel) => ({
  plan: { id: model.id, title: model.title, revision: model.revision },
  target: { kind: 'resource' as const, ref: workspaceResourceReferenceSchema.parse({ workspaceId: '0b4b9a52-2f7e-4c1a-9d3e-00000000000a', moduleId: 'planning', type: 'planning.plan', id: model.id }) },
  changed: [], attention: [],
})

describe("maint's second walk, screen defects", () => {
  test('D2-01, D2-02, D2-03 (R2-1): adding a World truck is not refused; what Generate still needs is listed, by name', () => {
    const inputs = supplyRunInputs()
    const model = modelOf({ ...inputs, settings: { ...inputs.settings, run: { id: 'run-1', linkedAt: '2026-09-03T08:00:00Z' } } })
    const pending = [{ edit: 'resource' as const, key: 'Truck-9', label: 'Truck 9', kind: 'tool' as const, count: 1, calendar: 'exercise', attributes: [], locator: 'einsatz/unit/unit%3Atruck-9', source: { by: 'planner' as const } }]
    const preview: Preview = {
      label: 'Add Truck 9 as a tool', refusal: null, asks: null,
      result: { ...writeOf(model), problems: [{ about: ['Truck-9'], code: 'world-unread', text: 'Truck 9: 2 World values are not read yet; refresh.' }], preview: { saved: false, consequence: 'Adds Truck 9.', violations: [], weakens: [] } },
    }
    const text = readableText(renderHtml(EditPreview, { preview, pending, context: contextOf(model), onApply: none, onDiscard: none, onUseTime: none }))
    expect(text).not.toContain('Refused')
    expect(text).toContain('Before Generate can run Truck 9: 2 World values are not read yet; refresh.')
    expect(text).toContain('Apply')
    expect(routineBreaches(text, ['Truck-9', 'world-unread'], ['Truck 9'])).toEqual([])
  })

  test('N-03, N-04 (R2-2): a drafted tag-out or test is given its crew in the preview and in the job panel', () => {
    const model = modelOf(trainAInputs())
    const preview: Preview = {
      label: 'Add the work on SW A', refusal: null, asks: null,
      result: { ...writeOf(model), problems: [{ about: ['SWA-TAG-2'], code: 'no-crew', text: "The drafted tag-out 'Tag out Service Water Pump A' needs a crew: add one." }], preview: { saved: false, consequence: 'Adds the work and drafts its tag-out and test.', violations: [], weakens: [] } },
    }
    const html = renderHtml(EditPreview, { preview, context: contextOf(model), onApply: none, onDiscard: none, onUseTime: none, onAddEdits: none })
    expect(readableText(html)).toContain('Who does the drafted jobs Tag out Service Water Pump A Who does it Choose a crew or tool…')
    expect(readableText(html)).toContain("Before Generate can run The drafted tag-out 'Tag out Service Water Pump A' needs a crew: add one.")
    expect(crewEdit('SWA-TAG-2', 'work-control')).toEqual({ ok: true, edits: [{ edit: 'job', key: 'SWA-TAG-2', needs: [{ anyOf: ['work-control'], amount: 1 }] }] })
    expect(crewEdit('SWA-RTS', 'work-control', 'test-team')).toEqual({ ok: true, edits: [{ edit: 'job', key: 'SWA-RTS', needs: [{ anyOf: ['work-control'], amount: 1 }, { anyOf: ['test-team'], amount: 1 }] }] })
    // In the job panel too, for any job; a job with no crew says so.
    const draft = { ...model.inputs.jobs.find(job => job.key === 'SWA-TAG')!, needs: [] }
    const withDraft = modelOf({ ...model.inputs, jobs: model.inputs.jobs.map(job => job.key === draft.key ? draft : job) })
    const panel = readableText(renderHtml(JobPanel, { jobKey: draft.key, context: contextOf(withDraft), row: undefined, why: null, onWhy: none, onPreview: none, onClose: none }))
    expect(panel).toContain('Who does it No crew or tool yet: Generate needs one for its working time.')
    expect(panel).toContain('Done by')
  })

  test('T6-04, D6-01, D6-02, T7-01 (R2-3): explanations with mixed names never say "no longer in this plan"', () => {
    const model = trainAPlanned()
    const context = contextOf(model)
    const rows = model.rows['opt-1']!
    const pull = rows.find(row => row.job === 'SWA-PUMP-OUT')!
    // Each name in `about` says its kind: a busy crew with the jobs holding it; the crews whose shift is off.
    const why = whyStart({ job: 'SWA-PUMP-OUT', start: pull.start, finish: pull.finish, floatHours: 0, joint: true, because: [
      { kind: 'crew', about: [{ kind: 'resource', key: 'mech-station' }, { kind: 'job', key: 'SWA-TAG' }, { kind: 'job', key: 'SWA-RTS' }], until: pull.start },
      { kind: 'shift', about: [{ kind: 'resource', key: 'ect-team' }], until: pull.start },
      { kind: 'tool', about: [{ kind: 'resource', key: 'crane' }] },
    ] }, context, pull)
    expect(why.sentence).not.toContain('no longer in this plan')
    expect(why.sentence).toContain('Station mechanical crew is busy with Remove SW A from service and hang tags and Restore SW A, fill and vent, pump test until Tue 07:00')
    expect(why.sentence).toContain('no working time for Eddy-current test contractor until Tue 07:00')
    const chain = finishChain({ lines: [], items: [{ job: 'SWA-RTS', start: rows[2]!.start, finish: rows[2]!.finish, floatHours: 0, joint: false, because: [{ kind: 'shift', about: [{ kind: 'calendar', key: 'day' }, { kind: 'resource', key: 'mech-station' }] }] }] }, context)
    expect(chain[0]!.because).toBe('no working time on Day shift for Station mechanical crew')
    expect(routineBreaches(`${why.sentence} ${chain[0]!.because}`, [], [])).toEqual([])
    // Rendered where the planner reads it: the finish chain in the attention column, and the job panel's answer.
    const column = readableText(renderHtml(AttentionColumn, { cards: [], finish: chain, onAction: none }))
    const panel = readableText(renderHtml(JobPanel, { jobKey: 'SWA-PUMP-OUT', context, row: pull, why, onWhy: none, onPreview: none, onClose: none }))
    for (const text of [column, panel]) expect(text).not.toContain('no longer in this plan')
  })

  test('T0s-01, T0s-03 (R2-6): when the linked simulation is outside the window, attention says so and offers to align it', () => {
    const inputs = trainAInputs()
    const at = '2026-09-03T08:00:00Z'
    const model = modelOf({ ...inputs, settings: { ...inputs.settings, run: { id: 'run-1', linkedAt: at } }, world: { refreshedAt: at, facts: [{ locator: inputs.equipment.find(item => item.key === 'SWB')!.locator!, id: 'running', label: 'Running', quantity: 'state', value: true, basis: 'observed', at }] } })
    const card = attentionCards(model, contextOf(model)).find(item => item.actions.includes('align-window'))!
    expect(card.title).toBe("The linked simulation is at Thu 3 Sep 10:00 (simulation time), outside this plan's window, Mon 16 Nov 07:00 to Sat 21 Nov 07:00.")
    // Hand calculation: the window is 5 days long; it moves to start at the simulation's hour, 08:00 UTC.
    const length = Date.parse(inputs.settings.window!.end) - Date.parse(inputs.settings.window!.start)
    expect(alignWindowEdit(model.inputs, simulationNow(model.inputs)!)).toEqual({ ok: true, edits: [{ edit: 'plan', window: { start: '2026-09-03T08:00:00.000Z', end: new Date(Date.parse('2026-09-03T08:00:00Z') + length).toISOString() }, dataDate: '2026-09-03T08:00:00.000Z' }] })
    expect(attentionCards(modelOf(inputs), contextOf(modelOf(inputs))).some(item => item.actions.includes('align-window'))).toBe(false)
    // Lane P's rule: a simulation at the plan's "now", days before the window, is planning ahead (the
    // Train A flagship: now Thu 12 Nov, window from Mon 16 Nov). No card then.
    const ahead = modelOf({ ...model.inputs, world: { refreshedAt: inputs.settings.dataDate, facts: model.inputs.world.facts.map(fact => ({ ...fact, at: inputs.settings.dataDate! })) } })
    expect(attentionCards(ahead, contextOf(ahead)).some(item => item.actions.includes('align-window'))).toBe(false)
    // Without a "now", the wall clock stands in: the Supply walk's 3 Sep simulation against a November window.
    const noNow = modelOf({ ...model.inputs, settings: { ...model.inputs.settings, dataDate: null } })
    expect(attentionCards(noNow, contextOf(noNow), Date.parse('2026-11-11T08:00:00Z')).some(item => item.actions.includes('align-window'))).toBe(true)
  })

  test('D5-02, N-05, T20-04 (R2-7): no raw kinds, no plain World counts, and cut text is caught', () => {
    expect(routineBreaches('world-unread: an item', [], [])).toEqual(expect.arrayContaining(['raw kind prefix']))
    expect(routineBreaches('no-tag-out: SW A', [], [])).toEqual(expect.arrayContaining(['raw kind prefix']))
    expect(routineBreaches('link: Close CCW HX A heads', [], [])).toEqual(['raw kind prefix'])
    expect(routineBreaches('invalid input: working_time_without_resource', [], [])).toEqual(expect.arrayContaining(['snake_case code']))
    expect(cutShort(["'Once the first Train A cooling item is tagged out, ever", 'Every item must be back within 72 h.', 'Clipped at a word…'])).toEqual(["'Once the first Train A cooling item is tagged out, ever"])
    const count = { label: 'Committed job steps', value: 0, unit: '1', basis: 'observed' as const, at: '2026-09-03T08:00:00Z' }
    expect(routineFact(count)).toBe(false)
    expect(factText({ ...count, label: 'Seats', value: 4 }, createTimeFormat('Europe/Oslo'))).toBe('Seats: 4 · observed · read Thu 3 Sep 10:00 (simulation time)')
  })

  test('D7-01, D7-02 (R2-8): read times are dated; the plan list says when it changed, labelled, without seconds', () => {
    const now = Date.parse('2026-11-11T07:54:18Z')
    expect(changedText('2026-11-11T07:49:18Z', now, 'Europe/Oslo')).toBe('changed 5 min ago')
    expect(changedText('2026-11-11T05:49:18Z', now, 'Europe/Oslo')).toBe('changed 2 h ago')
    expect(changedText('2026-11-09T07:49:18Z', now, 'Europe/Oslo')).toBe('changed Mon 9 Nov 08:49 (your time)')
  })

  test('T6-03, T4-01 (R2-11): the After list holds only the shown option\'s jobs; a recommendation is not drawn as an alarm', () => {
    const model = trainAPlanned()
    const context = contextOf(model)
    const rows = model.rows['opt-1']!
    const scheduled = new Set(rows.map(row => row.job))
    // SWA-REBUILD (rebuild method) follows the pump pull; the shown option does not schedule it.
    const all = readableText(renderHtml(JobPanel, { jobKey: 'SWA-PUMP-OUT', context, row: rows[1], scheduled: null, why: null, onWhy: none, onPreview: none, onClose: none }))
    expect(all).toContain('Rebuild SW A bowl assembly in workshop starts after this finishes (only with “Rebuild in place”)')
    const shown = readableText(renderHtml(JobPanel, { jobKey: 'SWA-PUMP-OUT', context, row: rows[1], scheduled, why: null, onWhy: none, onPreview: none, onClose: none }))
    expect(shown).not.toContain('Rebuild SW A bowl assembly in workshop')
    expect(outcomeBanner(model, context)?.recommended).toBe(true)
  })
})
