import { z } from 'zod'
import { objectIdSchema } from '../../core/model/index.ts'
import { careSitePackDataSchema, careTagsSchema, urgencySchema } from './model.ts'
import { ambulanceItemSchema } from './item-schemas.ts'

export const createItemCommandKind = 'world.ambulance.create-item'
export const assignCommandKind = 'world.ambulance.assign'
export const appendStopCommandKind = 'world.ambulance.append-stop'
export const cancelCommandKind = 'world.ambulance.cancel'
export const returnToBaseCommandKind = 'world.ambulance.return-to-base'
export const setUnitReadinessCommandKind = 'world.ambulance.set-unit-readiness'
export const setCareSiteCommandKind = 'world.ambulance.set-care-site'
export const setPatientAssessmentCommandKind = 'world.ambulance.set-patient-assessment'
export const setPatientDispositionCommandKind = 'world.ambulance.set-patient-disposition'
export const createItemPayloadSchema = z.object({ item: ambulanceItemSchema }).strict()
export const assignPayloadSchema = z.object({
  unitId: objectIdSchema, incidentId: objectIdSchema,
  patientIds: z.array(objectIdSchema).min(1).max(64).refine(ids => new Set(ids).size === ids.length, 'Patient IDs must be unique'),
}).strict()
export const appendStopPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pickup'), unitId: objectIdSchema, incidentId: objectIdSchema, patientIds: z.array(objectIdSchema).min(1).max(64).refine(ids => new Set(ids).size === ids.length, 'Patient IDs must be unique') }).strict(),
  z.object({ kind: z.literal('handover'), unitId: objectIdSchema, careSiteId: objectIdSchema, patientIds: z.array(objectIdSchema).min(1).max(64).refine(ids => new Set(ids).size === ids.length, 'Patient IDs must be unique') }).strict(),
])
export const unitPayloadSchema = z.object({ unitId: objectIdSchema }).strict()
export const setUnitReadinessPayloadSchema = unitPayloadSchema.extend({ ready: z.boolean() }).strict()
export const setCareSitePayloadSchema = z.object({
  careSiteId: objectIdSchema, accepting: z.boolean().optional(),
  handoverSlots: careSitePackDataSchema.shape.handoverSlots.optional(),
  handoverSeconds: careSitePackDataSchema.shape.handoverSeconds.optional(),
  capabilities: careTagsSchema.optional(), acceptedUrgencies: careSitePackDataSchema.shape.acceptedUrgencies.optional(),
}).strict().refine(input => Object.keys(input).length > 1, 'Provide at least one care-site setting')
export const setPatientAssessmentPayloadSchema = z.object({ patientId: objectIdSchema, assessedUrgency: urgencySchema, needs: careTagsSchema }).strict()
export const setPatientDispositionPayloadSchema = z.object({ patientId: objectIdSchema, disposition: z.literal('no-transport'), reason: z.string().trim().min(1).max(500) }).strict()
export const ambulanceCommandSchemas = {
  [createItemCommandKind]: createItemPayloadSchema, [assignCommandKind]: assignPayloadSchema,
  [appendStopCommandKind]: appendStopPayloadSchema, [cancelCommandKind]: unitPayloadSchema,
  [returnToBaseCommandKind]: unitPayloadSchema, [setUnitReadinessCommandKind]: setUnitReadinessPayloadSchema,
  [setCareSiteCommandKind]: setCareSitePayloadSchema, [setPatientAssessmentCommandKind]: setPatientAssessmentPayloadSchema,
  [setPatientDispositionCommandKind]: setPatientDispositionPayloadSchema,
} as const
