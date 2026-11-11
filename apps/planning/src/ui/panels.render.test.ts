// The job panel ("why it starts then", float), the edit preview (refused with the nearest allowed time;
// weakening needs a named agreement) and the options list (refusals with their cause, warnings beside
// the status, stale options claiming nothing), rendered on the server.
import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import { workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { whyStart } from './explain-text.ts'
import { optionOf, runBasis, status, supplyRunPlanned, trainAPlanned } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'
import { createTimeFormat } from './format.ts'
import { createNames } from './model.ts'
import type { Preview } from './preview.ts'
import type { Context } from './status-text.ts'

registerSvelte()
type Any = Component<Record<string, unknown>>
const { default: JobPanel } = await import('./JobPanel.svelte') as { default: Any }
const { default: EditPreview } = await import('./EditPreview.svelte') as { default: Any }
const { default: OptionsTable } = await import('./OptionsTable.svelte') as { default: Any }
const { default: NewPlanForm } = await import('./NewPlanForm.svelte') as { default: Any }

const model = trainAPlanned()
const context: Context = { inputs: model.inputs, names: createNames(model.inputs), format: createTimeFormat(model.inputs.settings.timeZone) }
const rows = model.rows['opt-1']!
const write = {
  plan: { id: model.id, title: model.title, revision: 3 },
  target: { kind: 'resource' as const, ref: workspaceResourceReferenceSchema.parse({ workspaceId: '0b4b9a52-2f7e-4c1a-9d3e-00000000000a', moduleId: 'planning', type: 'planning.plan', id: model.id }) },
  changed: [], attention: [], problems: [],
}
const none = () => {}

describe('panels', () => {
  test('the job panel says why it starts then, with joint causes and float, and offers a previewed lock', () => {
    const test = rows.find(row => row.job === 'SWA-RTS')!
    const why = whyStart({ job: 'SWA-RTS', start: test.start, finish: test.finish, floatHours: test.float.workingHours, joint: true, because: [{ kind: 'link', about: ['SWA-PUMP-OUT'] }, { kind: 'crew', about: ['test-team'], until: test.start }] }, context, test)
    const text = readableText(renderHtml(JobPanel, { jobKey: 'SWA-RTS', context, row: test, why, onWhy: none, onPreview: none, onClose: none }))
    expect(text).toContain('Restore SW A, fill and vent, pump test')
    expect(text).toContain('Shortest allowed')
    expect(text).toContain('Going below it needs someone\'s agreement.')
    expect(text).toContain('These are joint causes: easing only one of them does not move the job.')
    expect(text).toContain('it follows Pull SW A pump assembly; Test team (one return-to-service test at a time) is busy until Tue 12:00.')
    expect(text).toContain('limited by: the window end (crew availability is not counted)')
    expect(text).toContain('Fix its start')
    // The heading takes focus when the panel opens, so the panel is never out of sight.
    expect(renderHtml(JobPanel, { jobKey: 'SWA-RTS', context, row: test, why, onWhy: none, onPreview: none, onClose: none })).toContain('<h2 id="job-title" tabindex="-1">')
    const tag = readableText(renderHtml(JobPanel, { jobKey: 'SWA-TAG', context, row: rows[0], why: null, onWhy: none, onPreview: none, onClose: none }))
    expect(tag).toContain('World shows SW B running')
    expect(tag).toContain('Checked against World at read time.')
    const spare = readableText(renderHtml(JobPanel, { jobKey: 'SWA-SPARE-PREP', context, row: undefined, why: null, onWhy: none, onPreview: none, onClose: none }))
    expect(spare).toContain('△ Assumption')
    expect(spare).toContain('Depends on a promise, Mon 12:00: it is planned at that time and flagged.')
  })

  test('a hard due time and a soft target differ by shape and word in the job panel', () => {
    // Hand calculation: 16 h before the window end (Sat 07:00) is Fri 15:00.
    const finishBy = new Date(Date.parse(model.inputs.settings.window!.end) - 16 * 3_600_000).toISOString()
    const inputs = { ...model.inputs, rules: [...model.inputs.rules, { kind: 'due' as const, key: 'D1', job: 'SWA-RTS', finishBy, words: 'SW A back for the Friday surveillance.', source: { by: 'planner' as const } }] }
    const dueContext: Context = { ...context, inputs, names: createNames(inputs) }
    const text = readableText(renderHtml(JobPanel, { jobKey: 'SWA-RTS', context: dueContext, row: rows[2], why: null, onWhy: none, onPreview: none, onClose: none }))
    expect(text).toContain('Due by ■ Rule Fri 15:00: SW A back for the Friday surveillance.')
    expect(text).toContain('A hard rule: no plan finishes it later.')
    const supply = supplyRunPlanned()
    const supplyContext: Context = { inputs: supply.inputs, names: createNames(supply.inputs), format: createTimeFormat(supply.inputs.settings.timeZone) }
    const target = readableText(renderHtml(JobPanel, { jobKey: 'U-1', context: supplyContext, row: supply.rows['opt-1']![1], why: null, onWhy: none, onPreview: none, onClose: none }))
    expect(target).toContain('Wanted finish ◎ Target Thu 10:07')
    expect(target).toContain('A goal, not a rule: it may slip, and lateness is counted.')
  })

  test('removing or moving a rule later asks who agreed before the Module is even asked', () => {
    const preview: Preview = { label: 'Move the due time', result: { ...write, preview: { saved: false, consequence: 'The test may finish later.', violations: [], weakens: [] } }, refusal: null, asks: 'Moving a due time later weakens it' }
    const text = readableText(renderHtml(EditPreview, { preview, context, onApply: none, onDiscard: none, onUseTime: none }))
    expect(text).toContain('Moving a due time later weakens it')
    expect(text).toContain('Who agreed')
  })

  test('an edit that breaks a hard rule is refused in words, with the nearest allowed start (T20)', () => {
    const preview: Preview = {
      label: 'Fix the start of Restore SW A, fill and vent, pump test',
      result: { ...write, preview: { saved: false, consequence: 'The test would start before the pump is back in place.', violations: ['The return-to-service test must follow the work on SW A.'], weakens: [], nearestAllowed: rows[2]!.start } },
      refusal: null, asks: null,
    }
    const text = readableText(renderHtml(EditPreview, { preview, context, onApply: none, onDiscard: none, onUseTime: none }))
    expect(text).toContain('✕ Refused')
    expect(text).toContain('The return-to-service test must follow the work on SW A.')
    expect(text).toContain('Nearest allowed start: Tue 12:00')
    expect(text).toContain('Use this time')
    expect(text).not.toContain('Apply')
    expect(renderHtml(EditPreview, { preview, context, onApply: none, onDiscard: none, onUseTime: none })).toContain('<h2 id="preview-title" tabindex="-1">')
  })

  test('the site time zone is chosen from a list of zones, the default selected', () => {
    const html = renderHtml(NewPlanForm, { defaultZone: 'Europe/Oslo', defaultStart: '2026-11-16T07:00', defaultEnd: '2026-11-21T07:00', onCreate: none, onCancel: none })
    expect(html).toMatch(/<select[^>]*>[\s\S]*<option value="Europe\/Oslo" selected/)
    expect(html).toContain('<option value="Asia/Tokyo"')
    expect(html).not.toContain('placeholder="Europe/Oslo"')
  })

  test('a weakening edit asks who agreed and why before it can be applied', () => {
    const preview: Preview = { label: 'Remove SW B from the protected rule', result: { ...write, preview: { saved: false, consequence: 'SW B could be tagged out.', violations: [], weakens: ['R1'] } }, refusal: null, asks: null }
    const text = readableText(renderHtml(EditPreview, { preview, context, onApply: none, onDiscard: none, onUseTime: none }))
    expect(text).toContain(`This weakens ${model.inputs.rules.find(rule => rule.key === 'R1')!.words}`)
    expect(text).toContain('Who agreed')
    expect(text).toContain('Apply')
    const refused: Preview = { label: 'Tag out SW B', result: null, refusal: { text: 'Service Water Pump B is protected: it is never tagged, worked or tested.', needsAuthority: false }, asks: null }
    expect(readableText(renderHtml(EditPreview, { preview: refused, context, onApply: none, onDiscard: none, onUseTime: none }))).toContain('Service Water Pump B is protected')
  })

  test('options: proven infeasible with its cause, a warning beside a feasible status, a stale option claims nothing', () => {
    const run = runBasis(model.inputs.settings.grid)
    const v1 = optionOf('v1', 'Rebuild, days only', status({ word: 'proven infeasible', run, cause: { kind: 'chain', jobs: ['SWA-PUMP-OUT', 'SWA-REBUILD', 'SWA-RTS'], workHours: 38, calendars: ['day'], availableHours: 32, from: '2026-11-16T06:00:00Z', by: '2026-11-20T14:00:00Z' } }))
    const feasible = { ...model.options!.items[0]!, warnings: [{ kind: 'redundancy' as const, text: '2 items are taken out and no rule keeps any of them in service.', about: [] }] }
    const stale = optionOf('old', 'Earlier option', model.options!.items[0]!.status, { fresh: false })
    const text = readableText(renderHtml(OptionsTable, { options: [feasible, v1, stale], recommended: feasible.key, context, selected: feasible.key, onSelect: none, onBaseline: none }))
    expect(text).toContain('✕ proven infeasible')
    expect(text).toContain('need 38 h of work one after another, but Day shift gives only 32 h of working time between Mon 07:00 and Fri 15:00.')
    expect(text).toContain('! Warning 2 items are taken out and no rule keeps any of them in service.')
    expect(text).toContain('Made before the latest change: its status is not claimed for the current plan.')
    expect(text.match(/Set as baseline/g)?.length).toBe(1)
  })
})
