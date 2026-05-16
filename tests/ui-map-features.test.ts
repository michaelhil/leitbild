import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, ObjectId, ControlInstanceId } from '../src/core/model/index.ts'
import { nowIso } from '../src/core/model/index.ts'
import { setDestinationCommandKind } from '../src/domains/ambulance/commands.ts'
import { createOsloAmbulanceScenario } from '../src/domains/ambulance/scenario.ts'
import { createAmbulanceSimEngine } from '../src/domains/ambulance/sim/engine.ts'
import { ambulancePack } from '../src/domains/ambulance/pack.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createObjectFeatureCollection, createRouteFeatureCollection, mapSourceIds } from '../src/ui/map-features.ts'

const controlInstanceId = 'control-instance:ui-map-features' as ControlInstanceId
const actorId = 'actor:test-operator' as ActorId

const makeCommand = (config: {
  readonly kind: string
  readonly targetObjectIds: ReadonlyArray<ObjectId>
  readonly payload: unknown
}): CommandEnvelope => ({
  id: `command:${crypto.randomUUID()}` as CommandId,
  controlInstanceId,
  actorId,
  kind: config.kind,
  targetObjectIds: config.targetObjectIds,
  payload: config.payload,
  issuedAt: nowIso(),
})

describe('map feature projection', () => {
  test('projects routed ambulances into route GeoJSON without changing coordinate order', async () => {
    const engine = createAmbulanceSimEngine({
      controlInstanceId,
      scenario: createOsloAmbulanceScenario(),
      routing: createDirectRoutingAdapter(),
    })
    const initial = engine.snapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity')
    const incident = initial.objects.find(object => object.kind === 'incident')
    if (!ambulance || !incident) throw new Error('scenario missing ambulance or incident')

    const result = await engine.handleCommand(makeCommand({
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: {
        ambulanceId: ambulance.id,
        destinationId: incident.id,
      },
    }))
    expect(result.ok).toBe(true)

    const updatedObjects = engine.snapshot().objects
    const updatedAmbulance = updatedObjects.find(object => object.id === ambulance.id)
    if (!updatedAmbulance?.spatial.route?.planned) throw new Error('dispatch did not produce a planned route')

    const routeFeatures = createRouteFeatureCollection(updatedObjects, ambulance.id)
    expect(mapSourceIds.plannedRoutes).toBe('planned-route-source')
    expect(routeFeatures.features).toHaveLength(1)
    expect(routeFeatures.features[0]?.id).toBe(ambulance.id)
    expect(routeFeatures.features[0]?.properties.selected).toBe(true)
    expect(routeFeatures.features[0]?.geometry).toEqual(updatedAmbulance.spatial.route.planned)
    expect(routeFeatures.features[0]?.geometry.coordinates[0]).toEqual(updatedAmbulance.spatial.route.planned.coordinates[0])
  })

  test('projects remaining route when route progress is available', async () => {
    const engine = createAmbulanceSimEngine({
      controlInstanceId,
      scenario: createOsloAmbulanceScenario(),
      routing: createDirectRoutingAdapter(),
    })
    const initial = engine.snapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity')
    const incident = initial.objects.find(object => object.kind === 'incident')
    if (!ambulance || !incident) throw new Error('scenario missing ambulance or incident')

    const result = await engine.handleCommand(makeCommand({
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: {
        ambulanceId: ambulance.id,
        destinationId: incident.id,
      },
    }))
    expect(result.ok).toBe(true)
    engine.tick(1_000)

    const updatedObjects = engine.snapshot().objects
    const updatedAmbulance = updatedObjects.find(object => object.id === ambulance.id)
    if (!updatedAmbulance?.spatial.position || !updatedAmbulance.spatial.route?.planned) throw new Error('missing moved ambulance route')

    const routeFeatures = createRouteFeatureCollection(updatedObjects, ambulance.id)

    expect(routeFeatures.features[0]?.geometry.coordinates[0]).toEqual(updatedAmbulance.spatial.position.point.coordinates)
    expect(routeFeatures.features[0]?.geometry.coordinates.length).toBeLessThanOrEqual(updatedAmbulance.spatial.route.planned.coordinates.length + 1)
  })

  test('projects positioned objects into native MapLibre symbol features', () => {
    const engine = createAmbulanceSimEngine({
      controlInstanceId,
      scenario: createOsloAmbulanceScenario(),
      routing: createDirectRoutingAdapter(),
    })
    const objects = engine.snapshot().objects
    const ambulance = objects.find(object => object.kind === 'mobile_entity')
    if (!ambulance) throw new Error('scenario missing ambulance')

    const objectFeatures = createObjectFeatureCollection(
      objects,
      ambulance.id,
      object => object.id === ambulance.id,
      object => ambulancePack.presentObject(object, { objects }),
    )
    const ambulanceFeature = objectFeatures.features.find(feature => feature.id === ambulance.id)

    expect(objectFeatures.features).toHaveLength(3)
    expect(ambulanceFeature?.geometry).toEqual(ambulance.spatial.position?.point)
    expect(ambulanceFeature?.properties.icon).toBe('object-ambulance')
    expect(ambulanceFeature?.properties.selected).toBe(true)
    expect(ambulanceFeature?.properties.hasNewInfo).toBe(true)
  })
})
