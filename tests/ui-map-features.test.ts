import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, DomainId, ObjectId, ControlInstanceId } from '../src/core/model/index.ts'
import { geoPointFromLonLat, nowIso } from '../src/core/model/index.ts'
import { setDestinationCommandKind } from '../src/packs/ambulance/commands.ts'
import { osloAmbulanceTutorialScenario } from '../src/scenarios/index.ts'
import { createAmbulanceSimEngine } from '../src/packs/ambulance/sim/engine.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { trafficPack } from '../src/packs/traffic/pack.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createObjectFeatureCollection, createRouteFeatureCollection, createTrafficAreaFeatureCollection, createTrafficLineFeatureCollection, mapSourceIds } from '../src/ui/map-features.ts'

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
      objects: osloAmbulanceTutorialScenario.initialObjects,
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
      objects: osloAmbulanceTutorialScenario.initialObjects,
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
      objects: osloAmbulanceTutorialScenario.initialObjects,
      routing: createDirectRoutingAdapter(),
    })
    const objects = engine.snapshot().objects
    const ambulance = objects.find(object => object.kind === 'mobile_entity')
    if (!ambulance) throw new Error('scenario missing ambulance')

    const objectFeatures = createObjectFeatureCollection(
      objects,
      ambulance.id,
      ['incident:gronland-unattended'],
      object => object.id === ambulance.id,
      object => ambulancePack.presentObject(object, { objects }),
    )
    const ambulanceFeature = objectFeatures.features.find(feature => feature.id === ambulance.id)

    expect(objectFeatures.features).toHaveLength(9)
    expect(ambulanceFeature?.geometry).toEqual(ambulance.spatial.position?.point)
    expect(ambulanceFeature?.properties.icon).toBe('object-ambulance-ready')
    expect(ambulanceFeature?.properties.color).toBe('#16834f')
    expect(ambulanceFeature?.properties.muted).toBe(false)
    expect(ambulanceFeature?.properties.selected).toBe(true)
    expect(ambulanceFeature?.properties.highlighted).toBe(false)
    expect(ambulanceFeature?.properties.hasNewInfo).toBe(true)
  })

  test('projects traffic conditions into native MapLibre line features', () => {
    const lineObject = {
      id: 'traffic:test-road' as ObjectId,
      kind: 'zone' as const,
      domain: 'traffic' as DomainId,
      label: 'Test road slowdown',
      lifecycle: 'active' as const,
      revision: 0,
      spatial: {
        geometry: {
          type: 'LineString' as const,
          coordinates: [
            geoPointFromLonLat(10.74, 59.93).coordinates,
            geoPointFromLonLat(10.76, 59.92).coordinates,
          ],
        },
        frame: { kind: 'wgs84' as const },
      },
      operational: { status: 'slowdown', priority: 'high' as const, mode: 'simulated' as const },
      alerts: [],
      provenance: { source: 'operator' as const },
      timestamps: { createdAt: nowIso(), updatedAt: nowIso() },
    }
    const trafficFeatures = createTrafficLineFeatureCollection(
      [lineObject],
      () => ({ color: '#dc2626', summary: 'road segment · high' }),
    )

    expect(mapSourceIds.trafficLines).toBe('traffic-line-source')
    expect(trafficFeatures.features).toHaveLength(1)
    expect(trafficFeatures.features[0]?.id).toBe('traffic:test-road')
    expect(trafficFeatures.features[0]?.properties.color).toBe('#dc2626')
  })

  test('projects traffic areas into native MapLibre polygon features', () => {
    const polygonObject = {
      id: 'traffic:test-area' as ObjectId,
      kind: 'zone' as const,
      domain: 'traffic' as DomainId,
      label: 'Test area',
      lifecycle: 'active' as const,
      revision: 0,
      spatial: {
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[
            geoPointFromLonLat(10.70, 59.90).coordinates,
            geoPointFromLonLat(10.72, 59.90).coordinates,
            geoPointFromLonLat(10.72, 59.92).coordinates,
            geoPointFromLonLat(10.70, 59.90).coordinates,
          ]],
        },
        frame: { kind: 'wgs84' as const },
      },
      operational: { status: 'slowdown', priority: 'high' as const, mode: 'simulated' as const },
      alerts: [],
      provenance: { source: 'simulator' as const },
      timestamps: { createdAt: nowIso(), updatedAt: nowIso() },
    }

    const trafficFeatures = createTrafficAreaFeatureCollection(
      [polygonObject],
      () => ({ color: '#dc2626', summary: 'area · high' }),
    )

    expect(mapSourceIds.trafficAreas).toBe('traffic-area-source')
    expect(trafficFeatures.features).toHaveLength(1)
    expect(trafficFeatures.features[0]?.geometry.type).toBe('Polygon')
    expect(trafficFeatures.features[0]?.properties.color).toBe('#dc2626')
  })
})
