// Forms to edits: valid edits in the plan's own vocabulary, or the reason in words. Keys are made here.
import { describe, expect, test } from 'bun:test'
import type { PlanningSubject } from '@leitbild/contracts'
import { editSchema } from '../plan/edit-schema.ts'
import {
  crewEdits, equipmentFromWorld, goalsEdit, jobEdits, keyFor, linkEdit, localInputValue, lockEdit, planEdits, resourceFromWorld, ruleEdit,
  type CrewForm, type JobForm, type RuleForm,
} from './edit-forms.ts'
import { supplyRunInputs, trainAInputs } from './fixtures/plans.ts'

const inputs = trainAInputs()
const job: JobForm = {
  title: 'Replace pump seal', kind: 'work', equipment: ['SWA'], inside: true, value: '6', unit: 'h', elapsed: false, low: '5', high: '9',
  sourceBy: 'assumption', sourceNote: 'my estimate', crews: ['mech-station'], amount: '1', continuous: false,
}
const crew: CrewForm = { label: 'Electricians', kind: 'crew', count: '2', crewSize: '2', calendar: '', days: ['mon', 'tue'], from: '07:00', to: '15:00', sourceBy: 'planner', sourceNote: '' }
const rule: RuleForm = { kind: 'keep-in-service', words: 'One of these two always available', sourceBy: 'planner', sourceNote: '', equipment: [], members: ['SWA', 'SWB'], atLeast: '1', group: '', limit: '', limitUnit: 'h', job: '', finishBy: '' }

describe('form to edits', () => {
  test('keys are made from names, unique, and valid keys', () => {
    expect(keyFor('Replace pump seal', [])).toBe('Replace-pump-seal')
    expect(keyFor('Replace pump seal', ['Replace-pump-seal'])).toBe('Replace-pump-seal-2')
    expect(keyFor('— · —', [])).toBe('item')
  })

  test('a new plan: window in the site zone, then the goal order in the plan currency', () => {
    const built = planEdits({ title: 'Week 47', timeZone: 'Europe/Oslo', windowStart: '2026-11-16T07:00', windowEnd: '2026-11-21T07:00', goals: ['finish', 'extra-cost'] })
    // Hand-computed: 07:00 in Oslo in November (+01:00) is 06:00Z.
    expect(built).toEqual({ ok: true, edits: [{ edit: 'plan', title: 'Week 47', timeZone: 'Europe/Oslo', window: { start: '2026-11-16T06:00:00.000Z', end: '2026-11-21T06:00:00.000Z' } }] })
    expect(goalsEdit(['finish', 'extra-cost'], 'NOK')).toEqual({ ok: true, edits: [{ edit: 'goals', goals: [{ metric: 'finish', tolerance: { value: 0, unit: 'h' } }, { metric: 'extra-cost', tolerance: { value: 0, unit: 'NOK' } }] }] })
    expect(planEdits({ title: '', timeZone: 'Mars/Base', windowStart: '', windowEnd: '', goals: [] })).toEqual({ ok: false, problems: ['Give the plan a name.', 'Choose the site time zone, for example Europe/Oslo.', 'Choose at least one goal.'] })
    expect(planEdits({ title: 'x', timeZone: 'Europe/Oslo', windowStart: '2026-11-16T07:00', windowEnd: '2026-11-16T07:00', goals: ['finish'] })).toEqual({ ok: false, problems: ['The window must end after it starts.'] })
  })

  test('a job carries its estimate, range, source and crew; impossible forms are refused in words', () => {
    const built = jobEdits(job, inputs)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.edits[0]).toMatchObject({ edit: 'job', key: 'Replace-pump-seal', isolation: 'inside', duration: { value: 6, unit: 'h', calendar: 'working', range: { low: 5, high: 9 }, source: { by: 'assumption', note: 'my estimate' } }, needs: [{ anyOf: ['mech-station'], amount: 1 }] })
    expect(jobEdits({ ...job, low: '7' }, inputs)).toEqual({ ok: false, problems: ['The range must hold the most likely value: low ≤ value ≤ high.'] })
    expect(jobEdits({ ...job, equipment: ['SWA', 'CCWA'] }, inputs)).toEqual({ ok: false, problems: ['A work job is on at most one item; tag-outs and tests may cover several.'] })
    expect(jobEdits({ ...job, kind: 'test', equipment: [] }, inputs)).toEqual({ ok: false, problems: ['Choose the equipment it tags out or tests.'] })
    expect(jobEdits({ ...job, crews: [], value: '' }, inputs)).toEqual({ ok: false, problems: ['Give the hours (or minutes) the job takes.', 'Choose the crew or tool that does it.'] })
  })

  test('a crew with a new weekly shift is a calendar plus a resource; a weekly shift needs the site zone', () => {
    const built = crewEdits(crew, inputs)
    expect(built.ok && built.edits.map(edit => edit.edit)).toEqual(['calendar', 'resource'])
    const supply = supplyRunInputs()
    expect(crewEdits(crew, { ...supply, settings: { ...supply.settings, timeZone: null } })).toEqual({ ok: false, problems: ['Set the site time zone first: weekly shifts are in local time.'] })
    expect(crewEdits({ ...crew, sourceBy: 'reference' }, inputs)).toEqual({ ok: false, problems: ['Name the reference it comes from.'] })
  })

  test('links, locks and rules', () => {
    expect(linkEdit({ from: 'SWA-TAG', to: 'SWA-TAG', type: 'FS', lag: '', lagUnit: 'h' })).toEqual({ ok: false, problems: ['A job cannot follow itself.'] })
    expect(linkEdit({ from: 'SWA-TAG', to: 'SWA-PUMP-OUT', type: 'SS', lag: '2', lagUnit: 'h' })).toEqual({ ok: true, edits: [{ edit: 'link', from: 'SWA-TAG', to: 'SWA-PUMP-OUT', type: 'SS', lag: { value: 2, unit: 'h' } }] })
    expect(lockEdit('SWA-RTS', '2026-11-17T09:00', 'Europe/Oslo')).toEqual({ ok: true, edits: [{ edit: 'job', key: 'SWA-RTS', lock: '2026-11-17T08:00:00.000Z' }] })
    expect(localInputValue('2026-11-17T08:00:00.000Z', 'Europe/Oslo')).toBe('2026-11-17T09:00')
    const keep = ruleEdit(rule, inputs)
    expect(keep.ok && keep.edits[0]).toMatchObject({ edit: 'rule', kind: 'keep-in-service', members: ['SWA', 'SWB'], atLeast: 1, source: { by: 'planner' } })
    expect(ruleEdit({ ...rule, atLeast: '3' }, inputs)).toEqual({ ok: false, problems: ['At least 3 of 2 cannot be kept in service; choose fewer or add members.'] })
    expect(ruleEdit({ ...rule, members: ['SWA'] }, inputs)).toEqual({ ok: false, problems: ['Choose at least two items or crews that back each other up.'] })
    expect(ruleEdit({ ...rule, kind: 'span-limit', group: 'COOL-A', limit: '24' }, inputs).ok).toBe(true)
    // A due time is read in the site zone: Fri 15:00 in Oslo in November is 14:00Z.
    expect(ruleEdit({ ...rule, kind: 'due', words: 'SW A back for the Friday surveillance', job: 'SWA-RTS', finishBy: '2026-11-20T15:00' }, inputs)).toMatchObject({ ok: true, edits: [{ edit: 'rule', kind: 'due', job: 'SWA-RTS', finishBy: '2026-11-20T14:00:00.000Z' }] })
    expect(ruleEdit({ ...rule, kind: 'due', job: 'SWA-RTS', finishBy: '2026-11-25T15:00' }, inputs)).toEqual({ ok: false, problems: ['The due time must lie inside the plan window.'] })
  })

  test('World items become equipment or tools by locator; numbers that are not times are attributes taken from World', () => {
    const truck: PlanningSubject = {
      locator: 'einsatz/unit/unit%3Atruck-9', label: 'Truck 9', kind: 'vehicle',
      facts: [
        { id: 'unit:truck-9/property/payloadKg', label: 'Payload', quantity: 'mass', unit: 'kg', value: 900, basis: 'configured', at: '2026-09-03T08:00:00Z' },
        { id: 'unit:truck-9/service-seconds', label: 'On-scene time', quantity: 'duration', unit: 's', value: 180, basis: 'design', at: '2026-09-03T08:00:00Z' },
      ],
    }
    const supply = supplyRunInputs()
    const built = resourceFromWorld(truck, { kind: 'tool', calendar: '' }, supply)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.edits.map(edit => edit.edit)).toEqual(['calendar', 'resource'])
    expect(built.edits[1]).toMatchObject({ edit: 'resource', label: 'Truck 9', kind: 'tool', locator: truck.locator, attributes: [{ label: 'Payload', unit: 'kg', fromWorld: { locator: truck.locator, fact: 'unit:truck-9/property/payloadKg' } }] })
    expect(JSON.stringify(built.edits[1])).not.toContain('"value"')
    for (const edit of built.edits) expect(editSchema.safeParse(edit).success).toBe(true)

    const pump: PlanningSubject = { locator: 'process-plant/plant%3Atrain-a/mfwPumpA', label: 'Main Feedwater Pump A', kind: 'pump', facts: [] }
    expect(equipmentFromWorld(pump, { group: '', newGroup: 'Main feedwater' }, inputs)).toMatchObject({ ok: true, edits: [{ edit: 'equipment', label: 'Main Feedwater Pump A', group: 'Main-feedwater', groupLabel: 'Main feedwater' }] })
    const known = inputs.equipment.find(item => item.locator !== undefined)!
    expect(equipmentFromWorld({ ...pump, locator: known.locator!, label: known.label }, { group: '', newGroup: '' }, inputs)).toEqual({ ok: false, problems: [`${known.label} is already in the plan.`] })
  })
})
