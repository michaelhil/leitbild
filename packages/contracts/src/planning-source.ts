import { z } from 'zod'
import { workspaceResourceReferenceSchema } from './resources.ts'

export const planningSourceProfileSchema = z.enum(['einsatz', 'process-plant'])
export type PlanningSourceProfile = z.infer<typeof planningSourceProfileSchema>
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const planningWorldSourceSchema = workspaceResourceReferenceSchema.refine(
  source => source.moduleId === 'world' && source.type === 'world.simulation-run',
  'Planning source must be a World Simulation Run',
)
export const planningSourceRequestSchema = z.object({
  source: planningWorldSourceSchema,
  profile: planningSourceProfileSchema,
  subjectIds: z.array(z.string().min(1).max(512)).min(1).max(32).optional(),
}).strict()
export type PlanningSourceRequest = z.infer<typeof planningSourceRequestSchema>

export const planningSourceFactSchema = z.object({
  id: z.string().min(1).max(512),
  label: z.string().min(1).max(160),
  semantic: z.enum(['duration', 'capacity', 'state', 'quantity']),
  value: z.union([z.number().finite(), z.string().max(512), z.boolean()]),
  unit: z.string().max(32).optional(),
  basis: z.enum(['observation', 'owner-estimate']),
}).strict()
export type PlanningSourceFact = z.infer<typeof planningSourceFactSchema>
export const planningSourceSubjectSchema = z.object({
  locator: z.string().min(1).max(512),
  label: z.string().min(1).max(160),
  kind: z.string().min(1).max(80),
  facts: z.array(planningSourceFactSchema).max(128),
}).strict()
export type PlanningSourceSubject = z.infer<typeof planningSourceSubjectSchema>

/** Pack-owned query answer. World adds the Run frame and shared-input qualification. */
export const planningOwnerBasisSchema = z.object({
  simulationAt: z.string().datetime(),
  subjects: z.array(planningSourceSubjectSchema).min(1).max(32),
}).strict()
export const planningOwnerBasisInputSchema = z.object({
  subjectIds: z.array(z.string().min(1).max(512)).min(1).max(32).optional(),
}).strict()
export const planningSourceQualificationSchema = z.object({
  audience: z.literal('shared-research'),
  epoch: z.string().uuid(),
  restrictionRevision: z.number().int().nonnegative(),
  subjectIds: z.array(z.string().min(1).max(512)).min(1).max(32),
}).strict()
export const planningSourceBasisSchema = z.object({
  source: planningWorldSourceSchema,
  profile: planningSourceProfileSchema,
  observedAt: z.string().datetime(),
  simulationAt: z.string().datetime(),
  sequence: z.number().int().nonnegative(),
  subjects: z.array(planningSourceSubjectSchema).min(1).max(32),
  digest: digestSchema,
  qualification: planningSourceQualificationSchema,
}).strict()
export type PlanningSourceBasis = z.infer<typeof planningSourceBasisSchema>
export const planningSourceQualifyInputSchema = z.object({
  profile: planningSourceProfileSchema,
  qualification: planningSourceQualificationSchema,
  activation: z.enum(['loaded-only', 'load-if-needed']),
}).strict()
export const planningSourceQualificationResultSchema = z.object({
  allowed: z.boolean(),
  code: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
}).strict()
export type PlanningSourceQualificationResult = z.infer<typeof planningSourceQualificationResultSchema>
