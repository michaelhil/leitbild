import { describe, expect, test } from 'bun:test'
import type { CommandId } from '../../../core/model/index.ts'
import { advance, append, arrivalAt, at, commanding, emptyState, newTask, newUnit, ports, runAll, send, start, taskOf, templates, top, types, unitOf } from '../fixtures/engine-harness.ts'
import { refusalCode } from '../refusal.ts'
import { executeIntent } from './engine.ts'
import type { EngineActor, Intent } from './intents.ts'
import type { EngineState } from './model.ts'

/**
 * `unit.undo {unitId, commandId}` takes back a command's order while none
 * of it has been carried out. It is bound to the order: another command
 * since is `newer_order_exists`; an order carried out in whole or in part,
 * or none, is `nothing_to_undo`; it never strands load (`unit_loaded`).
 */

const by = async (state: EngineState, intent: Intent, actor: EngineActor): Promise<EngineState> => {
  const outcome = await executeIntent(state, intent, actor, ports)
  if (!outcome.ok) throw new Error(outcome.reason)
  return outcome.state
}
const refusedBy = async (state: EngineState, intent: Intent, actor: EngineActor) => {
  const outcome = await executeIntent(state, intent, actor, ports)
  if (outcome.ok) throw new Error('Expected a refusal')
  return { code: refusalCode(outcome.reason), reason: outcome.reason }
}
const undo = (unitId: string, commandId: string): Intent => ({ kind: 'undo', unitId, commandId: commandId as CommandId })

const field = () => runAll(emptyState(), [
  newUnit('c1', types.roadCarrier, at(0)),
  newUnit('d1', types.directCarrier, at(0.001)),
  newUnit('site', types.publicSite, at(0.02)),
  newTask('t1', templates.load, at(0.01), { [top]: 1 }),
  newTask('t2', templates.load, at(0.012), { [top]: 1 }, { priority: 'Q1' }),
])

describe('Einsatz unit.undo', () => {
  test('the latest order is taken back quietly: no work returned, the task uncovered again', async () => {
    let state = await by(await field(), send(['c1'], { taskId: 't1' }), commanding('first'))
    expect(taskOf(state, 't1').coverage.loads).toEqual([{ classId: top, waiting: 1, covered: 1 }])
    state = await by(state, undo('c1', 'first'), commanding('undo-1'))
    expect(unitOf(state, 'c1')).toMatchObject({ phase: 'available', orders: [], lastAction: { verb: 'undo' } })
    expect(unitOf(state, 'c1').taskId).toBeUndefined()
    expect(taskOf(state, 't1')).toMatchObject({ alerts: [], coverage: { loads: [{ classId: top, waiting: 1, covered: 0 }] } })
  })

  test('a stale command id is refused newer_order_exists; the latest is accepted', async () => {
    let state = await by(await field(), send(['c1'], { taskId: 't1' }), commanding('first'))
    state = await by(state, append('c1', { siteId: 'site' }), commanding('second'))
    expect(await refusedBy(state, undo('c1', 'first'), commanding('undo-1'))).toEqual({ code: 'newer_order_exists', reason: 'newer_order_exists: A newer order changed C1\'s plan since; undo that one, or give a new order' })
    state = await by(state, undo('c1', 'second'), commanding('undo-2'))
    expect(unitOf(state, 'c1')).toMatchObject({ taskId: 't1', orders: [{ kind: 'serve', state: 'active' }] })
  })

  test('nothing to undo before any order, and once the unit has arrived', async () => {
    const empty = await field()
    expect((await refusedBy(empty, undo('c1', 'first'), commanding('undo-1'))).code).toBe('nothing_to_undo')
    let state = await by(empty, send(['c1'], { taskId: 't1' }), commanding('first'))
    state = await advance(state, arrivalAt(state, 'c1'))
    expect(unitOf(state, 'c1').phase).toBe('on-task')
    expect(await refusedBy(state, undo('c1', 'first'), commanding('undo-1'))).toEqual({ code: 'nothing_to_undo', reason: 'nothing_to_undo: C1\'s last order has been carried out: it has arrived' })
  })

  test('undoing an order that dropped a task gives the task its unit back', async () => {
    let state = await by(await field(), send(['c1'], { taskId: 't1' }), commanding('first'))
    state = await by(state, { kind: 'order', units: ['c1'], stops: [{ taskId: 't2' }], when: 'now', drops: 't1' }, commanding('divert'))
    expect(unitOf(state, 'c1')).toMatchObject({ taskId: 't2', lastCommand: { id: 'divert', drops: 't1' } })
    expect(taskOf(state, 't1').alerts).toMatchObject([{ code: 'work_returned' }])
    state = await by(state, undo('c1', 'divert'), commanding('undo-1'))
    expect(unitOf(state, 'c1')).toMatchObject({ taskId: 't1', phase: 'mobilizing' })
    expect(taskOf(state, 't1')).toMatchObject({ alerts: [], coverage: { loads: [{ classId: top, waiting: 1, covered: 1 }] } })
    expect(taskOf(state, 't2').coverage.loads).toEqual([{ classId: top, waiting: 1, covered: 0 }])
    const done = await advance(state, start + 600_000)
    expect(taskOf(done, 't1').closedAtMs).toBeDefined()
  })

  test('once the unit is past the first stop of the order, nothing is undone: a carrier transporting what it picked up keeps its delivery', async () => {
    let state = await by(await field(), { kind: 'order', units: ['c1'], stops: [{ taskId: 't1' }, { siteId: 'site' }] }, commanding('first'))
    expect(unitOf(state, 'c1').lastCommand).toMatchObject({ id: 'first', stepId: 'step-1' })
    while (unitOf(state, 'c1').phase !== 'transporting') state = await advance(state, state.timeMs + 5_000)
    expect(unitOf(state, 'c1')).toMatchObject({ load: { [top]: 1 }, orders: [{ kind: 'deliver', state: 'active' }] })
    expect(await refusedBy(state, undo('c1', 'first'), commanding('undo-1'))).toEqual({ code: 'nothing_to_undo', reason: 'nothing_to_undo: C1 is past the first stop of its last order' })
    const done = await advance(state, start + 1_800_000)
    expect(unitOf(done, 'site').received).toEqual({ [top]: 1 })
    expect(unitOf(done, 'c1').load).toEqual({})
  })

  test('an order delivering the load a unit holds is not undone: the unit would keep its load and lose its delivery', async () => {
    let state = await by(await field(), send(['d1'], { taskId: 't1' }), commanding('pick-up'))
    while (unitOf(state, 'd1').phase !== 'holding') state = await advance(state, state.timeMs + 5_000)
    expect(unitOf(state, 'd1')).toMatchObject({ load: { [top]: 1 }, orders: [] })
    state = await by(state, send(['d1'], { siteId: 'site' }), commanding('deliver'))
    expect(unitOf(state, 'd1')).toMatchObject({ phase: 'transporting', lastCommand: { id: 'deliver' } })
    expect(await refusedBy(state, undo('d1', 'deliver'), commanding('undo-1'))).toEqual({ code: 'unit_loaded', reason: 'unit_loaded: D1 has 1 person on board, deliver first' })
  })

  test('a return gives no stop to take back', async () => {
    let state = await by(await field(), send(['c1'], { taskId: 't1' }), commanding('first'))
    state = await by(state, { kind: 'recall', unitId: 'c1' }, commanding('recall'))
    expect(await refusedBy(state, undo('c1', 'recall'), commanding('undo-1'))).toEqual({ code: 'nothing_to_undo', reason: 'nothing_to_undo: C1\'s last order gave it no stop to take back' })
  })
})
