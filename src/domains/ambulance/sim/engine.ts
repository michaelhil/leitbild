import { randomUUID } from 'node:crypto'
import type { CommandEnvelope, CommandResult, DomainEvent, GeoJsonLineString, GeoJsonPoint, InteractionSignal, IsoTimestamp, MotionProfileSet, ObjectId, OperationalObject, ControlInstanceId } from '../../../core/model/index.ts'
import { advanceAlongRoute, defaultMotionProfile, interactionSignalSchema, meters, motionProfileFor, nowIso, pointFromPosition, remainingDistanceAlongRoute, routeDistanceMeters } from '../../../core/model/index.ts'
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
import type { IncidentDomainData } from '../model.ts'
import type { AmbulanceScenario } from '../scenario.ts'
import { ambulanceSimAdapterId, ambulanceSimProviderId } from './constants.ts'
import { assetArrivedAtTargetSignalType } from './interactions.ts'
import {
  createAddedAmbulanceObject,
  createAddedIncidentObject,
  createAmbulanceObject,
  createFacilityObject,
  createHospitalObject,
  createIncidentObject,
  revealIncidentDetails,
  updateHospitalCapacity,
} from './object-state.ts'

interface AmbulanceMotion {
  readonly targetObjectId: ObjectId
  readonly motionProfileId: string
  readonly metersPerSecond: number
  readonly route: GeoJsonLineString
  readonly segmentIndex: number
}

interface EngineState {
  readonly controlInstanceId: ControlInstanceId
  readonly objectProjection: Map<ObjectId, OperationalObject>
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
  readonly observeCommittedEvents: (events: ReadonlyArray<DomainEvent>) => void
}

const defaultAmbulanceMotionProfileId = 'normal'

const ambulanceMotionProfiles: MotionProfileSet = {
  defaultProfileId: defaultAmbulanceMotionProfileId,
  profiles: [
    { id: 'normal', label: 'Normal response', metersPerSecond: 15 },
    { id: 'emergency', label: 'Emergency response', metersPerSecond: 22 },
    { id: 'slow', label: 'Congested traffic', metersPerSecond: 8 },
  ],
}

const getPoint = (object: OperationalObject): GeoJsonPoint => {
  const point = object.spatial.position?.point
  if (!point) {
    throw new Error(`object ${object.id} has no position`)
  }
  return point
}

const bearingDeg = (from: GeoJsonPoint, to: GeoJsonPoint): number => {
  const [fromLon, fromLat] = from.coordinates
  const [toLon, toLat] = to.coordinates
  const y = Math.sin((toLon - fromLon) * Math.PI / 180) * Math.cos(toLat * Math.PI / 180)
  const x = Math.cos(fromLat * Math.PI / 180) * Math.sin(toLat * Math.PI / 180)
    - Math.sin(fromLat * Math.PI / 180) * Math.cos(toLat * Math.PI / 180) * Math.cos((toLon - fromLon) * Math.PI / 180)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

const upsertEvent = (object: OperationalObject, at: IsoTimestamp): SimulationEvent => ({
  type: 'object.upserted',
  object,
  at,
  provenance: {
    source: 'simulator',
    adapterId: ambulanceSimAdapterId,
    externalId: object.id,
  },
})

const deleteEvent = (objectId: ObjectId, at: IsoTimestamp): SimulationEvent => ({
  type: 'object.deleted',
  objectId,
  at,
  provenance: {
    source: 'simulator',
    adapterId: ambulanceSimAdapterId,
    externalId: objectId,
  },
})

const arrivalSignalEvent = (
  controlInstanceId: ControlInstanceId,
  ambulance: OperationalObject,
  target: OperationalObject,
  at: IsoTimestamp,
  motion: AmbulanceMotion,
): SimulationEvent => {
  const signal = interactionSignalSchema.parse({
    id: `signal:${randomUUID()}`,
    controlInstanceId,
    at,
    source: { kind: 'object', id: ambulance.id, providerId: ambulanceSimProviderId },
    targets: [{ kind: 'object', id: target.id }],
    type: assetArrivedAtTargetSignalType,
    severity: 'notice',
    payload: {
      targetObjectId: target.id,
      motionProfileId: motion.motionProfileId,
      routeCompleted: true,
    },
  }) as InteractionSignal
  return {
    type: 'interaction.signal',
    signal,
    at,
    provenance: {
      source: 'simulator',
      adapterId: ambulanceSimAdapterId,
      externalId: ambulance.id,
    },
  }
}

const isHospital = (object: OperationalObject): boolean =>
  object.kind === 'facility'
  && typeof object.domainData === 'object'
  && object.domainData !== null
  && (object.domainData as { readonly type?: unknown }).type === 'hospital'

const isAmbulance = (object: OperationalObject): boolean =>
  object.kind === 'mobile_entity'
  && typeof object.domainData === 'object'
  && object.domainData !== null
  && (object.domainData as { readonly type?: unknown }).type === 'ambulance'

const isDestinationTarget = (object: OperationalObject): boolean =>
  object.kind === 'incident' || isHospital(object)

const nextNumberAfter = (objects: Iterable<OperationalObject>, prefix: string, fallback: number): number => {
  let highest = fallback - 1
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`)
  for (const object of objects) {
    const match = object.id.match(pattern)
    if (!match) continue
    const value = Number(match[1])
    if (Number.isInteger(value) && value > highest) highest = value
  }
  return highest + 1
}

const restoredMotionFor = (ambulance: OperationalObject, objects: ReadonlyMap<ObjectId, OperationalObject>): AmbulanceMotion | null => {
  if (!isAmbulance(ambulance)) return null
  if (ambulance.operational.status !== 'assigned' && ambulance.operational.status !== 'en_route') return null
  const targetObjectId = ambulance.tasking?.currentTaskId
  const route = ambulance.spatial.route?.planned
  if (!targetObjectId || !route || route.coordinates.length === 0) return null
  if (!objects.has(targetObjectId)) return null
  const currentPoint = getPoint(ambulance)
  let closestIndex = 0
  let closestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < route.coordinates.length; index++) {
    const distance = routeDistanceMeters(currentPoint, pointFromPosition(route.coordinates[index] ?? currentPoint.coordinates))
    if (distance < closestDistance) {
      closestDistance = distance
      closestIndex = index
    }
  }
  return {
    targetObjectId,
    motionProfileId: defaultMotionProfile(ambulanceMotionProfiles).id,
    metersPerSecond: defaultMotionProfile(ambulanceMotionProfiles).metersPerSecond,
    route,
    segmentIndex: Math.min(closestIndex + 1, route.coordinates.length - 1),
  }
}

const initialSegmentIndexFor = (currentPoint: GeoJsonPoint, route: GeoJsonLineString): number => {
  if (route.coordinates.length <= 1) return 0
  const firstPoint = pointFromPosition(route.coordinates[0] ?? currentPoint.coordinates)
  return routeDistanceMeters(currentPoint, firstPoint) < 2 ? 1 : 0
}

const routeSpeedFactor = (object: OperationalObject): number =>
  Math.min(1, ...((object.spatial.route?.impacts ?? [])
    .map(impact => impact.speedFactor ?? 1)
    .filter(factor => factor > 0)))

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
      adapterId: ambulanceSimAdapterId,
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
  readonly controlInstanceId: ControlInstanceId
  readonly scenario: AmbulanceScenario
  readonly routing: RoutingAdapter
  readonly initialObjects?: ReadonlyArray<OperationalObject>
}): AmbulanceSimEngine => {
  const at = nowIso()
  const objectProjection = new Map<ObjectId, OperationalObject>()
  if (config.initialObjects) {
    for (const object of config.initialObjects) objectProjection.set(object.id, object)
  } else {
    for (const ambulance of config.scenario.ambulances) objectProjection.set(ambulance.id, createAmbulanceObject(ambulance, at))
    for (const incident of config.scenario.incidents) objectProjection.set(incident.id, createIncidentObject(incident, at))
    for (const facility of config.scenario.facilities) objectProjection.set(facility.id, createFacilityObject(facility, at))
  }
  const motion = new Map<ObjectId, AmbulanceMotion>()
  for (const object of objectProjection.values()) {
    const restoredMotion = restoredMotionFor(object, objectProjection)
    if (restoredMotion) motion.set(object.id, restoredMotion)
  }
  const state: EngineState = {
    controlInstanceId: config.controlInstanceId,
    objectProjection,
    motion,
    elapsedMs: 0,
    nextAmbulanceNumber: nextNumberAfter(objectProjection.values(), 'amb:', config.scenario.ambulances.length + 1),
    nextHospitalNumber: nextNumberAfter(objectProjection.values(), 'facility:hospital-', config.scenario.facilities.filter(facility => facility.facilityType === 'hospital').length + 1),
    nextIncidentNumber: nextNumberAfter(objectProjection.values(), 'incident:', config.scenario.incidents.length + 1),
  }

  const snapshot = (): SimulationSnapshot => ({
    controlInstanceId: state.controlInstanceId,
    objects: [...state.objectProjection.values()],
    capturedAt: nowIso(),
  })

  const tick = (dtMs: number): ReadonlyArray<SimulationEvent> => {
    const events: SimulationEvent[] = []
    const at2 = nowIso()
    state.elapsedMs += dtMs
    if (state.elapsedMs >= 5_000) {
      for (const object of state.objectProjection.values()) {
        if (object.kind !== 'incident') continue
        const updated = revealIncidentDetails(object, at2)
        if (!updated) continue
        state.objectProjection.set(updated.id, updated)
        events.push(upsertEvent(updated, at2))
      }
    }
    if (state.elapsedMs >= 10_000) {
      for (const object of state.objectProjection.values()) {
        if (!isHospital(object)) continue
        const updated = updateHospitalCapacity(object, at2)
        if (!updated) continue
        state.objectProjection.set(updated.id, updated)
        events.push(upsertEvent(updated, at2))
      }
    }
    for (const [ambulanceId, motion] of state.motion.entries()) {
      const ambulance = state.objectProjection.get(ambulanceId)
      const target = state.objectProjection.get(motion.targetObjectId)
      if (!ambulance || !target) {
        state.motion.delete(ambulanceId)
        continue
      }
      const currentRoute = ambulance.spatial.route
      if (!currentRoute) {
        state.motion.delete(ambulanceId)
        continue
      }
      const currentPoint = getPoint(ambulance)
      const finalPoint = pointFromPosition(motion.route.coordinates[motion.route.coordinates.length - 1] ?? getPoint(target).coordinates)
      const routeAdvance = advanceAlongRoute({
        currentPoint,
        route: motion.route,
        segmentIndex: motion.segmentIndex,
        metersToMove: motion.metersPerSecond * routeSpeedFactor(ambulance) * dtMs / 1000,
      })
      const nextPoint = routeAdvance.point
      const arrived = routeDistanceMeters(nextPoint, finalPoint) < 15
      const segmentIndex = arrived ? motion.segmentIndex : routeAdvance.segmentIndex
      const remainingDistanceM = remainingDistanceAlongRoute(motion.route, nextPoint, segmentIndex)
      const effectiveSpeedMps = motion.metersPerSecond * routeSpeedFactor(ambulance)
      const etaSeconds = arrived ? 0 : Math.ceil(remainingDistanceM / effectiveSpeedMps)
      const moving: OperationalObject = {
        ...ambulance,
        revision: ambulance.revision + 1,
        spatial: {
          ...ambulance.spatial,
          route: {
            ...currentRoute,
            etaSeconds,
            progress: {
              segmentIndex,
              remainingDistanceM,
              advancedDistanceM: routeAdvance.advancedDistanceM,
              updatedAt: at2,
            },
          },
          position: {
            point: nextPoint,
            headingDeg: bearingDeg(currentPoint, routeAdvance.headingTarget),
            speedMps: arrived ? 0 : effectiveSpeedMps,
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
      if (arrived) {
        state.motion.delete(ambulanceId)
        const stopped = stopAmbulance(moving, at2, target.kind === 'incident' ? 'on_scene' : 'available')
        state.objectProjection.set(stopped.id, stopped)
        events.push(upsertEvent(stopped, at2))
        events.push(arrivalSignalEvent(state.controlInstanceId, stopped, target, at2, motion))
      } else {
        state.objectProjection.set(ambulanceId, moving)
        state.motion.set(ambulanceId, { ...motion, segmentIndex })
        events.push(upsertEvent(moving, at2))
      }
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
      state.objectProjection.set(object.id, object)
      return { ok: true, commandId: command.id, acceptedAt: at3 }
    }

    if (command.kind === cancelDestinationCommandKind) {
      const payload = cancelDestinationPayloadSchema.safeParse(command.payload)
      if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: at3, reason: payload.error.message }
      const ambulance = state.objectProjection.get(payload.data.ambulanceId)
      if (!ambulance) return { ok: false, commandId: command.id, rejectedAt: at3, reason: `ambulance not found: ${payload.data.ambulanceId}` }
      if (ambulance.kind !== 'mobile_entity') return { ok: false, commandId: command.id, rejectedAt: at3, reason: `${payload.data.ambulanceId} is not an ambulance` }
      state.motion.delete(payload.data.ambulanceId)
      state.objectProjection.set(ambulance.id, stopAmbulance(ambulance, at3, 'available', command.id))
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
    const ambulance = state.objectProjection.get(ambulanceId)
    const incident = state.objectProjection.get(destinationId)
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
        adapterId: ambulanceSimAdapterId,
        externalId: ambulance.id,
        causedByCommandId: command.id,
      },
      timestamps: {
        ...ambulance.timestamps,
        updatedAt: at3,
      },
    }
    state.objectProjection.set(updatedAmbulance.id, updatedAmbulance)

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
            adapterId: ambulanceSimAdapterId,
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
    state.objectProjection.set(updatedIncident.id, updatedIncident)
    const motionProfile = motionProfileFor(ambulanceMotionProfiles, defaultAmbulanceMotionProfileId)
    state.motion.set(updatedAmbulance.id, {
      targetObjectId: updatedIncident.id,
      motionProfileId: motionProfile.id,
      metersPerSecond: motionProfile.metersPerSecond,
      route: routeResult.geometry,
      segmentIndex: initialSegmentIndexFor(getPoint(updatedAmbulance), routeResult.geometry),
    })
    return { ok: true, commandId: command.id, acceptedAt: at3 }
  }

  const observeCommittedEvents = (events: ReadonlyArray<DomainEvent>): void => {
    for (const event of events) {
      if (event.type === 'object.upserted') {
        state.objectProjection.set(event.object.id, event.object)
      }
      if (event.type === 'object.deleted') {
        state.objectProjection.delete(event.objectId)
        state.motion.delete(event.objectId)
      }
    }
  }

  return { snapshot, tick, handleCommand, observeCommittedEvents }
}
