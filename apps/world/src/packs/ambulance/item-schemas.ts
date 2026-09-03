import { z } from 'zod'
import { objectIdSchema } from '../../core/model/index.ts'
import { careTagsSchema, careSitePackDataSchema, serviceSecondsSchema, urgencySchema } from './model.ts'

const position = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)])
const common = { id: objectIdSchema, label: z.string().trim().min(1).max(120) }
const place = { position: position.optional(), atObject: objectIdSchema.optional() }
export const ambulanceSpecSchema = z.object({
  ...common, ...place, type: z.literal('ambulance'),
  patientCapacity: z.number().int().min(1).max(64), capabilities: careTagsSchema, crewReady: z.boolean(),
  mobilizationSeconds: serviceSecondsSchema, sceneSeconds: serviceSecondsSchema,
  basePosition: position.optional(),
}).strict()
export const incidentSpecSchema = z.object({ ...common, ...place, type: z.literal('incident'), summary: z.string().max(2_000), dispatchUrgency: urgencySchema }).strict()
export const patientSpecSchema = z.object({ ...common, type: z.literal('patient'), incidentId: objectIdSchema, summary: z.string().max(2_000), assessedUrgency: urgencySchema, needs: careTagsSchema }).strict()
export const careSiteSpecSchema = z.object({
  ...common, ...place, type: z.literal('care-site'), capabilities: careTagsSchema,
  acceptedUrgencies: careSitePackDataSchema.shape.acceptedUrgencies,
  handoverSlots: careSitePackDataSchema.shape.handoverSlots, handoverSeconds: serviceSecondsSchema, accepting: z.boolean(),
}).strict()
export const ambulanceItemSchema = z.discriminatedUnion('type', [ambulanceSpecSchema, incidentSpecSchema, patientSpecSchema, careSiteSpecSchema]).superRefine((item, context) => {
  if (item.type !== 'patient' && Number(item.position !== undefined) + Number(item.atObject !== undefined) !== 1) context.addIssue({ code: 'custom', message: 'Provide exactly one position or atObject', path: ['position'] })
})
export type AmbulanceItem = z.infer<typeof ambulanceItemSchema>
