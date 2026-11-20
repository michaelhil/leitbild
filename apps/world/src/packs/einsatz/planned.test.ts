import { describe, expect, test } from 'bun:test'
import { createDirectRoutingAdapter } from '../../routing/direct-adapter.ts'
import { append, at, controller, emptyState, newTask, newUnit, refusalOf, run, runAll, send, templates, top, types, unitOf } from './fixtures/engine-harness.ts'
import type { EngineState } from './engine/model.ts'
import { recommend } from './recommend.ts'
import { situationSchema, unitOptionsSchema } from './situation/schema.ts'
import { readSituation } from './situation/situation.ts'
import { readUnitOptions } from './situation/unit-options.ts'
import { openViewer } from './viewer.ts'

/**
 * Later stops: a call another unit's plan holds as a queued stop. Coverage
 * counts only current stops; the situation shows what later stops will add,
 * recommend counts them as on their way, and unit options warn before a
 * second unit is sent to what they already cover.
 */

const routing = createDirectRoutingAdapter()
const read = (state: EngineState) => situationSchema.parse(readSituation({ state, viewer: openViewer, roles: [] }))
const callOf = (state: EngineState, id: string) => read(state).calls.find(call => call.id === id)!
const options = async (state: EngineState, unitId: string) => unitOptionsSchema.parse(await readUnitOptions({ state, viewer: openViewer, roles: [], actor: controller, unitId, routing }))
const targetOf = async (state: EngineState, unitId: string, taskId: string) =>
  (await options(state, unitId)).targets.find(entry => 'taskId' in entry.target && entry.target.taskId === taskId)

/** C1 works NEAR and holds LATER as stop 2; C2 is free; TWO waits with two people. */
const field = async (): Promise<EngineState> => {
  const state = await runAll(emptyState(), [
    newUnit('c1', types.roadCarrier, at(0)),
    newUnit('c2', types.roadCarrier, at(0.001)),
    newUnit('c3', types.roadCarrier, at(0.002)),
    newUnit('c4', types.roadCarrier, at(0.003)),
    newUnit('clinic', types.publicSite, at(0.02)),
    newTask('near', templates.load, at(0.005), { [top]: 1 }),
    newTask('later', templates.load, at(0.01), { [top]: 1 }),
    newTask('other', templates.load, at(0.007), { [top]: 1 }),
    newTask('two', templates.load, at(0.012), { [top]: 2 }),
    send(['c1'], { taskId: 'near' }),
    send(['c3'], { taskId: 'other' }),
  ])
  return await runAll(state, [append('c1', { taskId: 'later' }), append('c3', { taskId: 'two' })])
}

describe('Einsatz later stops', () => {
  test('the situation lists a call\'s later stops and what each need will reach with them; coverage still counts current stops only', async () => {
    const state = await field()
    expect(unitOf(state, 'c1').orders.map(step => [step.target, step.state])).toEqual([[{ taskId: 'near' }, 'active'], [{ taskId: 'later' }, 'queued']])
    const later = callOf(state, 'later')
    expect(later.planned).toMatchObject([{ unitId: 'c1', label: 'C1', stop: 2 }])
    expect(later.planned[0]!.eta).not.toBeNull()
    expect(later.needs).toMatchObject([{ kind: 'load', waiting: 1, covered: 0, planned: 1 }])
    expect(later.assigned).toEqual([])
    expect(callOf(state, 'two').needs).toMatchObject([{ kind: 'load', waiting: 2, covered: 0, planned: 1 }])
    expect(callOf(state, 'near')).toMatchObject({ planned: [], needs: [{ covered: 1, planned: 0 }] })
  })

  test('recommend counts later stops as on their way: none for a call they cover, the rest for one they cover in part', async () => {
    const state = await field()
    expect((await recommend({ state, viewer: openViewer, taskId: 'later', routing })).proposal).toBeNull()
    const two = (await recommend({ state, viewer: openViewer, taskId: 'two', routing })).proposal
    expect(two?.units).toHaveLength(1)
    expect(two?.covers).toEqual({ covered: 2, needed: 2 })
    expect(two?.remainder).toEqual([])
  })

  test('unit options warn before a second unit goes where later stops already cover what it adds; the order is still accepted', async () => {
    const state = await field()
    expect(await targetOf(state, 'c2', 'later')).toMatchObject({ canReplace: true, planned: 'LATER is already stop 2 of C1\'s plan' })
    // TWO still waits for one more person beyond C3's later stop: no warning.
    expect(await targetOf(state, 'c2', 'two')).not.toHaveProperty('planned')
    // C1's own later stop is no warning but where its plan holds it.
    expect((await options(state, 'c1')).refused.find(entry => entry.label === 'LATER')).toMatchObject({ code: 'already_in_plan', text: 'LATER is already stop 2 of C1\'s plan' })
    const sent = await run(state, send(['c2'], { taskId: 'later' }))
    expect(unitOf(sent, 'c2').taskId).toBe('later')
    // Once C2 covers it, C1's later stop adds nothing: the warning is gone, and the call shows C2 assigned.
    expect(callOf(sent, 'later')).toMatchObject({ assigned: [{ unitId: 'c2' }], needs: [{ covered: 1, planned: 0 }] })
  })

  test('a call its later stops cover needs no free unit', async () => {
    const state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('c2', types.roadCarrier, at(0.001)),
      newUnit('clinic', types.publicSite, at(0.02)),
      newTask('near', templates.load, at(0.005), { [top]: 1 }),
      newTask('other', templates.load, at(0.007), { [top]: 1 }),
      newTask('later', templates.load, at(0.01), { [top]: 1 }),
      send(['c1'], { taskId: 'near' }),
      send(['c2'], { taskId: 'other' }),
    ])
    expect(callOf(state, 'later').states.map(entry => entry.code)).toEqual(['no_free_unit'])
    const planned = await run(state, append('c1', { taskId: 'later' }))
    expect(callOf(planned, 'later').states).toEqual([])
    expect(await refusalOf(planned, append('c1', { taskId: 'later' }))).toEqual({ code: 'already_in_plan', reason: 'already_in_plan: LATER is already stop 2 of C1\'s plan' })
  })
})
