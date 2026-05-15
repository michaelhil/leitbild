import { z } from 'zod'
import type { ObjectId } from '../../core/model/index.ts'

export const ambulanceDomainId = 'ambulance_dispatch' as const

export const ambulanceStatusSchema = z.enum([
  'available',
  'assigned',
  'en_route',
  'on_scene',
  'transporting',
  'at_hospital',
  'out_of_service',
])
export type AmbulanceStatus = z.infer<typeof ambulanceStatusSchema>

export const incidentStatusSchema = z.enum(['open', 'assigned', 'responding', 'resolved'])
export type IncidentStatus = z.infer<typeof incidentStatusSchema>

export const ambulanceDomainDataSchema = z.object({
  type: z.literal('ambulance'),
  crewStatus: z.enum(['ready', 'busy', 'unavailable']),
  equipment: z.array(z.string().min(1)),
})
export type AmbulanceDomainData = z.infer<typeof ambulanceDomainDataSchema>

export const incidentDomainDataSchema = z.object({
  type: z.literal('incident'),
  triage: z.enum(['green', 'yellow', 'red']),
  patientCount: z.number().int().positive(),
  assignedAmbulanceId: z.string().optional(),
})
export type IncidentDomainData = z.infer<typeof incidentDomainDataSchema>

export interface AmbulanceAssignment {
  readonly ambulanceId: ObjectId
  readonly incidentId: ObjectId
}
