import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, SimulationRunId, SimulationRunEvent } from '../src/core/model/index.ts'
import { confirmedFact, geoPointFromLonLat, meters, nowIso, type KnowledgeFact, type ObjectId, type OperationalObject } from '../src/core/model/index.ts'
import {
  assignToIncidentCommandKind,
  cancelDestinationCommandKind,
  createObjectCommandKind,
  setDestinationCommandKind,
} from '../src/packs/ambulance/commands.ts'
import { ambulancePackDataSchema, hospitalPackDataSchema, incidentPackDataSchema, type AmbulancePackData, type HospitalPackData, type IncidentPackData } from '../src/packs/ambulance/model.ts'
import { responseScenario } from './fixtures/scenarios.ts'
import { createLocalAmbulancePackRuntimeAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createAmbulanceSimEngine, type AmbulanceSimEngine } from '../src/packs/ambulance/sim/engine.ts'
import { createAmbulanceArrivalInteractionHandler } from '../src/packs/ambulance/sim/interactions.ts'
import type { PackRuntimeEvent } from '../src/simulation/protocol.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { testScenarioRuntimeConfig } from './helpers.ts'

const simulationRunId = 'run-test' as SimulationRunId
const actorId = 'actor:test-operator' as ActorId

const makeCommand = (config: {
  readonly id: string
  readonly kind: string
  readonly targetObjectIds?: ReadonlyArray<ObjectId>
  readonly payload: unknown
  readonly expectedRevision?: number
}): CommandEnvelope => ({
  id: `command:${config.id}` as CommandId,
  simulationRunId,
  actorId,
  kind: config.kind,
  targetObjectIds: config.targetObjectIds ?? [],
  payload: config.payload,
  issuedAt: nowIso(),
  ...(config.expectedRevision !== undefined ? { expectedRevision: config.expectedRevision } : {}),
})

const knownFactValue = <T>(fact: KnowledgeFact<T> | undefined): T => {
  if (!fact || fact.state === 'unknown') throw new Error('expected known fact value')
  return fact.value
}

const withAmbulancePatients = (object: OperationalObject, patientsOnBoard: number, patientCapacity = 1): OperationalObject => {
  const data = ambulancePackDataSchema.parse(object.packData)
  const at = nowIso()
  return {
    ...object,
    packData: {
      ...data,
      transport: {
        patientCapacity: confirmedFact(patientCapacity, at, 'scenario', 1),
        patientsOnBoard: confirmedFact(patientsOnBoard, at, 'scenario', 1),
      },
    } satisfies AmbulancePackData,
  }
}

const withIncidentVictims = (object: OperationalObject, victimCount: number): OperationalObject => {
  const data = incidentPackDataSchema.parse(object.packData)
  const at = nowIso()
  return {
    ...object,
    packData: {
      ...data,
      victims: {
        ...data.victims,
        count: confirmedFact(victimCount, at, 'scenario', 1),
      },
    } satisfies IncidentPackData,
  }
}

const withHospitalBedsAvailable = (object: OperationalObject, bedsAvailable: number): OperationalObject => {
  const data = hospitalPackDataSchema.parse(object.packData)
  const at = nowIso()
  return {
    ...object,
    packData: {
      ...data,
      emergencyDepartment: {
        ...data.emergencyDepartment,
        traumaBedsAvailable: confirmedFact(bedsAvailable, at, 'scenario', 1),
        patientsReceived: confirmedFact(0, at, 'scenario', 1),
      },
    } satisfies HospitalPackData,
  }
}

const applyInteractionEvents = async (
  engine: AmbulanceSimEngine,
  events: ReadonlyArray<PackRuntimeEvent>,
): Promise<void> => {
  const handler = createAmbulanceArrivalInteractionHandler()
  for (const event of events) {
    if (event.type !== 'interaction.signal' || !handler.accepts(event.signal)) continue
    const effects = await handler.handle({
      signal: event.signal,
      snapshot: { objects: engine.snapshot().objects, seq: 0 },
      provenance: event.provenance,
    })
    const committedEvents: SimulationRunEvent[] = effects.map((effect, index) => {
      const base = {
        id: `event:test-${event.signal.id}-${index}` as SimulationRunEvent['id'],
        simulationRunId,
        seq: index + 1,
        at: event.signal.at,
        provenance: event.provenance,
      }
      if (effect.type === 'object.upsert') return { ...base, type: 'object.upserted' as const, object: effect.object }
      if (effect.type === 'object.delete') return { ...base, type: 'object.deleted' as const, objectId: effect.objectId }
      return { ...base, type: 'notification.emitted' as const, notification: effect.notification }
    })
    engine.observeCommittedEvents(committedEvents)
  }
}

describe('local ambulance runtime', () => {
  test('starts with the tutorial ambulance, incident, and hospital set', async () => {
    const connection = await createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }).connect({ simulationRunId, scenario: testScenarioRuntimeConfig() })
    const initial = await connection.getSnapshot()

    expect(initial.objects.filter(object => object.kind === 'mobile_entity')).toHaveLength(3)
    expect(initial.objects.filter(object => object.kind === 'incident')).toHaveLength(3)
    expect(initial.objects.filter(object => object.kind === 'facility')).toHaveLength(3)

    const ambulance = initial.objects.find(object => object.id === 'amb:a12')
    const hospital = initial.objects.find(object => object.id === 'facility:ous')
    expect(ambulance?.spatial.position?.point.coordinates).toEqual(hospital?.spatial.position?.point.coordinates)
    expect(ambulancePackDataSchema.parse(ambulance?.packData).capabilities).toContain('advanced_life_support')
    expect(incidentPackDataSchema.parse(initial.objects.find(object => object.id === 'incident:torshov-partial')?.packData).victims.count.state).toBe('unknown')
    expect(hospitalPackDataSchema.parse(hospital?.packData).emergencyDepartment.diversionStatus.state).toBe('confirmed')
    await connection.close()
  })

  test('restores missing runtime routes for active ambulances before starting motion', async () => {
    const runtime = testScenarioRuntimeConfig()
    const activeAmbulance = runtime.initialObjects.find(object =>
      object.kind === 'mobile_entity' && object.tasking?.currentTaskId !== undefined)
    if (!activeAmbulance?.spatial.position) throw new Error('scenario missing active ambulance')
    const objectsWithoutRoute = runtime.initialObjects.map(object => {
      if (object.id !== activeAmbulance.id) return object
      const { route: _route, ...spatialWithoutRoute } = object.spatial
      return {
        ...object,
        spatial: spatialWithoutRoute,
      }
    })
    const connection = await createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }).connect({
      simulationRunId,
      scenario: {
        ...runtime,
        initialObjects: objectsWithoutRoute,
      },
    })
    try {
      const restored = await connection.getSnapshot()
      const restoredAmbulance = restored.objects.find(object => object.id === activeAmbulance.id)
      expect(restoredAmbulance?.spatial.route?.planned?.coordinates.length).toBe(2)

      const startLon = activeAmbulance.spatial.position.point.coordinates[0]
      await Bun.sleep(1_100)
      const moved = await connection.getSnapshot()
      const movedAmbulance = moved.objects.find(object => object.id === activeAmbulance.id)
      expect(movedAmbulance?.spatial.position?.point.coordinates[0]).not.toBe(startLon)
      expect(movedAmbulance?.spatial.position?.speedMps).toBeGreaterThan(0)
    } finally {
      await connection.close()
    }
  })

  test('accepts a dispatch command and updates scenario state', async () => {
    const connection = await createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }).connect({ simulationRunId, scenario: testScenarioRuntimeConfig() })
    const initial = await connection.getSnapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity' && object.operational.status === 'available')
    const incident = initial.objects.find(object => object.id === 'incident:gronland-unattended')
    if (!ambulance || !incident) throw new Error('scenario missing ambulance or incident')

    const command = makeCommand({
      id: 'test-dispatch',
      kind: assignToIncidentCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: {
        ambulanceId: ambulance.id,
        incidentId: incident.id,
      },
      expectedRevision: ambulance.revision,
    })

    const result = await connection.sendCommand(command)
    expect(result.ok).toBe(true)

    const updated = await connection.getSnapshot()
    const updatedAmbulance = updated.objects.find(object => object.id === ambulance.id)
    const updatedIncident = updated.objects.find(object => object.id === incident.id)
    expect(updatedAmbulance?.operational.status).toBe('assigned')
    expect(updatedAmbulance?.spatial.route?.planned?.coordinates.length).toBeGreaterThanOrEqual(2)
    expect(updatedIncident?.operational.status).toBe('assigned')
    await connection.close()
  })

  test('ignores committed object upserts owned by other pack runtimes', async () => {
    const runtime = testScenarioRuntimeConfig()
    const connection = await createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }).connect({ simulationRunId, scenario: runtime })
    const trafficObject = runtime.initialObjects.find(object => object.packId === 'traffic')
    if (!trafficObject) throw new Error('scenario missing traffic object')

    await connection.observeCommittedEvents([{
      id: 'event:test-traffic-upsert' as SimulationRunEvent['id'],
      simulationRunId,
      seq: 1,
      at: nowIso(),
      provenance: { source: 'simulator' },
      type: 'object.upserted',
      object: trafficObject,
    }])

    const snapshot = await connection.getSnapshot()
    expect(snapshot.objects.some(object => object.packId === 'traffic')).toBe(false)
    await connection.close()
  })

  test('evolves incident and hospital facts through runtime events', () => {
    const engine = createAmbulanceSimEngine({
      simulationRunId,
      objects: responseScenario.initialObjects,
      routing: createDirectRoutingAdapter(),
    })

    const initialIncident = engine.snapshot().objects.find(object => object.id === 'incident:torshov-partial')
    if (!initialIncident) throw new Error('scenario missing incident')
    expect(incidentPackDataSchema.parse(initialIncident.packData).victims.count.state).toBe('unknown')

    const incidentEvents = engine.tick(5_000)
    expect(incidentEvents.some(event => event.type === 'object.upserted' && event.object.kind === 'incident')).toBe(true)
    const revealedIncident = engine.snapshot().objects.find(object => object.id === initialIncident.id)
    if (!revealedIncident) throw new Error('scenario missing updated incident')
    const incidentData = incidentPackDataSchema.parse(revealedIncident.packData)
    expect(incidentData.victims.count.state).toBe('estimated')
    expect(incidentData.victims.injuries.state).toBe('estimated')

    const hospitalEvents = engine.tick(5_000)
    expect(hospitalEvents.some(event => event.type === 'object.upserted' && event.object.kind === 'facility')).toBe(true)
    const hospital = engine.snapshot().objects.find(object => object.kind === 'facility')
    if (!hospital) throw new Error('scenario missing hospital')
    const hospitalData = hospitalPackDataSchema.parse(hospital.packData)
    expect(hospitalData.emergencyDepartment.ambulanceBaysAvailable.state).toBe('confirmed')
    if (hospitalData.emergencyDepartment.ambulanceBaysAvailable.state === 'unknown') throw new Error('expected known ambulance bay capacity')
    if (hospitalData.emergencyDepartment.diversionStatus.state === 'unknown') throw new Error('expected known diversion status')
    expect(hospitalData.emergencyDepartment.ambulanceBaysAvailable.value).toBe(1)
    expect(hospitalData.emergencyDepartment.diversionStatus.value).toBe('limited')
  })

  test('follows shaped route coordinates instead of jumping straight to the destination', async () => {
    const firstRoutePoint = geoPointFromLonLat(10.7387, 59.9364)
    const engine = createAmbulanceSimEngine({
      simulationRunId,
      objects: responseScenario.initialObjects,
      routing: {
        id: 'test-shaped-route',
        route: async () => ({
          geometry: {
            type: 'LineString',
            coordinates: [
              firstRoutePoint.coordinates,
              geoPointFromLonLat(10.7387, 59.9359).coordinates,
              geoPointFromLonLat(10.7750, 59.9120).coordinates,
            ],
          },
          distanceM: meters(1_000),
          durationSeconds: 60,
          provider: 'test',
        }),
      },
    })
    const initial = engine.snapshot()
    const ambulance = initial.objects.find(object => object.id === 'amb:a12')
    const incident = initial.objects.find(object => object.id === 'incident:gronland-unattended')
    if (!ambulance || !incident) throw new Error('scenario missing ambulance or incident')

    const result = await engine.handleCommand(makeCommand({
      id: 'route-first-coordinate',
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: { ambulanceId: ambulance.id, destinationId: incident.id },
    }))
    expect(result.ok).toBe(true)

    engine.tick(1_000)
    const movedAmbulance = engine.snapshot().objects.find(object => object.id === ambulance.id)
    if (!movedAmbulance?.spatial.position || !ambulance.spatial.position) throw new Error('missing moved ambulance position')
    expect(movedAmbulance.spatial.position.point.coordinates[0]).toBeCloseTo(ambulance.spatial.position.point.coordinates[0], 4)
    expect(movedAmbulance.spatial.position.point.coordinates[1]).toBeLessThan(ambulance.spatial.position.point.coordinates[1])
    expect(movedAmbulance.spatial.position.point.coordinates[1]).toBeGreaterThan(59.9363)
  })

  test('starts moving immediately when the route begins at the ambulance position', async () => {
    const engine = createAmbulanceSimEngine({
      simulationRunId,
      objects: responseScenario.initialObjects,
      routing: createDirectRoutingAdapter(),
    })
    const initial = engine.snapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity')
    const incident = initial.objects.find(object => object.kind === 'incident')
    if (!ambulance || !incident || !ambulance.spatial.position) throw new Error('scenario missing ambulance or incident')
    const initialPoint = ambulance.spatial.position.point

    const result = await engine.handleCommand(makeCommand({
      id: 'route-starts-at-ambulance',
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: { ambulanceId: ambulance.id, destinationId: incident.id },
    }))
    expect(result.ok).toBe(true)

    engine.tick(1_000)
    const movedAmbulance = engine.snapshot().objects.find(object => object.id === ambulance.id)
    if (!movedAmbulance?.spatial.position) throw new Error('missing moved ambulance position')
    expect(movedAmbulance.spatial.position.point.coordinates).not.toEqual(initialPoint.coordinates)
    expect(movedAmbulance.spatial.position.speedMps).toBeGreaterThan(0)
  })

  test('consumes the full movement budget across dense route geometry', async () => {
    const start = responseScenario.initialObjects.find(object => object.kind === 'mobile_entity')?.spatial.position?.point
    if (!start) throw new Error('scenario missing ambulance start')
    const [startLon, startLat] = start.coordinates
    const denseCoordinates = Array.from({ length: 50 }, (_value, index) =>
      geoPointFromLonLat(startLon, startLat + index * 0.00001).coordinates)
    const engine = createAmbulanceSimEngine({
      simulationRunId,
      objects: responseScenario.initialObjects,
      routing: {
        id: 'test-dense-route',
        route: async () => ({
          geometry: {
            type: 'LineString',
            coordinates: denseCoordinates,
          },
          distanceM: meters(55),
          durationSeconds: 4,
          provider: 'test',
        }),
      },
    })
    const initial = engine.snapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity')
    const incident = initial.objects.find(object => object.kind === 'incident')
    if (!ambulance || !incident || !ambulance.spatial.position) throw new Error('scenario missing ambulance or incident')

    const result = await engine.handleCommand(makeCommand({
      id: 'dense-route-budget',
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: { ambulanceId: ambulance.id, destinationId: incident.id },
    }))
    expect(result.ok).toBe(true)

    engine.tick(1_000)
    const movedAmbulance = engine.snapshot().objects.find(object => object.id === ambulance.id)
    if (!movedAmbulance?.spatial.position) throw new Error('missing moved ambulance position')

    const movedMeters = (movedAmbulance.spatial.position.point.coordinates[1] - startLat) * 110_540
    expect(movedMeters).toBeGreaterThan(13)
    expect(movedMeters).toBeLessThan(17)
    expect(movedAmbulance.spatial.route?.progress?.remainingDistanceM).toBeGreaterThan(0)
    expect(movedAmbulance.spatial.route?.etaSeconds).toBeGreaterThan(0)
  })

  test('uses the same default motion profile for new and restored motion', async () => {
    const engine = createAmbulanceSimEngine({
      simulationRunId: 'run-test-motion-profile' as SimulationRunId,
      objects: responseScenario.initialObjects,
      routing: createDirectRoutingAdapter(),
    })
    const initial = engine.snapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity')
    const incident = initial.objects.find(object => object.kind === 'incident')
    if (!ambulance || !incident) throw new Error('scenario missing ambulance or incident')

    const result = await engine.handleCommand(makeCommand({
      id: 'dispatch-motion-profile',
      kind: assignToIncidentCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: { ambulanceId: ambulance.id, incidentId: incident.id },
    }))
    expect(result.ok).toBe(true)
    engine.tick(1_000)
    const moving = engine.snapshot().objects.find(object => object.id === ambulance.id)
    expect(moving?.spatial.position?.speedMps).toBe(15)

    const restoredEngine = createAmbulanceSimEngine({
      simulationRunId: 'run-test-restored-motion-profile' as SimulationRunId,
      routing: createDirectRoutingAdapter(),
      objects: engine.snapshot().objects,
    })
    restoredEngine.tick(1_000)
    const restoredMoving = restoredEngine.snapshot().objects.find(object => object.id === ambulance.id)
    expect(restoredMoving?.spatial.position?.speedMps).toBe(15)
  })

  test('creates ambulance pack objects from operator commands', async () => {
    const connection = await createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }).connect({ simulationRunId, scenario: testScenarioRuntimeConfig() })
    const result = await connection.sendCommand(makeCommand({
      id: 'create-hospital',
      kind: createObjectCommandKind,
      payload: {
        objectType: 'hospital',
        label: 'Ullevål hospital',
        point: geoPointFromLonLat(10.7369, 59.9369),
      },
    }))

    expect(result.ok).toBe(true)
    const updated = await connection.getSnapshot()
    expect(updated.objects.some(object => object.kind === 'facility' && object.label === 'Ullevål hospital')).toBe(true)
    await connection.close()
  })

  test('retargets and cancels an ambulance destination', async () => {
    const connection = await createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }).connect({ simulationRunId, scenario: testScenarioRuntimeConfig() })
    const initial = await connection.getSnapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity')
    const incident = initial.objects.find(object => object.kind === 'incident')
    const hospital = initial.objects.find(object => object.kind === 'facility')
    if (!ambulance || !incident || !hospital) throw new Error('scenario missing test objects')

    const dispatchResult = await connection.sendCommand(makeCommand({
      id: 'dispatch-before-retarget',
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: { ambulanceId: ambulance.id, destinationId: incident.id },
    }))
    expect(dispatchResult.ok).toBe(true)

    const retargetResult = await connection.sendCommand(makeCommand({
      id: 'retarget-to-hospital',
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, hospital.id],
      payload: { ambulanceId: ambulance.id, destinationId: hospital.id },
    }))
    expect(retargetResult.ok).toBe(true)

    const retargeted = await connection.getSnapshot()
    const retargetedAmbulance = retargeted.objects.find(object => object.id === ambulance.id)
    expect(retargetedAmbulance?.tasking?.currentTaskId).toBe(hospital.id)

    const cancelResult = await connection.sendCommand(makeCommand({
      id: 'cancel-destination',
      kind: cancelDestinationCommandKind,
      targetObjectIds: [ambulance.id],
      payload: { ambulanceId: ambulance.id },
    }))
    expect(cancelResult.ok).toBe(true)

    const cancelled = await connection.getSnapshot()
    const cancelledAmbulance = cancelled.objects.find(object => object.id === ambulance.id)
    expect(cancelledAmbulance?.operational.status).toBe('available')
    expect(cancelledAmbulance?.tasking).toBeUndefined()
    expect(cancelledAmbulance?.spatial.route).toBeUndefined()
    await connection.close()
  })

  test('clears destination when an ambulance reaches a hospital', async () => {
    const connection = await createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }).connect({ simulationRunId, scenario: testScenarioRuntimeConfig() })
    const initial = await connection.getSnapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity')
    const hospital = initial.objects.find(object => object.kind === 'facility')
    if (!ambulance || !hospital) throw new Error('scenario missing ambulance or hospital')

    const result = await connection.sendCommand(makeCommand({
      id: 'send-to-hospital',
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, hospital.id],
      payload: { ambulanceId: ambulance.id, destinationId: hospital.id },
    }))
    expect(result.ok).toBe(true)

    await new Promise(resolve => setTimeout(resolve, 1_050))
    const arrived = await connection.getSnapshot()
    const arrivedAmbulance = arrived.objects.find(object => object.id === ambulance.id)
    expect(arrivedAmbulance?.operational.status).toBe('available')
    expect(arrivedAmbulance?.tasking).toBeUndefined()
    expect(arrivedAmbulance?.spatial.route).toBeUndefined()
    await connection.close()
  })

  test('loads patients and reduces victims when an empty ambulance reaches an incident', async () => {
    const baseObjects = responseScenario.initialObjects
    const baseAmbulance = baseObjects.find(object => object.id === 'amb:a12')
    const baseIncident = baseObjects.find(object => object.id === 'incident:gronland-unattended')
    if (!baseAmbulance || !baseIncident || !baseAmbulance.spatial.position || !baseIncident.spatial.position) {
      throw new Error('scenario missing ambulance or incident')
    }
    const initialObjects = baseObjects.map(object => {
      if (object.id !== baseIncident.id) return object
      return withIncidentVictims({
        ...object,
        spatial: {
          ...object.spatial,
          position: {
            ...object.spatial.position!,
            point: baseAmbulance.spatial.position!.point,
          },
        },
      }, 2)
    })
    const engine = createAmbulanceSimEngine({
      simulationRunId,
      objects: initialObjects,
      routing: createDirectRoutingAdapter(),
    })
    const initial = engine.snapshot()
    const ambulance = initial.objects.find(object => object.id === baseAmbulance.id)
    const incident = initial.objects.find(object => object.id === baseIncident.id)
    if (!ambulance || !incident) throw new Error('scenario missing ambulance or incident')

    const result = await engine.handleCommand(makeCommand({
      id: 'load-at-incident',
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: { ambulanceId: ambulance.id, destinationId: incident.id },
    }))
    expect(result.ok).toBe(true)

    await applyInteractionEvents(engine, engine.tick(600_000))
    const arrived = engine.snapshot()
    const arrivedAmbulance = arrived.objects.find(object => object.id === ambulance.id)
    const remainingIncident = arrived.objects.find(object => object.id === incident.id)
    if (!arrivedAmbulance || !remainingIncident) throw new Error('expected ambulance and incident after partial pickup')

    const ambulanceData = ambulancePackDataSchema.parse(arrivedAmbulance.packData)
    const incidentData = incidentPackDataSchema.parse(remainingIncident.packData)
    expect(ambulanceData.transport?.patientsOnBoard.state).toBe('confirmed')
    expect(knownFactValue(ambulanceData.transport?.patientsOnBoard)).toBe(1)
    expect(incidentData.victims.count.state).toBe('confirmed')
    expect(knownFactValue(incidentData.victims.count)).toBe(1)
  })

  test('marks an incident resolved when arriving ambulance capacity covers all victims', async () => {
    const baseObjects = createAmbulanceSimEngine({
      simulationRunId,
      objects: responseScenario.initialObjects,
      routing: createDirectRoutingAdapter(),
    }).snapshot().objects
    const initialObjects = baseObjects.map(object => {
      if (object.kind === 'mobile_entity') return withAmbulancePatients(object, 0, 2)
      if (object.kind === 'incident') return withIncidentVictims(object, 1)
      return object
    })
    const engine = createAmbulanceSimEngine({
      simulationRunId,
      objects: initialObjects,
      routing: createDirectRoutingAdapter(),
    })
    const ambulance = engine.snapshot().objects.find(object => object.kind === 'mobile_entity')
    const incident = engine.snapshot().objects.find(object => object.kind === 'incident')
    if (!ambulance || !incident) throw new Error('scenario missing ambulance or incident')

    const result = await engine.handleCommand(makeCommand({
      id: 'resolve-incident-by-pickup',
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: { ambulanceId: ambulance.id, destinationId: incident.id },
    }))
    expect(result.ok).toBe(true)

    const events = engine.tick(300_000)
    expect(events.some(event => event.type === 'interaction.signal')).toBe(true)
    await applyInteractionEvents(engine, events)
    const resolvedIncident = engine.snapshot().objects.find(object => object.id === incident.id)
    if (!resolvedIncident) throw new Error('expected resolved incident to remain visible')
    const incidentData = incidentPackDataSchema.parse(resolvedIncident.packData)
    expect(resolvedIncident.operational.status).toBe('resolved')
    expect(knownFactValue(incidentData.victims.count)).toBe(0)
    const arrivedAmbulance = engine.snapshot().objects.find(object => object.id === ambulance.id)
    const ambulanceData = ambulancePackDataSchema.parse(arrivedAmbulance?.packData)
    expect(knownFactValue(ambulanceData.transport?.patientsOnBoard)).toBe(1)
  })

  test('unloads patients and updates hospital capacity when a loaded ambulance reaches a hospital', async () => {
    const baseObjects = createAmbulanceSimEngine({
      simulationRunId,
      objects: responseScenario.initialObjects,
      routing: createDirectRoutingAdapter(),
    }).snapshot().objects
    const initialObjects = baseObjects.map(object => object.kind === 'mobile_entity' ? withAmbulancePatients(object, 1, 1) : object)
    const engine = createAmbulanceSimEngine({
      simulationRunId,
      objects: initialObjects,
      routing: createDirectRoutingAdapter(),
    })
    const ambulance = engine.snapshot().objects.find(object => object.kind === 'mobile_entity')
    const hospital = engine.snapshot().objects.find(object => object.kind === 'facility')
    if (!ambulance || !hospital) throw new Error('scenario missing ambulance or hospital')

    const result = await engine.handleCommand(makeCommand({
      id: 'unload-at-hospital',
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, hospital.id],
      payload: { ambulanceId: ambulance.id, destinationId: hospital.id },
    }))
    expect(result.ok).toBe(true)

    await applyInteractionEvents(engine, engine.tick(1_000))
    const arrived = engine.snapshot()
    const arrivedAmbulance = arrived.objects.find(object => object.id === ambulance.id)
    const updatedHospital = arrived.objects.find(object => object.id === hospital.id)
    const ambulanceData = ambulancePackDataSchema.parse(arrivedAmbulance?.packData)
    const hospitalData = hospitalPackDataSchema.parse(updatedHospital?.packData)
    expect(arrivedAmbulance?.operational.status).toBe('available')
    expect(knownFactValue(ambulanceData.transport?.patientsOnBoard)).toBe(0)
    expect(knownFactValue(hospitalData.emergencyDepartment.traumaBedsAvailable)).toBe(1)
    expect(knownFactValue(hospitalData.emergencyDepartment.patientsReceived)).toBe(1)
  })

  test('keeps loaded ambulance waiting when hospital has no receiving capacity', async () => {
    const baseObjects = createAmbulanceSimEngine({
      simulationRunId,
      objects: responseScenario.initialObjects,
      routing: createDirectRoutingAdapter(),
    }).snapshot().objects
    const initialObjects = baseObjects.map(object => {
      if (object.kind === 'mobile_entity') return withAmbulancePatients(object, 1, 1)
      if (object.kind === 'facility') return withHospitalBedsAvailable(object, 0)
      return object
    })
    const engine = createAmbulanceSimEngine({
      simulationRunId,
      objects: initialObjects,
      routing: createDirectRoutingAdapter(),
    })
    const ambulance = engine.snapshot().objects.find(object => object.kind === 'mobile_entity')
    const hospital = engine.snapshot().objects.find(object => object.kind === 'facility')
    if (!ambulance || !hospital) throw new Error('scenario missing ambulance or hospital')

    const result = await engine.handleCommand(makeCommand({
      id: 'hospital-full',
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, hospital.id],
      payload: { ambulanceId: ambulance.id, destinationId: hospital.id },
    }))
    expect(result.ok).toBe(true)

    await applyInteractionEvents(engine, engine.tick(1_000))
    const arrived = engine.snapshot()
    const arrivedAmbulance = arrived.objects.find(object => object.id === ambulance.id)
    const updatedHospital = arrived.objects.find(object => object.id === hospital.id)
    const ambulanceData = ambulancePackDataSchema.parse(arrivedAmbulance?.packData)
    const hospitalData = hospitalPackDataSchema.parse(updatedHospital?.packData)
    expect(arrivedAmbulance?.operational.status).toBe('at_hospital')
    expect(knownFactValue(ambulanceData.transport?.patientsOnBoard)).toBe(1)
    expect(knownFactValue(hospitalData.emergencyDepartment.traumaBedsAvailable)).toBe(0)
    expect(knownFactValue(hospitalData.emergencyDepartment.patientsReceived)).toBe(0)
  })
})
