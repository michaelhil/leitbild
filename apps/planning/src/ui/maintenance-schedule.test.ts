import { describe, expect, test } from 'bun:test'
import type { Component } from 'svelte'
import definition from '../definitions/nuclear-maintenance-planning.plan-definition.json'
import { planInputsSchema } from '../plan/schema.ts'
import type { ExplainResult } from './api.ts'
import { createTimeFormat } from './format.ts'
import { modelOf, trainAPlanned } from './fixtures/plans.ts'
import { readableText, registerSvelte, renderHtml } from './fixtures/svelte-ssr.ts'
import { createPlanningClient } from './api.ts'
import { activeScheduleLinks, readScheduleExplanation, scheduleAxis, scheduleTaskGroups } from './maintenance-schedule.ts'
import { maintenanceEquipmentElement, maintenanceVariantsFor } from './maintenance-demo.ts'
import type { DatedRow } from './model.ts'

registerSvelte()
const { default: MaintenanceSchedule } = await import('./MaintenanceSchedule.svelte') as { default: Component<Record<string, unknown>> }
const client = createPlanningClient('0b4b9a52-2f7e-4c1a-9d3e-00000000000a', async () => { throw new Error('No Host in a render test') })
const time = createTimeFormat('Europe/Oslo')

describe('maintenance schedule interaction boundaries', () => {
  test('two-day axes name both civil dates, including a DST boundary', () => {
    const axis = scheduleAxis(Date.parse('2026-11-18T06:00:00Z'), Date.parse('2026-11-19T14:00:00Z'), time)
    expect(axis.days.map(day => day.label)).toEqual(['Wed 18 Nov', 'Thu 19 Nov'])
    expect(axis.days.reduce((sum, day) => sum + day.width, 0)).toBeCloseTo(100)
    const dst = scheduleAxis(Date.parse('2026-10-24T05:00:00Z'), Date.parse('2026-10-26T06:00:00Z'), time)
    expect(dst.days.map(day => day.label)).toEqual(['Sat 24 Oct', 'Sun 25 Oct', 'Mon 26 Oct'])
    expect(dst.days[1]!.width / 100 * 49).toBeCloseTo(25)
    const halfHour = scheduleAxis(Date.parse('2026-11-18T06:00:00Z'), Date.parse('2026-11-19T06:00:00Z'), createTimeFormat('Asia/Kolkata'))
    expect(halfHour.days[1]!.left / 100 * 24).toBeCloseTo(12.5)
  })

  test('renders only supplied scheduled tasks, with the same reusable view for a larger or earlier plan', () => {
    const inputs = planInputsSchema.parse(definition.inputs)
    // TEST ONLY: arbitrary display positions, never a claimed solver receipt.
    const rows: DatedRow[] = inputs.jobs.map((job, index) => ({
      job: job.key, start: new Date(Date.parse(inputs.settings.window!.start) + index * 3_600_000).toISOString(),
      finish: new Date(Date.parse(inputs.settings.window!.start) + (index + 1) * 3_600_000).toISOString(),
      uses: [], float: { workingHours: 19, limitedBy: { kind: 'window-end' } },
    }))
    const model = modelOf(inputs)
    const html = renderHtml(MaintenanceSchedule, { client, model, rows, option: 'test-option', label: 'Checked work schedule', target: inputs.jobs.find(job => job.key === 'restore')!.target!.finishBy })
    const words = readableText(html)
    expect((html.match(/role="rowheader"/g) ?? []).length).toBe(16)
    for (const word of ['Wed 18 Nov', 'Thu 19 Nov', 'Tasks', 'Crews and tools', 'What sets the finish']) expect(words).toContain(word)
    expect(words).not.toContain('critical path')
    expect(html).not.toContain('class="chart-row chain')
    expect(words).not.toContain('Preview impact')
    const earlier = trainAPlanned()
    expect(scheduleTaskGroups(earlier, earlier.rows['opt-1']!).flatMap(group => group.jobs).map(job => job.key)).toEqual(earlier.rows['opt-1']!.map(row => row.job))
    expect(scheduleTaskGroups(model, rows.slice(0, 2)).flatMap(group => group.jobs)).toHaveLength(2)
    const groups = scheduleTaskGroups(model, rows, 'Shared gates and return to service')
    expect(groups.slice(0, -1).map(group => group.label).sort()).toEqual(['Service Water Pump A', 'Component Cooling Water Pump A', 'Component Cooling Heat Exchanger A'].sort())
    expect(groups.at(-1)!.label).toBe('Shared gates and return to service')
    expect(groups.flatMap(group => group.jobs)).toHaveLength(16)
    expect(maintenanceVariantsFor(model).variants!.map(variant => variant.label)).toEqual(['Existing crews', 'With HX contractor'])
  })

  test('only explicitly authored demo equipment gets a World navigation target', () => {
    expect(maintenanceEquipmentElement('CCWHXA')).toBe('componentCoolingHeatExchangerA')
    expect(maintenanceEquipmentElement('SWA')).toBe('serviceWaterPumpA')
    expect(maintenanceEquipmentElement('unknown-equipment')).toBeNull()
    expect(maintenanceEquipmentElement('toString')).toBeNull()
  })

  test('inspector dependencies exclude inactive method links even when both tasks are scheduled', () => {
    const model = trainAPlanned()
    const rows = model.rows['opt-1']!
    const common = { from: rows[0]!.job, to: rows[1]!.job, type: 'FS' as const, lag: { value: 0, unit: 'h' as const } }
    const inputs = { ...model.inputs, links: [{ ...common, method: { choice: 'SWA-method', option: 'swap' } }, { ...common, method: { choice: 'SWA-method', option: 'rebuild' } }] }
    const options = { ...model.options!, items: [{ ...model.options!.items[0]!, variant: { methods: [{ choice: 'SWA-method', option: 'swap' }], purchases: [] } }] }
    expect(activeScheduleLinks({ ...model, inputs, options }, 'opt-1', rows)).toEqual([inputs.links[0]!])
  })

  test('finish reads follow every owner cursor under one before/after retained-publication check', async () => {
    const events: string[] = []
    const item = (job: string): ExplainResult['items'][number] => ({ job, start: '2026-11-18T06:00:00Z', finish: '2026-11-18T07:00:00Z', floatHours: 19, joint: false, because: [{ kind: 'link', about: [{ kind: 'job', key: 'before' }] }] })
    const answers: ExplainResult[] = [
      { lines: ['First'], items: [item('restore')], more: '1', limiting: { result: 'no-gain', about: { kind: 'resource', key: 'test-team' } } },
      { lines: ['Second'], items: [item('hx-clean')], more: '2' },
      { lines: ['Third'], items: [item('isolate')] },
    ]
    const result = await readScheduleExplanation({ explain: async (plan, input) => { events.push(`${plan}:${input.option}:${input.cursor ?? 'first'}`); return answers.shift()! } }, 'plan', 'retained', { ask: 'finish', job: 'restore' }, async () => { events.push('pin') })
    expect(events).toEqual(['pin', 'plan:retained:first', 'plan:retained:1', 'plan:retained:2', 'pin'])
    expect(result.items.map(item => item.job)).toEqual(['restore', 'hx-clean', 'isolate'])
    expect(result.lines).toEqual(['First', 'Second', 'Third'])
    expect(result.limiting?.result).toBe('no-gain')
    expect(result.more).toBeUndefined()
  })

  test('a changed owner pin refuses the complete explanation, and repeated cursors never loop', async () => {
    let pins = 0
    await expect(readScheduleExplanation({ explain: async () => ({ lines: [], items: [] }) }, 'plan', 'retained', { ask: 'finish' }, async () => { if (++pins === 2) throw new Error('Changed publication') })).rejects.toThrow('Changed publication')
    await expect(readScheduleExplanation({ explain: async () => ({ lines: [], items: [], more: 'same' }) }, 'plan', 'retained', { ask: 'finish' }, async () => {})).rejects.toThrow('same explanation page')
  })
})
