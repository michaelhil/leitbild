import { describe, expect, test } from 'bun:test'
import {
  attributeSchema, calendarSchema, certificateSchema, changeSchema, combineWorldFacts, datedRowSchema, durationSchema, durationWithSchema, editKindSchema, equipmentSchema, goalSchema,
  jobSchema, planInputsSchema, planSchema, purchaseSchema, resourceSchema, ruleSchema, statusSchema, type WorldFactCopy,
} from './schema.ts'
import { editSchema } from './edit-schema.ts'
import { editInputSchema, generateResultSchema } from '../api/contract.ts'

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
    expect(train.jobs).toHaveLength(12)
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
    expect(accepted({ word: 'unresolved', run, goals: [{ word: 'proven optimal', goal: 0, value: 0, unit: 'h', bound: { value: 0, source: 'logic+calendars' } }] })).toBe(false)
    expect(accepted({ word: 'proven infeasible', run })).toBe(false)
    expect(accepted({ word: 'validated feasible', run, goals: [
      { word: 'best found under budget', goal: 0, value: 2.5, unit: 'h' },
      { word: 'proven optimal', goal: 1, value: 398800, unit: 'NOK', bound: { value: 398800, source: 'fixed-costs' } }] })).toBe(false)
    expect(accepted({ word: 'validated feasible', run, goals: [{ word: 'proven optimal', goal: 0, value: 3, unit: 'h', bound: { value: 0, source: 'logic+calendars' } }] })).toBe(false)
    expect(accepted({ word: 'cancelled', run, cause: chain(37, 32) })).toBe(false)
    expect(accepted({ word: 'validated feasible', run, goals: [
      { word: 'proven optimal', goal: 0, value: 0, unit: 'h', bound: { value: 0, source: 'logic+calendars' } },
      { word: 'best found under budget', goal: 1, value: 464250, unit: 'NOK', bound: { value: 340000, source: 'fixed-costs' } }] })).toBe(true)
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
    const goals = (second: object) => ({ word: 'validated feasible', run, goals: [{ word: 'proven optimal', goal: 0, value: 0, unit: 'h', bound: { value: 0, source: 'logic+calendars' } }, { goal: 1, ...second }] })
    expect(accepted(goals({ word: 'proven optimal', value: 464250, unit: 'NOK', bound: { value: 464249.9999999997, source: 'fixed-costs' } }))).toBe(true)
    expect(accepted(goals({ word: 'proven optimal', value: 464250, unit: 'NOK', bound: { value: 464249, source: 'fixed-costs' } }))).toBe(false)
    expect(accepted(goals({ word: 'proven optimal', value: 2.5, unit: 'h', bound: { value: 2.4999999999, source: 'logic+calendars' } }))).toBe(true)
    expect(accepted(goals({ word: 'proven optimal', value: 2.5, unit: 'h', bound: { value: 2, source: 'logic+calendars' } }))).toBe(false)
    expect(accepted(goals({ word: 'best found under budget', value: 464250, unit: 'NOK', bound: { value: 464250.0000000003, source: 'fixed-costs' } }))).toBe(true)
    expect(accepted(goals({ word: 'best found under budget', value: 464250, unit: 'NOK', bound: { value: 464251, source: 'fixed-costs' } }))).toBe(false)
    expect(accepted(goals({ word: 'best found under budget', value: 3, unit: 'kg' }))).toBe(false)
    const fine = { ...run, grid: '30s' }
    expect(accepted({ word: 'validated feasible', run: fine, goals: [{ word: 'proven optimal', goal: 0, value: 1, unit: 'min', bound: { value: 0.5, source: 'logic+calendars' } }] })).toBe(false)
    expect(accepted({ word: 'validated feasible', run: fine, goals: [{ word: 'proven optimal', goal: 0, value: 1, unit: 'min', bound: { value: 0.9999999, source: 'logic+calendars' } }] })).toBe(true)
  })

  test('3. the Assistant-facing status uses the status words and the goal order rule', () => {
    const result = (status: object) => generateResultSchema.safeParse({ plan: { id: '0c4008f3-ffac-47ce-9be0-a0c71e68a781', revision: 3 }, options: [{ key: 'o1', label: 'Swap', status, warnings: [] }], text: 'x' }).success
    expect(result({ word: 'validated feasible', goals: [{ word: 'best found under budget', value: 2.5, unit: 'h' }, { word: 'proven optimal', value: 398800, unit: 'NOK', bound: 398800, gap: 0 }] })).toBe(false)
    expect(result({ word: 'optimal', goals: [] })).toBe(false)
    expect(result({ word: 'validated feasible', goals: [{ word: 'optimal', value: 2.5, unit: 'h' }] })).toBe(false)
    expect(result({ word: 'unresolved', goals: [{ word: 'best found under budget', value: 2.5, unit: 'h' }] })).toBe(false)
    expect(result({ word: 'proven infeasible', goals: [] })).toBe(false)
    expect(result({ word: 'validated feasible', goals: [{ word: 'proven optimal', value: 0, unit: 'h' }] })).toBe(false)
    expect(result({ word: 'validated feasible', goals: [{ word: 'best found under budget', value: 2.5, unit: 'h', bound: 1 }] })).toBe(false)
    expect(result({ word: 'validated feasible', goals: [{ word: 'proven optimal', value: 0, unit: 'h', bound: 0, gap: 0 }, { word: 'best found under budget', value: 464250, unit: 'NOK', bound: 340000, gap: 124250 }] })).toBe(true)
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
      expect(item(key).source).toBeUndefined()
    }
    for (const key of ['EDGB', 'BUSB', 'SWYD']) {
      expect(item(key).locator).toBeUndefined()
      expect(item(key).source.by).toBe('reference')
    }
    expect(equipmentSchema.safeParse({ ...item('EDGB'), source: { by: 'reference' } }).success).toBe(false)
    expect(editSchema.safeParse({ edit: 'equipment', key: 'SWYD', label: 'Switchyard and offsite supply', supportedBy: [], source: { by: 'reference', note: 'maint case change C10' } }).success).toBe(true)
  })
})
