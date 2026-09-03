import type { CommandEnvelope, CommandResult, GeoJsonPoint, ObjectId, OperationalObject, RouteImpact, SimulationRunEvent, SimulationRunId } from '../../../core/model/index.ts'
import { geoPointFromLonLat, meters, nowIso, routeDistanceMeters } from '../../../core/model/index.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import type { PackRuntimeEvent, PackRuntimeSnapshot } from '../../../simulation/protocol.ts'
import * as commands from '../commands.ts'
import {
  ambulancePackId, careSitePackDataSchema,
  cancelEligibility, destinationEligibility, dispatchEligibility, noTransportEligibility, patientObjects,
  preparedRouteSchema, returnToBaseEligibility, transportEligibility, unitPatients,
  type AmbulanceAssignment, type AmbulanceDomainData, type PatientPackData, type PreparedRoute,
} from '../model.ts'
import { ambulanceSimAdapterId } from './constants.ts'
import { createAmbulanceItem, validateAmbulanceDeletion, validateAmbulanceObject, validateAmbulanceObjects } from './object-state.ts'

export interface AmbulanceEngineCheckpoint { readonly simulationTimeMs: number }
export interface AmbulanceCommandOutcome { readonly result: CommandResult; readonly events: readonly PackRuntimeEvent[] }
export interface AmbulanceSimEngine {
  readonly snapshot: () => PackRuntimeSnapshot
  readonly checkpoint: () => AmbulanceEngineCheckpoint
  readonly advanceTo: (simulationTimeMs: number) => readonly PackRuntimeEvent[]
  readonly handleCommand: (command: CommandEnvelope) => Promise<AmbulanceCommandOutcome>
  readonly observeCommittedEvents: (events: readonly SimulationRunEvent[]) => void
  readonly validateDeletion: (objectId: string) => void
  readonly setRoadWeatherImpact: (objectId: ObjectId, impact: RouteImpact | undefined) => PackRuntimeEvent | undefined
}

const pointOf = (object: OperationalObject): GeoJsonPoint => {
  if (!object.spatial.position?.point) throw new Error(`${object.id} has no canonical point`)
  return object.spatial.position.point
}
const routeDistances = new WeakMap<PreparedRoute['geometry'], Float64Array>()
const cumulativeDistances = (route: PreparedRoute['geometry']): Float64Array => {
  const cached = routeDistances.get(route)
  if (cached) return cached
  const distances = new Float64Array(route.coordinates.length)
  for (let i = 1; i < distances.length; i++) distances[i] = distances[i - 1]! + routeDistanceMeters(geoPointFromLonLat(...route.coordinates[i - 1]!), geoPointFromLonLat(...route.coordinates[i]!))
  routeDistances.set(route, distances)
  return distances
}
const geometricLength = (route: PreparedRoute['geometry']): number => cumulativeDistances(route).at(-1) ?? 0
const routePosition = (route: PreparedRoute, progressMs: number): { point: GeoJsonPoint; segmentIndex: number } => {
  const coordinates = route.geometry.coordinates
  const distances = cumulativeDistances(route.geometry)
  const target = geometricLength(route.geometry) * (route.durationMs === 0 ? 1 : Math.min(1, progressMs / route.durationMs))
  let lower = 1, upper = coordinates.length - 1
  while (lower < upper) { const middle = Math.floor((lower + upper) / 2); if (distances[middle]! < target) lower = middle + 1; else upper = middle }
  const a = coordinates[lower - 1]!, b = coordinates[lower]!
  const distance = distances[lower]! - distances[lower - 1]!
  const fraction = distance > 0 ? (target - distances[lower - 1]!) / distance : 1
  return { point: geoPointFromLonLat(a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction), segmentIndex: lower }
}
const moving = (assignment: AmbulanceAssignment): boolean => ['responding', 'transporting', 'returning'].includes(assignment.phase)
const speedFactor = (object: OperationalObject): number => Math.min(1, ...(object.spatial.route?.impacts ?? []).map(impact => impact.speedFactor ?? 1))
const assertEligible = (reasons: readonly string[]): void => { if (reasons.length) throw new Error(reasons.join('; ')) }
// Objects enter through validated boundaries and transitions replace data
// immutably. Numerical reads must not repeatedly parse/clone road geometries.
const ownedData = (object: OperationalObject): AmbulanceDomainData => object.packData as AmbulanceDomainData
const dataOfType = <T extends AmbulanceDomainData['type']>(object: OperationalObject, type: T): Extract<AmbulanceDomainData, { type: T }> => {
  const data = ownedData(object)
  if (data.type !== type) throw new Error(`${object.id}: expected ${type}`)
  return data as Extract<AmbulanceDomainData, { type: T }>
}

/** Mechanics are committed into canonical owned objects, including exact route
 * progress and simulation-time deadlines. The only additional checkpoint is the
 * time through which these objects have been advanced. */
export const createAmbulanceSimEngine = (config: {
  readonly simulationRunId: SimulationRunId
  readonly objects: readonly OperationalObject[]
  readonly routing: RoutingAdapter
  readonly simulationTimeMs: number
  readonly objectById?: (id: ObjectId) => OperationalObject | undefined
}): AmbulanceSimEngine => {
  if (!Number.isFinite(config.simulationTimeMs) || config.simulationTimeMs < 0) throw new Error('Invalid engine simulation time')
  validateAmbulanceObjects(config.objects)
  let objects = new Map(config.objects.filter(object => object.packId === ambulancePackId).map(object => [object.id, structuredClone(object)]))
  let simulationTimeMs = config.simulationTimeMs
  const all = (): OperationalObject[] => [...objects.values()]
  const requireObject = (id: ObjectId): OperationalObject => {
    const object = objects.get(id)
    if (!object) throw new Error(`Ambulance object not found: ${id}`)
    return object
  }
  const requirePatient = (id: ObjectId): OperationalObject => {
    const object = requireObject(id)
    dataOfType(object, 'patient')
    return object
  }

  const prepareRoute = async (from: GeoJsonPoint, to: GeoJsonPoint): Promise<PreparedRoute> => {
    const route = await config.routing.route({ from, to })
    const prepared = preparedRouteSchema.parse({ geometry: route.geometry, durationMs: route.durationSeconds * 1000, distanceM: route.distanceM, provider: route.provider })
    if (prepared.durationMs <= 0 && geometricLength(prepared.geometry) > 0.01) throw new Error('Routing returned nonzero geometry without travel time')
    // Reject egregious snapping instead of teleporting to an unrelated road.
    const first = geoPointFromLonLat(...prepared.geometry.coordinates[0]!)
    const last = geoPointFromLonLat(...prepared.geometry.coordinates.at(-1)!)
    if (routeDistanceMeters(first, from) > 1_000 || routeDistanceMeters(last, to) > 1_000) throw new Error('Route endpoint is more than 1 km from the requested location')
    return prepared
  }

  const watch = (ids: readonly ObjectId[]): (() => void) => {
    const watched = ids.map(id => ({ id, object: objects.get(id), canonical: config.objectById?.(id) }))
    return () => {
      for (const entry of watched) {
        if (objects.get(entry.id) !== entry.object) throw new Error(`State changed while preparing route: ${entry.id}; retry`)
        if (config.objectById && entry.canonical) {
          const current = config.objectById(entry.id)
          if (!current || current.revision !== entry.canonical.revision) throw new Error(`Canonical object changed while preparing route: ${entry.id}; retry`)
        }
      }
    }
  }

  const transaction = (work: (tx: ReturnType<typeof createTransaction>) => void, targetTime = simulationTimeMs, commandId?: CommandEnvelope['id']): readonly PackRuntimeEvent[] => {
    const tx = createTransaction(targetTime, commandId)
    work(tx)
    tx.finish()
    validateAmbulanceObjects([...tx.draft.values()])
    objects = tx.draft
    simulationTimeMs = targetTime
    return tx.events
  }

  function createTransaction(targetTime: number, commandId?: CommandEnvelope['id']) {
    const draft = new Map(objects)
    const events: PackRuntimeEvent[] = []
    const motionDirty = new Set<ObjectId>()
    const at = nowIso()
    let time = simulationTimeMs
    const values = () => [...draft.values()]
    const get = (id: ObjectId): OperationalObject => {
      const object = draft.get(id)
      if (!object) throw new Error(`Object not found: ${id}`)
      return object
    }
    const emitObject = (object: OperationalObject, record: boolean) => {
      events.push({ type: 'object.upserted', object, at, history: record ? 'record' : 'snapshot-only', provenance: object.provenance })
    }
    const put = (object: OperationalObject, data: AmbulanceDomainData, record = true, point?: GeoJsonPoint): OperationalObject => {
      let spatial = object.spatial
      let status: string
      let tasking: OperationalObject['tasking']
      if (data.type === 'ambulance') {
        const assignment = data.assignment
        status = assignment?.phase ?? (data.crewReady ? 'available' : 'out-of-service')
        const { route: _, ...rest } = spatial
        const position = point ?? pointOf(object)
        const leg = assignment?.leg
        const factor = speedFactor(object)
        const active = assignment && moving(assignment)
        spatial = { ...rest, position: { point: position, observedAt: at, speedMps: active && leg && leg.durationMs > 0 ? leg.distanceM / (leg.durationMs / 1000) * factor : 0 }, ...(leg ? { route: { planned: leg.geometry, source: 'simulator' as const, ...(factor > 0 ? { etaSeconds: (leg.durationMs - leg.progressMs) / 1000 / factor } : {}), progress: { segmentIndex: routePosition(leg, leg.progressMs).segmentIndex, remainingDistanceM: meters(leg.distanceM * (leg.durationMs === 0 ? 0 : 1 - leg.progressMs / leg.durationMs)), updatedAt: at }, ...(object.spatial.route?.impacts ? { impacts: object.spatial.route.impacts } : {}) } } : {}) }
        const target = ['transporting', 'queued', 'handover'].includes(assignment?.phase ?? '') ? assignment?.destinationId : assignment?.incidentId
        if (target) tasking = { currentTaskId: target }
      } else if (data.type === 'incident') status = data.closedAtMs === undefined ? data.firstArrivalAtMs === undefined ? 'open' : 'responding' : 'resolved'
      else if (data.type === 'care-site') status = data.accepting ? 'accepting' : 'not-accepting'
      else status = data.disposition === 'active' ? data.holder.kind === 'incident' ? 'awaiting-response' : 'in-ambulance' : data.disposition
      const { tasking: _, ...base } = object
      const updated: OperationalObject = { ...base, revision: object.revision + 1, spatial, packData: data, operational: { ...object.operational, status }, lifecycle: data.type === 'incident' && data.closedAtMs !== undefined || data.type === 'patient' && data.disposition !== 'active' ? 'resolved' : 'active', ...(tasking ? { tasking } : {}), provenance: { source: commandId ? 'operator' : 'simulator', adapterId: ambulanceSimAdapterId, externalId: object.id, ...(commandId ? { causedByCommandId: commandId } : {}) }, timestamps: { ...object.timestamps, updatedAt: at } }
      draft.set(updated.id, updated)
      if (record) { motionDirty.delete(updated.id); emitObject(updated, true) } else motionDirty.add(updated.id)
      return updated
    }
    const setUnit = (id: ObjectId, assignment: AmbulanceAssignment | undefined, record = true, point?: GeoJsonPoint) => {
      const unit = get(id)
      const { assignment: _, ...data } = dataOfType(unit, 'ambulance')
      return put(unit, { ...data, ...(assignment ? { assignment } : {}) }, record, point)
    }
    const setPatient = (id: ObjectId, update: Partial<PatientPackData>) => {
      const patient = get(id)
      return put(patient, { ...dataOfType(patient, 'patient'), ...update })
    }
    const closeIncidents = () => {
      const patients = patientObjects(values())
      for (const object of values()) {
        const data = ownedData(object)
        if (data.type !== 'incident') continue
        const members = patients.filter(patient => dataOfType(patient, 'patient').incidentId === object.id)
        const closed = members.length > 0 && members.every(patient => dataOfType(patient, 'patient').disposition !== 'active')
        if (closed && data.closedAtMs === undefined) put(object, { ...data, closedAtMs: time })
        if (!closed && data.closedAtMs !== undefined) { const { closedAtMs: _, ...open } = data; put(object, open) }
      }
    }
    const startQueues = (): boolean => {
      let changed = false
      for (const site of values()) {
        const siteData = ownedData(site)
        if (siteData.type !== 'care-site' || !siteData.accepting) continue
        const units = values().filter(object => ownedData(object).type === 'ambulance')
        const serving = units.filter(unit => { const a = dataOfType(unit, 'ambulance').assignment; return a?.phase === 'handover' && a.destinationId === site.id }).length
        const queue = units.filter(unit => { const a = dataOfType(unit, 'ambulance').assignment; return a?.phase === 'queued' && a.destinationId === site.id }).sort((a, b) => dataOfType(a, 'ambulance').assignment!.phaseStartedAtMs - dataOfType(b, 'ambulance').assignment!.phaseStartedAtMs || a.id.localeCompare(b.id))
        let free = Math.max(0, siteData.handoverSlots - serving)
        for (const unit of queue) {
          const a = dataOfType(get(unit.id), 'ambulance').assignment!
          const patients = a.patientIds.map(get)
          if (destinationEligibility(site, patients).length) continue
          if (free-- <= 0) break
          setUnit(unit.id, { ...a, phase: 'handover', phaseStartedAtMs: time, phaseDueAtMs: time + siteData.handoverSeconds * 1000 })
          a.patientIds.forEach(id => setPatient(id, { handoverStartedAtMs: time }))
          changed = true
        }
      }
      return changed
    }
    const finishScene = (unit: OperationalObject, a: AmbulanceAssignment) => {
      a.patientIds.forEach(id => setPatient(id, { holder: { kind: 'ambulance', id: unit.id }, pickedUpAtMs: time }))
      const { phaseDueAtMs: _, leg: _leg, onwardRoute, ...rest } = a
      if (onwardRoute && a.destinationId && destinationEligibility(draft.get(a.destinationId), a.patientIds.map(get)).length === 0) setUnit(unit.id, { ...rest, phase: 'transporting', phaseStartedAtMs: time, leg: { ...onwardRoute, progressMs: 0 } })
      else {
        const { destinationId: _, ...withoutDestination } = rest
        setUnit(unit.id, { ...withoutDestination, phase: 'ready-for-transport', phaseStartedAtMs: time })
      }
    }
    const boundaries = (): boolean => {
      let changed = false
      for (const initial of values()) {
        const unit = get(initial.id)
        const data = ownedData(unit)
        if (data.type !== 'ambulance' || !data.assignment) continue
        const a = data.assignment
        if (a.phase === 'mobilizing' && a.phaseDueAtMs! <= time) {
          const { phaseDueAtMs: _, ...rest } = a
          setUnit(unit.id, { ...rest, phase: 'responding', phaseStartedAtMs: time })
          a.patientIds.forEach(id => { if (dataOfType(get(id), 'patient').departedAtMs === undefined) setPatient(id, { departedAtMs: time }) })
        } else if (a.phase === 'on-scene' && a.phaseDueAtMs! <= time) finishScene(unit, a)
        else if (a.phase === 'handover' && a.phaseDueAtMs! <= time) {
          a.patientIds.forEach(id => setPatient(id, { holder: { kind: 'care-site', id: a.destinationId! }, disposition: 'delivered', completedAtMs: time }))
          setUnit(unit.id, undefined)
        } else if (moving(a) && a.leg && a.leg.progressMs >= a.leg.durationMs - 0.000001) {
          const point = geoPointFromLonLat(...a.leg.geometry.coordinates.at(-1)!)
          const { leg: _, ...rest } = a
          if (a.phase === 'returning') setUnit(unit.id, undefined, true, point)
          else if (a.phase === 'responding') {
            setUnit(unit.id, { ...rest, phase: 'on-scene', phaseStartedAtMs: time, phaseDueAtMs: time + data.sceneSeconds * 1000 }, true, point)
            const incident = get(a.incidentId!), incidentData = dataOfType(incident, 'incident')
            if (incidentData.firstArrivalAtMs === undefined) put(incident, { ...incidentData, firstArrivalAtMs: time })
            a.patientIds.forEach(id => { if (dataOfType(get(id), 'patient').contactedAtMs === undefined) setPatient(id, { contactedAtMs: time }) })
          } else {
            setUnit(unit.id, { ...rest, phase: 'queued', phaseStartedAtMs: time }, true, point)
            a.patientIds.forEach(id => setPatient(id, { arrivedAtSiteMs: time }))
          }
        } else continue
        changed = true
      }
      if (changed) closeIncidents()
      return startQueues() || changed
    }
    const advance = () => {
      let iterations = 0
      while (true) {
        while (boundaries()) {
          if (++iterations > 100_000) throw new Error('Ambulance transition budget exceeded')
        }
        if (time >= targetTime) break
        if (!values().some(object => { const data = ownedData(object); return data.type === 'ambulance' && data.assignment })) { time = targetTime; break }
        let next = Math.min(targetTime, time + 1_000)
        for (const object of values()) {
          const data = ownedData(object)
          const a = data.type === 'ambulance' ? data.assignment : undefined
          if (!a) continue
          if (a.phaseDueAtMs !== undefined && a.phaseDueAtMs > time) next = Math.min(next, a.phaseDueAtMs)
          if (moving(a) && a.leg && speedFactor(object) > 0) next = Math.min(next, time + (a.leg.durationMs - a.leg.progressMs) / speedFactor(object))
        }
        if (next <= time || !Number.isFinite(next)) throw new Error('Ambulance clock could not advance')
        const dt = next - time
        for (const object of values()) {
          const data = ownedData(object)
          if (data.type !== 'ambulance' || !data.assignment) continue
          const a = data.assignment
          const busy = { ...data, busyTimeMs: data.busyTimeMs + (a.phase === 'returning' ? 0 : dt) }
          if (moving(a) && a.leg) {
            const progressMs = Math.min(a.leg.durationMs, a.leg.progressMs + dt * speedFactor(object))
            put(object, { ...busy, assignment: { ...a, leg: { ...a.leg, progressMs } } }, false, routePosition(a.leg, progressMs).point)
          } else put(object, busy, false)
        }
        time = next
        if (++iterations > 100_000) throw new Error('Ambulance advance budget exceeded; use bounded simulation steps')
      }
      closeIncidents()
    }
    return { draft, events, get, put, setUnit, setPatient, values, advance, startQueues, closeIncidents, finish: () => { for (const id of motionDirty) emitObject(get(id), false) } }
  }

  const handleCommand = async (command: CommandEnvelope): Promise<AmbulanceCommandOutcome> => {
    const rejected = (error: unknown): AmbulanceCommandOutcome => ({ result: { ok: false, commandId: command.id, rejectedAt: nowIso(), reason: error instanceof Error ? error.message : String(error) }, events: [] })
    try {
      const schema = commands.ambulanceCommandSchemas[command.kind as keyof typeof commands.ambulanceCommandSchemas]
      if (!schema) throw new Error(`Unsupported Ambulance command: ${command.kind}`)
      const validated = schema.parse(command.payload)
      const primaryId = 'ambulanceId' in validated ? validated.ambulanceId : 'careSiteId' in validated ? validated.careSiteId : 'patientId' in validated ? validated.patientId : undefined
      if (command.expectedRevision !== undefined) {
        if (!primaryId || command.targetObjectIds.length !== 1 || command.targetObjectIds[0] !== primaryId) throw new Error('expectedRevision requires exactly the command primary target')
        if (requireObject(primaryId).revision !== command.expectedRevision) throw new Error(`Revision conflict for ${primaryId}; refresh the current object before retrying`)
      }
      let action: (tx: ReturnType<typeof createTransaction>) => void
      if (command.kind === commands.createItemCommandKind) {
        const { item } = commands.createItemPayloadSchema.parse(command.payload)
        const created = createAmbulanceItem(item, { at: nowIso(), simulationTimeMs, objectById: id => objects.get(id) ?? config.objectById?.(id) })
        const object: OperationalObject = { ...created, provenance: { ...created.provenance, source: 'operator', causedByCommandId: command.id } }
        action = tx => { tx.draft.set(object.id, object); tx.events.push({ type: 'object.upserted', object, at: object.timestamps.updatedAt, history: 'record', provenance: object.provenance }); tx.closeIncidents() }
      } else if (command.kind === commands.dispatchCommandKind) {
        const input = commands.dispatchPayloadSchema.parse(command.payload)
        const unit = requireObject(input.ambulanceId), incident = requireObject(input.incidentId), patients = input.patientIds.map(requirePatient)
        assertEligible(dispatchEligibility(unit, incident, patients, all()))
        const site = input.destinationId ? requireObject(input.destinationId) : undefined
        if (site) assertEligible(destinationEligibility(site, patients))
        const unchanged = watch([unit.id, incident.id, ...input.patientIds, ...(site ? [site.id] : [])])
        const [route, onwardRoute] = await Promise.all([prepareRoute(pointOf(unit), pointOf(incident)), site ? prepareRoute(pointOf(incident), pointOf(site)) : Promise.resolve(undefined)])
        unchanged()
        assertEligible(dispatchEligibility(requireObject(unit.id), requireObject(incident.id), input.patientIds.map(requirePatient), all()))
        const data = dataOfType(unit, 'ambulance')
        action = tx => {
          tx.setUnit(unit.id, { phase: 'mobilizing', incidentId: incident.id, patientIds: input.patientIds, ...(site ? { destinationId: site.id } : {}), startedAtMs: simulationTimeMs, phaseStartedAtMs: simulationTimeMs, phaseDueAtMs: simulationTimeMs + data.mobilizationSeconds * 1000, leg: { ...route, progressMs: 0 }, ...(onwardRoute ? { onwardRoute } : {}) })
          input.patientIds.forEach(id => { if (dataOfType(tx.get(id), 'patient').assignedAtMs === undefined) tx.setPatient(id, { assignedAtMs: simulationTimeMs }) })
        }
      } else if (command.kind === commands.transportCommandKind) {
        const input = commands.transportPayloadSchema.parse(command.payload)
        const unit = requireObject(input.ambulanceId), site = requireObject(input.destinationId)
        assertEligible(transportEligibility(unit, site, all()))
        const unchanged = watch([unit.id, site.id, ...unitPatients(unit.id, all()).map(p => p.id)])
        const route = await prepareRoute(pointOf(unit), pointOf(site))
        unchanged()
        const a = dataOfType(unit, 'ambulance').assignment!
        action = tx => {
          const { leg: _, onwardRoute: _onward, phaseDueAtMs: _due, ...rest } = a
          tx.setUnit(unit.id, { ...rest, destinationId: site.id, phase: 'transporting', phaseStartedAtMs: simulationTimeMs, leg: { ...route, progressMs: 0 } })
          // Arrival measures the current/final receiving-site visit. Earlier
          // visits remain in accepted history, not as a false current arrival.
          a.patientIds.forEach(id => tx.setPatient(id, { arrivedAtSiteMs: undefined }))
        }
      } else if (command.kind === commands.returnToBaseCommandKind) {
        const { ambulanceId } = commands.unitPayloadSchema.parse(command.payload)
        const unit = requireObject(ambulanceId)
        assertEligible(returnToBaseEligibility(unit, all()))
        const data = dataOfType(unit, 'ambulance'), unchanged = watch([unit.id])
        const route = await prepareRoute(pointOf(unit), data.basePoint)
        unchanged()
        action = tx => { tx.setUnit(unit.id, { phase: 'returning', patientIds: [], startedAtMs: simulationTimeMs, phaseStartedAtMs: simulationTimeMs, leg: { ...route, progressMs: 0 } }) }
      } else if (command.kind === commands.cancelCommandKind) {
        const { ambulanceId } = commands.unitPayloadSchema.parse(command.payload), unit = requireObject(ambulanceId)
        assertEligible(cancelEligibility(unit))
        const a = dataOfType(unit, 'ambulance').assignment
        action = tx => {
          if (!a) return
          if (unitPatients(unit.id, tx.values()).length) {
            const { destinationId: _, leg: _leg, onwardRoute: _onward, phaseDueAtMs: _due, ...rest } = a
            tx.setUnit(unit.id, { ...rest, phase: 'ready-for-transport', phaseStartedAtMs: simulationTimeMs })
            a.patientIds.forEach(id => tx.setPatient(id, { arrivedAtSiteMs: undefined }))
          } else tx.setUnit(unit.id, undefined)
        }
      } else if (command.kind === commands.setUnitReadinessCommandKind) {
        const { ambulanceId, ready } = commands.setUnitReadinessPayloadSchema.parse(command.payload), unit = requireObject(ambulanceId), data = dataOfType(unit, 'ambulance')
        if (!ready && data.assignment) throw new Error('Complete or cancel the assignment before withdrawing the unit')
        action = tx => { tx.put(unit, { ...data, crewReady: ready }) }
      } else if (command.kind === commands.setCareSiteCommandKind) {
        const { careSiteId, ...settings } = commands.setCareSitePayloadSchema.parse(command.payload), site = requireObject(careSiteId)
        const next = careSitePackDataSchema.parse({ ...dataOfType(site, 'care-site'), ...settings })
        action = tx => { tx.put(site, next); tx.startQueues() }
      } else if (command.kind === commands.setPatientAssessmentCommandKind) {
        const { patientId, assessedUrgency, needs } = commands.setPatientAssessmentPayloadSchema.parse(command.payload), patient = requirePatient(patientId), data = dataOfType(patient, 'patient')
        if (data.disposition !== 'active') throw new Error('Cannot reassess a completed patient')
        // Assessment changes never fabricate a transfer or undo an admitted
        // handover. New admissions recheck compatibility; queries expose any
        // now-unsuitable assignment for explicit operator review.
        action = tx => { tx.setPatient(patientId, { assessedUrgency, needs }) }
      } else if (command.kind === commands.setPatientDispositionCommandKind) {
        const { patientId, reason } = commands.setPatientDispositionPayloadSchema.parse(command.payload), patient = requirePatient(patientId)
        assertEligible(noTransportEligibility(patient, all()))
        action = tx => { tx.setPatient(patientId, { disposition: 'no-transport', dispositionReason: reason, completedAtMs: simulationTimeMs }); tx.closeIncidents() }
      } else throw new Error(`Unsupported Ambulance command: ${command.kind}`)
      const events = transaction(tx => { action(tx); tx.advance() }, simulationTimeMs, command.id)
      return { result: { ok: true, commandId: command.id, acceptedAt: nowIso() }, events }
    } catch (error) { return rejected(error) }
  }

  return {
    snapshot: () => ({ simulationRunId: config.simulationRunId, objects: all(), capturedAt: nowIso() }),
    checkpoint: () => ({ simulationTimeMs }),
    advanceTo: target => {
      if (!Number.isFinite(target) || target < simulationTimeMs) throw new Error('Ambulance simulation time must be finite and monotonic')
      if (target - simulationTimeMs > 86_400_000) throw new Error('Advance at most 24 simulated hours in one call')
      return transaction(tx => tx.advance(), target)
    },
    handleCommand,
    validateDeletion: id => validateAmbulanceDeletion(id, all()),
    observeCommittedEvents: events => {
      for (const event of events) {
        if (event.type === 'object.deleted') objects.delete(event.objectId)
        if (event.type === 'object.upserted' && event.object.packId === ambulancePackId) {
          const current = objects.get(event.object.id)
          if (!current || current.revision < event.object.revision) objects.set(event.object.id, validateAmbulanceObject(event.object))
        }
      }
    },
    setRoadWeatherImpact: (id, impact) => {
      const object = objects.get(id)
      if (!object?.spatial.route || ownedData(object).type !== 'ambulance') return
      const previous = object.spatial.route.impacts ?? []
      const remaining = previous.filter(entry => entry.source.kind !== 'runtime' || entry.source.id !== 'ambulance.road-weather')
      const impacts = impact ? [...remaining, impact] : remaining
      const stable = (entries: readonly RouteImpact[]) => entries.map(({ updatedAt: _, ...entry }) => entry)
      if (JSON.stringify(stable(previous)) === JSON.stringify(stable(impacts))) return
      const at = nowIso(), updated: OperationalObject = { ...object, revision: object.revision + 1, spatial: { ...object.spatial, route: { ...object.spatial.route, impacts } }, provenance: { source: 'simulator', adapterId: ambulanceSimAdapterId, externalId: object.id }, timestamps: { ...object.timestamps, updatedAt: at } }
      objects.set(id, updated)
      return { type: 'object.upserted', object: updated, at, history: 'snapshot-only', provenance: updated.provenance }
    },
  }
}
