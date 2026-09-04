import { z } from 'zod'
import { notificationIdSchema, objectIdSchema, type InteractionEffect, type InteractionHandler, type InteractionSignal, type OperationalObject } from '../../core/model/index.ts'
import { ambulancePackId, incidentPackDataSchema, patientPackDataSchema } from './model.ts'

export const reconnaissanceObservationSignalType = 'reconnaissance.observation.requested'
const reconnaissancePayloadSchema = z.object({
  observerId: objectIdSchema,
  targetId: objectIdSchema,
  sensorId: z.string().min(1).max(128),
  observedAtMs: z.number().finite().nonnegative(),
}).strict()

const notification = (signal: InteractionSignal, message: string, severity: 'notice' | 'warning'): InteractionEffect => ({
  type: 'notification.emit',
  notification: {
    id: notificationIdSchema.parse(`notification:reconnaissance:${crypto.randomUUID()}`),
    simulationRunId: signal.simulationRunId,
    at: signal.at,
    title: severity === 'notice' ? 'Incident observation recorded' : 'Incident observation rejected',
    message,
    severity,
    source: signal.source,
    targets: signal.targets,
    signalId: signal.id,
  },
})

const updateIncident = (object: OperationalObject, packData: z.infer<typeof incidentPackDataSchema>, at: InteractionSignal['at']): OperationalObject => ({
  ...object,
  revision: object.revision + 1,
  packData,
  provenance: { source: 'simulator', externalId: object.id },
  timestamps: { ...object.timestamps, updatedAt: at },
})

/** Ambulance owns the meaning of an incident observation. The Drone signal only
 * proves that a validated sensor observed a target; it never imports or mutates
 * medical state itself. */
export const createIncidentObservationHandler = (): InteractionHandler => ({
  id: 'ambulance.incident-observation',
  priority: 60,
  accepts: signal => signal.type === reconnaissanceObservationSignalType,
  handle: async ({ signal, snapshot }) => {
    const payload = reconnaissancePayloadSchema.parse(signal.payload)
    const observer = snapshot.objects.find(object => object.id === payload.observerId)
    if (!observer || signal.source.kind !== 'object' || signal.source.id !== observer.id) {
      return [notification(signal, 'The reconnaissance observer is not available', 'warning')]
    }
    if (!signal.targets.some(target => target.kind === 'object' && target.id === payload.targetId)) {
      return [notification(signal, 'The reconnaissance target does not match the signal target', 'warning')]
    }
    const target = snapshot.objects.find(object => object.id === payload.targetId)
    if (!target || target.packId !== ambulancePackId) return []
    const incident = incidentPackDataSchema.safeParse(target.packData)
    if (!incident.success) return [notification(signal, `${target.label} is not an Ambulance incident`, 'warning')]
    const casualties = snapshot.objects.flatMap(object => {
      if (object.packId !== ambulancePackId) return []
      const patient = patientPackDataSchema.safeParse(object.packData)
      return patient.success && patient.data.incidentId === target.id
        ? [{ patientId: object.id, assessedUrgency: patient.data.assessedUrgency, needs: patient.data.needs }]
        : []
    })
    const observation = {
      observerId: payload.observerId,
      sensorId: payload.sensorId,
      observedAtMs: payload.observedAtMs,
      casualtyCount: casualties.length,
      casualties,
    }
    const packData = incidentPackDataSchema.parse({
      ...incident.data,
      observations: [...incident.data.observations, observation].slice(-1_000),
    })
    return [
      { type: 'object.upsert', object: updateIncident(target, packData, signal.at) },
      notification(signal, `${observer.label} observed ${casualties.length} casualties at ${target.label}`, 'notice'),
    ]
  },
})
