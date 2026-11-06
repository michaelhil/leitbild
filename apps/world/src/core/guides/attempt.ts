import { z } from 'zod'
import { presentationReceiptSchema, presentationPromptEvidenceSchema, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { idSchema } from '../model/ids.ts'

const stamp = z.string().datetime({ offset: true })
export const guideAttemptIdSchema = z.string().uuid()
export const guidePromptSchema = z.object({ effectId: idSchema, requestId: z.string().min(1).max(256), messageId: z.string().min(1).max(256), room: workspaceResourceReferenceSchema, stepAttemptId: z.string().uuid() }).strict()
  .refine(value => value.room.moduleId === 'agents' && value.room.type === 'agents.room', { message: 'Prompt evidence belongs to one exact Agents Room' })
const conditionResultSchema = z.object({
  status: z.enum(['satisfied', 'contradicted', 'unknown', 'stale', 'refused']), reason: z.string(),
  at: stamp, sequence: z.number().int().nonnegative(), value: z.union([z.number(), z.string(), z.boolean()]).optional(),
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
    stepId: idSchema, outcome: z.enum(['acknowledged', 'satisfied', 'presented', 'responded', 'skipped']), at: stamp,
    evidence: conditionResultSchema.optional(),
    promptEvidence: presentationPromptEvidenceSchema.optional(),
  }).strict()),
  // Only this step's delivery results. Prior learning decisions retain semantic evidence, not continuous UI telemetry.
  receipts: z.array(z.object({ effectId: idSchema, receipt: presentationReceiptSchema }).strict()),
  prompt: guidePromptSchema.optional(),
}).strict()
export type GuideAttempt = z.infer<typeof guideAttemptSchema>

