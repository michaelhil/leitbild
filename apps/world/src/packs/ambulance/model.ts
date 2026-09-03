import { z } from 'zod'
import { geoJsonLineStringSchema, geoJsonPointSchema, objectIdSchema, type OperationalObject } from '../../core/model/index.ts'

export const ambulancePackId = 'ambulance' as const
export const urgencySchema = z.enum(['acute', 'urgent', 'ordinary'])
export type Urgency = z.infer<typeof urgencySchema>
export const careTagsSchema = z.array(z.string().trim().min(1).max(64)).max(32).refine(tags => new Set(tags).size === tags.length, 'Care tags must be unique')
/** Every domain *AtMs/deadline below is absolute simulation epoch milliseconds,
 * not observation/wall time. Core object timestamps retain wall-time meaning. */
export const simulationTimestampSchema = z.number().finite().nonnegative()
export const serviceSecondsSchema = z.number().finite().nonnegative().max(86_400)

export const preparedRouteSchema = z.object({
  geometry: geoJsonLineStringSchema,
  durationMs: z.number().finite().nonnegative(),
  distanceM: z.number().finite().nonnegative(),
  provider: z.string().min(1).max(120),
}).strict()
export type PreparedRoute = z.infer<typeof preparedRouteSchema>
export const assignmentPhaseSchema = z.enum(['mobilizing', 'responding', 'on-scene', 'ready-for-transport', 'transporting', 'queued', 'handover', 'returning'])
export type AssignmentPhase = z.infer<typeof assignmentPhaseSchema>
export const ambulanceAssignmentSchema = z.object({
  phase: assignmentPhaseSchema,
  incidentId: objectIdSchema.optional(),
  patientIds: z.array(objectIdSchema).max(64),
  destinationId: objectIdSchema.optional(),
  startedAtMs: simulationTimestampSchema,
  phaseStartedAtMs: simulationTimestampSchema,
  phaseDueAtMs: simulationTimestampSchema.optional(),
  leg: preparedRouteSchema.extend({ progressMs: z.number().finite().nonnegative() }).optional(),
  onwardRoute: preparedRouteSchema.optional(),
}).strict()
export type AmbulanceAssignment = z.infer<typeof ambulanceAssignmentSchema>
export const ambulancePackDataSchema = z.object({
  type: z.literal('ambulance'),
  patientCapacity: z.number().int().min(1).max(64),
  capabilities: careTagsSchema,
  crewReady: z.boolean(),
  basePoint: geoJsonPointSchema,
  mobilizationSeconds: serviceSecondsSchema,
  sceneSeconds: serviceSecondsSchema,
  assignment: ambulanceAssignmentSchema.optional(),
  busyTimeMs: z.number().finite().nonnegative(),
}).strict()
export type AmbulancePackData = z.infer<typeof ambulancePackDataSchema>
export const incidentPackDataSchema = z.object({
  type: z.literal('incident'),
  summary: z.string().max(2_000),
  dispatchUrgency: urgencySchema,
  subjectObjectId: objectIdSchema.optional(),
  receivedAtMs: simulationTimestampSchema,
  firstArrivalAtMs: simulationTimestampSchema.optional(),
  closedAtMs: simulationTimestampSchema.optional(),
}).strict()
export type IncidentPackData = z.infer<typeof incidentPackDataSchema>
export const patientHolderSchema = z.object({ kind: z.enum(['incident', 'ambulance', 'care-site']), id: objectIdSchema }).strict()
export const patientPackDataSchema = z.object({
  type: z.literal('patient'),
  incidentId: objectIdSchema,
  summary: z.string().max(2_000),
  assessedUrgency: urgencySchema,
  needs: careTagsSchema,
  holder: patientHolderSchema,
  disposition: z.enum(['active', 'delivered', 'no-transport']),
  dispositionReason: z.string().min(1).max(500).optional(),
  createdAtMs: simulationTimestampSchema,
  assignedAtMs: simulationTimestampSchema.optional(),
  departedAtMs: simulationTimestampSchema.optional(),
  contactedAtMs: simulationTimestampSchema.optional(),
  pickedUpAtMs: simulationTimestampSchema.optional(),
  arrivedAtSiteMs: simulationTimestampSchema.optional(),
  handoverStartedAtMs: simulationTimestampSchema.optional(),
  completedAtMs: simulationTimestampSchema.optional(),
}).strict()
export type PatientPackData = z.infer<typeof patientPackDataSchema>
export const careSitePackDataSchema = z.object({
  type: z.literal('care-site'),
  capabilities: careTagsSchema,
  acceptedUrgencies: z.array(urgencySchema).min(1).max(3).refine(values => new Set(values).size === values.length, 'Urgencies must be unique'),
  handoverSlots: z.number().int().min(0).max(1_000),
  handoverSeconds: serviceSecondsSchema,
  accepting: z.boolean(),
  subjectObjectId: objectIdSchema.optional(),
}).strict()
export type CareSitePackData = z.infer<typeof careSitePackDataSchema>
export const ambulanceDomainDataSchema = z.discriminatedUnion('type', [ambulancePackDataSchema, incidentPackDataSchema, patientPackDataSchema, careSitePackDataSchema])
export type AmbulanceDomainData = z.infer<typeof ambulanceDomainDataSchema>
export const ambulanceDataOf = (object: OperationalObject): AmbulanceDomainData => ambulanceDomainDataSchema.parse(object.packData)
export const patientObjects = (objects: readonly OperationalObject[]): readonly OperationalObject[] => objects.filter(object => object.packId === ambulancePackId && (object.packData as { type?: string } | undefined)?.type === 'patient')
export const unitPatients = (unitId: string, objects: readonly OperationalObject[]): readonly OperationalObject[] => patientObjects(objects).filter(object => {
  const patient = patientPackDataSchema.parse(object.packData)
  return patient.holder.kind === 'ambulance' && patient.holder.id === unitId
})
/** These explanations govern UI/AI candidates and command acceptance alike. */
export const destinationEligibility = (site: OperationalObject | undefined, patients: readonly OperationalObject[]): string[] => {
  if (!site || site.packId !== ambulancePackId) return ['Care site does not exist']
  const parsed = careSitePackDataSchema.safeParse(site.packData)
  if (!parsed.success) return ['Destination is not a care site']
  const data = parsed.data
  const reasons: string[] = []
  if (!data.accepting) reasons.push('Care site is not accepting arrivals')
  for (const object of patients) {
    const patient = patientPackDataSchema.parse(object.packData)
    if (!data.acceptedUrgencies.includes(patient.assessedUrgency)) reasons.push(`${object.label}: care site does not accept ${patient.assessedUrgency} patients`)
    const missing = patient.needs.filter(need => !data.capabilities.includes(need))
    if (missing.length) reasons.push(`${object.label}: care site lacks ${missing.join(', ')}`)
  }
  return reasons
}
export const dispatchEligibility = (unit: OperationalObject | undefined, incident: OperationalObject | undefined, patients: readonly OperationalObject[], objects: readonly OperationalObject[]): string[] => {
  if (!unit || unit.packId !== ambulancePackId) return ['Response unit does not exist']
  const parsed = ambulancePackDataSchema.safeParse(unit.packData)
  if (!parsed.success) return ['Asset is not an ambulance']
  const data = parsed.data
  const reasons: string[] = []
  if (!data.crewReady) reasons.push('Crew is not ready')
  if (data.assignment && data.assignment.phase !== 'returning') reasons.push('Unit is already committed; cancel its current response first')
  if (unitPatients(unit.id, objects).length) reasons.push('Unit already carries patients')
  if (!incident || incident.packId !== ambulancePackId || !incidentPackDataSchema.safeParse(incident.packData).success) reasons.push('Target is not an incident')
  if (incident?.lifecycle === 'resolved') reasons.push('Incident is already resolved')
  if (!patients.length) reasons.push('Select at least one patient')
  if (patients.length > data.patientCapacity) reasons.push(`Patient selection exceeds capacity ${data.patientCapacity}`)
  const reserved = new Set(objects.flatMap(object => {
    const other = object.packId === ambulancePackId ? ambulancePackDataSchema.safeParse(object.packData) : null
    return other?.success && object.id !== unit.id ? other.data.assignment?.patientIds ?? [] : []
  }))
  for (const object of patients) {
    const patient = patientPackDataSchema.parse(object.packData)
    if (patient.incidentId !== incident?.id || patient.holder.kind !== 'incident' || patient.holder.id !== incident?.id || patient.disposition !== 'active') reasons.push(`${object.label}: patient is not awaiting response at this incident`)
    if (reserved.has(object.id)) reasons.push(`${object.label}: patient is already reserved by another unit`)
    const missing = patient.needs.filter(need => !data.capabilities.includes(need))
    if (missing.length) reasons.push(`${object.label}: unit lacks ${missing.join(', ')}`)
  }
  return reasons
}

export const transportEligibility = (unit: OperationalObject | undefined, site: OperationalObject | undefined, objects: readonly OperationalObject[]): string[] => {
  const parsed = unit?.packId === ambulancePackId ? ambulancePackDataSchema.safeParse(unit.packData) : null
  if (!unit || !parsed?.success) return ['Asset is not an ambulance']
  const reasons = destinationEligibility(site, unitPatients(unit.id, objects))
  if (!parsed.data.crewReady) reasons.push('Crew is not ready')
  if (!parsed.data.assignment || !['ready-for-transport', 'transporting', 'queued'].includes(parsed.data.assignment.phase)) reasons.push('Unit must have completed on-scene work before transport or retargeting')
  if (!unitPatients(unit.id, objects).length) reasons.push('Unit has no patients on board')
  return reasons
}

export const cancelEligibility = (unit: OperationalObject | undefined): string[] => {
  const parsed = unit?.packId === ambulancePackId ? ambulancePackDataSchema.safeParse(unit.packData) : null
  if (!parsed?.success) return ['Asset is not an ambulance']
  return parsed.data.assignment?.phase === 'handover' ? ['Handover is already in progress; wait for it to complete'] : []
}

export const returnToBaseEligibility = (unit: OperationalObject | undefined, objects: readonly OperationalObject[]): string[] => {
  const parsed = unit?.packId === ambulancePackId ? ambulancePackDataSchema.safeParse(unit.packData) : null
  if (!unit || !parsed?.success) return ['Asset is not an ambulance']
  const reasons: string[] = []
  if (!parsed.data.crewReady) reasons.push('Crew is not ready')
  if (parsed.data.assignment && parsed.data.assignment.phase !== 'returning') reasons.push('Unit has an active assignment; complete or cancel it first')
  if (unitPatients(unit.id, objects).length) reasons.push('Unit still carries patients')
  return reasons
}

export const noTransportEligibility = (patient: OperationalObject | undefined, objects: readonly OperationalObject[]): string[] => {
  const parsed = patient?.packId === ambulancePackId ? patientPackDataSchema.safeParse(patient.packData) : null
  if (!patient || !parsed?.success) return ['Asset is not a patient']
  const reasons: string[] = []
  if (parsed.data.disposition !== 'active' || parsed.data.holder.kind !== 'incident') reasons.push('No-transport requires an active patient still at the incident')
  if (objects.some(object => {
    const data = object.packId === ambulancePackId ? ambulancePackDataSchema.safeParse(object.packData) : null
    return data?.success && data.data.assignment?.patientIds.includes(patient.id)
  })) reasons.push('Cancel the patient response reservation before recording no-transport')
  return reasons
}

/** New assessments are facts, not actions to reject when a plan is unsuitable.
 * Keep custody intact and expose these mismatches for an operator's decision. */
export const assignmentWarnings = (unit: OperationalObject, objects: readonly OperationalObject[]): string[] => {
  const parsed = unit.packId === ambulancePackId ? ambulancePackDataSchema.safeParse(unit.packData) : null
  if (!parsed?.success || !parsed.data.assignment) return []
  const assignment = parsed.data.assignment
  const patients = assignment.patientIds.map(id => objects.find(object => object.id === id)).filter((object): object is OperationalObject => object !== undefined)
  const reasons = patients.flatMap(object => {
    const patient = patientPackDataSchema.parse(object.packData)
    const missing = patient.needs.filter(need => !parsed.data.capabilities.includes(need))
    return missing.length ? [`${object.label}: assigned unit lacks ${missing.join(', ')}; review the response plan`] : []
  })
  if (assignment.destinationId && assignment.phase !== 'handover') reasons.push(...destinationEligibility(objects.find(object => object.id === assignment.destinationId), patients))
  return reasons
}
