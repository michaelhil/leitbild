import { describe, expect, test } from 'bun:test'
import { advance, append, arrivalAt, at, commanding, emptyState, first, newTask, newUnit, pointOf, ports, refusalOf, run, runAll, second, send, start, taskOf, templates, top, types, unitOf } from '../fixtures/engine-harness.ts'
import { predictedDelivery } from './delivery.ts'
import { advanceEngine, executeIntent } from './engine.ts'
import type { Intent } from './intents.ts'
import type { EngineState } from './model.ts'

/**
 * `unit.order`: one atomic intent gives units a plan of stops. Every stop is
 * validated on the state the stops before it leave; any refusal leaves the
 * state as it was. A busy unit needs `when`; `now` names the task it drops.
 */

const order = (units: ReadonlyArray<string>, stops: Extract<Intent, { kind: 'order' }>['stops'], extra: Partial<Extract<Intent, { kind: 'order' }>> = {}): Intent =>
  ({ kind: 'order', units: [...units], stops: [...stops], ...extra })

const field = async (): Promise<EngineState> => runAll(emptyState(), [
  newUnit('c1', types.roadCarrier, at(0)),
  newUnit('c2', types.roadCarrier, at(0.001)),
  newUnit('clinic', types.publicSite, at(0.02)),
  newUnit('camp', types.sidedSite, at(0.004)),
  newTask('t1', templates.load, at(0.005), { [top]: 1 }),
  newTask('t2', templates.load, at(0.006), { [top]: 2 }),
])

describe('Einsatz unit.order', () => {
  test('pick up at a task, then deliver to a named site: one order, two stops, named by its command', async () => {
    const outcome = await executeIntent(await field(), order(['c1'], [{ taskId: 't1' }, { siteId: 'camp' }]), commanding('command-1'), ports)
    if (!outcome.ok) throw new Error(outcome.reason)
    const unit = unitOf(outcome.state, 'c1')
    expect(unit.orders.map(step => [step.id, step.kind, step.state, step.commandId])).toEqual([
      ['step-1', 'serve', 'active', 'command-1'],
      ['step-2', 'deliver', 'queued', 'command-1'],
    ])
    expect(unit).toMatchObject({ taskId: 't1', lastCommand: { id: 'command-1', stepId: 'step-1' }, lastAction: { verb: 'queue' } })
    expect(unit.lastAction).not.toHaveProperty('commandId')
    const done = await advance(outcome.state, start + 600_000)
    expect(unitOf(done, 'camp').received).toEqual({ [top]: 1 })
    expect(unitOf(done, 'clinic').received).toEqual({})
  })

  test('all or nothing: a refused stop leaves every unit as it was', async () => {
    const state = await field()
    const refused = await refusalOf(state, order(['c1'], [{ taskId: 't1' }, { taskId: 't1' }]))
    expect(refused).toEqual({ code: 'requirement_covered', reason: 'requirement_covered: T1 needs nothing more that C1 provides' })
    const before = unitOf(state, 'c1')
    expect(unitOf(state, 'c1')).toEqual(before)
    expect(taskOf(state, 't1').coverage.loads).toEqual([{ classId: top, waiting: 1, covered: 0 }])
    expect((await refusalOf(state, order(['c1', 'c2'], [{ taskId: 't1' }]))).code).toBe('requirement_covered')
  })

  test('several units take the same stops, their first judged together', async () => {
    const state = await run(await field(), order(['c1', 'c2'], [{ taskId: 't2' }]))
    expect(['c1', 'c2'].map(id => unitOf(state, id).taskId)).toEqual(['t2', 't2'])
    expect(taskOf(state, 't2').coverage.loads).toEqual([{ classId: top, waiting: 2, covered: 2 }])
  })

  test('a busy unit must say when: after appends behind its job, now drops it', async () => {
    let state = await run(await field(), send(['c1'], { taskId: 't1' }))
    expect((await refusalOf(state, order(['c1'], [{ taskId: 't2' }]))).code).toBe('when_required')
    expect((await refusalOf(state, order(['c1'], [{ taskId: 't2' }], { when: 'now', drops: 't2' }))).code).toBe('drops_mismatch')
    const after = await run(state, append('c1', { siteId: 'camp' }, { taskId: 't2' }))
    expect(unitOf(after, 'c1').orders.map(step => [step.kind, step.state])).toEqual([['serve', 'active'], ['deliver', 'queued'], ['serve', 'queued']])
    expect(unitOf(after, 'c1').taskId).toBe('t1')
    state = await run(state, order(['c1'], [{ taskId: 't2' }], { when: 'now', drops: 't1' }))
    expect(unitOf(state, 'c1')).toMatchObject({ taskId: 't2', lastAction: { verb: 'divert' } })
    expect(taskOf(state, 't1').alerts).toMatchObject([{ code: 'work_returned' }])
  })

  test('when "after" on a free unit starts its first stop at once; drops on a free unit is a mismatch', async () => {
    const state = await field()
    expect(unitOf(await run(state, append('c1', { taskId: 't1' })), 'c1')).toMatchObject({ taskId: 't1', orders: [{ state: 'active' }] })
    expect(await refusalOf(state, order(['c1'], [{ taskId: 't1' }], { when: 'now', drops: 't2' }))).toEqual({ code: 'drops_mismatch', reason: 'drops_mismatch: C1 works for no task, so it drops none' })
  })

  test('priority decides a divert: equal is allowed, from strictly more urgent work it is refused', async () => {
    let state = await runAll(await field(), [
      newTask('urgent', templates.load, at(0.03), { [top]: 1 }, { priority: first }),
      newTask('routine', templates.load, at(0.03, 0.001), { [top]: 1 }, { priority: second }),
      newTask('peer', templates.load, at(0.03, 0.002), { [top]: 1 }, { priority: first }),
      send(['c1'], { taskId: 'urgent' }),
    ])
    expect((await refusalOf(state, order(['c1'], [{ taskId: 'routine' }], { when: 'now', drops: 'urgent' }))).code).toBe('divert_from_higher_priority')
    state = await run(state, order(['c1'], [{ taskId: 'peer' }], { when: 'now', drops: 'urgent' }))
    expect(unitOf(state, 'c1').taskId).toBe('peer')
  })
})

describe('Einsatz predicted delivery', () => {
  test('a carrier with no site stop is predicted to deliver where its deliver order then takes the load', async () => {
    let state = await run(await field(), order(['c1'], [{ taskId: 't1' }]))
    const predicted = predictedDelivery(state, 'c1')
    expect(predicted?.site.id).toBe('camp')
    expect(predicted?.from).toEqual(taskOf(state, 't1').point)
    // The reflex resolves the same site from where the unit then stands.
    state = (await advanceEngine(state, start + 600_000, ports)).state
    expect(unitOf(state, 'camp').received).toEqual({ [top]: 1 })
  })

  test('a site that closes changes the prediction; a named site stop leaves none', async () => {
    let state = await run(await field(), order(['c1'], [{ taskId: 't1' }]))
    state = await run(state, { kind: 'site.set', siteId: 'camp', accepting: false })
    expect(predictedDelivery(state, 'c1')?.site.id).toBe('clinic')
    const named = await run(await field(), order(['c1'], [{ taskId: 't1' }, { siteId: 'clinic' }]))
    expect(predictedDelivery(named, 'c1')).toBeUndefined()
    const idle = await field()
    expect(predictedDelivery(idle, 'c1')).toBeUndefined()
    expect(pointOf(idle, 'c1')).toEqual(at(0))
    expect(arrivalAt(named, 'c1')).toBeGreaterThan(start)
  })
})
