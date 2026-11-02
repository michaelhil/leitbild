import { z } from 'zod'
import { presentationReceiptSchema } from '@leitbild/contracts'
import { idSchema } from '../model/ids.ts'

const stamp = z.string().datetime({ offset: true })
export const guideAttemptIdSchema = z.string().uuid()
const conditionResultSchema = z.object({
  status: z.enum(['satisfied', 'contradicted', 'unknown', 'stale', 'refused']), reason: z.string(),
  at: stamp, sequence: z.number().int().nonnegative(), value: z.union([z.number(), z.string()]).optional(),
  clock: z.enum(['simulation', 'wall']).optional(), ref: z.string().optional(), unit: z.string().optional(),
}).strict()
export const guideAttemptSchema = z.object({
  id: guideAttemptIdSchema,
  guideId: idSchema,
  guideDigest: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(),
  createdAt: stamp,
  updatedAt: stamp,
  status: z.enum(['active', 'paused', 'completed', 'stopped']),
  roleIds: z.array(idSchema),
  stepId: idSchema,
  stepAttemptId: z.string().uuid(),
  completed: z.array(z.object({
    stepId: idSchema, outcome: z.enum(['acknowledged', 'satisfied', 'presented', 'skipped']), at: stamp,
    evidence: conditionResultSchema.optional(),
  }).strict()),
  // Only this step's delivery results. Prior learning decisions retain semantic evidence, not continuous UI telemetry.
  receipts: z.array(z.object({ effectId: idSchema, receipt: presentationReceiptSchema }).strict()),
}).strict()
export type GuideAttempt = z.infer<typeof guideAttemptSchema>

