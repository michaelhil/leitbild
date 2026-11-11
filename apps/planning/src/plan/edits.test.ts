import { describe, expect, test } from 'bun:test'
import { applyEdits, requireAuthority, type EditContext } from './edits.ts'
import { editSchema, type Edit } from './edit-schema.ts'
import { planInputsSchema, type PlanInputs } from './schema.ts'

const fixture = async (name: string): Promise<PlanInputs> => planInputsSchema.parse(await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json())
const trainA = await fixture('train-a.fragment.json')
const supplyRun = await fixture('supply-run.case2.json')
const context: EditContext = { now: '2026-11-12T10:02:00+01:00', by: { kind: 'human', name: 'Planner' } }
const edits = (...given: unknown[]): Edit[] => given.map(edit => editSchema.parse(edit))
const apply = (inputs: PlanInputs, ...given: unknown[]) => applyEdits(inputs, edits(...given), context)
const refusal = (work: () => unknown) => {
  try { work() } catch (error) { return error as { status: number; code: string; message: string; details?: Record<string, unknown> } }
  throw new Error('expected a refusal')
}
const job = (inputs: PlanInputs, key: string) => inputs.jobs.find(entry => entry.key === key)!
const weakenings = (inputs: PlanInputs, ...given: unknown[]) => apply(inputs, ...given).weakens.map(weakening => [weakening.code, weakening.what, weakening.about[0]])

// Keys from the fixture, never values: a tested work job, its supports, a covered item and the protected item.
const protectedRule = trainA.rules.find(rule => rule.kind === 'protected')!
const protectedItem = protectedRule.kind === 'protected' ? protectedRule.equipment[0]! : ''
const spanRule = trainA.rules.find(rule => rule.kind === 'span-limit')!
const supported = trainA.equipment.find(item => item.supportedBy.length > 0)!
const groupedTagOut = trainA.jobs.find(entry => entry.kind === 'tag-out' && entry.equipment.some(key => trainA.equipment.find(item => item.key === key)?.group !== undefined))!
const minimumTest = trainA.jobs.find(entry => entry.kind === 'test' && entry.minimum !== undefined)!
const workJob = trainA.jobs.find(entry => entry.kind === 'work' && entry.isolation === 'inside')!

describe('field-level edits (S1)', () => {
  test('a given field replaces that field, null clears an optional one, an omitted field is kept', () => {
    const target = trainA.jobs.find(entry => entry.duration.range !== undefined)!
    const { inputs, changes } = apply(trainA, { edit: 'job', key: target.key, duration: { value: target.duration.value! + 6 } }, { edit: 'job', key: target.key, duration: { range: null } })
    const after = job(inputs, target.key)
    expect(after.duration.value).toBe(target.duration.value! + 6)
    expect(after.duration.range).toBeUndefined()
    expect(after.duration.unit).toBe(target.duration.unit)
    expect(after.needs).toEqual(target.needs)
    expect(changes.map(change => [change.verb, change.what, change.key])).toEqual([['changed', 'job', target.key], ['changed', 'job', target.key]])
    expect(job(trainA, target.key).duration.value).toBe(target.duration.value)   // the input is never mutated
  })

  test('a new key needs every required field; a missing estimate is asked for, never defaulted', () => {
    const missing = refusal(() => apply(trainA, { edit: 'job', key: 'NEW', title: 'New job', kind: 'work', isolation: 'none' }))
    expect([missing.status, missing.code]).toEqual([400, 'invalid_request'])
    expect(missing.message).toContain('needs duration')
    expect((missing.details?.expected as { fields: string[] }).fields).toContain('duration')
    const noIsolation = refusal(() => apply(trainA, { edit: 'job', key: 'NEW', title: 'New job', kind: 'work', duration: { value: 2, unit: 'h', calendar: 'working' } }))
    expect(noIsolation.message).toContain('isolation')
    const created = apply(trainA, { edit: 'job', key: 'NEW', title: 'New job', kind: 'work', isolation: 'none', duration: { value: 2, unit: 'h', calendar: 'working' } })
    expect(job(created.inputs, 'NEW')).toMatchObject({ needs: [], tags: [], continuous: false, duration: { origin: { by: 'planner' } } })
  })

  test('a link is named by (from, to, type) and a removed job takes its links with it', () => {
    const pairs = trainA.jobs.flatMap(from => trainA.jobs.filter(to => to !== from).map(to => [from, to] as const))
    const [first, second] = pairs.find(([from, to]) => !trainA.links.some(link => link.from === from.key && link.to === to.key))!
    const linked = apply(trainA, { edit: 'link', from: first!.key, to: second!.key, type: 'FS' })
    expect(linked.inputs.links.filter(link => link.from === first!.key && link.to === second!.key && link.type === 'FS')).toEqual([{ from: first!.key, to: second!.key, type: 'FS', lag: { value: 0, unit: 'h' } }])
    const removed = apply(linked.inputs, { edit: 'remove', what: 'job', key: second!.key })
    expect(removed.inputs.links.some(link => link.from === second!.key || link.to === second!.key)).toBe(false)
    expect(removed.changes.filter(change => change.what === 'link' && change.verb === 'removed').length).toBe(linked.inputs.links.filter(link => link.from === second!.key || link.to === second!.key).length)
  })

  test('every key a plan names must exist', () => {
    const unknown = refusal(() => apply(trainA, { edit: 'job', key: workJob.key, needs: [{ anyOf: ['nobody'] }] }))
    expect([unknown.status, unknown.code, unknown.details?.about]).toEqual([400, 'unknown_reference', [workJob.key, 'nobody']])
    expect(refusal(() => apply(trainA, { edit: 'remove', what: 'calendar', key: trainA.resources[0]!.calendar })).code).toBe('unknown_reference')
    expect(refusal(() => apply(trainA, { edit: 'equipment', key: supported.supportedBy[0]!, supportedBy: [supported.key] })).message).toContain('cycle')
  })

  test('linking a Run stores only its reference and clears copies of another Run', () => {
    const read = { ...supplyRun, settings: { ...supplyRun.settings, run: { id: 'run-1', linkedAt: '2026-09-03T08:00:00Z' } }, world: { refreshedAt: '2026-09-03T08:00:05Z', facts: [{ id: 'f', label: 'f', quantity: 'state', value: true, basis: 'observed' as const, at: '2026-09-03T08:00:00Z', locator: 'einsatz/unit/x' }] } }
    const linked = apply(read, { edit: 'plan', run: 'run-2' })
    expect(linked.inputs.settings.run).toEqual({ id: 'run-2', linkedAt: '2026-11-12T09:02:00Z' })
    expect(linked.inputs.world).toEqual({ refreshedAt: null, facts: [] })
    expect(linked.runChanged).toBe(true)
  })

  test('a World value is stored as references, never as a number; a unit Planning cannot convert is refused', () => {
    const truck = supplyRun.resources.find(resource => resource.attributes.some(attribute => attribute.origin.by === 'world'))!
    const attribute = truck.attributes.find(entry => entry.origin.by === 'world')!
    const ref = attribute.origin.by === 'world' ? attribute.origin.refs[0]! : undefined!
    const kept = apply(supplyRun, { edit: 'resource', key: truck.key, attributes: [{ key: attribute.key, label: attribute.label, unit: attribute.unit, fromWorld: ref }] })
    expect(kept.inputs.resources.find(resource => resource.key === truck.key)!.attributes[0]).toMatchObject({ value: null, origin: { by: 'world', refs: [ref] } })
    const read = { ...supplyRun, world: { refreshedAt: '2026-09-03T08:00:05Z', facts: [{ id: ref.fact, label: 'Payload', quantity: 'payloadKg', unit: 'lb', value: 700, basis: 'configured' as const, at: '2026-09-03T08:00:00Z', locator: ref.locator }] } }
    const unit = refusal(() => apply(read, { edit: 'resource', key: truck.key, attributes: [{ key: attribute.key, label: attribute.label, unit: attribute.unit, fromWorld: ref }] }))
    expect([unit.code, unit.message.includes('"lb"')]).toEqual(['invalid_request', true])
  })
})

describe('hard rules: protection, authority and minimums (A2, adversary item 8)', () => {
  test('a job on protected equipment is refused, with or without authority', () => {
    const refused = refusal(() => apply(trainA, { edit: 'job', key: workJob.key, equipment: [protectedItem] }))
    expect([refused.status, refused.code, refused.details?.about]).toEqual([409, 'protected_equipment', [workJob.key, protectedItem, protectedRule.key]])
  })

  test('each weakening edit is named and needs authority; adding a rule needs none', () => {
    expect(weakenings(trainA, { edit: 'equipment', key: supported.key, supportedBy: [] })).toEqual([['needs_authority', 'support', supported.key]])
    const grouped = trainA.equipment.find(item => item.group === (spanRule.kind === 'span-limit' ? spanRule.group : ''))!
    expect(weakenings(trainA, { edit: 'equipment', key: grouped.key, group: null })).toEqual([['needs_authority', 'group', grouped.key]])
    expect(weakenings(trainA, { edit: 'job', key: groupedTagOut.key, kind: 'work', isolation: 'none' })).toEqual([['needs_authority', 'job-kind', groupedTagOut.key]])
    expect(weakenings(trainA, { edit: 'rule', key: spanRule.key, limit: { value: 96, unit: 'h' } })).toEqual([['needs_authority', 'rule', spanRule.key]])
    expect(weakenings(trainA, { edit: 'remove', what: 'rule', key: protectedRule.key })).toEqual([['needs_authority', 'rule', protectedRule.key]])
    const unworked = trainA.equipment.find(item => item.group !== undefined && !trainA.jobs.some(entry => entry.equipment.includes(item.key)) && !trainA.equipment.some(other => other.supportedBy.includes(item.key)))
    if (unworked !== undefined) expect(weakenings(trainA, { edit: 'remove', what: 'equipment', key: unworked.key })).toEqual([['needs_authority', 'equipment', unworked.key]])
    expect(weakenings(trainA, { edit: 'remove', what: 'job', key: minimumTest.key })).toEqual([['needs_authority', 'covering-job', minimumTest.key]])
    const multi = trainA.jobs.find(entry => entry.kind === 'test' && entry.equipment.length > 1)
    if (multi !== undefined) expect(weakenings(trainA, { edit: 'job', key: multi.key, equipment: multi.equipment.slice(0, 1) })).toEqual([['needs_authority', 'covering-equipment', multi.key]])
    expect(weakenings(trainA, { edit: 'rule', key: 'R9', kind: 'keep-in-service', members: [supported.key, supported.supportedBy[0]!], atLeast: 1, words: 'Keep one in service.' })).toEqual([])
  })

  test('removing protected equipment needs authority; with it the edit is saved and can then touch the item', () => {
    const remaining = protectedRule.kind === 'protected' ? protectedRule.equipment.slice(1) : []
    const edit = remaining.length === 0 ? { edit: 'remove', what: 'rule', key: protectedRule.key } : { edit: 'rule', key: protectedRule.key, equipment: remaining }
    const outcome = apply(trainA, edit)
    expect(() => requireAuthority(outcome.weakens, undefined)).toThrow(/authority/)
    expect(refusal(() => requireAuthority(outcome.weakens, undefined)).code).toBe('needs_authority')
    expect(() => requireAuthority(outcome.weakens, { name: 'Shift supervisor', reason: 'Train B work moved to this week' })).not.toThrow()
  })

  test('a test estimated below its minimum is below_minimum; lowering or clearing the minimum needs authority; minimum is for tests only', () => {
    const minimum = minimumTest.minimum!
    const below = apply(trainA, { edit: 'job', key: minimumTest.key, duration: { value: minimum.value / 2, unit: minimum.unit } })
    expect(below.weakens.map(weakening => weakening.code)).toEqual(['below_minimum'])
    expect(refusal(() => requireAuthority(below.weakens, undefined)).code).toBe('below_minimum')
    expect(weakenings(trainA, { edit: 'job', key: minimumTest.key, minimum: null })).toEqual([['needs_authority', 'minimum', minimumTest.key]])
    expect(refusal(() => apply(trainA, { edit: 'job', key: workJob.key, minimum: { value: 1, unit: 'h', words: 'not a test' } })).code).toBe('invalid_request')
  })
})
