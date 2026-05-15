import { z } from 'zod'
import { objectIdSchema } from '../../core/model/index.ts'

export const assignToIncidentCommandKind = 'ambulance.assign_to_incident'

export const assignToIncidentPayloadSchema = z.object({
  ambulanceId: objectIdSchema,
  incidentId: objectIdSchema,
})

export type AssignToIncidentPayload = z.infer<typeof assignToIncidentPayloadSchema>
