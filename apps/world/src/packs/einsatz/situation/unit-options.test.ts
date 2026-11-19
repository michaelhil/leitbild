import { describe, expect, test } from 'bun:test'
import { createDirectRoutingAdapter } from '../../../routing/direct-adapter.ts'
import { advance, arrivalAt, at, controller, emptyState, first, newTask, newUnit, refusalOf, run, runAll, send, templates, top, types, unitOf } from '../fixtures/engine-harness.ts'
import type { EngineState } from '../engine/model.ts'
import { openViewer } from '../viewer.ts'
import { unitOptionsSchema } from './schema.ts'
import { readUnitOptions } from './unit-options.ts'

/**
 * `world.einsatz.unit.options`: where one unit may be ordered now, nearest
 * first, judged by the engine's own order validation, and where not and why.
 */

const options = async (state: EngineState, unitId: string) => unitOptionsSchema.parse(await readUnitOptions({
  state, viewer: openViewer, roles: [], actor: controller, unitId, routing: createDirectRoutingAdapter(),
}))

const field = () => runAll(emptyState(), [
  newUnit('c1', types.roadCarrier, at(0)),
  newUnit('h1', types.payloadServer, at(0.001)),
  newUnit('clinic', types.publicSite, at(0.02)),
  newUnit('store', types.inert, at(0.03)),
  newTask('near', templates.load, at(0.005), { [top]: 1 }),
  newTask('far', templates.load, at(0.015), { [top]: 1 }, { priority: first }),
  newTask('lift', templates.lift, at(0.006)),
])

describe('Einsatz unit options', () => {
  test('a free unit lists every target an order accepts, nearest first, with the verb; refusals carry their code', async () => {
    const answer = await options(await field(), 'c1')
    expect(answer.busy).toBeNull()
    expect(answer.targets.map(target => [target.label, target.verb])).toEqual([['NEAR', 'pick-up'], ['FAR', 'pick-up'], ['CLINIC', 'go-to'], ['STORE', 'go-to']])
    expect(answer.targets.map(target => target.etaS)).toEqual([...answer.targets.map(target => target.etaS)].sort((a, b) => a - b))
    expect(answer.refused).toEqual([{ target: { taskId: 'lift' }, label: 'LIFT', code: 'requirement_unmet', text: 'C1 · Lift 400 kg · needs ≥ 500 kg' }])
  })

  test('every listed target is one unit.order accepts', async () => {
    const state = await field()
    for (const target of (await options(state, 'c1')).targets) {
      expect((await run(state, { kind: 'order', units: ['c1'], stops: [target.target] })).units.get('c1')!.orders).toHaveLength(1)
    }
  })

  test('a busy unit names its task once, with its priority code and when it is free; each valid target says whether "now" takes it, a refused divert "now" is the server\'s', async () => {
    const state = await run(await field(), send(['c1'], { taskId: 'far' }))
    const answer = await options(state, 'c1')
    expect(answer.busy).toMatchObject({ taskId: 'far', label: 'FAR', code: 'Q1' })
    expect(answer.busy!.freeInS).toBeGreaterThan(0)
    // No target repeats the job: the targets carry none of it, only whether "now" takes them.
    for (const target of answer.targets) expect(Object.keys(target).sort()).toEqual(['etaS', 'label', 'now', 'target', 'verb'])
    // NEAR ranks lower than FAR, so a "now" divert from FAR is refused; "after" is still valid, so NEAR is listed, taken only after.
    expect(answer.targets.find(target => target.label === 'NEAR')).toMatchObject({ verb: 'pick-up', now: false })
    expect(answer.targets.find(target => target.label === 'CLINIC')).toMatchObject({ now: true })
    expect((await refusalOf(state, { kind: 'order', units: ['c1'], stops: [{ taskId: 'near' }], when: 'now', drops: 'far' })).code).toBe('divert_from_higher_priority')
    expect((await run(state, { kind: 'order', units: ['c1'], stops: [{ taskId: 'near' }], when: 'after' })).units.get('c1')!.orders).toHaveLength(2)
  })

  test('T7: a carrier taking its load to a site takes no call now, but a call after its delivery is valid; a site to deliver to is valid now', async () => {
    let state = await run(await field(), send(['c1'], { taskId: 'near' }))
    state = await advance(state, arrivalAt(state, 'c1') + 10_000)
    expect(unitOf(state, 'c1')).toMatchObject({ phase: 'transporting', load: { [top]: 1 } })
    expect(unitOf(state, 'c1').taskId).toBeUndefined()
    const answer = await options(state, 'c1')
    expect(answer.busy).toBeNull()
    expect(answer.targets.find(target => target.label === 'CLINIC')).toMatchObject({ verb: 'deliver', now: true })
    const far = answer.targets.find(target => target.label === 'FAR')!
    expect(far).toMatchObject({ verb: 'pick-up', now: false })
    expect((await refusalOf(state, send(['c1'], { taskId: 'far' }))).code).toBe('unit_loaded')
    const after = await run(state, { kind: 'order', units: ['c1'], stops: [{ taskId: 'far' }], when: 'after' })
    expect(unitOf(after, 'c1').orders.map(step => [step.kind, step.state])).toEqual([['deliver', 'active'], ['serve', 'queued']])
    // A call it cannot serve even after delivering is refused for that reason, not for its load.
    expect(answer.refused.find(entry => entry.label === 'LIFT')).toMatchObject({ code: 'requirement_unmet' })
  })

  test('a unit not in the picture is refused, as a Capability rejection', async () => {
    const state = await field()
    await expect(options(state, 'nobody')).rejects.toMatchObject({ code: 'capability_target_not_found' })
  })
})
