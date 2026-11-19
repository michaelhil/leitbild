import { describe, expect, test } from 'bun:test'
import { packMapFeatureSchema } from '../../core/packs/protocol.ts'
import type { IsoTimestamp } from '../../core/model/index.ts'
import { plannedPaths, queuedPlanRoutesInputSchema, waypointItemId } from './chain-path.ts'
import type { Intent } from './engine/intents.ts'
import type { EngineState } from './engine/model.ts'
import { engineObjects } from './engine/objects.ts'
import { advance, at, emptyState, low, newTask, newUnit, ports, runAll, send, start, templates, top, types, unitOf } from './fixtures/engine-harness.ts'
import { createQueuedRouteReader } from './runtime/queued-routes.ts'
import type { StepTarget } from './steps.ts'
import { resolveViewer } from './viewer.ts'
import { einsatzPackView } from './ui-pack.ts'

const queue = (unitId: string, to: StepTarget): Intent => ({ kind: 'order', units: [unitId], stops: [to], when: 'after' })
const objectsOf = (state: EngineState) => engineObjects(state, () => ({ at: new Date(state.timeMs).toISOString() as IsoTimestamp, provenance: { source: 'simulator' } }))

describe('Einsatz job chain paths', () => {
  test('the planned path is the active route and each queued leg’s endpoints', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('far', types.publicSite, at(-0.01)),
      newTask('a', templates.load, at(0.005), { [top]: 1 }),
      newTask('b', templates.load, at(-0.008), { [low]: 1 }),
      send(['c1'], { taskId: 'a' }),
      queue('c1', { siteId: 'far' }),
      queue('c1', { taskId: 'b' }),
      queue('c1', { point: at(0.02) }),
    ])
    state = await advance(state, start + 10_000)
    const [path] = plannedPaths(objectsOf(state))
    expect(path).toMatchObject({ unitId: 'c1', activeLeg: unitOf(state, 'c1').leg!.geometry })
    expect(path!.segments.map(segment => [segment.stepId, segment.from.coordinates, segment.to.coordinates, segment.targetLabel])).toEqual([
      ['step-2', at(0.005).coordinates, at(-0.01).coordinates, 'FAR'],
      ['step-3', at(-0.01).coordinates, at(-0.008).coordinates, 'B'],
      ['step-4', at(-0.008).coordinates, at(0.02).coordinates, undefined],
    ])
  })

  test('the selected unit’s dotted legs use road geometry and cached endpoints', async () => {
    const state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('far', types.publicSite, at(-0.01)),
      newTask('a', templates.load, at(0.005), { [top]: 1 }),
      send(['c1'], { taskId: 'a' }),
      queue('c1', { siteId: 'far' }),
      queue('c1', { point: at(0.02) }),
    ])
    const objects = objectsOf(state)
    const presentation = einsatzPackView.presentation
    expect(presentation.mapFeatureLayers).toEqual(['routes'])
    expect(presentation.mapFeatureQueries!({ objects })).toEqual([])
    expect(presentation.mapFeatureQueries!({ objects, selectedObjectId: 'far' })).toEqual([])
    const [request] = presentation.mapFeatureQueries!({ objects, selectedObjectId: 'c1' })
    const input = queuedPlanRoutesInputSchema.parse(request!.input)
    const visible = new Map(objects.map(object => [object.id, object]))
    const viewer = resolveViewer(undefined, [])
    const bend = at(0.002, 0.002).coordinates
    let routeCalls = 0
    const read = createQueuedRouteReader({
      id: 'test-road',
      route: async request => {
        routeCalls++
        const route = await ports.routing.route(request)
        return { ...route, geometry: { type: 'LineString', coordinates: [request.from.coordinates, bend, request.to.coordinates] } }
      },
    })
    const result = await read(state, visible, viewer, input)
    expect(result.features.map(feature => packMapFeatureSchema.parse(feature))).toMatchObject([
      { id: 'einsatz-plan:c1:step-2', lineDashed: true, geometry: { coordinates: [at(0.005).coordinates, bend, at(-0.01).coordinates] } },
      { id: 'einsatz-plan:c1:step-3', lineDashed: true, geometry: { coordinates: [at(-0.01).coordinates, bend, at(0.02).coordinates] } },
    ])
    expect(await read(state, visible, viewer, input)).toEqual(result)
    expect(await read(state, visible, viewer, { ...input, expectedPlan: [] })).toEqual({ features: [] })
    expect(routeCalls).toBe(2)

    const unavailable = createQueuedRouteReader({ id: 'test-road', route: async () => { throw new Error('offline') } })
    expect(await unavailable(state, visible, viewer, input)).toEqual({ features: [] })
  })

  test('coordinate stops of the selected unit have red pins that select their exact plan entry', async () => {
    const state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('c2', types.roadCarrier, at(-0.02)),
      send(['c1'], { point: at(0.01) }),
      send(['c2'], { point: at(-0.01) }),
      queue('c1', { point: at(0.02) }),
    ])
    const objects = objectsOf(state)
    const points = (selectedObjectId?: string) => einsatzPackView.presentation.mapFeatures!({
      objects, ...(selectedObjectId === undefined ? {} : { selectedObjectId }),
    }).filter(feature => feature.geometry.type === 'Point')
    expect(points()).toEqual([])
    expect(points('c1').map(feature => packMapFeatureSchema.parse(feature))).toMatchObject([
      { geometry: at(0.01), color: '#a83f4d', selection: { panelId: 'einsatz.dispatch', itemId: waypointItemId('c1', 'step-1') } },
      { geometry: at(0.02), color: '#a83f4d', selection: { panelId: 'einsatz.dispatch', itemId: waypointItemId('c1', 'step-2') } },
    ])
    expect(points('c2').map(feature => feature.selection?.itemId)).toEqual([waypointItemId('c2', 'step-1')])
  })
})
