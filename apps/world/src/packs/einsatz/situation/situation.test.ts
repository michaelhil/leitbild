import { describe, expect, test } from 'bun:test'
import { advance, append, at, commanding, config, emptyState, first, low, newTask, newUnit, ports, run, runAll, second, send, start, templates, top, types, unitOf } from '../fixtures/engine-harness.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { executeIntent } from '../engine/engine.ts'
import { emptyEngineState, type EngineState } from '../engine/model.ts'
import { openViewer } from '../viewer.ts'
import { situationSchema } from './schema.ts'
import { readSituation } from './situation.ts'

/**
 * `world.einsatz.situation`: the calls by priority, the units with their
 * plans, predicted deliveries and the actor of their last order, the sites,
 * the counts and the configured words, read from the engine state and
 * valid against the wire schema.
 */

const read = (state: EngineState, group?: string) => situationSchema.parse(readSituation({ state, viewer: openViewer, roles: [], ...(group === undefined ? {} : { group }) }))

const field = () => runAll(emptyState(), [
  newUnit('c1', types.roadCarrier, at(0)),
  newUnit('d1', types.directCarrier, at(0.001)),
  newUnit('g1', types.pairServer, at(0.002)),
  newUnit('clinic', types.publicSite, at(0.02)),
  newTask('t-low', templates.load, at(0.01), { [low]: 1 }),
  newTask('t-first', templates.load, at(0.012), { [top]: 1 }, { priority: first }),
  newTask('t-second', templates.pair, at(0.014), undefined, { priority: second }),
])

describe('Einsatz situation', () => {
  test('calls rank by priority, then creation time; counts name every priority', async () => {
    let state = await field()
    state = await run(state, newTask('t-first-later', templates.load, at(0.016), { [top]: 1 }, { priority: first }))
    const situation = read(state)
    expect(situation.calls.map(call => [call.id, call.priority.code])).toEqual([['t-first', 'Q1'], ['t-first-later', 'Q1'], ['t-second', 'Q2'], ['t-low', 'Q3']])
    expect(situation.counts.calls).toEqual([{ priorityId: 'Q1', code: 'Q1', count: 2 }, { priorityId: 'Q2', code: 'Q2', count: 1 }, { priorityId: 'Q3', code: 'Q3', count: 1 }])
    expect(situation.counts).toMatchObject({ freeUnits: 3, units: 3, acceptingSites: 1, sites: 1, oldestWaitingS: 0 })
    expect(situation.calls.find(call => call.id === 't-second')!.needs).toEqual([{ kind: 'requirement', provides: 'guard', label: '2 guards', where: [], count: 2, enRoute: 0, onTask: 0, completed: 0 }])
    expect(situation.calls.find(call => call.id === 't-low')!.needs).toEqual([{ kind: 'load', classId: low, code: 'C3', label: '1 person', waiting: 1, covered: 0 }])
  })

  test('a unit shows its plan with verbs and ETAs, its predicted delivery and who ordered it', async () => {
    const outcome = await executeIntent(await field(), { kind: 'order', units: ['c1'], stops: [{ taskId: 't-low' }] }, commanding('command-1'), ports)
    if (!outcome.ok) throw new Error(outcome.reason)
    const unit = read(outcome.state).units.find(entry => entry.id === 'c1')!
    expect(unit).toMatchObject({
      status: { word: 'Mobilizing', tone: 'busy' },
      plan: [{ id: 'step-1', verb: 'pick-up', target: { taskId: 't-low' }, label: 'T-LOW', state: 'active', by: { label: 'Controller', isViewer: false } }],
      predictedDelivery: { siteId: 'clinic', label: 'CLINIC' },
      lastOrder: { by: { label: 'Controller', isViewer: false }, commandId: 'command-1' },
      carry: { capacity: 1, load: [] },
      properties: [{ id: 'liftKg', label: 'Lift', value: '400 kg' }],
    })
    expect(unit.plan[0]!.eta?.kind).toBe('straight-line')
    // A road unit's delivery is not routed until it comes up.
    expect(unit.predictedDelivery!.eta).toMatchObject({ kind: 'unavailable' })
    const call = read(outcome.state).calls.find(entry => entry.id === 't-low')!
    expect(call.assigned).toMatchObject([{ unitId: 'c1', label: 'C1', phase: 'mobilizing' }])
    const site = read(outcome.state).sites[0]!
    expect(site).toMatchObject({ id: 'clinic', accepting: true, slots: { used: 0, total: 1 }, inbound: [{ unitId: 'c1' }] })
    // The plan going on by itself is the last order now, but the command undo names stays the one that gave the plan.
    let later = outcome.state
    while (unitOf(later, 'c1').phase !== 'transporting') later = await advance(later, later.timeMs + 5_000)
    expect(read(later).units.find(entry => entry.id === 'c1')!.lastOrder).toEqual({ by: { label: 'Standing order', isViewer: false }, commandId: 'command-1' })
  })

  test('a unit moving in straight lines has an estimate for every stop; a stop it delivers at is a delivery', async () => {
    let state = await field()
    state = await run(state, { kind: 'order', units: ['d1'], stops: [{ taskId: 't-low' }, { siteId: 'clinic' }] })
    const unit = read(state).units.find(entry => entry.id === 'd1')!
    expect(unit.plan.map(stop => [stop.verb, stop.eta?.kind])).toEqual([['pick-up', 'straight-line'], ['deliver', 'straight-line']])
    expect(unit.predictedDelivery).toBeNull()
  })

  test('an order given by an AI agent and the plan going on by itself are named in words', async () => {
    let state = await field()
    state = await run(state, send(['g1'], { point: at(0.03) }), { by: 'ai:actor:assistant', commandable: () => true })
    state = await run(state, append('g1', { point: at(0.04) }))
    const unit = read(state).units.find(entry => entry.id === 'g1')!
    expect(unit.plan.map(stop => stop.by.label)).toEqual(['AI agent', 'Controller'])
    state = await advance(state, start + 600_000)
    expect(read(state).units.find(entry => entry.id === 'g1')!.lastOrder?.by.label).toBe('Plan')
  })

  test('overdue holds only for a priority with a response target, once it waited past it with no unit there', async () => {
    const timed = einsatzConfigSchema.parse({ ...config, priorities: [{ id: 'Q1', label: 'First', code: 'Q1', responseTargetS: 60 }, ...config.priorities.slice(1)] })
    let state = emptyEngineState({ config: timed, sides: [], timeMs: start })
    for (const intent of [newTask('urgent', templates.load, at(0.01), { [top]: 1 }, { priority: first }), newTask('slow', templates.load, at(0.01), { [top]: 1 })]) {
      const outcome = await executeIntent(state, intent, { by: 'Controller', commandable: () => true }, ports)
      if (!outcome.ok) throw new Error(outcome.reason)
      state = outcome.state
    }
    expect(read(state).calls.map(call => [call.id, call.overdue])).toEqual([['urgent', false], ['slow', undefined]])
    state = await advance(state, start + 61_000)
    const urgent = read(state).calls.find(call => call.id === 'urgent')!
    expect(urgent.overdue).toBe(true)
    expect(urgent.states.map(entry => entry.code)).toEqual(['overdue', 'no_free_unit'])
  })

  test('groups head the units and filter them; the words are the configuration\'s, else neutral', async () => {
    const state = await field()
    const situation = read(state)
    expect(situation.units.map(unit => unit.id)).toEqual(['c1', 'd1', 'g1'])
    expect(situation.words).toMatchObject({ calls: 'Jobs', units: 'Units', send: 'Dispatch', noCalls: 'No calls waiting' })
    expect(situation.features).toEqual({ hasCarry: true, hasSites: true, hasContacts: false, propertyColumns: [{ id: 'liftKg', label: 'Lift' }, { id: 'payloadKg', label: 'Payload' }] })
    expect(() => read(state, 'nowhere')).toThrow('unknown_group: Group "nowhere" is not declared')
  })
})
