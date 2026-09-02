import { z } from 'zod'
import { geoJsonPointSchema, objectIdSchema } from '../../core/model/index.ts'

export const assignToIncidentCommandKind = 'world.ambulance.assign-to-incident'
export const createObjectCommandKind = 'world.ambulance.create-object'
export const setDestinationCommandKind = 'world.ambulance.set-destination'
export const cancelDestinationCommandKind = 'world.ambulance.cancel-destination'

export const assignToIncidentPayloadSchema = z.object({
  ambulanceId: objectIdSchema,
  incidentId: objectIdSchema,
})

export type AssignToIncidentPayload = z.infer<typeof assignToIncidentPayloadSchema>

export const creatableAmbulanceObjectTypeSchema = z.enum(['ambulance', 'hospital', 'incident'])
export type CreatableAmbulanceObjectType = z.infer<typeof creatableAmbulanceObjectTypeSchema>

export const createObjectPayloadSchema = z.object({
  objectType: creatableAmbulanceObjectTypeSchema,
  label: z.string().min(1).max(80),
  point: geoJsonPointSchema,
})

export type CreateObjectPayload = z.infer<typeof createObjectPayloadSchema>

export const setDestinationPayloadSchema = z.object({
  ambulanceId: objectIdSchema,
  destinationId: objectIdSchema,
})

export type SetDestinationPayload = z.infer<typeof setDestinationPayloadSchema>

export const cancelDestinationPayloadSchema = z.object({
  ambulanceId: objectIdSchema,
})

export type CancelDestinationPayload = z.infer<typeof cancelDestinationPayloadSchema>
