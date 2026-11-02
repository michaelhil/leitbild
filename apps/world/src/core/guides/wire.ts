import { z } from 'zod'
import { presentationRecipientSchema, presentationReceiptSchema, presentationRequestSchema, presentationTargetSchema } from '@leitbild/contracts'
import { guideAttemptSchema } from './attempt.ts'
import { guideEffectSchema } from './model.ts'

const effect = guideEffectSchema.extend({ requestId: z.string().optional(), delivery: z.string().optional(), reason: z.string().optional() }).strict()
export const guideReadingSchema = z.object({
  available: z.literal(true), title: z.string(), description: z.string().optional(), attemptId: z.string().uuid().optional(),
  revision: z.number().int().nonnegative().optional(), status: guideAttemptSchema.shape.status.optional(), stepAttemptId: z.string().uuid().optional(),
  step: z.object({ id: z.string(), title: z.string(), instruction: z.string(), help: z.string().optional(), completion: z.enum(['acknowledge', 'condition', 'presentation']), effects: z.array(effect) }).strict().optional(),
  completed: guideAttemptSchema.shape.completed.optional(), receipts: guideAttemptSchema.shape.receipts.optional(),
  condition: z.object({ status: z.enum(['satisfied', 'contradicted', 'unknown', 'stale', 'refused']), reason: z.string(), at: z.string(), sequence: z.number(), value: z.union([z.string(), z.number()]).optional(), clock: z.enum(['wall', 'simulation']).optional(), ref: z.string().optional(), unit: z.string().optional() }).strict().optional(),
}).strict()
export type GuideReading = z.infer<typeof guideReadingSchema>

export const presentationOutputs = {
  register: presentationRecipientSchema,
  poll: z.object({ recipient: presentationRecipientSchema, requests: z.array(presentationRequestSchema) }).strict(),
  unregister: z.object({ closed: z.literal(true) }).strict(),
  targets: z.object({ targets: z.array(z.object({ target: presentationTargetSchema, label: z.string(), actions: z.array(z.enum(['focus', 'reveal', 'highlight', 'explain', 'draft'])) }).strict()), nextOffset: z.number().optional() }).strict(),
  request: z.object({ requestId: z.string(), status: z.literal('pending'), expiresAt: z.string().datetime({ offset: true }) }).strict(),
  result: z.object({ requestId: z.string(), status: z.enum(['pending', 'applied', 'declined', 'unavailable', 'expired', 'superseded', 'cancelled']), receipt: presentationReceiptSchema.optional() }).strict(),
  cancel: z.object({ requestId: z.string(), clearRequestId: z.string(), status: z.literal('cancelled') }).strict(),
  receipt: presentationReceiptSchema,
}

