import type { GeoJsonPoint, IsoTimestamp, ObjectId, OperationalObject } from '../../../core/model/index.ts'
import { geoJsonPointSchema, geoPointFromLonLat } from '../../../core/model/index.ts'
import { ambulanceItemSchema, type AmbulanceItem } from '../item-schemas.ts'
import { ambulanceDataOf, ambulancePackId, incidentPackDataSchema, type AmbulanceDomainData } from '../model.ts'
import { ambulanceSimAdapterId } from './constants.ts'

export interface ItemConstructionContext {
  readonly at: IsoTimestamp
  readonly simulationTimeMs: number
  readonly objectById: (id: ObjectId) => OperationalObject | undefined
}

/** A reference captures one existing canonical point, never a spatial binding. */
const capturePoint = (item: Exclude<AmbulanceItem, { type: 'patient' }>, context: ItemConstructionContext): GeoJsonPoint => {
  if (item.position) return geoPointFromLonLat(...item.position)
  const point = item.atObject ? context.objectById(item.atObject)?.spatial.position?.point : undefined
  if (!point) throw new Error(`Location reference ${item.atObject ?? '(missing)'} has no canonical point`)
  return structuredClone(point)
}

export const createAmbulanceItem = (raw: AmbulanceItem, context: ItemConstructionContext): OperationalObject => {
  const item = ambulanceItemSchema.parse(raw)
  if (!Number.isFinite(context.simulationTimeMs) || context.simulationTimeMs < 0) throw new Error('Invalid simulation time')
  if (context.objectById(item.id)) throw new Error(`Object already exists: ${item.id}`)
  const point = item.type === 'patient' ? undefined : capturePoint(item, context)
  const subject = item.type !== 'patient' && item.atObject ? { subjectObjectId: item.atObject } : {}
  let data: AmbulanceDomainData
  if (item.type === 'ambulance') data = { type: item.type, patientCapacity: item.patientCapacity, capabilities: item.capabilities, crewReady: item.crewReady, basePoint: geoJsonPointSchema.parse(item.basePosition ? geoPointFromLonLat(...item.basePosition) : point!), mobilizationSeconds: item.mobilizationSeconds, sceneSeconds: item.sceneSeconds, busyTimeMs: 0 }
  else if (item.type === 'incident') data = { type: item.type, summary: item.summary, dispatchUrgency: item.dispatchUrgency, receivedAtMs: context.simulationTimeMs, ...subject }
  else if (item.type === 'care-site') data = { type: item.type, capabilities: item.capabilities, acceptedUrgencies: item.acceptedUrgencies, handoverSlots: item.handoverSlots, handoverSeconds: item.handoverSeconds, accepting: item.accepting, ...subject }
  else {
    const incident = context.objectById(item.incidentId)
    if (!incident || incident.packId !== ambulancePackId || !incidentPackDataSchema.safeParse(incident.packData).success) throw new Error(`Patient requires an existing incident: ${item.incidentId}`)
    data = { type: item.type, incidentId: item.incidentId, summary: item.summary, assessedUrgency: item.assessedUrgency, needs: item.needs, holder: { kind: 'incident', id: item.incidentId }, disposition: 'active', createdAtMs: context.simulationTimeMs }
  }
  const object: OperationalObject = {
    id: item.id,
    kind: item.type === 'ambulance' ? 'mobile_entity' : item.type === 'care-site' ? 'facility' : item.type,
    packId: ambulancePackId as OperationalObject['packId'], label: item.label, lifecycle: 'active', revision: 0,
    spatial: { frame: { kind: 'wgs84' }, ...(point ? { position: { point, observedAt: context.at, ...(item.type === 'ambulance' ? { speedMps: 0 } : {}) } } : {}) },
    operational: { status: item.type === 'ambulance' ? item.crewReady ? 'available' : 'out-of-service' : item.type === 'incident' ? 'open' : item.type === 'patient' ? 'awaiting-response' : item.accepting ? 'accepting' : 'not-accepting', mode: 'simulated' },
    alerts: [], provenance: { source: 'simulator', adapterId: ambulanceSimAdapterId, externalId: item.id },
    timestamps: { createdAt: context.at, updatedAt: context.at }, packData: data,
  }
  return validateAmbulanceObject(object)
}

export const validateAmbulanceObject = (object: OperationalObject): OperationalObject => {
  if (object.packId !== ambulancePackId) throw new Error(`Object ${object.id} is not owned by Ambulance`)
  const data = ambulanceDataOf(object)
  const kind = data.type === 'ambulance' ? 'mobile_entity' : data.type === 'care-site' ? 'facility' : data.type
  if (object.kind !== kind) throw new Error(`${object.id}: ${data.type} requires object kind ${kind}`)
  if (data.type !== 'patient' && !object.spatial.position?.point) throw new Error(`${object.id}: positioned asset requires a canonical point`)
  if (data.type === 'ambulance' && data.assignment) {
    const a = data.assignment
    if (new Set(a.patientIds).size !== a.patientIds.length) throw new Error(`${object.id}: duplicate assignment patients`)
    if (a.patientIds.length > data.patientCapacity) throw new Error(`${object.id}: assignment exceeds patient capacity`)
    if (a.phaseStartedAtMs < a.startedAtMs || (a.phaseDueAtMs !== undefined && a.phaseDueAtMs < a.phaseStartedAtMs)) throw new Error(`${object.id}: inconsistent assignment timestamps`)
    if (['mobilizing', 'on-scene', 'handover'].includes(a.phase) && a.phaseDueAtMs === undefined) throw new Error(`${object.id}: timed phase requires deadline`)
    if (['mobilizing', 'responding', 'transporting', 'returning'].includes(a.phase) && !a.leg) throw new Error(`${object.id}: movement phase requires prepared route`)
    if (a.leg && (a.leg.progressMs > a.leg.durationMs || (a.leg.distanceM > 0 && a.leg.durationMs <= 0))) throw new Error(`${object.id}: invalid route progress or duration`)
    if (a.phase === 'returning' ? a.patientIds.length > 0 || a.incidentId !== undefined || a.destinationId !== undefined : !a.incidentId || a.patientIds.length === 0) throw new Error(`${object.id}: inconsistent assignment purpose`)
    if (['transporting', 'queued', 'handover'].includes(a.phase) && !a.destinationId) throw new Error(`${object.id}: transport requires a care site`)
    if (a.onwardRoute && !a.destinationId) throw new Error(`${object.id}: onward route has no destination`)
  }
  if (data.type === 'patient') {
    if (data.disposition === 'delivered' && (data.holder.kind !== 'care-site' || data.completedAtMs === undefined)) throw new Error(`${object.id}: delivered patient requires completed care-site handover`)
    if (data.disposition === 'no-transport' && (data.holder.kind !== 'incident' || !data.dispositionReason || data.completedAtMs === undefined)) throw new Error(`${object.id}: no-transport requires incident custody, reason and completion time`)
    const milestones = [data.createdAtMs, data.assignedAtMs, data.departedAtMs, data.contactedAtMs, data.pickedUpAtMs, data.arrivedAtSiteMs, data.handoverStartedAtMs, data.completedAtMs].filter((value): value is number => value !== undefined)
    if (milestones.some((value, index) => index > 0 && value < milestones[index - 1]!)) throw new Error(`${object.id}: patient milestones must follow simulation-time order`)
  }
  return { ...object, packData: data }
}

export const validateAmbulanceObjects = (objects: readonly OperationalObject[]): void => {
  const index = new Map(objects.filter(object => object.packId === ambulancePackId).map(object => [object.id, validateAmbulanceObject(object).packData as AmbulanceDomainData]))
  const reserved = new Set<string>()
  for (const object of objects) {
    if (object.packId !== ambulancePackId) continue
    const data = index.get(object.id)!
    if (data.type === 'patient') {
      const incident = index.get(data.incidentId)
      if (incident?.type !== 'incident') throw new Error(`${object.id}: incident does not exist`)
      const holder = index.get(data.holder.id)
      if (holder?.type !== data.holder.kind) throw new Error(`${object.id}: invalid patient holder ${data.holder.id}`)
      if (data.holder.kind === 'ambulance') {
        if (holder.type !== 'ambulance' || !holder.assignment?.patientIds.includes(object.id)) throw new Error(`${object.id}: patient custody is not represented by holder assignment`)
      }
    }
    if (data.type !== 'ambulance' || !data.assignment) continue
    const a = data.assignment
    if (a.incidentId && index.get(a.incidentId)?.type !== 'incident') throw new Error(`${object.id}: assignment incident does not exist`)
    if (a.destinationId && index.get(a.destinationId)?.type !== 'care-site') throw new Error(`${object.id}: assignment care site does not exist`)
    for (const id of a.patientIds) {
      if (reserved.has(id)) throw new Error(`${id}: patient is reserved by more than one unit`)
      reserved.add(id)
      const patient = index.get(id)
      if (patient?.type !== 'patient') throw new Error(`${object.id}: assignment patient does not exist: ${id}`)
      if (patient.incidentId !== a.incidentId || patient.disposition !== 'active') throw new Error(`${object.id}: assignment contains a completed or unrelated patient`)
      const shouldBeOnBoard = ['ready-for-transport', 'transporting', 'queued', 'handover'].includes(a.phase)
      if (shouldBeOnBoard ? patient.holder.kind !== 'ambulance' || patient.holder.id !== object.id : patient.holder.kind !== 'incident' || patient.holder.id !== a.incidentId) throw new Error(`${id}: patient holder disagrees with response phase`)
    }
  }
  // Capacity follows from unique bounded assignment IDs and the bidirectional
  // holder check above; no second fleet × patient scan is needed.
}

/** Deletion cannot strand patients or invalidate an in-flight assignment. */
export const validateAmbulanceDeletion = (objectId: string, objects: readonly OperationalObject[]): void => {
  for (const object of objects) {
    if (object.packId !== ambulancePackId) continue
    const data = ambulanceDataOf(object)
    if (data.type === 'patient' && (data.holder.id === objectId || data.incidentId === objectId)) throw new Error(`Cannot delete ${objectId}: patient ${object.label} still references it; transfer/remove patients first`)
    if (data.type === 'ambulance' && data.assignment && (object.id === objectId || data.assignment.incidentId === objectId || data.assignment.destinationId === objectId || data.assignment.patientIds.includes(objectId as ObjectId))) throw new Error(`Cannot delete ${objectId}: cancel or complete ${object.label}'s active assignment first`)
  }
}
