import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, ControlInstanceId, DomainEvent } from '../src/core/model/index.ts'
import { confirmedFact, geoPointFromLonLat, meters, nowIso, type KnowledgeFact, type ObjectId, type OperationalObject } from '../src/core/model/index.ts'
import {
  assignToIncidentCommandKind,
  cancelDestinationCommandKind,
  createObjectCommandKind,
  setDestinationCommandKind,
} from '../src/domains/ambulance/commands.ts'
import { ambulanceDomainDataSchema, hospitalDomainDataSchema, incidentDomainDataSchema, type AmbulanceDomainData, type HospitalDomainData, type IncidentDomainData } from '../src/domains/ambulance/model.ts'
import { createOsloAmbulanceScenario } from '../src/domains/ambulance/scenario.ts'
import { createLocalAmbulanceSimulationAdapter } from '../src/domains/ambulance/sim/adapter.ts'
import { createAmbulanceSimEngine, type AmbulanceSimEngine } from '../src/domains/ambulance/sim/engine.ts'
import { createAmbulanceArrivalInteractionHandler } from '../src/domains/ambulance/sim/interactions.ts'
import type { SimulationEvent } from '../src/simulation/protocol.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'

const controlInstanceId = 'control-instance:test' as ControlInstanceId
const actorId = 'actor:test-operator' as ActorId

const makeCommand = (config: {
  readonly id: string
  readonly kind: string
  readonly targetObjectIds?: ReadonlyArray<ObjectId>
  readonly payload: unknown
  readonly expectedRevision?: number
}): CommandEnvelope => ({
  id: `command:${config.id}` as CommandId,
  controlInstanceId,
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
  const data = ambulanceDomainDataSchema.parse(object.domainData)
  const at = nowIso()
  return {
    ...object,
    domainData: {
      ...data,
      transport: {
        patientCapacity: confirmedFact(patientCapacity, at, 'scenario', 1),
        patientsOnBoard: confirmedFact(patientsOnBoard, at, 'scenario', 1),
      },
    } satisfies AmbulanceDomainData,
  }
}

const withIncidentVictims = (object: OperationalObject, victimCount: number): OperationalObject => {
  const data = incidentDomainDataSchema.parse(object.domainData)
  const at = nowIso()
  return {
    ...object,
    domainData: {
      ...data,
      victims: {
        ...data.victims,
        count: confirmedFact(victimCount, at, 'scenario', 1),
      },
    } satisfies IncidentDomainData,
  }
}

const withHospitalBedsAvailable = (object: OperationalObject, bedsAvailable: number): OperationalObject => {
  const data = hospitalDomainDataSchema.parse(object.domainData)
  const at = nowIso()
  return {
    ...object,
    domainData: {
      ...data,
      emergencyDepartment: {
        ...data.emergencyDepartment,
        traumaBedsAvailable: confirmedFact(bedsAvailable, at, 'scenario', 1),
        patientsReceived: confirmedFact(0, at, 'scenario', 1),
      },
    } satisfies HospitalDomainData,
  }
}

const applyInteractionEvents = async (
  engine: AmbulanceSimEngine,
  events: ReadonlyArray<SimulationEvent>,
): Promise<void> => {
  const handler = createAmbulanceArrivalInteractionHandler()
  for (const event of events) {
    if (event.type !== 'interaction.signal' || !handler.accepts(event.signal)) continue
    const effects = await handler.handle({
      signal: event.signal,
      snapshot: { objects: engine.snapshot().objects, seq: 0 },
      provenance: event.provenance,
    })
    const committedEvents: DomainEvent[] = effects.map((effect, index) => {
      const base = {
        id: `event:test-${event.signal.id}-${index}` as DomainEvent['id'],
        controlInstanceId,
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

describe('local ambulance simulator', () => {
  test('starts with one ambulance, one incident, and one hospital', async () => {
    const connection = await createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }).connect({ controlInstanceId })
    const initial = await connection.getSnapshot()

    expect(initial.objects.filter(object => object.kind === 'mobile_entity')).toHaveLength(1)
    expect(initial.objects.filter(object => object.kind === 'incident')).toHaveLength(1)
    expect(initial.objects.filter(object => object.kind === 'facility')).toHaveLength(1)

    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity')
    const hospital = initial.objects.find(object => object.kind === 'facility')
    expect(ambulance?.spatial.position?.point.coordinates).toEqual(hospital?.spatial.position?.point.coordinates)
    expect(ambulanceDomainDataSchema.parse(ambulance?.domainData).capabilities).toContain('advanced_life_support')
    expect(incidentDomainDataSchema.parse(initial.objects.find(object => object.kind === 'incident')?.domainData).victims.count.state).toBe('unknown')
    expect(hospitalDomainDataSchema.parse(hospital?.domainData).emergencyDepartment.diversionStatus.state).toBe('confirmed')
    await connection.close()
  })

  test('accepts a dispatch command and updates scenario state', async () => {
    const connection = await createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }).connect({ controlInstanceId })
    const initial = await connection.getSnapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity' && object.operational.status === 'available')
    const incident = initial.objects.find(object => object.kind === 'incident')
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

  test('evolves incident and hospital facts through simulator events', () => {
    const engine = createAmbulanceSimEngine({
      controlInstanceId,
      scenario: createOsloAmbulanceScenario(),
      routing: createDirectRoutingAdapter(),
    })

    const initialIncident = engine.snapshot().objects.find(object => object.kind === 'incident')
    if (!initialIncident) throw new Error('scenario missing incident')
    expect(incidentDomainDataSchema.parse(initialIncident.domainData).victims.count.state).toBe('unknown')

    const incidentEvents = engine.tick(5_000)
    expect(incidentEvents.some(event => event.type === 'object.upserted' && event.object.kind === 'incident')).toBe(true)
    const revealedIncident = engine.snapshot().objects.find(object => object.kind === 'incident')
    if (!revealedIncident) throw new Error('scenario missing updated incident')
    const incidentData = incidentDomainDataSchema.parse(revealedIncident.domainData)
    expect(incidentData.victims.count.state).toBe('estimated')
    expect(incidentData.victims.injuries.state).toBe('estimated')

    const hospitalEvents = engine.tick(5_000)
    expect(hospitalEvents.some(event => event.type === 'object.upserted' && event.object.kind === 'facility')).toBe(true)
    const hospital = engine.snapshot().objects.find(object => object.kind === 'facility')
    if (!hospital) throw new Error('scenario missing hospital')
    const hospitalData = hospitalDomainDataSchema.parse(hospital.domainData)
    expect(hospitalData.emergencyDepartment.ambulanceBaysAvailable.state).toBe('confirmed')
    if (hospitalData.emergencyDepartment.ambulanceBaysAvailable.state === 'unknown') throw new Error('expected known ambulance bay capacity')
    if (hospitalData.emergencyDepartment.diversionStatus.state === 'unknown') throw new Error('expected known diversion status')
    expect(hospitalData.emergencyDepartment.ambulanceBaysAvailable.value).toBe(1)
    expect(hospitalData.emergencyDepartment.diversionStatus.value).toBe('limited')
  })

  test('follows shaped route coordinates instead of jumping straight to the destination', async () => {
    const scenario = createOsloAmbulanceScenario()
    const firstRoutePoint = geoPointFromLonLat(10.7387, 59.9364)
    const engine = createAmbulanceSimEngine({
      controlInstanceId,
      scenario,
      routing: {
        id: 'test-shaped-route',
        route: async () => ({
          geometry: {
            type: 'LineString',
            coordinates: [
              firstRoutePoint.coordinates,
              geoPointFromLonLat(10.7387, 59.9359).coordinates,
              scenario.incidents[0]?.position.coordinates ?? firstRoutePoint.coordinates,
            ],
          },
          distanceM: meters(1_000),
          durationSeconds: 60,
          provider: 'test',
        }),
      },
    })
    const initial = engine.snapshot()
    const ambulance = initial.objects.find(object => object.kind === 'mobile_entity')
    const incident = initial.objects.find(object => object.kind === 'incident')
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
    const scenario = createOsloAmbulanceScenario()
    const engine = createAmbulanceSimEngine({
      controlInstanceId,
      scenario,
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
    const scenario = createOsloAmbulanceScenario()
    const start = scenario.ambulances[0]?.position
    if (!start) throw new Error('scenario missing ambulance start')
    const [startLon, startLat] = start.coordinates
    const denseCoordinates = Array.from({ length: 50 }, (_value, index) =>
      geoPointFromLonLat(startLon, startLat + index * 0.00001).coordinates)
    const engine = createAmbulanceSimEngine({
      controlInstanceId,
      scenario,
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
    const scenario = createOsloAmbulanceScenario()
    const engine = createAmbulanceSimEngine({
      controlInstanceId: 'control-instance:test-motion-profile' as ControlInstanceId,
      scenario,
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
      controlInstanceId: 'control-instance:test-restored-motion-profile' as ControlInstanceId,
      scenario,
      routing: createDirectRoutingAdapter(),
      initialObjects: engine.snapshot().objects,
    })
    restoredEngine.tick(1_000)
    const restoredMoving = restoredEngine.snapshot().objects.find(object => object.id === ambulance.id)
    expect(restoredMoving?.spatial.position?.speedMps).toBe(15)
  })

  test('creates ambulance domain objects from operator commands', async () => {
    const connection = await createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }).connect({ controlInstanceId })
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
    const connection = await createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }).connect({ controlInstanceId })
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
    const connection = await createLocalAmbulanceSimulationAdapter({ routing: createDirectRoutingAdapter() }).connect({ controlInstanceId })
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
      id: 'load-at-incident',
      kind: setDestinationCommandKind,
      targetObjectIds: [ambulance.id, incident.id],
      payload: { ambulanceId: ambulance.id, destinationId: incident.id },
    }))
    expect(result.ok).toBe(true)

    await applyInteractionEvents(engine, engine.tick(300_000))
    const arrived = engine.snapshot()
    const arrivedAmbulance = arrived.objects.find(object => object.id === ambulance.id)
    const remainingIncident = arrived.objects.find(object => object.id === incident.id)
    if (!arrivedAmbulance || !remainingIncident) throw new Error('expected ambulance and incident after partial pickup')

    const ambulanceData = ambulanceDomainDataSchema.parse(arrivedAmbulance.domainData)
    const incidentData = incidentDomainDataSchema.parse(remainingIncident.domainData)
    expect(ambulanceData.transport?.patientsOnBoard.state).toBe('confirmed')
    expect(knownFactValue(ambulanceData.transport?.patientsOnBoard)).toBe(1)
    expect(incidentData.victims.count.state).toBe('estimated')
    expect(knownFactValue(incidentData.victims.count)).toBe(1)
  })

  test('marks an incident resolved when arriving ambulance capacity covers all victims', async () => {
    const seed = createAmbulanceSimEngine({
      controlInstanceId,
      scenario: createOsloAmbulanceScenario(),
      routing: createDirectRoutingAdapter(),
    }).snapshot().objects
    const initialObjects = seed.map(object => {
      if (object.kind === 'mobile_entity') return withAmbulancePatients(object, 0, 2)
      if (object.kind === 'incident') return withIncidentVictims(object, 1)
      return object
    })
    const engine = createAmbulanceSimEngine({
      controlInstanceId,
      scenario: createOsloAmbulanceScenario(),
      routing: createDirectRoutingAdapter(),
      initialObjects,
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
    const incidentData = incidentDomainDataSchema.parse(resolvedIncident.domainData)
    expect(resolvedIncident.operational.status).toBe('resolved')
    expect(knownFactValue(incidentData.victims.count)).toBe(0)
    const arrivedAmbulance = engine.snapshot().objects.find(object => object.id === ambulance.id)
    const ambulanceData = ambulanceDomainDataSchema.parse(arrivedAmbulance?.domainData)
    expect(knownFactValue(ambulanceData.transport?.patientsOnBoard)).toBe(1)
  })

  test('unloads patients and updates hospital capacity when a loaded ambulance reaches a hospital', async () => {
    const seed = createAmbulanceSimEngine({
      controlInstanceId,
      scenario: createOsloAmbulanceScenario(),
      routing: createDirectRoutingAdapter(),
    }).snapshot().objects
    const initialObjects = seed.map(object => object.kind === 'mobile_entity' ? withAmbulancePatients(object, 1, 1) : object)
    const engine = createAmbulanceSimEngine({
      controlInstanceId,
      scenario: createOsloAmbulanceScenario(),
      routing: createDirectRoutingAdapter(),
      initialObjects,
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
    const ambulanceData = ambulanceDomainDataSchema.parse(arrivedAmbulance?.domainData)
    const hospitalData = hospitalDomainDataSchema.parse(updatedHospital?.domainData)
    expect(arrivedAmbulance?.operational.status).toBe('available')
    expect(knownFactValue(ambulanceData.transport?.patientsOnBoard)).toBe(0)
    expect(knownFactValue(hospitalData.emergencyDepartment.traumaBedsAvailable)).toBe(2)
    expect(knownFactValue(hospitalData.emergencyDepartment.patientsReceived)).toBe(1)
  })

  test('keeps loaded ambulance waiting when hospital has no receiving capacity', async () => {
    const seed = createAmbulanceSimEngine({
      controlInstanceId,
      scenario: createOsloAmbulanceScenario(),
      routing: createDirectRoutingAdapter(),
    }).snapshot().objects
    const initialObjects = seed.map(object => {
      if (object.kind === 'mobile_entity') return withAmbulancePatients(object, 1, 1)
      if (object.kind === 'facility') return withHospitalBedsAvailable(object, 0)
      return object
    })
    const engine = createAmbulanceSimEngine({
      controlInstanceId,
      scenario: createOsloAmbulanceScenario(),
      routing: createDirectRoutingAdapter(),
      initialObjects,
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
    const ambulanceData = ambulanceDomainDataSchema.parse(arrivedAmbulance?.domainData)
    const hospitalData = hospitalDomainDataSchema.parse(updatedHospital?.domainData)
    expect(arrivedAmbulance?.operational.status).toBe('at_hospital')
    expect(knownFactValue(ambulanceData.transport?.patientsOnBoard)).toBe(1)
    expect(knownFactValue(hospitalData.emergencyDepartment.traumaBedsAvailable)).toBe(0)
    expect(knownFactValue(hospitalData.emergencyDepartment.patientsReceived)).toBe(0)
  })
})
