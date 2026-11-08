import { z } from 'zod'
import { workspaceResourceReferenceSchema } from './resources.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const engineeringProfileSchema = z.enum(['plant-thermal', 'grid-balance'])
export const engineeringProfileRevisionSchema = z.literal('engineering-research-1')
export const engineeringQuantitySchema = z.object({
  id: z.string().min(1).max(160), label: z.string().min(1).max(160),
  quantity: z.string().min(1).max(80), unit: z.string().min(1).max(32),
  value: z.number().finite(), quality: z.enum(['good', 'unknown']),
}).strict()
export const engineeringQualificationFrameSchema = z.object({
  epoch: z.string().uuid(), scenarioDigest: digest, restrictionRevision: z.number().int().nonnegative(),
}).strict()
export const engineeringInputFrameSchema = engineeringQualificationFrameSchema.extend({
  sequence: z.number().int().nonnegative(), simulationAt: z.string().datetime(), observedAt: z.string().datetime(),
}).strict()
export const engineeringCaptureInputSchema = z.object({
  profile: engineeringProfileSchema, subjectId: z.string().min(1).max(160),
}).strict()
export const engineeringInputBasisSchema = engineeringCaptureInputSchema.extend({
  source: workspaceResourceReferenceSchema,
  profileRevision: engineeringProfileRevisionSchema,
  frame: engineeringInputFrameSchema,
  quantities: z.array(engineeringQuantitySchema).min(1).max(32), digest,
}).strict()
export const engineeringQualifyInputSchema = engineeringCaptureInputSchema.extend({
  profileRevision: engineeringProfileRevisionSchema, frame: engineeringQualificationFrameSchema,
}).strict()
export const engineeringQualificationResultSchema = z.object({
  allowed: z.boolean(), code: z.string().min(1).optional(), reason: z.string().min(1).optional(),
}).strict()

export const engineeringInterventionSchema = z.object({
  atSeconds: z.number().int().nonnegative().max(600),
  path: z.string().min(1).max(160), value: z.union([z.number().finite(), z.boolean()]),
}).strict()
export const engineeringContinuationSubmitSchema = z.object({
  profile: z.literal('plant-thermal'), subjectId: z.string().min(1).max(160),
  horizonSeconds: z.number().int().positive().max(600),
  sampleEverySeconds: z.number().int().positive().max(60).default(5),
  variant: z.object({ label: z.string().trim().min(1).max(100), actions: z.array(engineeringInterventionSchema).min(1).max(16) }).strict(),
  /** A deliberate rerun uses the retained origin with a new submission key. */
  replayJobId: z.string().uuid().optional(),
}).strict().superRefine((value, context) => {
  const used = new Set<string>()
  value.variant.actions.forEach((action, index) => {
    if (action.atSeconds > value.horizonSeconds) context.addIssue({ code: 'custom', path: ['variant', 'actions', index], message: 'Intervention is after the horizon' })
    const key = `${action.atSeconds}:${action.path}`
    if (used.has(key)) context.addIssue({ code: 'custom', path: ['variant', 'actions', index], message: 'Conflicting simultaneous controls on the same path' })
    used.add(key)
  })
})
export const engineeringContinuationInspectSchema = z.object({
  jobId: z.string().uuid(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20),
}).strict()
export const engineeringContinuationCancelSchema = z.object({ jobId: z.string().uuid() }).strict()
export const engineeringContinuationSampleSchema = z.object({
  elapsedSeconds: z.number().finite().nonnegative(), simulationAt: z.string().datetime(),
  modelElapsedMs: z.number().finite().nonnegative(), quantities: z.array(engineeringQuantitySchema).max(32),
}).strict()
export const engineeringInterventionReceiptSchema = engineeringInterventionSchema.extend({
  acceptedAt: z.string().datetime().nullable(), status: z.enum(['accepted', 'refused', 'unknown']),
  reason: z.string().max(2000).optional(),
  application: z.literal('queued-owner-write'),
}).strict()
export const engineeringContinuationCaseSchema = z.object({
  id: z.enum(['baseline', 'variant']), label: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'partial', 'failed']),
  reachedSeconds: z.number().finite().nonnegative(), modelElapsedMs: z.number().finite().nonnegative(),
  reason: z.string().max(2000).optional(),
  interventions: z.array(engineeringInterventionReceiptSchema).max(16),
  sampleCount: z.number().int().nonnegative(), samples: z.array(engineeringContinuationSampleSchema).max(601),
}).strict()
export const engineeringContinuationReceiptSchema = z.object({
  jobId: z.string().uuid(), source: workspaceResourceReferenceSchema,
  status: z.enum(['queued', 'running', 'cancellation-requested', 'completed', 'partial', 'failed', 'cancelled', 'interrupted']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  request: engineeringContinuationSubmitSchema,
  origin: engineeringInputBasisSchema,
  reason: z.string().max(2000).optional(),
  cases: z.array(engineeringContinuationCaseSchema).max(2),
  sampleOffset: z.number().int().nonnegative(), sampleLimit: z.number().int().nonnegative(),
  limits: z.object({ wallSeconds: z.number().positive(), workerCount: z.number().int().positive(), outputBytes: z.number().int().positive() }).strict(),
  evidenceKind: z.literal('exact-state-conditional-continuation'),
  executionDigest: digest,
  observationGrid: z.literal('new-grid-at-captured-origin'),
  qualification: z.literal('research-only'),
}).strict()
/** Safe cancellation acknowledgement when the source no longer qualifies for
 * returning its retained values. This contains no source facts or view. */
export const engineeringContinuationCancellationSchema = z.object({
  jobId: z.string().uuid(), status: z.enum(['completed', 'partial', 'failed', 'cancelled', 'interrupted']),
  evidenceAvailable: z.literal(false),
}).strict()
export type EngineeringProfile = z.infer<typeof engineeringProfileSchema>
export type EngineeringQuantity = z.infer<typeof engineeringQuantitySchema>
export type EngineeringInputBasis = z.infer<typeof engineeringInputBasisSchema>
export type EngineeringQualifyInput = z.infer<typeof engineeringQualifyInputSchema>
export type EngineeringContinuationSubmit = z.infer<typeof engineeringContinuationSubmitSchema>
export type EngineeringContinuationReceipt = z.infer<typeof engineeringContinuationReceiptSchema>
export type EngineeringContinuationCase = z.infer<typeof engineeringContinuationCaseSchema>
