import { z } from 'zod'
import { embeddedViewPublicationSchema } from '@leitbild/contracts'
import { certificateSchema, instantSchema, keySchema, labelSchema, planInputsSchema } from '../plan/schema.ts'
import { statusOutSchema } from './contract.ts'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const scheduleDisplayInputSchema = z.object({
  option: keySchema.optional().describe('Retained option to show, including a deadline what-if or refusal; default the recommended option'),
  digest: digestSchema.optional().describe('From the published view state: refuse if the retained option, reference schedule or inputs changed; omit only to publish a new view'),
  reference: keySchema.nullable().optional().describe('With digest, the exact published reference option key, or explicit null for no reference; omit when publishing a new view'),
}).strict().superRefine((input, context) => {
  if (input.digest !== undefined && (input.option === undefined || input.reference === undefined)) context.addIssue({ code: 'custom', path: ['reference'], message: 'A pinned schedule read names its option and exact reference, or null, with its digest' })
  if (input.digest === undefined && input.reference !== undefined) context.addIssue({ code: 'custom', path: ['reference'], message: 'A reference is supplied only with a published digest' })
})
export const scheduleDisplayStateSchema = z.object({ plan: z.uuid(), option: keySchema, reference: keySchema.nullable(), digest: digestSchema }).strict()
const referenceSchema = z.object({ key: keySchema, label: labelSchema, inputsRevision: z.number().int().positive(), fresh: z.literal(true), cost: z.number().nullable(), finish: instantSchema }).strict()
export const scheduleDisplayResultSchema = z.object({
  view: embeddedViewPublicationSchema,
  schedule: z.object({
    plan: z.object({ id: z.uuid(), title: labelSchema, revision: z.number().int().positive(), timeZone: planInputsSchema.shape.settings.shape.timeZone, window: planInputsSchema.shape.settings.shape.window, currency: planInputsSchema.shape.settings.shape.currency }).strict(),
    option: z.object({ key: keySchema, label: labelSchema, inputsRevision: z.number().int().positive(), fresh: z.boolean(), status: statusOutSchema, cost: z.number().nullable(), finish: instantSchema.nullable() }).strict(),
    deadline: z.object({ job: keySchema, finishBy: instantSchema }).strict().nullable(),
    certificate: certificateSchema.nullable(),
    reference: referenceSchema.nullable(),
    digest: digestSchema,
  }).strict(),
}).strict()
export type ScheduleDisplayResult = z.infer<typeof scheduleDisplayResultSchema>
