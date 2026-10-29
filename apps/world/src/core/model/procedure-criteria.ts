import { z } from 'zod'
import { parseProcedureAssessment, type ProcedureAssessmentCondition } from '@leitbild/procmd'
import { isoTimestampSchema } from './time.ts'

export const authoredConditionSchema = z.unknown().transform((value, context): ProcedureAssessmentCondition | typeof z.NEVER => {
  try { return parseProcedureAssessment({ condition: value }).condition }
  catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) }); return z.NEVER }
})
const statusSchema = z.enum(['supported', 'contradicted', 'unknown'])
export type ProcedureCriterionStatus = z.infer<typeof statusSchema>

export const procedureCriterionReadingSchema = z.object({
  source: z.string().min(1),
  description: z.string().optional(),
  tagId: z.string().optional(),
  operator: z.string().optional(),
  expected: z.union([z.number().finite(), z.boolean()]).optional(),
  evidence: z.enum(['instrument', 'engineering-diagnostic']).optional(),
  bound: z.enum(['value', 'lower', 'upper']).optional(),
  value: z.union([z.number().finite(), z.boolean()]).optional(),
  unit: z.string().optional(),
  sampledAt: isoTimestampSchema.optional(),
  path: z.string().optional(),
  writable: z.boolean().optional(),
  binding: z.enum(['resolved', 'resolved-with-warnings', 'missing', 'unchecked']).optional(),
  warnings: z.array(z.string()).optional(),
  quality: z.string().optional(),
  conversionStatus: z.enum(['native', 'converted', 'unavailable']).optional(),
  scopeId: z.string().optional(),
  signalTagId: z.string().optional(),
  acquiredEvidence: z.enum(['instrument', 'engineering-diagnostic']).optional(),
  provenance: z.string().optional(),
  modelRef: z.string().optional(),
  modelDigest: z.string().optional(),
  automationRef: z.string().optional(),
  automationDigest: z.string().optional(),
  status: statusSchema,
  reason: z.string().optional(),
}).strict()

export const procedureBranchAssessmentSchema = z.object({
  branchIndex: z.number().int().nonnegative(),
  status: statusSchema,
  simulationTime: isoTimestampSchema,
  condition: authoredConditionSchema.optional(),
  observation: z.object({ capabilityId: z.string().min(1), input: z.record(z.string(), z.unknown()), source: z.string().min(1), maxAgeSeconds: z.number().finite().nonnegative(), result: z.record(z.string(), z.unknown()).optional() }).strict().optional(),
  applicability: z.object({ description: z.string().min(1), source: z.string().min(1),
    model: z.object({ ref: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
    automation: z.object({ ref: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  }).strict().optional(),
  readings: z.array(procedureCriterionReadingSchema),
  reasons: z.array(z.string()),
}).strict()
export type ProcedureBranchAssessment = z.infer<typeof procedureBranchAssessmentSchema>
export type ProcedureCriterionReading = z.infer<typeof procedureCriterionReadingSchema>

