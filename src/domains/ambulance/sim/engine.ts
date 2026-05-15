import type { AdapterId, CommandEnvelope, CommandResult, DomainId, GeoJsonLineString, GeoJsonPoint, GeoJsonPosition2D, IsoTimestamp, ObjectId, OperationalObject, SessionId, TelemetryState } from '../../../core/model/index.ts'
import { geoPointFromLonLat, meters, nowIso } from '../../../core/model/index.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import type { SimulationEvent, SimulationSnapshot } from '../../../simulation/protocol.ts'
import { assignToIncidentCommandKind, assignToIncidentPayloadSchema } from '../commands.ts'
import { ambulanceDomainId, type AmbulanceDomainData, type IncidentDomainData } from '../model.ts'
import type { AmbulanceScenario } from '../scenario.ts'

interface AmbulanceMotion {
  readonly targetObjectId: ObjectId
  readonly metersPerSecond: number
  readonly route: GeoJsonLineString
  readonly segmentIndex: number
}

interface EngineState {
  readonly sessionId: SessionId
  readonly objects: Map<ObjectId, OperationalObject>
  readonly motion: Map<ObjectId, AmbulanceMotion>
}

export interface AmbulanceSimEngine {
  readonly snapshot: () => SimulationSnapshot
  readonly tick: (dtMs: number) => ReadonlyArray<SimulationEvent>
  readonly handleCommand: (command: CommandEnvelope) => Promise<CommandResult>
}

const adapterId = 'adapter:ambulance-local' as AdapterId
const domain = ambulanceDomainId as DomainId

const getPoint = (object: OperationalObject): GeoJsonPoint => {
  const point = object.spatial.position?.point
  if (!point) {
    throw new Error(`object ${object.id} has no position`)
  }
  return point
}

const pointFromPosition = (position: GeoJsonPosition2D): GeoJsonPoint => ({
  type: 'Point',
  coordinates: position,
})

const distanceMeters = (from: GeoJsonPoint, to: GeoJsonPoint): number => {
  const [fromLon, fromLat] = from.coordinates
  const [toLon, toLat] = to.coordinates
  const meanLatRad = ((fromLat + toLat) / 2) * Math.PI / 180
  const dx = (toLon - fromLon) * 111_320 * Math.cos(meanLatRad)
  const dy = (toLat - fromLat) * 110_540
  return Math.sqrt(dx * dx + dy * dy)
}

const moveTowards = (from: GeoJsonPoint, to: GeoJsonPoint, metersToMove: number): GeoJsonPoint => {
  const distance = distanceMeters(from, to)
  if (distance <= metersToMove || distance === 0) return to
  const ratio = metersToMove / distance
  const [fromLon, fromLat] = from.coordinates
  const [toLon, toLat] = to.coordinates
  return geoPointFromLonLat(fromLon + (toLon - fromLon) * ratio, fromLat + (toLat - fromLat) * ratio)
}

const bearingDeg = (from: GeoJsonPoint, to: GeoJsonPoint): number => {
  const [fromLon, fromLat] = from.coordinates
  const [toLon, toLat] = to.coordinates
  const y = Math.sin((toLon - fromLon) * Math.PI / 180) * Math.cos(toLat * Math.PI / 180)
  const x = Math.cos(fromLat * Math.PI / 180) * Math.sin(toLat * Math.PI / 180)
    - Math.sin(fromLat * Math.PI / 180) * Math.cos(toLat * Math.PI / 180) * Math.cos((toLon - fromLon) * Math.PI / 180)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

const makeTelemetry = (at: IsoTimestamp, heartRate: number, spo2: number): TelemetryState => ({
  signals: {
    heartRate: {
      signalId: 'heartRate',
      label: 'Heart rate',
      unit: 'bpm',
      latest: heartRate,
      samples: [{ at, value: heartRate }],
      severity: heartRate > 120 ? 'warning' : 'normal',
    },
    spo2: {
      signalId: 'spo2',
      label: 'SpO2',
      unit: '%',
      latest: spo2,
      samples: [{ at, value: spo2 }],
      severity: spo2 < 92 ? 'critical' : spo2 < 95 ? 'warning' : 'normal',
    },
  },
})

const createAmbulanceObject = (seed: AmbulanceScenario['ambulances'][number], at: IsoTimestamp): OperationalObject => ({
  id: seed.id,
  kind: 'mobile_entity',
  domain,
  label: seed.label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    position: {
      point: seed.position,
      headingDeg: 0,
      speedMps: 0,
      accuracyM: meters(8),
      observedAt: at,
      staleAfterMs: 5_000,
    },
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: 'available',
    priority: 'normal',
    mode: 'simulated',
  },
  alerts: [],
  communication: {
    state: 'connected',
    lastContactAt: at,
  },
  provenance: {
    source: 'simulator',
    adapterId,
    externalId: seed.id,
  },
  timestamps: {
    createdAt: at,
    updatedAt: at,
  },
  domainData: {
    type: 'ambulance',
    crewStatus: 'ready',
    equipment: [...seed.equipment],
  } satisfies AmbulanceDomainData,
})

const createIncidentObject = (seed: AmbulanceScenario['incidents'][number], at: IsoTimestamp): OperationalObject => ({
  id: seed.id,
  kind: 'incident',
  domain,
  label: seed.label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    position: {
      point: seed.position,
      accuracyM: meters(5),
      observedAt: at,
      staleAfterMs: 60_000,
    },
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: 'open',
    priority: seed.triage === 'red' ? 'critical' : seed.triage === 'yellow' ? 'high' : 'normal',
    mode: 'simulated',
  },
  telemetry: makeTelemetry(at, seed.triage === 'red' ? 122 : 98, seed.triage === 'red' ? 91 : 96),
  alerts: seed.triage === 'red'
    ? [{
        id: `${seed.id}:triage`,
        kind: 'triage_red',
        severity: 'critical',
        message: 'Red triage incident requires immediate dispatch',
        raisedAt: at,
        acknowledged: false,
      }]
    : [],
  provenance: {
    source: 'simulator',
    adapterId,
    externalId: seed.id,
  },
  timestamps: {
    createdAt: at,
    updatedAt: at,
  },
  domainData: {
    type: 'incident',
    triage: seed.triage,
    patientCount: seed.patientCount,
  } satisfies IncidentDomainData,
})

const createFacilityObject = (seed: AmbulanceScenario['facilities'][number], at: IsoTimestamp): OperationalObject => ({
  id: seed.id,
  kind: 'facility',
  domain,
  label: seed.label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    position: {
      point: seed.position,
      observedAt: at,
      staleAfterMs: 600_000,
    },
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: seed.facilityType,
    priority: 'normal',
    mode: 'simulated',
  },
  alerts: [],
  provenance: {
    source: 'simulator',
    adapterId,
    externalId: seed.id,
  },
  timestamps: {
    createdAt: at,
    updatedAt: at,
  },
  domainData: {
    type: seed.facilityType,
  },
})

const upsertEvent = (object: OperationalObject, at: IsoTimestamp): SimulationEvent => ({
  type: 'object.upserted',
  object,
  at,
  provenance: {
    source: 'simulator',
    adapterId,
    externalId: object.id,
  },
})

export const createAmbulanceSimEngine = (config: {
  readonly sessionId: SessionId
  readonly scenario: AmbulanceScenario
  readonly routing: RoutingAdapter
}): AmbulanceSimEngine => {
  const at = nowIso()
  const objects = new Map<ObjectId, OperationalObject>()
  for (const ambulance of config.scenario.ambulances) objects.set(ambulance.id, createAmbulanceObject(ambulance, at))
  for (const incident of config.scenario.incidents) objects.set(incident.id, createIncidentObject(incident, at))
  for (const facility of config.scenario.facilities) objects.set(facility.id, createFacilityObject(facility, at))
  const state: EngineState = {
    sessionId: config.sessionId,
    objects,
    motion: new Map(),
  }

  const snapshot = (): SimulationSnapshot => ({
    sessionId: state.sessionId,
    objects: [...state.objects.values()],
    capturedAt: nowIso(),
  })

  const tick = (dtMs: number): ReadonlyArray<SimulationEvent> => {
    const events: SimulationEvent[] = []
    const at2 = nowIso()
    for (const [ambulanceId, motion] of state.motion.entries()) {
      const ambulance = state.objects.get(ambulanceId)
      const target = state.objects.get(motion.targetObjectId)
      if (!ambulance || !target) {
        state.motion.delete(ambulanceId)
        continue
      }
      const currentPoint = getPoint(ambulance)
      const targetPoint = pointFromPosition(motion.route.coordinates[Math.min(motion.segmentIndex + 1, motion.route.coordinates.length - 1)] ?? getPoint(target).coordinates)
      const nextPoint = moveTowards(currentPoint, targetPoint, motion.metersPerSecond * dtMs / 1000)
      const remainingSegment = distanceMeters(nextPoint, targetPoint)
      const lastSegment = motion.segmentIndex >= motion.route.coordinates.length - 2
      const arrived = lastSegment && remainingSegment < 15
      const segmentIndex = !arrived && remainingSegment < 15 ? motion.segmentIndex + 1 : motion.segmentIndex
      const updated: OperationalObject = {
        ...ambulance,
        revision: ambulance.revision + 1,
        spatial: {
          ...ambulance.spatial,
          position: {
            point: nextPoint,
            headingDeg: bearingDeg(currentPoint, targetPoint),
            speedMps: arrived ? 0 : motion.metersPerSecond,
            accuracyM: meters(8),
            observedAt: at2,
            staleAfterMs: 5_000,
          },
        },
        operational: {
          ...ambulance.operational,
          status: arrived ? 'on_scene' : 'en_route',
          intent: arrived ? 'treat_patient' : 'respond_to_incident',
        },
        communication: {
          state: 'connected',
          lastContactAt: at2,
        },
        timestamps: {
          ...ambulance.timestamps,
          updatedAt: at2,
        },
      }
      state.objects.set(ambulanceId, updated)
      if (arrived) {
        state.motion.delete(ambulanceId)
      } else {
        state.motion.set(ambulanceId, { ...motion, segmentIndex })
      }
      events.push(upsertEvent(updated, at2))
    }
    return events
  }

  const handleCommand = async (command: CommandEnvelope): Promise<CommandResult> => {
    const at3 = nowIso()
    if (command.kind !== assignToIncidentCommandKind) {
      return { ok: false, commandId: command.id, rejectedAt: at3, reason: `unsupported command kind: ${command.kind}` }
    }
    const payload = assignToIncidentPayloadSchema.safeParse(command.payload)
    if (!payload.success) {
      return { ok: false, commandId: command.id, rejectedAt: at3, reason: payload.error.message }
    }
    const ambulance = state.objects.get(payload.data.ambulanceId)
    const incident = state.objects.get(payload.data.incidentId)
    if (!ambulance) return { ok: false, commandId: command.id, rejectedAt: at3, reason: `ambulance not found: ${payload.data.ambulanceId}` }
    if (!incident) return { ok: false, commandId: command.id, rejectedAt: at3, reason: `incident not found: ${payload.data.incidentId}` }
    if (ambulance.operational.status !== 'available') {
      return { ok: false, commandId: command.id, rejectedAt: at3, reason: `ambulance is not available: ${ambulance.operational.status}` }
    }

    let routeResult
    try {
      routeResult = await config.routing.route({
        from: getPoint(ambulance),
        to: getPoint(incident),
      })
    } catch (err) {
      return { ok: false, commandId: command.id, rejectedAt: at3, reason: `routing failed: ${err instanceof Error ? err.message : String(err)}` }
    }

    const updatedAmbulance: OperationalObject = {
      ...ambulance,
      revision: ambulance.revision + 1,
      operational: {
        ...ambulance.operational,
        status: 'assigned',
        intent: 'respond_to_incident',
      },
      spatial: {
        ...ambulance.spatial,
        route: {
          planned: routeResult.geometry,
          etaSeconds: routeResult.durationSeconds,
          source: routeResult.provider === 'osrm' ? 'simulator' : 'operator',
        },
      },
      tasking: {
        currentTaskId: payload.data.incidentId,
        assignedBy: command.actorId,
        assignedAt: at3,
      },
      provenance: {
        source: 'simulator',
        adapterId,
        externalId: ambulance.id,
        causedByCommandId: command.id,
      },
      timestamps: {
        ...ambulance.timestamps,
        updatedAt: at3,
      },
    }
    state.objects.set(updatedAmbulance.id, updatedAmbulance)

    const incidentData = incident.domainData as IncidentDomainData
    const updatedIncident: OperationalObject = {
      ...incident,
      revision: incident.revision + 1,
      operational: {
        ...incident.operational,
        status: 'assigned',
      },
      provenance: {
        source: 'simulator',
        adapterId,
        externalId: incident.id,
        causedByCommandId: command.id,
      },
      timestamps: {
        ...incident.timestamps,
        updatedAt: at3,
      },
      domainData: {
        ...incidentData,
        assignedAmbulanceId: updatedAmbulance.id,
      } satisfies IncidentDomainData,
    }
    state.objects.set(updatedIncident.id, updatedIncident)
    state.motion.set(updatedAmbulance.id, {
      targetObjectId: updatedIncident.id,
      metersPerSecond: 15,
      route: routeResult.geometry,
      segmentIndex: 0,
    })
    return { ok: true, commandId: command.id, acceptedAt: at3 }
  }

  return { snapshot, tick, handleCommand }
}
