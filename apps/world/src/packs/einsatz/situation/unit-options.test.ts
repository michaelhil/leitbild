import { describe, expect, test } from 'bun:test'
import { createDirectRoutingAdapter } from '../../../routing/direct-adapter.ts'
import { advance, append, arrivalAt, at, controller, emptyState, first, newTask, newUnit, refusalOf, run, runAll, send, templates, top, types, unitOf } from '../fixtures/engine-harness.ts'
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
    expect(answer.plan).toEqual([])
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

  test('a busy unit names its task once, with its priority code and when it is free; a target "after" its job takes is valid, a refused divert "now" is the server\'s', async () => {
    const state = await run(await field(), send(['c1'], { taskId: 'far' }))
    const answer = await options(state, 'c1')
    expect(answer.busy).toMatchObject({ taskId: 'far', label: 'FAR', code: 'Q1' })
    expect(answer.busy!.freeInS).toBeGreaterThan(0)
    expect(answer.plan).toEqual([{ id: 'step-1', state: 'active' }])
    // NEAR ranks lower than FAR, so a "now" divert from FAR is refused; "after" is still valid, so NEAR is listed.
    expect(answer.targets.find(target => target.label === 'NEAR')).toMatchObject({
      verb: 'pick-up', afterOnly: true, canReplace: false, canAdd: true, replaceRefusal: expect.stringContaining('more urgent'),
    })
    expect(answer.targets.find(target => target.label === 'CLINIC')).toBeDefined()
    expect((await refusalOf(state, { kind: 'order', units: ['c1'], stops: [{ taskId: 'near' }], when: 'now', drops: 'far' })).code).toBe('divert_from_higher_priority')
  })

  test('an active move with a full queue permits replacing, but not adding', async () => {
    const state = await run(await field(), {
      kind: 'order', units: ['c1'], stops: Array.from({ length: 20 }, (_, index) => ({ point: at(0.04, index * 0.001) })),
    })
    const answer = await options(state, 'c1')
    expect(answer.busy).toBeNull()
    expect(answer.plan).toHaveLength(20)
    expect(answer.targets.find(target => target.label === 'NEAR')).toMatchObject({
      afterOnly: false, canReplace: true, canAdd: false, addRefusal: expect.stringContaining('20 stops'),
    })
  })

  test('T7: a carrier taking its load to a site takes no call now, but a call after its delivery is valid, with the verb it gets then; another site to deliver to is valid now', async () => {
    let state = await run(await field(), send(['c1'], { taskId: 'near' }))
    state = await advance(state, arrivalAt(state, 'c1') + 10_000)
    expect(unitOf(state, 'c1')).toMatchObject({ phase: 'transporting', load: { [top]: 1 } })
    expect(unitOf(state, 'c1').taskId).toBeUndefined()
    expect(unitOf(state, 'c1').orders.map(step => step.target)).toEqual([{ siteId: 'clinic' }])
    state = await run(state, newUnit('annex', types.publicSite, at(0.02, 0.005)))
    const answer = await options(state, 'c1')
    expect(answer.busy).toBeNull()
    expect(answer.targets.find(target => target.label === 'ANNEX')).toMatchObject({ verb: 'deliver', afterOnly: false, canReplace: true })
    // The site its delivery leads to is in its plan: judged by adding it, as a go-to once the load is delivered.
    expect(answer.targets.find(target => target.label === 'CLINIC')).toMatchObject({ verb: 'go-to', afterOnly: true, canReplace: false, replaceRefusal: 'CLINIC is already in C1\'s plan' })
    expect(answer.targets.find(target => target.label === 'FAR')).toMatchObject({ verb: 'pick-up', afterOnly: true, canReplace: false, canAdd: true })
    expect((await refusalOf(state, send(['c1'], { taskId: 'far' }))).code).toBe('unit_loaded')
    const after = await run(state, { kind: 'order', units: ['c1'], stops: [{ taskId: 'far' }], when: 'after' })
    expect(unitOf(after, 'c1').orders.map(step => [step.kind, step.state])).toEqual([['deliver', 'active'], ['serve', 'queued']])
    // A call it cannot serve even after delivering is refused for that reason, not for its load.
    expect(answer.refused.find(entry => entry.label === 'LIFT')).toMatchObject({ code: 'requirement_unmet' })
  })

  test('a target the plan already holds, active or queued, is judged by adding it only: it never replaces, and adding it refused lists it as refused', async () => {
    const state = await run(await run(await field(), send(['c1'], { taskId: 'near' })), append('c1', { taskId: 'far' }))
    expect(unitOf(state, 'c1').orders.map(step => [step.target, step.state])).toEqual([[{ taskId: 'near' }, 'active'], [{ taskId: 'far' }, 'queued']])
    const answer = await options(state, 'c1')
    expect(answer.targets.map(target => target.label)).not.toContain('NEAR')
    expect(answer.targets.map(target => target.label)).not.toContain('FAR')
    expect(answer.refused.filter(entry => entry.label === 'NEAR' || entry.label === 'FAR')).toEqual([
      { target: { taskId: 'near' }, label: 'NEAR', code: 'requirement_covered', text: 'NEAR needs nothing more than C1 provides' },
      { target: { taskId: 'far' }, label: 'FAR', code: 'requirement_covered', text: 'FAR needs nothing more than C1 provides' },
    ])
    // The engine itself still takes a "now" order to the active stop as an "already" no-op; the options read does not offer it.
    expect((await run(state, { kind: 'order', units: ['c1'], stops: [{ taskId: 'near' }], when: 'now', drops: 'near' })).units.get('c1')!.orders).toHaveLength(2)
  })

  test('a held target with load still waiting can be added for a further trip, but not replace: the answer says it is already in the plan', async () => {
    const state = await run(await run(await field(), newTask('big', templates.load, at(0.008), { [top]: 2 })), send(['c1'], { taskId: 'big' }))
    const big = (await options(state, 'c1')).targets.find(target => target.label === 'BIG')
    expect(big).toMatchObject({ canReplace: false, canAdd: true, afterOnly: true, replaceRefusal: 'BIG is already in C1\'s plan' })
    expect(big).not.toHaveProperty('addRefusal')
    expect(unitOf(await run(state, append('c1', { taskId: 'big' })), 'c1').orders.map(step => step.state)).toEqual(['active', 'queued'])
  })

  test('a unit not in the picture is refused, as a Capability rejection', async () => {
    const state = await field()
    await expect(options(state, 'nobody')).rejects.toMatchObject({ code: 'capability_target_not_found' })
  })
})
