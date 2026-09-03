import { z } from 'zod'
import { geoJsonPointSchema, objectIdSchema, operationalObjectSchema, type IsoTimestamp, type OperationalObject } from '../../core/model/index.ts'
import { defineSimulationQueryCapability } from '../../simulation/capabilities.ts'
import type { PackRuntimeQuery, SimulationCapability } from '../../simulation/protocol.ts'
import { ambulanceDataOf, ambulancePackId, assignmentWarnings, destinationEligibility, dispatchEligibility, patientPackDataSchema, transportEligibility, urgencySchema, type AmbulanceDomainData } from './model.ts'
import { dispatchPayloadSchema } from './commands.ts'

const count = z.number().int().nonnegative()
const timestamp = z.number().finite().nonnegative()
const pagination = { limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(100000).default(0) }
const identity = { id: objectIdSchema, label: z.string(), point: geoJsonPointSchema.nullable() }
export const unitSummarySchema = z.object({
  ...identity, phase: z.string(), crewReady: z.boolean(), patientCapacity: count, capabilities: z.array(z.string()),
  patientIds: z.array(objectIdSchema), onBoardPatientIds: z.array(objectIdSchema), incidentId: objectIdSchema.nullable(), destinationId: objectIdSchema.nullable(),
  phaseDueAtMs: timestamp.nullable(), remainingTravelSeconds: z.number().nonnegative().nullable(), busyTimeMs: timestamp, assignmentWarnings: z.array(z.string()),
}).strict()
export const incidentSummarySchema = z.object({
  ...identity, summary: z.string(), dispatchUrgency: urgencySchema, subjectObjectId: objectIdSchema.nullable(),
  receivedAtMs: timestamp, firstArrivalAtMs: timestamp.nullable(), closedAtMs: timestamp.nullable(),
  patients: count, activePatients: count, assignedUnitIds: z.array(objectIdSchema),
}).strict()
export const patientSummarySchema = z.object({
  ...identity, incidentId: objectIdSchema, summary: z.string(), assessedUrgency: urgencySchema, needs: z.array(z.string()),
  holder: patientPackDataSchema.shape.holder, disposition: patientPackDataSchema.shape.disposition, dispositionReason: z.string().nullable(),
}).strict()
export const careSiteSummarySchema = z.object({
  ...identity, accepting: z.boolean(), capabilities: z.array(z.string()), acceptedUrgencies: z.array(urgencySchema),
  handoverSlots: count, handoverSeconds: z.number().nonnegative(), subjectObjectId: objectIdSchema.nullable(),
  queuedUnitIds: z.array(objectIdSchema), handingOverUnitIds: z.array(objectIdSchema),
}).strict()
const totalsSchema = z.object({ units: count, incidents: count, patients: count, careSites: count }).strict()
export const dispatchStateSchema = z.object({
  observedAt: z.iso.datetime(), simulationTimeMs: timestamp,
  units: z.array(unitSummarySchema), incidents: z.array(incidentSummarySchema), patients: z.array(patientSummarySchema), careSites: z.array(careSiteSummarySchema),
  totals: totalsSchema, truncated: z.boolean(),
}).strict()
export type DispatchState = z.infer<typeof dispatchStateSchema>
const dispatchStateInput = z.object({ ...pagination, incidentId: objectIdSchema.optional() }).strict()
const optionsInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('dispatch'), incidentId: objectIdSchema, patientIds: dispatchPayloadSchema.shape.patientIds, ...pagination }).strict(),
  z.object({ action: z.literal('transport'), ambulanceId: objectIdSchema, ...pagination }).strict(),
])
const candidateSchema = z.object({ id: objectIdSchema, label: z.string(), eligible: z.boolean(), reasons: z.array(z.string()) }).strict()
export const dispatchOptionsSchema = z.object({ units: z.array(candidateSchema), careSites: z.array(candidateSchema), totals: z.object({ units: count, careSites: count }).strict(), truncated: z.boolean() }).strict()
export type DispatchOptions = z.infer<typeof dispatchOptionsSchema>
const durationSummarySchema = z.object({ samples: count, meanSeconds: z.number().nonnegative().nullable(), maximumSeconds: z.number().nonnegative().nullable() }).strict()
export const ambulanceMetricsSchema = z.object({
  observedAt: z.iso.datetime(), simulationTimeMs: timestamp,
  incidents: z.object({ total: count, awaitingFirstArrival: count, firstResponse: durationSummarySchema }).strict(),
  patients: z.object({ total: count, active: count, delivered: count, noTransport: count, dispatchWait: durationSummarySchema, mobilization: durationSummarySchema, timeToContact: durationSummarySchema, transport: durationSummarySchema, handoverWait: durationSummarySchema, handover: durationSummarySchema }).strict(),
  units: z.object({ total: count, dispatchable: count, assigned: count, busySeconds: z.number().nonnegative() }).strict(), limitations: z.array(z.string()),
}).strict()
export type AmbulanceMetrics = z.infer<typeof ambulanceMetricsSchema>

export const ambulanceQueryKinds = ['world.ambulance.dispatch-state', 'world.ambulance.object', 'world.ambulance.dispatch-options', 'world.ambulance.metrics'] as const
export const ambulanceQueryCapabilities: ReadonlyArray<SimulationCapability> = [
  defineSimulationQueryCapability({ id: ambulanceQueryKinds[0], title: 'Inspect ambulance dispatch', description: 'Bounded summaries of units, incidents, patients, and care-site queues. Limit/offset apply separately to each list; totals and truncation are explicit. Optional incidentId narrows incident/patient/assigned-unit lists. Patient points resolve their current custody holder. All *AtMs times are absolute simulation epoch milliseconds; observedAt is wall time. remainingTravelSeconds uses the current weather-adjusted route estimate, null when absent or blocked. Assignment warnings expose changed patient needs or unsuitable destinations without silently replanning.', input: dispatchStateInput, output: dispatchStateSchema }),
  defineSimulationQueryCapability({ id: ambulanceQueryKinds[1], title: 'Inspect an ambulance domain object', description: 'Read one exact ambulance, incident, patient, or care-site including configured assumptions, patient custody and recorded milestones. Returns null if absent. No fabricated clinical measurements.', input: z.object({ objectId: objectIdSchema }).strict(), output: z.object({ object: operationalObjectSchema.nullable() }).strict() }),
  defineSimulationQueryCapability({ id: ambulanceQueryKinds[2], title: 'Find dispatch and destination options', description: 'Read bounded candidates and explicit eligibility reasons using the same domain checks as commands. Choose patients explicitly for dispatch; transport uses the unit’s assigned patient group. Does not reserve patients, compute routes, or issue commands. Eligibility is rechecked when a command is accepted.', input: optionsInput, output: dispatchOptionsSchema }),
  defineSimulationQueryCapability({ id: ambulanceQueryKinds[3], title: 'Read dispatch performance measures', description: 'Aggregate completed operational intervals from canonical milestones. Missing intervals are excluded with explicit sample counts, never treated as zero. Transport means pickup to the current/final receiving-site arrival; retargeting may include waits at a prior site. Handover wait describes the current/final site visit; earlier visits remain in the event journal. These are simulated logistics measures, not clinical outcomes.', input: z.object({}).strict(), output: ambulanceMetricsSchema }),
]

const identityFor = (object: OperationalObject) => ({ id: object.id, label: object.label, point: object.spatial.position?.point ?? null })
const urgencyRank = { acute: 0, urgent: 1, ordinary: 2 }
const durationSummary = (values: ReadonlyArray<number>) => ({ samples: values.length, meanSeconds: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null, maximumSeconds: values.length ? values.reduce((maximum, value) => Math.max(maximum, value), 0) : null })
const interval = (start: number | undefined, end: number | undefined): number[] => {
  if (start === undefined || end === undefined) return []
  if (end < start) throw new Error('Ambulance milestone precedes its starting milestone')
  return [(end - start) / 1000]
}

export const answerAmbulanceQuery = (config: { request: PackRuntimeQuery; objects: ReadonlyArray<OperationalObject>; at: IsoTimestamp; simulationTimeMs: number }): unknown => {
  const entries = config.objects.filter(object => object.packId === ambulancePackId).map(object => ({ object, data: ambulanceDataOf(object) }))
  const typed = <T extends AmbulanceDomainData['type']>(type: T) => entries.filter((entry): entry is { object: OperationalObject; data: Extract<AmbulanceDomainData, { type: T }> } => entry.data.type === type)
  const units = typed('ambulance'), incidents = typed('incident'), patients = typed('patient'), careSites = typed('care-site')
  const page = <T>(values: ReadonlyArray<T>, input: { offset: number; limit: number }) => values.slice(input.offset, input.offset + input.limit)
  if (config.request.capabilityId === ambulanceQueryKinds[1]) {
    const { objectId } = z.object({ objectId: objectIdSchema }).parse(config.request.input)
    return { object: entries.find(entry => entry.object.id === objectId)?.object ?? null }
  }
  if (config.request.capabilityId === ambulanceQueryKinds[0]) {
    const input = dispatchStateInput.parse(config.request.input)
    const selectedIncidents = incidents.filter(entry => !input.incidentId || entry.object.id === input.incidentId).sort((a, b) => Number(a.data.closedAtMs !== undefined) - Number(b.data.closedAtMs !== undefined) || urgencyRank[a.data.dispatchUrgency] - urgencyRank[b.data.dispatchUrgency] || a.data.receivedAtMs - b.data.receivedAtMs || a.object.id.localeCompare(b.object.id))
    const selectedPatients = patients.filter(entry => !input.incidentId || entry.data.incidentId === input.incidentId)
    const selectedUnits = units.filter(entry => !input.incidentId || entry.data.assignment?.incidentId === input.incidentId)
    const totals = { units: selectedUnits.length, incidents: selectedIncidents.length, patients: selectedPatients.length, careSites: careSites.length }
    return {
      observedAt: config.at, simulationTimeMs: config.simulationTimeMs, totals, truncated: Object.values(totals).some(total => input.offset + input.limit < total),
      units: page(selectedUnits, input).map(({ object, data }) => ({ ...identityFor(object), phase: data.assignment?.phase ?? (data.crewReady ? 'available' : 'out-of-service'), crewReady: data.crewReady, patientCapacity: data.patientCapacity, capabilities: data.capabilities,
        patientIds: data.assignment?.patientIds ?? [], onBoardPatientIds: patients.filter(patient => patient.data.holder.kind === 'ambulance' && patient.data.holder.id === object.id).map(patient => patient.object.id),
        incidentId: data.assignment?.incidentId ?? null, destinationId: data.assignment?.destinationId ?? null, phaseDueAtMs: data.assignment?.phaseDueAtMs ?? null,
        remainingTravelSeconds: object.spatial.route?.etaSeconds ?? null, busyTimeMs: data.busyTimeMs, assignmentWarnings: assignmentWarnings(object, config.objects) })),
      incidents: page(selectedIncidents, input).map(({ object, data }) => ({ ...identityFor(object), summary: data.summary, dispatchUrgency: data.dispatchUrgency, subjectObjectId: data.subjectObjectId ?? null, receivedAtMs: data.receivedAtMs, firstArrivalAtMs: data.firstArrivalAtMs ?? null, closedAtMs: data.closedAtMs ?? null,
        patients: patients.filter(patient => patient.data.incidentId === object.id).length, activePatients: patients.filter(patient => patient.data.incidentId === object.id && patient.data.disposition === 'active').length,
        assignedUnitIds: units.filter(unit => unit.data.assignment?.incidentId === object.id).map(unit => unit.object.id) })),
      patients: page(selectedPatients, input).map(({ object, data }) => ({ ...identityFor(object), point: config.objects.find(holder => holder.id === data.holder.id)?.spatial.position?.point ?? null, incidentId: data.incidentId, summary: data.summary, assessedUrgency: data.assessedUrgency, needs: data.needs, holder: data.holder, disposition: data.disposition, dispositionReason: data.dispositionReason ?? null })),
      careSites: page(careSites, input).map(({ object, data }) => ({ ...identityFor(object), accepting: data.accepting, capabilities: data.capabilities, acceptedUrgencies: data.acceptedUrgencies, handoverSlots: data.handoverSlots, handoverSeconds: data.handoverSeconds, subjectObjectId: data.subjectObjectId ?? null,
        queuedUnitIds: units.filter(unit => unit.data.assignment?.destinationId === object.id && unit.data.assignment.phase === 'queued').map(unit => unit.object.id),
        handingOverUnitIds: units.filter(unit => unit.data.assignment?.destinationId === object.id && unit.data.assignment.phase === 'handover').map(unit => unit.object.id) })),
    }
  }
  if (config.request.capabilityId === ambulanceQueryKinds[2]) {
    const input = optionsInput.parse(config.request.input)
    const selectedUnit = input.action === 'transport' ? units.find(unit => unit.object.id === input.ambulanceId) : undefined
    if (input.action === 'transport' && !selectedUnit) throw new Error('Response unit does not exist')
    const patientIds = input.action === 'dispatch' ? input.patientIds : selectedUnit?.data.assignment?.patientIds ?? []
    const group = patientIds.map(id => { const patient = patients.find(patient => patient.object.id === id); if (!patient) throw new Error('Patient does not exist: ' + id); return patient.object })
    const incident = input.action === 'dispatch' ? incidents.find(incident => incident.object.id === input.incidentId)?.object : undefined
    const candidateUnits = input.action === 'dispatch' ? units : []
    const candidates = page(candidateUnits, input).map(({ object }) => {
      const reasons = dispatchEligibility(object, incident, group, config.objects)
      return { id: object.id, label: object.label, eligible: reasons.length === 0, reasons }
    })
    const destinations = page(careSites, input).map(({ object }) => {
      const reasons = input.action === 'transport' ? transportEligibility(selectedUnit?.object, object, config.objects) : destinationEligibility(object, group)
      return { id: object.id, label: object.label, eligible: reasons.length === 0, reasons }
    })
    return { units: candidates, careSites: destinations, totals: { units: candidateUnits.length, careSites: careSites.length }, truncated: candidateUnits.length > input.offset + input.limit || careSites.length > input.offset + input.limit }
  }
  if (config.request.capabilityId === ambulanceQueryKinds[3]) {
    return {
      observedAt: config.at, simulationTimeMs: config.simulationTimeMs,
      incidents: { total: incidents.length, awaitingFirstArrival: incidents.filter(entry => entry.data.firstArrivalAtMs === undefined && entry.data.closedAtMs === undefined).length, firstResponse: durationSummary(incidents.flatMap(entry => interval(entry.data.receivedAtMs, entry.data.firstArrivalAtMs))) },
      patients: { total: patients.length, active: patients.filter(entry => entry.data.disposition === 'active').length, delivered: patients.filter(entry => entry.data.disposition === 'delivered').length, noTransport: patients.filter(entry => entry.data.disposition === 'no-transport').length,
        dispatchWait: durationSummary(patients.flatMap(entry => interval(entry.data.createdAtMs, entry.data.assignedAtMs))), mobilization: durationSummary(patients.flatMap(entry => interval(entry.data.assignedAtMs, entry.data.departedAtMs))), timeToContact: durationSummary(patients.flatMap(entry => interval(entry.data.createdAtMs, entry.data.contactedAtMs))), transport: durationSummary(patients.flatMap(entry => interval(entry.data.pickedUpAtMs, entry.data.arrivedAtSiteMs))), handoverWait: durationSummary(patients.flatMap(entry => interval(entry.data.arrivedAtSiteMs, entry.data.handoverStartedAtMs))), handover: durationSummary(patients.flatMap(entry => interval(entry.data.handoverStartedAtMs, entry.data.completedAtMs))) },
      units: { total: units.length, dispatchable: units.filter(entry => entry.data.crewReady && (!entry.data.assignment || entry.data.assignment.phase === 'returning')).length, assigned: units.filter(entry => !!entry.data.assignment).length, busySeconds: units.reduce((sum, entry) => sum + entry.data.busyTimeMs / 1000, 0) },
      limitations: ['Operational logistics model, not patient physiology or validated clinical outcomes.', 'Service durations and capabilities are authored assumptions.', 'Dispatchable and assigned counts overlap for returning units that may be redeployed.', 'Receiving intervals describe the current/final site; prior retargeted visits remain in the event journal.', 'Missing milestone intervals are excluded; this is not a clinical performance benchmark.'],
    }
  }
  throw new Error('Ambulance Pack does not support query Capability: ' + config.request.capabilityId)
}
