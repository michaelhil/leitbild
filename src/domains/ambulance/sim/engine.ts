import type { AdapterId, CommandEnvelope, CommandResult, DomainId, GeoJsonLineString, GeoJsonPoint, GeoJsonPosition2D, IsoTimestamp, ObjectId, OperationalObject, SessionId, TelemetryState } from '../../../core/model/index.ts'
import { confirmedFact, estimatedFact, geoPointFromLonLat, meters, nowIso, unknownFact } from '../../../core/model/index.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import type { SimulationEvent, SimulationSnapshot } from '../../../simulation/protocol.ts'
import {
  assignToIncidentCommandKind,
  assignToIncidentPayloadSchema,
  cancelDestinationCommandKind,
  cancelDestinationPayloadSchema,
  createObjectCommandKind,
  createObjectPayloadSchema,
  setDestinationCommandKind,
  setDestinationPayloadSchema,
} from '../commands.ts'
import { ambulanceDomainId, type AmbulanceDomainData, type HospitalDomainData, type IncidentDomainData, type InjurySummary } from '../model.ts'
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
  elapsedMs: number
  nextAmbulanceNumber: number
  nextHospitalNumber: number
  nextIncidentNumber: number
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

const makeAmbulanceDomainData = (equipment: ReadonlyArray<string>, at: IsoTimestamp): AmbulanceDomainData => ({
  type: 'ambulance',
  schemaVersion: 1,
  capabilities: [
    'advanced_life_support',
    'oxygen',
    'stretcher',
    ...(equipment.includes('defibrillator') ? ['defibrillator' as const] : []),
    ...(equipment.includes('ventilator') ? ['ventilator' as const] : []),
  ],
  crew: {
    status: 'ready',
    level: confirmedFact('advanced', at, 'scenario', 1),
    availableSeats: confirmedFact(1, at, 'scenario', 1),
  },
})

const makeIncidentDomainData = (triage: 'green' | 'yellow' | 'red', at: IsoTimestamp, assignedAmbulanceId?: ObjectId): IncidentDomainData => ({
  type: 'incident',
  schemaVersion: 1,
  triage: confirmedFact(triage, at, 'scenario', 1),
  victims: {
    count: unknownFact(at, 'scenario'),
    injuries: unknownFact(at, 'scenario'),
    entrapment: unknownFact(at, 'scenario'),
  },
  hazards: unknownFact(at, 'scenario'),
  ...(assignedAmbulanceId ? { assignedAmbulanceId } : {}),
})

const makeHospitalDomainData = (at: IsoTimestamp): HospitalDomainData => ({
  type: 'hospital',
  schemaVersion: 1,
  emergencyDepartment: {
    traumaBedsAvailable: confirmedFact(3, at, 'scenario', 1),
    ambulanceBaysAvailable: confirmedFact(2, at, 'scenario', 1),
    diversionStatus: confirmedFact('open', at, 'scenario', 1),
  },
  capabilities: ['trauma_center', 'stroke_unit', 'cardiac_catheterization'],
})

const makeEstimatedInjuries = (): InjurySummary[] => [
  { category: 'trauma', severity: 'critical', count: 1 },
  { category: 'respiratory', severity: 'serious', count: 1 },
]

const incidentDataOf = (object: OperationalObject): IncidentDomainData | null => {
  const data = object.domainData
  return typeof data === 'object'
    && data !== null
    && (data as { readonly type?: unknown }).type === 'incident'
    && (data as { readonly schemaVersion?: unknown }).schemaVersion === 1
    ? data as IncidentDomainData
    : null
}

const hospitalDataOf = (object: OperationalObject): HospitalDomainData | null => {
  const data = object.domainData
  return typeof data === 'object'
    && data !== null
    && (data as { readonly type?: unknown }).type === 'hospital'
    && (data as { readonly schemaVersion?: unknown }).schemaVersion === 1
    ? data as HospitalDomainData
    : null
}

const revealIncidentDetails = (object: OperationalObject, at: IsoTimestamp): OperationalObject | null => {
  const data = incidentDataOf(object)
  if (!data || data.victims.count.state !== 'unknown') return null
  return {
    ...object,
    revision: object.revision + 1,
    domainData: {
      ...data,
      victims: {
        count: estimatedFact(2, at, 'simulation', 0.72),
        injuries: estimatedFact(makeEstimatedInjuries(), at, 'simulation', 0.68),
        entrapment: estimatedFact(false, at, 'simulation', 0.61),
      },
      hazards: estimatedFact(['traffic obstruction', 'possible fuel spill'], at, 'simulation', 0.55),
    } satisfies IncidentDomainData,
    provenance: {
      source: 'simulator',
      adapterId,
      externalId: object.id,
    },
    timestamps: {
      ...object.timestamps,
      updatedAt: at,
    },
  }
}

const updateHospitalCapacity = (object: OperationalObject, at: IsoTimestamp): OperationalObject | null => {
  const data = hospitalDataOf(object)
  if (!data || data.emergencyDepartment.ambulanceBaysAvailable.state !== 'confirmed') return null
  if (data.emergencyDepartment.ambulanceBaysAvailable.value === 1) return null
  return {
    ...object,
    revision: object.revision + 1,
    domainData: {
      ...data,
      emergencyDepartment: {
        ...data.emergencyDepartment,
        ambulanceBaysAvailable: confirmedFact(1, at, 'simulation', 1),
        diversionStatus: confirmedFact('limited', at, 'simulation', 1),
      },
    } satisfies HospitalDomainData,
    provenance: {
      source: 'simulator',
      adapterId,
      externalId: object.id,
    },
    timestamps: {
      ...object.timestamps,
      updatedAt: at,
    },
  }
}

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
    ...makeAmbulanceDomainData(seed.equipment, at),
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
    ...makeIncidentDomainData(seed.triage, at),
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
    ...makeHospitalDomainData(at),
  } satisfies HospitalDomainData,
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

const isHospital = (object: OperationalObject): boolean =>
  object.kind === 'facility'
  && typeof object.domainData === 'object'
  && object.domainData !== null
  && (object.domainData as { readonly type?: unknown }).type === 'hospital'

const isDestinationTarget = (object: OperationalObject): boolean =>
  object.kind === 'incident' || isHospital(object)

const createHospitalObject = (id: ObjectId, label: string, point: GeoJsonPoint, at: IsoTimestamp, causedByCommandId: CommandEnvelope['id']): OperationalObject => ({
  id,
  kind: 'facility',
  domain,
  label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    position: {
      point,
      observedAt: at,
      staleAfterMs: 600_000,
    },
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: 'hospital',
    priority: 'normal',
    mode: 'simulated',
  },
  alerts: [],
  provenance: {
    source: 'operator',
    adapterId,
    externalId: id,
    causedByCommandId,
  },
  timestamps: {
    createdAt: at,
    updatedAt: at,
  },
  domainData: {
    ...makeHospitalDomainData(at),
  } satisfies HospitalDomainData,
})

const createAddedAmbulanceObject = (id: ObjectId, label: string, point: GeoJsonPoint, at: IsoTimestamp, causedByCommandId: CommandEnvelope['id']): OperationalObject => ({
  id,
  kind: 'mobile_entity',
  domain,
  label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    position: {
      point,
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
    source: 'operator',
    adapterId,
    externalId: id,
    causedByCommandId,
  },
  timestamps: {
    createdAt: at,
    updatedAt: at,
  },
  domainData: {
    ...makeAmbulanceDomainData(['defibrillator', 'oxygen', 'stretcher'], at),
  } satisfies AmbulanceDomainData,
})

const createAddedIncidentObject = (id: ObjectId, label: string, point: GeoJsonPoint, at: IsoTimestamp, causedByCommandId: CommandEnvelope['id']): OperationalObject => ({
  id,
  kind: 'incident',
  domain,
  label,
  lifecycle: 'active',
  revision: 0,
  spatial: {
    position: {
      point,
      accuracyM: meters(5),
      observedAt: at,
      staleAfterMs: 60_000,
    },
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: 'open',
    priority: 'critical',
    mode: 'simulated',
  },
  telemetry: makeTelemetry(at, 122, 91),
  alerts: [{
    id: `${id}:triage`,
    kind: 'triage_red',
    severity: 'critical',
    message: 'Red triage incident requires immediate dispatch',
    raisedAt: at,
    acknowledged: false,
  }],
  provenance: {
    source: 'operator',
    adapterId,
    externalId: id,
    causedByCommandId,
  },
  timestamps: {
    createdAt: at,
    updatedAt: at,
  },
  domainData: {
    ...makeIncidentDomainData('red', at),
  } satisfies IncidentDomainData,
})

const stopAmbulance = (ambulance: OperationalObject, at: IsoTimestamp, status: string, causedByCommandId?: CommandEnvelope['id']): OperationalObject => {
  const { route: _route, ...spatialWithoutRoute } = ambulance.spatial
  const { intent: _intent, ...operationalWithoutIntent } = ambulance.operational
  const { tasking: _tasking, ...ambulanceWithoutTasking } = ambulance

  return {
    ...ambulanceWithoutTasking,
    revision: ambulance.revision + 1,
    spatial: {
      ...spatialWithoutRoute,
      ...(ambulance.spatial.position
        ? {
            position: {
              ...ambulance.spatial.position,
              speedMps: 0,
              observedAt: at,
            },
          }
        : {}),
    },
    operational: {
      ...operationalWithoutIntent,
      status,
    },
    provenance: {
      source: causedByCommandId ? 'operator' : 'simulator',
      adapterId,
      externalId: ambulance.id,
      ...(causedByCommandId ? { causedByCommandId } : {}),
    },
    timestamps: {
      ...ambulance.timestamps,
      updatedAt: at,
    },
  }
}

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
    elapsedMs: 0,
    nextAmbulanceNumber: config.scenario.ambulances.length + 1,
    nextHospitalNumber: config.scenario.facilities.filter(facility => facility.facilityType === 'hospital').length + 1,
    nextIncidentNumber: config.scenario.incidents.length + 1,
  }

  const snapshot = (): SimulationSnapshot => ({
    sessionId: state.sessionId,
    objects: [...state.objects.values()],
    capturedAt: nowIso(),
  })

  const tick = (dtMs: number): ReadonlyArray<SimulationEvent> => {
    const events: SimulationEvent[] = []
    const at2 = nowIso()
    state.elapsedMs += dtMs
    if (state.elapsedMs >= 5_000) {
      for (const object of state.objects.values()) {
        if (object.kind !== 'incident') continue
        const updated = revealIncidentDetails(object, at2)
        if (!updated) continue
        state.objects.set(updated.id, updated)
        events.push(upsertEvent(updated, at2))
      }
    }
    if (state.elapsedMs >= 10_000) {
      for (const object of state.objects.values()) {
        if (!isHospital(object)) continue
        const updated = updateHospitalCapacity(object, at2)
        if (!updated) continue
        state.objects.set(updated.id, updated)
        events.push(upsertEvent(updated, at2))
      }
    }
    for (const [ambulanceId, motion] of state.motion.entries()) {
      const ambulance = state.objects.get(ambulanceId)
      const target = state.objects.get(motion.targetObjectId)
      if (!ambulance || !target) {
        state.motion.delete(ambulanceId)
        continue
      }
      const currentPoint = getPoint(ambulance)
      const targetIndex = Math.min(motion.segmentIndex, motion.route.coordinates.length - 1)
      const targetPoint = pointFromPosition(motion.route.coordinates[targetIndex] ?? getPoint(target).coordinates)
      const finalPoint = pointFromPosition(motion.route.coordinates[motion.route.coordinates.length - 1] ?? getPoint(target).coordinates)
      const nextPoint = moveTowards(currentPoint, targetPoint, motion.metersPerSecond * dtMs / 1000)
      const remainingSegment = distanceMeters(nextPoint, targetPoint)
      const arrived = distanceMeters(nextPoint, finalPoint) < 15
      const segmentIndex = !arrived && remainingSegment < 15
        ? Math.min(motion.segmentIndex + 1, motion.route.coordinates.length - 1)
        : motion.segmentIndex
      const moving: OperationalObject = {
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
      const updated = arrived
        ? stopAmbulance(moving, at2, target.kind === 'incident' ? 'on_scene' : 'available')
        : moving
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
    if (command.kind === createObjectCommandKind) {
      const payload = createObjectPayloadSchema.safeParse(command.payload)
      if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: at3, reason: payload.error.message }
      const object = payload.data.objectType === 'hospital'
        ? createHospitalObject(`facility:hospital-${state.nextHospitalNumber++}` as ObjectId, payload.data.label, payload.data.point, at3, command.id)
        : payload.data.objectType === 'ambulance'
          ? createAddedAmbulanceObject(`amb:${state.nextAmbulanceNumber++}` as ObjectId, payload.data.label, payload.data.point, at3, command.id)
          : createAddedIncidentObject(`incident:${state.nextIncidentNumber++}` as ObjectId, payload.data.label, payload.data.point, at3, command.id)
      state.objects.set(object.id, object)
      return { ok: true, commandId: command.id, acceptedAt: at3 }
    }

    if (command.kind === cancelDestinationCommandKind) {
      const payload = cancelDestinationPayloadSchema.safeParse(command.payload)
      if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: at3, reason: payload.error.message }
      const ambulance = state.objects.get(payload.data.ambulanceId)
      if (!ambulance) return { ok: false, commandId: command.id, rejectedAt: at3, reason: `ambulance not found: ${payload.data.ambulanceId}` }
      if (ambulance.kind !== 'mobile_entity') return { ok: false, commandId: command.id, rejectedAt: at3, reason: `${payload.data.ambulanceId} is not an ambulance` }
      state.motion.delete(payload.data.ambulanceId)
      state.objects.set(ambulance.id, stopAmbulance(ambulance, at3, 'available', command.id))
      return { ok: true, commandId: command.id, acceptedAt: at3 }
    }

    if (command.kind !== assignToIncidentCommandKind && command.kind !== setDestinationCommandKind) {
      return { ok: false, commandId: command.id, rejectedAt: at3, reason: `unsupported command kind: ${command.kind}` }
    }

    const payload = command.kind === assignToIncidentCommandKind
      ? assignToIncidentPayloadSchema.safeParse(command.payload)
      : setDestinationPayloadSchema.safeParse(command.payload)
    if (!payload.success) {
      return { ok: false, commandId: command.id, rejectedAt: at3, reason: payload.error.message }
    }
    const ambulanceId = payload.data.ambulanceId
    const destinationId = 'incidentId' in payload.data ? payload.data.incidentId : payload.data.destinationId
    const ambulance = state.objects.get(ambulanceId)
    const incident = state.objects.get(destinationId)
    if (!ambulance) return { ok: false, commandId: command.id, rejectedAt: at3, reason: `ambulance not found: ${payload.data.ambulanceId}` }
    if (ambulance.kind !== 'mobile_entity') return { ok: false, commandId: command.id, rejectedAt: at3, reason: `${ambulanceId} is not an ambulance` }
    if (!incident) return { ok: false, commandId: command.id, rejectedAt: at3, reason: `destination not found: ${destinationId}` }
    if (!isDestinationTarget(incident)) return { ok: false, commandId: command.id, rejectedAt: at3, reason: `destination must be an incident or hospital: ${destinationId}` }

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
        currentTaskId: destinationId,
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

    const updatedIncident: OperationalObject = incident.kind === 'incident'
      ? {
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
            ...(incident.domainData as IncidentDomainData),
            assignedAmbulanceId: updatedAmbulance.id,
          } satisfies IncidentDomainData,
        }
      : incident
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
