import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat } from '../../core/model/index.ts'
import { createDirectRoutingAdapter } from '../../routing/direct-adapter.ts'
import { einsatzConfigSchema } from './config-validation.ts'
import { predictedDelivery } from './engine/delivery.ts'
import { advanceEngine, executeIntent } from './engine/engine.ts'
import { commandsEveryUnit, type EngineActor, type Intent } from './engine/intents.ts'
import { emptyEngineState, type EngineState } from './engine/model.ts'
import fixture from './fixtures/never-seen.config.json'
import { recommend } from './recommend.ts'
import { readSituation } from './situation/situation.ts'
import { readUnitOptions } from './situation/unit-options.ts'
import { situationSchema, unitOptionsSchema } from './situation/schema.ts'
import { openViewer } from './viewer.ts'

/**
 * A unit type, template, service, load class, priority and lexicon no code
 * has ever seen, from configuration alone, driven through every read model
 * and the order: nothing in the Pack names any of them.
 */

const config = einsatzConfigSchema.parse(fixture)
const routing = createDirectRoutingAdapter()
const actor: EngineActor = { by: 'Controller', commandable: commandsEveryUnit }
const [cartType, siteType] = config.unitTypes.map(type => type.id) as [string, string]
const template = config.taskTemplates[0]!.id
const loadClass = config.loadClasses[0]!.id
const at = (east: number) => geoPointFromLonLat(11 + east, 59)

const run = async (state: EngineState, intent: Intent): Promise<EngineState> => {
  const outcome = await executeIntent(state, intent, actor, { routing })
  if (!outcome.ok) throw new Error(outcome.reason)
  return outcome.state
}

const field = async (): Promise<EngineState> => {
  let state = emptyEngineState({ config, sides: [], timeMs: Date.parse('2026-05-01T10:00:00Z') })
  for (const intent of [
    { kind: 'unit.create', id: 'cart-1', type: cartType, at: at(0), label: 'K1' },
    { kind: 'unit.create', id: 'cart-2', type: cartType, at: at(0.02), label: 'K2', properties: { 'zx-veil': 0 } },
    { kind: 'unit.create', id: 'apiary', type: siteType, at: at(0.01), label: 'North apiary' },
    { kind: 'task.create', id: 'swarm-1', template, at: at(0.005), label: 'S-1 Swarm in the orchard', loads: { [loadClass]: 1 } },
    { kind: 'task.create', id: 'swarm-2', template, at: at(0.006), label: 'S-2 Swarm on the fence', priority: 'zx-warm' },
  ] satisfies ReadonlyArray<Intent>) state = await run(state, intent)
  return state
}

describe('Einsatz with a never-seen asset type', () => {
  test('the situation lists it in its own words, with its priority, property and site', async () => {
    const situation = situationSchema.parse(readSituation({ state: await field(), viewer: openViewer, roles: [] }))
    expect(situation.words).toMatchObject({ calls: 'Sightings', units: 'Crews', send: 'Task' })
    expect(situation.calls.map(call => [call.label, call.priority.code])).toEqual([['S-1 Swarm in the orchard', 'ZH'], ['S-2 Swarm on the fence', 'ZW']])
    expect(situation.calls.slice(0, 1)).toMatchObject([{ label: 'S-1 Swarm in the orchard', priority: { code: 'ZH', responseTargetS: 900 }, overdue: false, needs: [{ kind: 'requirement', label: '1 keeper', where: ['Veils ≥ 1'] }, { kind: 'load', label: '1 hive' }] }])
    expect(situation.units.map(unit => [unit.label, unit.typeLabel, unit.properties[0]?.value])).toEqual([['K1', 'Keeper cart', '2'], ['K2', 'Keeper cart', '0']])
    expect(situation.sites.map(site => site.label)).toEqual(['North apiary'])
  })

  test('unit.options, recommend, the order and the predicted delivery all work from configuration', async () => {
    let state = await field()
    const options = unitOptionsSchema.parse(await readUnitOptions({ state, viewer: openViewer, roles: [], actor, unitId: 'cart-1', routing }))
    expect(options.targets.map(target => [target.label, target.verb])).toContainEqual(['S-1 Swarm in the orchard', 'pick-up'])
    const refusedFor = unitOptionsSchema.parse(await readUnitOptions({ state, viewer: openViewer, roles: [], actor, unitId: 'cart-2', routing }))
    expect(refusedFor.refused).toContainEqual(expect.objectContaining({ label: 'S-2 Swarm on the fence', code: 'requirement_unmet', text: 'K2 · Veils 0 · needs ≥ 1' }))
    expect((await recommend({ state, viewer: openViewer, taskId: 'swarm-2', routing })).whyNot).toEqual([{ unitId: 'cart-2', label: 'K2', reasons: ['K2 · Veils 0 · needs ≥ 1'] }])
    const answer = await recommend({ state, viewer: openViewer, taskId: 'swarm-1', routing })
    expect(answer.proposal?.order).toEqual({ units: ['cart-1'], stops: [{ taskId: 'swarm-1' }] })
    state = await run(state, { kind: 'order', ...answer.proposal!.order })
    expect(predictedDelivery(state, 'cart-1')?.site.id).toBe('apiary')
    state = (await advanceEngine(state, state.timeMs + 30 * 60_000, { routing })).state
    expect(state.units.get('apiary')!.received).toEqual({ [loadClass]: 1 })
    expect(state.tasks.get('swarm-1')!.closedAtMs).toBeDefined()
  })
})
