import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceIdSchema } from '@leitbild/contracts'
import {
  alsoRuleSchema, attributeSchema, calendarSchema, caveatSchema, certificateSchema, changeSchema, combineWorldFacts, datedRowSchema, durationSchema, durationWithSchema, editKindSchema,
  equipmentSchema, goalProofBreaks, goalSchema, jobSchema, leadSchema, methodChoiceSchema, optionLeadIssue, optionSchema, planInputsSchema, planSchema, purchaseSchema, resourceSchema,
  robustSchema, ruleSchema, statusSchema, type WorldFactCopy,
} from './schema.ts'
import { editSchema } from './edit-schema.ts'
import { applyEdits } from './edits.ts'
import { createPlanStore } from './store.ts'
import { editInputSchema, generateResultSchema } from '../api/contract.ts'
import { checkPlan, inputCodes } from '../check/check.ts'
import { shownNotes } from './fixtures/train-a-case.convert.ts'

const fixture = async (name: string): Promise<any> => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json()
const trainA = await fixture('train-a.fragment.json')
const supplyRun = await fixture('supply-run.case2.json')

// The run basis and the six cases of R/impl/inc1/status-invariants.ts.
const run = { grid: '30min', engine: 'ts-lahc', formulation: 'compile 1, bounds 1, engine 1, grid 30min, tz 2026a', seed: 1,
  budget: { evals: 4000, cpuMs: 9000, wallMs: 18000 }, stoppedBy: 'evals', evals: 4000, cpuMs: 600 }
const chain = (workHours: number, availableHours: number) => ({ kind: 'chain', jobs: ['A'], workHours, calendars: ['day'], availableHours, from: '2026-11-17T06:00:00Z', by: '2026-11-20T14:00:00Z' })
const accepted = (value: unknown) => statusSchema.safeParse(value).success

describe('the two cases', () => {
  test('both fixtures parse as plan inputs', () => {
    const train = planInputsSchema.parse(trainA)
    expect(train.jobs).toHaveLength(13)
    expect(train.jobs.filter(job => job.kind === 'test').map(job => [job.key, job.minimum?.value])).toEqual([
      ['SWA-RTS', 2.5], ['CCWA-RTS', 1.5], ['RHRA-RTS', 1.5], ['HHSIA-RTS', 1], ['CSA-RTS', 1.5], ['AFWA-RTS', 1.5]])
    expect(train.rules.map(rule => rule.source.by)).toEqual(['reference', 'reference'])
    expect(train.goals[1]?.tolerance).toEqual({ value: 25000, unit: 'NOK' })
    const supply = planInputsSchema.parse(supplyRun)
    expect(supply.resources.map(resource => [resource.key, resource.source.by])).toEqual([
      ['truck-1', 'planner'], ['truck-3', 'planner'], ['truck-4', 'planner'], ['truck-2', 'assumption'], ['truck-5', 'assumption']])
    expect(supply.calendars.map(calendar => [calendar.key, calendar.source.by])).toEqual([['exercise', 'planner'], ['joins-0802', 'assumption'], ['joins-08053', 'assumption']])
    expect(supply.jobs.flatMap(job => job.durationWith.filter(entry => entry.source !== undefined).map(entry => [job.key, entry.resource, entry.source?.by])))
      .toEqual([['U-1', 'truck-2', 'assumption'], ['R-1', 'truck-2', 'assumption'], ['R-1', 'truck-5', 'assumption']])
  })

  test('a minimum is allowed only on tests', () => {
    const test = trainA.jobs.find((job: any) => job.key === 'SWA-RTS')
    expect(jobSchema.parse(test).minimum?.value).toBe(2.5)
    const refused = jobSchema.safeParse({ ...test, kind: 'work' })
    expect(refused.success).toBe(false)
    expect(refused.error?.issues.map(issue => issue.path)).toEqual([['minimum']])
    const { minimum: _minimum, ...withoutMinimum } = test
    expect(jobSchema.safeParse({ ...withoutMinimum, kind: 'work' }).success).toBe(true)
  })

  test('a time zone Intl does not know and a reversed window are refused', () => {
    expect(planInputsSchema.safeParse({ ...trainA, settings: { ...trainA.settings, timeZone: 'Mars/Base' } }).success).toBe(false)
    expect(planInputsSchema.safeParse({ ...trainA, settings: { ...trainA.settings, window: { start: '2026-11-21T06:00:00Z', end: '2026-11-16T06:00:00Z' } } }).success).toBe(false)
  })
})

describe('status cannot hold a contradiction (A4)', () => {
  test('the five r1 contradictions are refused and a consistent status is accepted', () => {
    expect(accepted({ word: 'unresolved', run, goals: [{ word: 'proven optimal', goal: 0, value: 0, unit: 'h', bound: { value: 0, source: 'logic+calendars', certificate: { kind: 'zero' } } }] })).toBe(false)
    expect(accepted({ word: 'proven infeasible', run })).toBe(false)
    expect(accepted({ word: 'validated feasible', run, goals: [
      { word: 'best found under budget', goal: 0, value: 2.5, unit: 'h' },
      { word: 'proven optimal', goal: 1, value: 398800, unit: 'NOK', bound: { value: 398800, source: 'fixed-costs', certificate: { kind: 'fixed-costs', items: [{ key: 'charged', amount: 398800 }] } } }] })).toBe(false)
    expect(accepted({ word: 'validated feasible', run, goals: [{ word: 'proven optimal', goal: 0, value: 3, unit: 'h', bound: { value: 0, source: 'logic+calendars', certificate: { kind: 'zero' } } }] })).toBe(false)
    expect(accepted({ word: 'cancelled', run, cause: chain(37, 32) })).toBe(false)
    // Every "proven optimal" carries its bound's certificate (adversary item 23).
    expect(accepted({ word: 'validated feasible', run, goals: [{ word: 'proven optimal', goal: 0, value: 0, unit: 'h', bound: { value: 0, source: 'logic+calendars' } }] })).toBe(false)
    expect(accepted({ word: 'validated feasible', run, goals: [
      { word: 'proven optimal', goal: 0, value: 0, unit: 'h', bound: { value: 0, source: 'logic+calendars', certificate: { kind: 'zero' } } },
      { word: 'best found under budget', goal: 1, value: 464250, unit: 'NOK', bound: { value: 340000, source: 'fixed-costs', certificate: { kind: 'fixed-costs', items: [{ key: 'charged', amount: 340000 }] } } }] })).toBe(true)
  })
})

describe('adversary r2 check (coordinator-adopted)', () => {
  test('1. a certificate proves something: more work than capacity, over a real interval', () => {
    expect(accepted({ word: 'proven infeasible', run, cause: chain(37, 32) })).toBe(true)
    expect(accepted({ word: 'proven infeasible', run, cause: chain(30, 32) })).toBe(false)
    expect(accepted({ word: 'proven infeasible', run, cause: chain(32, 32) })).toBe(false)
    expect(accepted({ word: 'proven infeasible', run, cause: { ...chain(37, 32), from: '2026-11-20T14:00:00Z', by: '2026-11-17T06:00:00Z' } })).toBe(false)
    const energy = { kind: 'energy', resources: ['mech'], jobs: ['A'], requiredHours: 49, availableHours: 48, from: '2026-11-17T01:00:00Z', to: '2026-11-20T01:00:00Z' }
    expect(certificateSchema.safeParse(energy).success).toBe(true)
    expect(certificateSchema.safeParse({ ...energy, requiredHours: 40 }).success).toBe(false)
    expect(certificateSchema.safeParse({ ...energy, to: energy.from }).success).toBe(false)
    const availability = { kind: 'availability', rule: 'heavy-free', items: ['truck-2', 'truck-4'], from: '2026-09-03T08:00:00Z', to: '2026-09-03T08:05:00Z' }
    expect(certificateSchema.safeParse(availability).success).toBe(true)
    expect(certificateSchema.safeParse({ ...availability, to: '2026-09-03T07:59:00Z' }).success).toBe(false)
  })

  test('2. proven optimal compares value and bound at the goal resolution', () => {
    const goals = (second: object) => ({ word: 'validated feasible', run, goals: [{ word: 'proven optimal', goal: 0, value: 0, unit: 'h', bound: { value: 0, source: 'logic+calendars', certificate: { kind: 'zero' } } }, { goal: 1, ...second }] })
    expect(accepted(goals({ word: 'proven optimal', value: 464250, unit: 'NOK', bound: { value: 464249.9999999997, source: 'fixed-costs', certificate: { kind: 'fixed-costs', items: [{ key: 'charged', amount: 464249.9999999997 }] } } }))).toBe(true)
    expect(accepted(goals({ word: 'proven optimal', value: 464250, unit: 'NOK', bound: { value: 464249, source: 'fixed-costs', certificate: { kind: 'fixed-costs', items: [{ key: 'charged', amount: 464249 }] } } }))).toBe(false)
    expect(accepted(goals({ word: 'proven optimal', value: 2.5, unit: 'h', bound: { value: 2.4999999999, source: 'logic+calendars', certificate: { kind: 'earliest-finish', jobs: [{ job: 'last', finish: '2026-11-16T09:00:00Z' }] } } }))).toBe(true)
    expect(accepted(goals({ word: 'proven optimal', value: 2.5, unit: 'h', bound: { value: 2, source: 'logic+calendars', certificate: { kind: 'earliest-finish', jobs: [{ job: 'last', finish: '2026-11-16T09:00:00Z' }] } } }))).toBe(false)
    expect(accepted(goals({ word: 'best found under budget', value: 464250, unit: 'NOK', bound: { value: 464250.0000000003, source: 'fixed-costs', certificate: { kind: 'fixed-costs', items: [{ key: 'charged', amount: 464250.0000000003 }] } } }))).toBe(true)
    expect(accepted(goals({ word: 'best found under budget', value: 464250, unit: 'NOK', bound: { value: 464251, source: 'fixed-costs', certificate: { kind: 'fixed-costs', items: [{ key: 'charged', amount: 464251 }] } } }))).toBe(false)
    expect(accepted(goals({ word: 'best found under budget', value: 3, unit: 'kg' }))).toBe(false)
    const fine = { ...run, grid: '30s' }
    expect(accepted({ word: 'validated feasible', run: fine, goals: [{ word: 'proven optimal', goal: 0, value: 1, unit: 'min', bound: { value: 0.5, source: 'logic+calendars', certificate: { kind: 'earliest-finish', jobs: [{ job: 'last', finish: '2026-11-16T09:00:00Z' }] } } }] })).toBe(false)
    expect(accepted({ word: 'validated feasible', run: fine, goals: [{ word: 'proven optimal', goal: 0, value: 1, unit: 'min', bound: { value: 0.9999999, source: 'logic+calendars', certificate: { kind: 'earliest-finish', jobs: [{ job: 'last', finish: '2026-11-16T09:00:00Z' }] } } }] })).toBe(true)
  })

  // Increment 2: every goal line names the plan's goal id (design §0.3), so each line here carries its id.
  test('3. the Assistant-facing status uses the status words and the goal order rule', () => {
    const result = (status: object) => generateResultSchema.safeParse({ plan: { id: '0c4008f3-ffac-47ce-9be0-a0c71e68a781', revision: 3 }, options: [{ key: 'o1', label: 'Swap', status, warnings: [] }], text: 'x' }).success
    expect(result({ word: 'validated feasible', goals: [{ goal: 0, word: 'best found under budget', value: 2.5, unit: 'h' }, { goal: 1, word: 'proven optimal', value: 398800, unit: 'NOK', bound: 398800, gap: 0 }] })).toBe(false)
    expect(result({ word: 'optimal', goals: [] })).toBe(false)
    expect(result({ word: 'validated feasible', goals: [{ goal: 0, word: 'optimal', value: 2.5, unit: 'h' }] })).toBe(false)
    expect(result({ word: 'unresolved', goals: [{ goal: 0, word: 'best found under budget', value: 2.5, unit: 'h' }] })).toBe(false)
    expect(result({ word: 'proven infeasible', goals: [] })).toBe(false)
    expect(result({ word: 'validated feasible', goals: [{ goal: 0, word: 'proven optimal', value: 0, unit: 'h' }] })).toBe(false)
    expect(result({ word: 'validated feasible', goals: [{ goal: 0, word: 'best found under budget', value: 2.5, unit: 'h', bound: 1 }] })).toBe(false)
    expect(result({ word: 'validated feasible', goals: [{ goal: 0, word: 'proven optimal', value: 0, unit: 'h', bound: 0, gap: 0 }, { goal: 1, word: 'best found under budget', value: 464250, unit: 'NOK', bound: 340000, gap: 124250 }] })).toBe(true)
    expect(result({ word: 'proven infeasible', goals: [], cause: { kind: 'chain', requiredHours: 38, availableHours: 32, about: ['SWA-REBUILD'] } })).toBe(true)
  })

  test('4. keep-in-service needs 1 <= atLeast <= members', () => {
    const rule = { kind: 'keep-in-service', key: 'k', members: [{ equipment: 'A' }, { equipment: 'B' }], words: 'x', source: { by: 'planner' } }
    expect(ruleSchema.safeParse({ ...rule, atLeast: 5 }).success).toBe(false)
    expect(ruleSchema.safeParse({ ...rule, atLeast: 3 }).success).toBe(false)
    expect(ruleSchema.safeParse({ ...rule, atLeast: 0 }).success).toBe(false)
    expect(ruleSchema.safeParse({ ...rule, atLeast: 2 }).success).toBe(true)
    expect(ruleSchema.safeParse({ ...rule, atLeast: 1 }).success).toBe(true)
  })
})

describe('float names the limit that binds it (goals r2 check)', () => {
  const row = { job: 'SWA-TAG', start: '2026-11-17T06:00:00Z', finish: '2026-11-17T09:00:00Z', uses: [{ resource: 'work-control', from: '2026-11-17T06:00:00Z', to: '2026-11-17T09:00:00Z' }] }
  test('window end and span limit both parse; anything else is refused', () => {
    expect(datedRowSchema.parse({ ...row, float: { workingHours: 12.5, limitedBy: { kind: 'window-end' } } }).float.limitedBy).toEqual({ kind: 'window-end' })
    expect(datedRowSchema.parse({ ...row, float: { workingHours: 0, limitedBy: { kind: 'span-limit', rule: 'R2' } } }).float.limitedBy).toEqual({ kind: 'span-limit', rule: 'R2' })
    expect(datedRowSchema.safeParse({ ...row, float: { workingHours: 1, limitedBy: { kind: 'span-limit' } } }).success).toBe(false)
    expect(datedRowSchema.safeParse({ ...row, float: { workingHours: 1, limitedBy: { kind: 'window-end', rule: 'R2' } } }).success).toBe(false)
    expect(datedRowSchema.safeParse({ ...row, float: { workingHours: 1 } }).success).toBe(false)
    expect(datedRowSchema.safeParse({ ...row, float: { workingHours: -1, limitedBy: { kind: 'window-end' } } }).success).toBe(false)
  })
})

describe('one way to say where a value comes from (simplicity r2 check, coordinator-adopted)', () => {
  test('stored notBefore, calendar and resource carry a source; purchase carries none', () => {
    const spare = trainA.jobs.find((job: any) => job.key === 'SWA-SPARE-PREP')
    expect(jobSchema.parse(spare).notBefore?.source).toEqual({ by: 'assumption', note: 'vendor promise' })
    const { source, ...notBefore } = spare.notBefore
    expect(jobSchema.safeParse({ ...spare, notBefore: { ...notBefore, origin: source } }).success).toBe(false)
    const { source: _calendarSource, ...calendar } = trainA.calendars[0]
    const { source: _resourceSource, ...resource } = trainA.resources[0]
    expect(calendarSchema.safeParse({ ...calendar, origin: { by: 'planner' } }).success).toBe(false)
    expect(resourceSchema.safeParse({ ...resource, origin: { by: 'planner' } }).success).toBe(false)
    expect(calendarSchema.safeParse(calendar).success).toBe(false)
    expect(resourceSchema.safeParse(resource).success).toBe(false)
    expect(purchaseSchema.safeParse({ ...trainA.purchases[0], origin: { by: 'planner' } }).success).toBe(false)
    expect(purchaseSchema.safeParse({ ...trainA.purchases[0], source: { by: 'planner' } }).success).toBe(false)
  })

  test('calendar and resource sources: a person, or a reference that names itself', () => {
    const calendar = trainA.calendars[0], resource = trainA.resources[0]
    for (const source of [{ by: 'planner' }, { by: 'assumption', note: 'Announced join' }, { by: 'reference', note: 'NUREG-1431 LCO 3.7.5' }]) {
      expect(calendarSchema.safeParse({ ...calendar, source }).success).toBe(true)
      expect(resourceSchema.safeParse({ ...resource, source }).success).toBe(true)
    }
    for (const source of [{ by: 'reference' }, { by: 'world' }, { by: 'planner', refs: [] }]) {
      expect(calendarSchema.safeParse({ ...calendar, source }).success).toBe(false)
      expect(resourceSchema.safeParse({ ...resource, source }).success).toBe(false)
    }
    const r1 = trainA.rules[0]
    expect(ruleSchema.safeParse({ ...r1, source: { by: 'reference' } }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'calendar', key: 'day', source: { by: 'reference', note: 'Site working-time agreement' } }).success).toBe(true)
    expect(editSchema.safeParse({ edit: 'calendar', key: 'day', source: { by: 'reference' } }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'resource', key: 'truck-2', source: { by: 'assumption', note: 'Announced join' } }).success).toBe(true)
    expect(editSchema.safeParse({ edit: 'rule', key: 'R2', source: { by: 'reference' } }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'job', key: 'R-1', durationWith: [{ resource: 'truck-5', fromWorld: [{ locator: 'einsatz/unit/unit%3Atruck-1', fact: 'unit:truck-1/service-seconds' }], source: { by: 'assumption', note: "Truck 1's World estimate used" } }] }).success).toBe(true)
  })

  test('stored durationWith holds a value or World refs, in the job unit', () => {
    const refs = [{ locator: 'einsatz/unit/unit%3Atruck-4', fact: 'unit:truck-4/service-seconds' }]
    expect(durationWithSchema.safeParse({ resource: 'truck-4', refs }).success).toBe(true)
    expect(durationWithSchema.safeParse({ resource: 'truck-4', value: 300 }).success).toBe(true)
    expect(durationWithSchema.safeParse({ resource: 'truck-4', value: 300, refs }).success).toBe(false)
    expect(durationWithSchema.safeParse({ resource: 'truck-4' }).success).toBe(false)
    expect(durationWithSchema.safeParse({ resource: 'truck-4', duration: { value: null, unit: 's', calendar: 'elapsed', origin: { by: 'world', refs } } }).success).toBe(false)
  })

  test('edits give a source on durations, notBefore, rules and attributes; `confirmed` and free-text sources are gone', () => {
    const job = { edit: 'job', key: 'SWA-SPARE-PREP' }
    expect(editSchema.safeParse({ ...job, duration: { value: 4, source: { by: 'assumption', note: 'vendor quote' } } }).success).toBe(true)
    expect(editSchema.safeParse({ ...job, duration: { value: 4, source: 'vendor quote' } }).success).toBe(false)
    expect(editSchema.safeParse({ ...job, duration: { value: 4, source: { by: 'world' } } }).success).toBe(false)
    expect(editSchema.safeParse({ ...job, notBefore: { at: '2026-11-16T11:00:00Z', words: 'Vendor promise', source: { by: 'assumption' } } }).success).toBe(true)
    expect(editSchema.safeParse({ ...job, notBefore: { at: '2026-11-16T11:00:00Z', words: 'Vendor promise', confirmed: false } }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'rule', key: 'R2', source: { by: 'planner', note: 'Modelled on NUREG-1431' } }).success).toBe(true)
    expect(editSchema.safeParse({ edit: 'resource', key: 'truck-2', attributes: [{ key: 'payloadKg', label: 'Payload', value: 1000, unit: 'kg', source: { by: 'assumption', note: 'Announced' } }] }).success).toBe(true)
  })

  test('edits say resource where storage does', () => {
    expect(editSchema.safeParse({ edit: 'resource', key: 'crane', kind: 'tool', count: 1 }).success).toBe(true)
    expect(editSchema.safeParse({ edit: 'crew', key: 'crane', kind: 'tool', count: 1 }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'purchase', key: 'ot', resource: 'mech-station' }).success).toBe(true)
    expect(editSchema.safeParse({ edit: 'purchase', key: 'ot', crew: 'mech-station' }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'job', key: 'U-1', durationWith: [{ resource: 'truck-4', value: 200 }] }).success).toBe(true)
    expect(editSchema.safeParse({ edit: 'job', key: 'U-1', durationWith: [{ crew: 'truck-4', value: 200 }] }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'remove', what: 'resource', key: 'truck-5' }).success).toBe(true)
    expect(editSchema.safeParse({ edit: 'remove', what: 'crew', key: 'truck-5' }).success).toBe(false)
  })
})

describe('summed World values take the weakest basis and the oldest time', () => {
  const locator = 'einsatz/unit/unit%3Atruck-4'
  const copy = (id: string, value: WorldFactCopy['value'], basis: WorldFactCopy['basis'], at: string, unit?: string): WorldFactCopy =>
    ({ locator, id, label: id, quantity: 'duration', value, basis, at, ...(unit === undefined ? {} : { unit }) })
  const arrival = copy('unit:truck-4/arrival-seconds/task:sports-hall-tank', 130, 'owner-estimate', '2026-09-03T08:00:10Z', 's')
  const service = copy('unit:truck-4/service-seconds', 3, 'configured', '2026-09-03T08:00:00Z', 'min')
  const ref = (fact: WorldFactCopy) => ({ locator: fact.locator, fact: fact.id })

  test('arrival plus service', () => {
    expect(combineWorldFacts([ref(arrival), ref(service)], [arrival, service], 's')).toEqual({ ok: true, value: 310, unit: 's', basis: 'owner-estimate', at: '2026-09-03T08:00:00Z' })
  })

  test('the basis order is owner-estimate < configured < design < observed', () => {
    const facts = (['observed', 'design', 'configured', 'owner-estimate'] as const).map((basis, index) => copy(`f${index}`, 1, basis, `2026-09-03T08:0${index}:00Z`, 's'))
    const sum = (indexes: number[]) => combineWorldFacts(indexes.map(index => ref(facts[index]!)), facts, 's')
    expect(sum([0])).toMatchObject({ basis: 'observed', at: '2026-09-03T08:00:00Z' })
    expect(sum([0, 1])).toMatchObject({ basis: 'design', value: 2 })
    expect(sum([1, 2])).toMatchObject({ basis: 'configured' })
    expect(sum([3, 0])).toMatchObject({ basis: 'owner-estimate', at: '2026-09-03T08:00:00Z' })
    expect(sum([2, 3])).toMatchObject({ basis: 'owner-estimate', at: '2026-09-03T08:02:00Z' })
  })

  test('missing, ambiguous, non-number and unconvertible values are refused by name', () => {
    expect(combineWorldFacts([ref(arrival)], [service], 's')).toEqual({ ok: false, code: 'world_value_unread', ref: ref(arrival) })
    expect(combineWorldFacts([ref(arrival)], [arrival, arrival], 's')).toMatchObject({ ok: false, code: 'world_value_ambiguous' })
    const state = copy('unit:truck-4/phase', 'idle', 'observed', '2026-09-03T08:00:00Z')
    expect(combineWorldFacts([ref(state)], [state], 's')).toMatchObject({ ok: false, code: 'world_value_not_number' })
    const flow = copy('plant:train-a/serviceWaterPumpA/nominal-flow', 400, 'design', '2026-11-12T09:00:00Z', 'kg/s')
    expect(combineWorldFacts([ref(flow)], [flow], 's')).toMatchObject({ ok: false, code: 'unit_unknown', unit: 'kg/s' })
    const payload = copy('unit:truck-4/property/payloadKg', 1500, 'configured', '2026-09-03T08:00:00Z', 'kg')
    expect(combineWorldFacts([ref(payload)], [payload], 's')).toMatchObject({ ok: false, code: 'unit_mismatch', unit: 'kg' })
    expect(combineWorldFacts([ref(payload)], [payload], 'kg')).toMatchObject({ ok: true, value: 1500, basis: 'configured' })
  })
})

describe('architecture review of lane A (coordinator-adopted)', () => {
  const refs = [{ locator: 'einsatz/unit/unit%3Atruck-4', fact: 'unit:truck-4/property/payloadKg' }]
  const payload = { key: 'payloadKg', label: 'Payload', unit: 'kg', changes: [] }

  test('2. a World value is never stored: it is null with its references; a person\'s value is stored', () => {
    expect(attributeSchema.safeParse({ ...payload, value: null, origin: { by: 'world', refs } }).success).toBe(true)
    expect(attributeSchema.safeParse({ ...payload, value: 1500, origin: { by: 'world', refs } }).success).toBe(false)
    expect(attributeSchema.safeParse({ ...payload, value: 1000, origin: { by: 'assumption', note: 'Announced' } }).success).toBe(true)
    expect(attributeSchema.safeParse({ ...payload, value: null, origin: { by: 'planner' } }).success).toBe(false)
    const arrival = { unit: 's', calendar: 'elapsed', origin: { by: 'world', refs } }
    expect(durationSchema.safeParse({ ...arrival, value: null }).success).toBe(true)
    expect(durationSchema.safeParse({ ...arrival, value: 130 }).success).toBe(false)
    const trucks = supplyRun.resources.filter((resource: any) => resource.attributes[0].origin.by === 'world')
    expect(trucks.map((resource: any) => [resource.key, resource.attributes[0].value])).toEqual([['truck-1', null], ['truck-3', null], ['truck-4', null]])
    expect(supplyRun.world).toEqual({ refreshedAt: null, facts: [] })
  })

  test('3. stored rules carry a source, never an origin', () => {
    for (const rule of [...trainA.rules, ...supplyRun.rules]) expect(ruleSchema.safeParse(rule).success).toBe(true)
    const { source: _source, ...r2 } = trainA.rules[1]
    expect(ruleSchema.safeParse({ ...r2, origin: { by: 'planner' } }).success).toBe(false)
    expect(ruleSchema.safeParse({ ...r2, source: { by: 'world', refs } }).success).toBe(false)
  })

  test('4. goal units fit the metric, at the boundary', () => {
    expect(goalSchema.safeParse({ metric: 'extra-cost', tolerance: { value: 25000, unit: 'NOK' } }).success).toBe(true)
    expect(goalSchema.safeParse({ metric: 'extra-cost', tolerance: { value: 8, unit: 'h' } }).success).toBe(false)
    expect(goalSchema.safeParse({ metric: 'span-over', threshold: { value: 54, unit: 'h' }, tolerance: { value: 0, unit: 'h' } }).success).toBe(true)
    expect(goalSchema.safeParse({ metric: 'span-over', threshold: { value: 54, unit: 'kg' }, tolerance: { value: 0, unit: 'h' } }).success).toBe(false)
    expect(goalSchema.safeParse({ metric: 'lateness', tolerance: { value: 0, unit: 'kg' } }).success).toBe(false)
    expect(goalSchema.safeParse({ metric: 'lateness', tolerance: { value: 0, unit: 'd' } }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'goals', goals: [{ metric: 'unavailable-hours', tolerance: { value: 0, unit: 'kg' } }] }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'goals', goals: [{ metric: 'unavailable-hours', tolerance: { value: 30, unit: 'min' } }] }).success).toBe(true)
  })

  test('5. working time is never given in days', () => {
    const shift = { value: 2, unit: 'd', calendar: 'working', origin: { by: 'planner' } }
    expect(durationSchema.safeParse(shift).success).toBe(false)
    expect(durationSchema.safeParse({ ...shift, calendar: 'elapsed' }).success).toBe(true)
    expect(durationSchema.safeParse({ ...shift, value: 16, unit: 'h' }).success).toBe(true)
    const test = trainA.jobs.find((job: any) => job.key === 'SWA-RTS')
    expect(jobSchema.safeParse({ ...test, minimum: { ...test.minimum, value: 1, unit: 'd' } }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'job', key: 'SWA-RTS', duration: { value: 2, unit: 'd', calendar: 'working' } }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'job', key: 'SWA-RTS', duration: { value: 2, unit: 'd', calendar: 'elapsed' } }).success).toBe(true)
  })

  test('should-fix: remove names what it removes', () => {
    expect(editSchema.safeParse({ edit: 'remove', what: 'job', key: 'SWA-RTS' }).success).toBe(true)
    expect(editSchema.safeParse({ edit: 'remove', what: 'job' }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'remove', what: 'job', key: 'SWA-RTS', from: 'A' }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'remove', what: 'link', from: 'CCWHXA-OPEN', to: 'CCWHXA-CLEAN', type: 'SS' }).success).toBe(true)
    expect(editSchema.safeParse({ edit: 'remove', what: 'link', from: 'CCWHXA-OPEN', to: 'CCWHXA-CLEAN' }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'remove', what: 'link', key: 'L1', from: 'CCWHXA-OPEN', to: 'CCWHXA-CLEAN', type: 'SS' }).success).toBe(false)
  })

  test('should-fix: a duration holds a value or World values, never both; a durationWith row holds exactly one', () => {
    const world = [{ locator: 'einsatz/unit/unit%3Atruck-4', fact: 'unit:truck-4/service-seconds' }]
    const job = { edit: 'job', key: 'U-1' }
    expect(editSchema.safeParse({ ...job, duration: { fromWorld: world } }).success).toBe(true)
    expect(editSchema.safeParse({ ...job, duration: { value: 300 } }).success).toBe(true)
    expect(editSchema.safeParse({ ...job, duration: { range: { low: 200, high: 400 } } }).success).toBe(true)
    expect(editSchema.safeParse({ ...job, duration: { value: 300, fromWorld: world } }).success).toBe(false)
    expect(editSchema.safeParse({ ...job, duration: { fromWorld: world, source: { by: 'planner' } } }).success).toBe(false)
    expect(editSchema.safeParse({ ...job, duration: { value: 300, fromWorld: null } }).success).toBe(true)
    expect(editSchema.safeParse({ ...job, durationWith: [{ resource: 'truck-4' }] }).success).toBe(false)
    expect(editSchema.safeParse({ ...job, durationWith: [{ resource: 'truck-4', value: 300, fromWorld: world }] }).success).toBe(false)
    expect(editSchema.safeParse({ ...job, durationWith: [{ resource: 'truck-4', fromWorld: world }] }).success).toBe(true)
    const attribute = { key: 'payloadKg', label: 'Payload', unit: 'kg' }
    expect(editSchema.safeParse({ edit: 'resource', key: 'truck-4', attributes: [{ ...attribute, fromWorld: refs[0] }] }).success).toBe(true)
    expect(editSchema.safeParse({ edit: 'resource', key: 'truck-4', attributes: [{ ...attribute, value: 1500, fromWorld: refs[0] }] }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'resource', key: 'truck-4', attributes: [attribute] }).success).toBe(false)
  })

  test('should-fix: keep-in-service names each member once', () => {
    const rule = { kind: 'keep-in-service', key: 'k', atLeast: 2, words: 'x', source: { by: 'planner' } }
    expect(ruleSchema.safeParse({ ...rule, members: [{ equipment: 'A' }, { equipment: 'A' }] }).success).toBe(false)
    expect(ruleSchema.safeParse({ ...rule, members: [{ equipment: 'A' }, { resource: 'A' }] }).success).toBe(true)
  })

  test('should-fix: the plan names its Workspace by id, and changes by edit kind or refresh', () => {
    expect(editKindSchema.options).toEqual(editSchema.options.map(option => option.shape.edit.value))
    const change = { seq: 1, at: '2026-11-12T09:00:00Z', by: { kind: 'human' }, revision: 1, summary: 'Created from Train A work week' }
    expect(changeSchema.safeParse({ ...change, kinds: ['job', 'refresh'] }).success).toBe(true)
    expect(changeSchema.safeParse({ ...change, kinds: ['crew'] }).success).toBe(false)
    const plan = { id: '0c4008f3-ffac-47ce-9be0-a0c71e68a781', workspaceId: '7f153395-135d-4c79-ac91-4dbd15928d15', revision: 1, createdAt: change.at, updatedAt: change.at,
      inputs: trainA, options: null, baselines: [], changes: [{ ...change, kinds: ['job'] }], droppedChanges: 0 }
    expect(planSchema.safeParse(plan).success).toBe(true)
    expect(planSchema.safeParse({ ...plan, workspaceId: 'workspace-1' }).success).toBe(false)
    expect(planSchema.safeParse({ ...plan, source: { definition: 'train-a-work-week' } }).success).toBe(false)
  })
})

describe('a hard due rule (coordinator decision)', () => {
  // Train A window: Mon 16 Nov 07:00 to Sat 21 Nov 07:00 CET = 06:00Z to 06:00Z. Thu 19 Nov 15:00 CET = 14:00Z.
  const due = { kind: 'due', key: 'SR-SWA', job: 'SWA-RTS', finishBy: '2026-11-19T14:00:00Z', words: 'SW A surveillance due Thu 15:00', source: { by: 'reference', note: 'Surveillance frequency of the plant procedure' } }
  const withRule = (rule: object) => planInputsSchema.safeParse({ ...trainA, rules: [...trainA.rules, rule] })

  test('it parses as a stored rule and as a rule edit', () => {
    expect(ruleSchema.parse(due).kind).toBe('due')
    expect(withRule(due).success).toBe(true)
    const { source: _source, ...unsourced } = due
    expect(ruleSchema.safeParse(unsourced).success).toBe(false)
    expect(ruleSchema.safeParse({ ...due, by: due.finishBy }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'rule', key: 'SR-SWA', kind: 'due', job: 'SWA-RTS', finishBy: '2026-11-19T15:00:00+01:00', words: 'SW A surveillance due Thu 15:00', source: { by: 'planner' } }).success).toBe(true)
  })

  test('its time is checked against the plan window', () => {
    expect(withRule({ ...due, finishBy: '2026-11-21T06:00:00Z' }).success).toBe(true)
    expect(withRule({ ...due, finishBy: '2026-11-21T06:30:00Z' }).success).toBe(false)
    expect(withRule({ ...due, finishBy: '2026-11-16T06:00:00Z' }).success).toBe(false)
    expect(withRule({ ...due, finishBy: '2026-11-13T14:00:00Z' }).success).toBe(false)
    const refused = withRule({ ...due, finishBy: '2026-11-23T14:00:00Z' })
    expect(refused.error?.issues.map(issue => issue.path)).toEqual([['rules', 2, 'finishBy']])
  })

  test('a binding due rule can be named by float and by a temporal certificate', () => {
    const row = { job: 'SWA-RTS', start: '2026-11-19T09:00:00Z', finish: '2026-11-19T12:30:00Z', uses: [] }
    expect(datedRowSchema.safeParse({ ...row, float: { workingHours: 1.5, limitedBy: { kind: 'due', rule: 'SR-SWA' } } }).success).toBe(true)
    expect(certificateSchema.safeParse({ kind: 'temporal', steps: [{ job: 'SWA-PUMP-OUT', via: 'link' }, { job: 'SWA-RTS', via: 'due' }] }).success).toBe(true)
  })

  test('removing one is a rule removal, which carries authority (applyEdits refuses it without)', () => {
    const removal = { edits: [{ edit: 'remove', what: 'rule', key: 'SR-SWA' }] }
    expect(editInputSchema.safeParse({ ...removal, authority: { name: 'Operations manager', reason: 'Surveillance performed early on Monday' } }).success).toBe(true)
    expect(editInputSchema.safeParse({ ...removal, authority: { name: 'Operations manager' } }).success).toBe(false)
  })
})

describe('R1 protects exactly what it names (ai review)', () => {
  const r1 = trainA.rules.find((rule: any) => rule.key === 'R1')
  const item = (key: string) => trainA.equipment.find((entry: any) => entry.key === key)

  test('every Train B item, the turbine-driven AFW pump and the switchyard', () => {
    expect(r1.equipment).toEqual(['SWB', 'CCWB', 'RHRB', 'HHSIB', 'CSB', 'AFWB', 'AFWTD', 'EDGB', 'BUSB', 'SWYD'])
    expect(r1.words).toBe('Every Train B item (SW B, CCW B, RHR B, HHSI B, CS B, MD AFW B, EDG B, safety bus B), the turbine-driven AFW pump and the switchyard/offsite supply are never tagged, worked or tested.')
    for (const key of r1.equipment) expect(item(key)).toBeDefined()
  })

  test('pumps World reads carry their locator; items it does not read are declared by reference', () => {
    for (const key of ['SWB', 'CCWB', 'RHRB', 'HHSIB', 'CSB', 'AFWB', 'AFWTD']) {
      expect(item(key).locator).toStartWith('process-plant/plant%3Atrain-a/')
      expect(item(key).source?.by).not.toBe('reference')
    }
    for (const key of ['EDGB', 'BUSB', 'SWYD']) {
      expect(item(key).locator).toBeUndefined()
      expect(item(key).source.by).toBe('reference')
    }
    expect(equipmentSchema.safeParse({ ...item('EDGB'), source: { by: 'reference' } }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'equipment', key: 'SWYD', label: 'Switchyard and offsite supply', supportedBy: [], source: { by: 'reference', note: 'maint case change C10' } }).success).toBe(true)
  })
})

describe('Train A is valid input for the checker', () => {
  test('one tag-out covers the CCW A pump and HX A, so every work job inside an item is bracketed', () => {
    const tag = trainA.jobs.find((job: any) => job.key === 'CCWA-TAG')
    expect([tag.kind, tag.equipment]).toEqual(['tag-out', ['CCWA', 'CCWHXA']])
    const inputs = planInputsSchema.parse(trainA)
    for (const option of inputs.methods[0]!.options) {
      const result = checkPlan(inputs, { methods: [{ choice: inputs.methods[0]!.key, option: option.key }], purchases: inputs.purchases.map(purchase => purchase.key) }, [])
      expect({ option: option.key, problems: result.violations.filter(violation => inputCodes.has(violation.code)).map(violation => violation.words) }).toEqual({ option: option.key, problems: [] })
    }
  })
})

describe('function keys name items that back each other up', () => {
  test('each A/B pair shares one key; the turbine-driven AFW pump has its own; series items have none', () => {
    const fn = (key: string) => trainA.equipment.find((item: any) => item.key === key)?.function
    const pairs: Array<[string, string]> = [['SWA', 'SWB'], ['CCWA', 'CCWB'], ['RHRA', 'RHRB'], ['HHSIA', 'HHSIB'], ['CSA', 'CSB'], ['AFWA', 'AFWB']]
    for (const [a, b] of pairs) {
      expect(fn(a)).toBeString()
      expect(fn(a)).toBe(fn(b))
    }
    expect(fn('AFWTD')).not.toBe(fn('AFWA'))
    expect(fn('CCWHXA')).toBeUndefined()
    for (const item of trainA.equipment.filter((entry: any) => entry.function !== undefined)) expect(item.source).toEqual({ by: 'planner', note: shownNotes.membership })
  })

  test('it parses as a key on stored equipment and in the equipment edit; null clears it', () => {
    const item = { key: 'MFWA', label: 'Main Feedwater Pump A', supportedBy: [], function: 'main-feedwater' }
    expect(equipmentSchema.parse(item).function).toBe('main-feedwater')
    expect(equipmentSchema.safeParse({ ...item, function: 'main feedwater' }).success).toBe(false)
    expect(equipmentSchema.safeParse({ ...item, function: null }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'equipment', key: 'MFWA', function: 'main-feedwater' }).success).toBe(true)
    expect(editSchema.safeParse({ edit: 'equipment', key: 'MFWA', function: null }).success).toBe(true)
    expect(editSchema.safeParse({ edit: 'equipment', key: 'MFWA', function: '' }).success).toBe(false)
  })
})

describe('shown text in the fixtures is in planner words (walk item 16)', () => {
  const fixtures = ['train-a.case.json', 'train-a.fragment.json', 'supply-run.case2.json']
  const texts = async (name: string, fields: ReadonlySet<string>) => {
    const found: Array<[string, string]> = []
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((child, index) => walk(child, `${path}/${index}`))
      if (node === null || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node)) {
        if (typeof value === 'string' && fields.has(key)) found.push([`${name}${path}/${key}`, value])
        else walk(value, `${path}/${key}`)
      }
    }
    walk(await fixture(name), '')
    return found
  }
  // Review traces: the reviewer names maint and or, case change ids C1-C12, case versions and the twin.
  const reviewTrace = /maint|\bor\b|case change|\bC(1[0-2]|[1-9])\b|v0\.2|v1\.1|twin/i
  // In every shown text, ids and versions of review artefacts (design ids such as S10, review files).
  const reviewId = /case change|\b[ACDGS](1[0-2]|[1-9])\b|v0\.2|v1\.1|twin|\.md\b/i

  test('no note names a reviewer, a case change, a case version or the twin', async () => {
    for (const name of fixtures) {
      const notes = await texts(name, new Set(['note']))
      expect(notes.length).toBeGreaterThan(0)
      expect(notes.filter(([, text]) => reviewTrace.test(text))).toEqual([])
    }
  })

  test('no label, title or words carry a review id', async () => {
    for (const name of fixtures) expect((await texts(name, new Set(['label', 'title', 'words', 'purpose', 'note']))).filter(([, text]) => reviewId.test(text))).toEqual([])
  })

  test('the checks catch the old notes', () => {
    for (const old of ['train membership: planner knowledge (case v0.2)', 'maint case change C10: EDG B ...', "or's runs", 'Dispatcher\'s coverage rule (case2.md).']) expect(reviewTrace.test(old) || reviewId.test(old)).toBe(true)
    expect(reviewId.test('Vendor promises the spare for Monday 12:00 (scheduled at it and flagged; S10)')).toBe(true)
    for (const fine of ['Backup pair: the planner\'s knowledge of the plant\'s trains.', 'Protected-train practice for work at power (NUMARC 93-01 section 11)', 'NUREG-1431 LCO 3.7.5 Condition B']) expect(reviewTrace.test(fine)).toBe(false)
  })
})

describe('whole-window calendars follow the plan window (walk 3, R3-1)', () => {
  // Lane P's edit moves a calendar with the plan window when its periods are exactly the window, with no
  // weekly entries and no exceptions. That form has no schema field; this pins which fixture calendars use it.
  const isWholeWindow = (inputs: any, calendar: any) => inputs.settings.window !== null && calendar.weekly.length === 0 && calendar.except.length === 0
    && calendar.periods.length === 1 && Date.parse(calendar.periods[0].start) === Date.parse(inputs.settings.window.start) && Date.parse(calendar.periods[0].end) === Date.parse(inputs.settings.window.end)

  test('the Supply run trucks on duty from the start are whole-window; the announced joins stay absolute', () => {
    expect(supplyRun.calendars.filter((calendar: any) => isWholeWindow(supplyRun, calendar)).map((calendar: any) => calendar.key)).toEqual(['exercise'])
    expect(supplyRun.resources.filter((resource: any) => resource.calendar === 'exercise').map((resource: any) => resource.key)).toEqual(['truck-1', 'truck-3', 'truck-4'])
  })

  test('Train A has no whole-window calendar: its shifts are weekly and its bookings are fixed dates', async () => {
    const full = await fixture('train-a.case.json')
    for (const inputs of [trainA, full]) expect(inputs.calendars.filter((calendar: any) => isWholeWindow(inputs, calendar))).toEqual([])
  })
})

// ═══════════ Increment 2 "Choose": schema part 2 (design r3 §0.3, §2.2; adversary part 2 check, fixes A and C) ═══════════
// Every part 2 example of R/impl/inc23/schema-draft.ts, against the real schema, and design §8's part 2 rows for lane A.

type Word = 'proven optimal' | 'best found under budget'
const earliest = { value: 10, source: 'logic+calendars', certificate: { kind: 'earliest-finish', jobs: [{ job: 'AFWA-RTS', finish: '2026-11-17T10:00:00Z' }] } }
const lineOf = (word: Word, goal: number) => ({ word, goal, value: 10, unit: 'h', ...(word === 'proven optimal' ? { bound: earliest } : {}) })
const feasible = (words: readonly Word[], lead?: object, ids: readonly number[] = words.map((_, index) => index)) =>
  ({ word: 'validated feasible', run, goals: words.map((word, index) => lineOf(word, ids[index]!)), ...(lead === undefined ? {} : { lead }) })
const leastSpan = { value: 7.5, source: 'logic+calendars', certificate: { kind: 'least-span', spans: [{ group: 'AFW-A', hours: 7.5 }] } }
const afwFirst = (word: Word, extra: object = {}) => ({ group: 'AFW-A', word, value: 7.5, unit: 'h', ...extra })
const found: Word = 'best found under budget', proof: Word = 'proven optimal'
const issues = (value: unknown) => statusSchema.safeParse(value).error?.issues.map(issue => issue.path.join('.')) ?? []

describe('increment 2: method caveats', () => {
  test('the spare exposure caveat parses, with who must agree; a value comes with its unit (draft)', () => {
    const exposure = { label: 'Weeks without a ready SW spare', value: 10, unit: 'weeks', words: 'Vendor turnaround, planner estimate 8–14 weeks; not priced', agreement: 'Spares owner' }
    expect(caveatSchema.safeParse(exposure).success).toBe(true)
    const { value: _value, unit: _unit, ...unvalued } = exposure
    expect(caveatSchema.safeParse(unvalued).success).toBe(true)
    expect(caveatSchema.safeParse({ ...unvalued, value: 10 }).error?.issues.map(issue => issue.path)).toEqual([['unit']])
    expect(caveatSchema.safeParse({ ...unvalued, unit: 'weeks' }).success).toBe(false)
    const { words: _words, ...wordless } = exposure
    expect(caveatSchema.safeParse(wordless).success).toBe(false)
  })

  const caveat = { label: 'Depends on a delivery', words: 'The spare is promised for Monday 12:00.' }

  test('a stored method option holds one to four caveats; an empty list is refused', () => {
    const method = trainA.methods[0]
    const withCaveats = (caveats: unknown[]) => methodChoiceSchema.safeParse({ ...method, options: [{ ...method.options[0], caveats }, method.options[1]] }).success
    expect(withCaveats([caveat])).toBe(true)
    expect(withCaveats(Array.from({ length: 4 }, () => caveat))).toBe(true)
    expect(withCaveats(Array.from({ length: 5 }, () => caveat))).toBe(false)
    expect(withCaveats([])).toBe(false)
  })

  test('the method edit gives caveats; omitted keeps them, null clears them, and words stay', async () => {
    const inputs = planInputsSchema.parse(await fixture('train-a.case.json'))
    const context = { now: '2026-11-12T10:02:00+01:00', by: { kind: 'human' as const } }
    const option = (key: string, extra: object = {}) => ({ key, label: key, fixedCost: 1, ...extra })
    const method = (options: unknown[]) => editSchema.parse({ edit: 'method', key: 'SWA-method', options })
    const worded = { ...inputs, methods: [{ ...inputs.methods[0]!, options: inputs.methods[0]!.options.map(entry => ({ ...entry, words: `${entry.label}, as planned` })) }] }
    const given = applyEdits(worded, [method([option('rebuild', { caveats: [caveat] }), option('swap', { caveats: [caveat, caveat] })])], context).inputs
    expect(given.methods[0]!.options.map(entry => [entry.words, entry.caveats?.length])).toEqual([['Rebuild in place, as planned', 1], ['Swap in refurbished spare, as planned', 2]])
    const kept = applyEdits(given, [method([option('rebuild'), option('swap', { caveats: null })])], context).inputs.methods[0]!.options
    expect(kept.map(entry => entry.caveats)).toEqual([[caveat], undefined])
    expect(planInputsSchema.safeParse({ ...inputs, methods: [{ ...inputs.methods[0]!, options: kept }] }).success).toBe(true)
    const added = applyEdits(inputs, [editSchema.parse({ edit: 'method', key: 'CCW-method', label: 'CCW seal', options: [option('a', { caveats: [caveat] }), option('b')] })], context).inputs.methods[1]!.options
    expect(added.map(entry => entry.caveats)).toEqual([[caveat], undefined])
    expect(editSchema.safeParse({ edit: 'method', key: 'SWA-method', options: [option('rebuild', { caveats: [] }), option('swap')] }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'method', key: 'SWA-method', options: [option('rebuild', { caveats: [{ ...caveat, value: 3 }] }), option('swap')] }).success).toBe(false)
  })
})

describe('increment 2: what-if variants (also, lead)', () => {
  const r2 = { kind: 'span-limit', key: 'W48', group: 'COOL-A', limit: { value: 48, unit: 'h' }, singleEntry: true, words: 'Train A cooling chain back within 48 h', source: { by: 'planner' } }
  const due = { kind: 'due', key: 'W-AFW', job: 'AFWA-RTS', finishBy: '2026-11-18T12:00:00Z', words: 'AFW A back by Wed 13:00', source: { by: 'planner' } }

  test('also holds exactly one span-limit or due rule, and never another kind', () => {
    expect(alsoRuleSchema.safeParse(r2).success).toBe(true)
    expect(alsoRuleSchema.safeParse(due).success).toBe(true)
    for (const rule of trainA.rules.filter((entry: { kind: string }) => entry.kind === 'protected')) expect(alsoRuleSchema.safeParse(rule).success).toBe(false)
    expect(alsoRuleSchema.safeParse({ kind: 'keep-in-service', key: 'k', members: [{ equipment: 'A' }, { equipment: 'B' }], atLeast: 1, words: 'x', source: { by: 'planner' } }).success).toBe(false)
    const option = (variant: object) => optionSchema.safeParse({ key: 'w48', label: 'At most 48 h out', variant: { methods: [], purchases: [], ...variant }, status: { word: 'unresolved', run }, rows: [], metrics: [], inputsRevision: 1 }).success
    expect(option({ also: [r2] })).toBe(true)
    expect(option({ also: [] })).toBe(false)
    expect(option({ also: [r2, due] })).toBe(false)
    expect(option({ also: [{ ...r2, source: undefined }] })).toBe(false)
  })

  test('lead is a plan goal by id or a group, never a bare index (draft)', () => {
    expect(leadSchema.safeParse({ goal: 1 }).success).toBe(true)
    expect(leadSchema.safeParse({ group: 'AFW-A' }).success).toBe(true)
    expect(leadSchema.safeParse(1).success).toBe(false)
    expect(leadSchema.safeParse({ goal: 6 }).success).toBe(false)
    expect(leadSchema.safeParse({ goal: 1, group: 'AFW-A' }).success).toBe(false)
    expect(leadSchema.safeParse({ group: 'AFW A' }).success).toBe(false)
  })
})

describe('increment 2: the lead status keeps the plan\'s goal ids; only the lead is proven (adversary r2 decision 1)', () => {
  test('fix C: a lead-first status with cost (goal 1) proven parses; the same words without a lead break the order rule (draft)', () => {
    expect(issues(feasible([found, proof, found], { goal: 1 }))).toEqual([])
    expect(issues(feasible([found, proof, found]))).toEqual(['goals.1.word'])
    expect(issues(feasible([found, found, proof], { goal: 2 }))).toEqual([])
    expect(issues(feasible([proof, found, found], { goal: 0 }))).toEqual([])
  })

  test('a proof out of place, a renumbered goal or a lead beyond the plan\'s goals is refused (draft)', () => {
    expect(issues(feasible([proof, proof, found], { goal: 1 }))).toEqual(['goals.0.word'])
    expect(issues(feasible([found, found, proof], { goal: 1 }))).toEqual(['goals.2.word'])
    expect(issues(feasible([proof, found, found], { goal: 1 }, [1, 0, 2]))).toContain('goals.0.goal')
    expect(issues(feasible([found, found, found], { goal: 3 }))).toEqual(['lead.goal'])
    expect(issues({ word: 'unresolved', run, lead: { goal: 0 } }).length).toBeGreaterThan(0)
  })

  test('"finish AFW A first": the group\'s own proven line, every plan goal best found (draft)', () => {
    expect(issues(feasible([found, found, found], afwFirst(proof, { bound: leastSpan })))).toEqual([])
    expect(issues(feasible([found, found, found], afwFirst(found)))).toEqual([])
    expect(issues(feasible([found, found, found], afwFirst(found, { bound: { ...leastSpan, value: 7, certificate: undefined } })))).toEqual([])
    expect(issues(feasible([proof, found], afwFirst(found)))).toEqual(['goals.0.word'])
  })

  test('fix A: a group lead "proven optimal" names its bound and certificate and equals the bound (draft)', () => {
    // Without a bound or its certificate the line is no line of the union: refused at the lead.
    expect(issues(feasible([found, found], afwFirst(proof)))).toEqual(['lead'])
    expect(issues(feasible([found, found], afwFirst(proof, { bound: { value: 7.5, source: 'logic+calendars' } })))).toEqual(['lead'])
    expect(issues(feasible([found, found], afwFirst(proof, { value: 9, bound: leastSpan })))).toEqual(['lead.bound'])
    expect(issues(feasible([found, found], afwFirst(found, { value: 7, bound: leastSpan })))).toEqual(['lead.bound'])
    expect(issues(feasible([found, found], afwFirst(proof, { unit: 'NOK', bound: leastSpan })))).toEqual(['lead.unit'])
    expect(issues(feasible([found, found], { group: 'AFW-A' })).length).toBeGreaterThan(0)
  })

  test('goalProofBreaks is the one proof rule: goal order without a lead, the lead alone with one', () => {
    expect(goalProofBreaks([found, proof, proof])).toEqual([1, 2])
    expect(goalProofBreaks([proof, proof, found])).toEqual([])
    expect(goalProofBreaks([found, proof, proof], { goal: 1 })).toEqual([2])
    expect(goalProofBreaks([proof, found], { group: 'AFW-A' })).toEqual([0])
  })
})

describe('increment 2: an option\'s lead and its status\'s lead name the same thing', () => {
  const withLead = (asked: object | undefined, solved: object | undefined) => ({
    key: 'afw-first', label: 'Finish AFW A first', variant: { methods: [], purchases: [], ...(asked === undefined ? {} : { lead: asked }) },
    status: feasible([found, found, found], solved), rows: [], metrics: [], inputsRevision: 1,
  })

  test('another lead, or a lead on one side only, is refused (draft)', () => {
    expect(optionLeadIssue({ variant: { methods: [], purchases: [], lead: { goal: 1 } }, status: feasible([found, found], { goal: 0 }) as never })).toBe('The status names another leading goal than the what-if')
    expect(optionSchema.safeParse(withLead({ goal: 1 }, { goal: 1 })).success).toBe(true)
    expect(optionSchema.safeParse(withLead({ group: 'AFW-A' }, afwFirst(found))).success).toBe(true)
    expect(optionSchema.safeParse(withLead({ group: 'CS-A' }, afwFirst(found))).success).toBe(false)
    expect(optionSchema.safeParse(withLead({ goal: 1 }, { group: 'AFW-A', word: found, value: 1, unit: 'h' })).success).toBe(false)
    expect(optionSchema.safeParse(withLead({ goal: 1 }, undefined)).success).toBe(false)
    // An option that is not a what-if cannot claim a lead to carry a proof out of goal order.
    expect(optionSchema.safeParse({ ...withLead(undefined, { goal: 1 }), status: feasible([found, proof, found], { goal: 1 }) }).error?.issues.map(issue => issue.path.join('.'))).toEqual(['status.lead'])
    expect(optionSchema.safeParse({ ...withLead({ goal: 1 }, undefined), status: { word: 'unresolved', run } }).success).toBe(true)
  })
})

describe('increment 2: re-timing, bought metrics and the previous option set', () => {
  test('pessimistic re-timing: holds, or the first rule broken with its job and by how much; no stored +25 % (draft, S4)', () => {
    const breaks = { holds: false, rule: 'R2', job: 'CCWHXA-CLEAN', by: { value: 3, unit: 'h' } }
    expect(robustSchema.safeParse({ allPessimistic: breaks, single: [{ job: 'CCWHXA-CLEAN', outcome: breaks }] }).success).toBe(true)
    expect(robustSchema.safeParse({ allPessimistic: { holds: true }, plus25: { holds: true }, single: [] }).success).toBe(false)
    expect(robustSchema.safeParse({ allPessimistic: { holds: true }, single: [] }).success).toBe(true)
    expect(robustSchema.safeParse({ allPessimistic: { ...breaks, by: { value: 0, unit: 'h' } }, single: [] }).success).toBe(false)
    expect(robustSchema.safeParse({ allPessimistic: { holds: true, rule: 'R2' }, single: [] }).success).toBe(false)
    expect(robustSchema.safeParse({ allPessimistic: { holds: true }, single: Array.from({ length: 13 }, () => ({ job: 'A', outcome: { holds: true } })) }).success).toBe(false)
  })

  test('an option takes one bought:<purchase> metric per purchase, beside its other measures', () => {
    const option = (count: number) => optionSchema.safeParse({ key: 'o', label: 'o', variant: { methods: [], purchases: [] }, status: { word: 'unresolved', run }, rows: [],
      metrics: Array.from({ length: count }, (_, index) => ({ id: `bought:p${index}`, value: 1, unit: 'h' })), inputsRevision: 1 }).success
    expect(option(96)).toBe(true)
    expect(option(97)).toBe(false)
  })

  test('the previous option set is an option set of the plan schema; untyped content is refused', async () => {
    const [, line] = (await Bun.file(new URL('./fixtures/increment-1-plan.json', import.meta.url)).text()).split('\n')
    const { frozenInputs: _frozen, baselines: _baselines, ...stored } = JSON.parse(line!)
    const plan = { ...stored, baselines: [] }
    expect(planSchema.safeParse({ ...plan, previousOptions: plan.options }).success).toBe(true)
    expect(planSchema.safeParse({ ...plan, previousOptions: { ...plan.options, note: 'x' } }).success).toBe(false)
    expect(planSchema.safeParse({ ...plan, previousOptions: { at: plan.options.at, by: plan.options.by, options: [{ key: 'x' }] } }).success).toBe(false)
    expect(planSchema.safeParse({ ...plan, previousOptions: null }).success).toBe(false)
  })
})

describe('no crew numbers in the dated rows (adversary r2 decision 3)', () => {
  test('a crew use names its pool and times, never which crew of it', () => {
    const row = { job: 'CCWA-SEAL', start: '2026-11-17T06:00:00Z', finish: '2026-11-17T16:00:00Z', float: { workingHours: 0, limitedBy: { kind: 'window-end' } } }
    const use = { resource: 'mech-station', from: '2026-11-17T06:00:00Z', to: '2026-11-17T16:00:00Z' }
    expect(datedRowSchema.safeParse({ ...row, uses: [use] }).success).toBe(true)
    expect(datedRowSchema.safeParse({ ...row, uses: [{ ...use, unit: 2 }] }).success).toBe(false)
    expect(datedRowSchema.safeParse({ ...row, uses: [use], crews: [2] }).success).toBe(false)
  })
})

describe('an increment 1 plan file reads unchanged (design §2.1, D7, C9)', () => {
  // increment-1-plan.json: written by fixtures/increment-1-plan.make.ts at 1212cfe0e (create, link, refresh, Generate, baseline 'Freeze').
  test('its plan, options and saved baseline read through the store as a plan of this schema, not damaged', async () => {
    const text = await Bun.file(new URL('./fixtures/increment-1-plan.json', import.meta.url)).text()
    const stored = JSON.parse(text.split('\n')[1]!)
    const root = await mkdtemp(join(tmpdir(), 'planning-inc1-'))
    try {
      const store = createPlanStore(root)
      const workspaceId = workspaceIdSchema.parse(stored.workspaceId)
      await store.provision(workspaceId)
      await mkdir(join(root, 'workspaces', workspaceId, 'planning', 'plans'), { recursive: true })
      await Bun.write(join(root, 'workspaces', workspaceId, 'planning', 'plans', `${stored.id}.json`), text)
      expect((await store.list(workspaceId)).damaged).toEqual([])
      const plan = await store.read(workspaceId, stored.id)
      expect(planSchema.parse(plan)).toEqual(plan)
      expect(plan.baselines.map(baseline => [baseline.name, baseline.option.key, baseline.option.status.word])).toEqual([['Freeze', stored.options.recommended, 'validated feasible']])
      expect(plan.baselines[0]!.inputs).toEqual(plan.inputs)
      expect(plan.options!.options.every(option => option.inputsRevision === plan.revision && option.status.word === 'validated feasible')).toBe(true)
      // Written before increment 2: no part 2 field is in it, and nothing was migrated to read it.
      expect([plan.previousOptions, ...plan.options!.options.map(option => option.robust ?? option.variant.lead ?? option.variant.also)]).toEqual([undefined, undefined, undefined])
      expect(plan.inputs.methods[0]!.options.every(option => option.caveats === undefined)).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
