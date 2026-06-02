import { z } from 'zod'
import { actorIdSchema, commandIdSchema, idSchema, objectIdSchema } from './ids.ts'
import { isoTimestampSchema } from './time.ts'

export const procedureSourceIdSchema = idSchema
export const procedureIdSchema = z.string().min(1).max(80).regex(/^[A-Z0-9][A-Z0-9._-]*$/)
export const procedureStepIdSchema = idSchema
export const procedureTagIdSchema = z.string().min(1).max(80).regex(/^[A-Z0-9][A-Z0-9._/-]*$/)
export const procedureRunIdSchema = z.string().min(1).max(128).regex(/^procedure-run:[a-zA-Z0-9._:-]+$/)

export type ProcedureSourceId = z.infer<typeof procedureSourceIdSchema>
export type ProcedureId = z.infer<typeof procedureIdSchema>
export type ProcedureStepId = z.infer<typeof procedureStepIdSchema>
export type ProcedureTagId = z.infer<typeof procedureTagIdSchema>
export type ProcedureRunId = z.infer<typeof procedureRunIdSchema>

export const procedureRunScopeSchema = z.object({
  systemId: idSchema,
  targetObjectId: objectIdSchema.optional(),
  label: z.string().min(1).max(160).optional(),
})
export type ProcedureRunScope = z.infer<typeof procedureRunScopeSchema>

export const procedureAssessmentSchema = z.enum(['blank', 'complete', 'failed', 'unknown'])
export type ProcedureAssessment = z.infer<typeof procedureAssessmentSchema>

export const procedureStepStatusSchema = z.enum(['met', 'not-met', 'unknown'])
export type ProcedureStepStatus = z.infer<typeof procedureStepStatusSchema>

export const procedureSourceSchema = z.object({
  sourceId: procedureSourceIdSchema,
  label: z.string().min(1),
  repository: z.string().min(1),
  ref: z.string().min(1),
  path: z.string().min(1),
  commitSha: z.string().min(1).optional(),
  fetchedAt: isoTimestampSchema,
  sourceUrl: z.string().url(),
})
export type ProcedureSource = z.infer<typeof procedureSourceSchema>

export const procedureTagSchema = z.object({
  id: procedureTagIdSchema,
  description: z.string().min(1).optional(),
  simPath: z.string().min(1).optional(),
  units: z.string().min(1).optional(),
  equipment: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  range: z.array(z.number().finite()).length(2).optional(),
})
export type ProcedureTag = z.infer<typeof procedureTagSchema>

export const procedureTextBlockSchema = z.object({
  kind: z.enum(['check', 'action', 'when', 'until', 'abort-if', 'abort-to', 'within', 'concurrent', 'caution', 'note', 'because', 'text']),
  text: z.string().min(1),
  tagIds: z.array(procedureTagIdSchema).default([]),
})
export type ProcedureTextBlock = z.infer<typeof procedureTextBlockSchema>

export const procedureBranchSchema = z.object({
  label: z.string().min(1),
  target: z.string().min(1),
  targetKind: z.enum(['step', 'procedure', 'end', 'retry', 'abort', 'unknown']),
  because: z.string().min(1).optional(),
  tagIds: z.array(procedureTagIdSchema).default([]),
})
export type ProcedureBranch = z.infer<typeof procedureBranchSchema>

export const procedureStepSchema = z.object({
  id: procedureStepIdSchema,
  label: z.string().min(1),
  title: z.string().min(1),
  level: z.number().int().min(2).max(6),
  blocks: z.array(procedureTextBlockSchema).default([]),
  branches: z.array(procedureBranchSchema).default([]),
  tagIds: z.array(procedureTagIdSchema).default([]),
  sourceLine: z.number().int().positive(),
})
export type ProcedureStep = z.infer<typeof procedureStepSchema>

export const procedureDocumentSchema = z.object({
  source: procedureSourceSchema,
  procedureId: procedureIdSchema,
  title: z.string().min(1),
  profile: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  appliesTo: z.string().min(1).optional(),
  csfsMonitored: z.array(idSchema).default([]),
  entryTriggers: z.array(idSchema).default([]),
  description: z.string().default(''),
  sourcePath: z.string().min(1),
  sourceUrl: z.string().url(),
  rawMarkdown: z.string(),
  steps: z.array(procedureStepSchema).default([]),
  tags: z.array(procedureTagSchema).default([]),
})
export type ProcedureDocument = z.infer<typeof procedureDocumentSchema>

export const procedureCatalogItemSchema = z.object({
  sourceId: procedureSourceIdSchema,
  procedureId: procedureIdSchema,
  title: z.string().min(1),
  profile: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  csfsMonitored: z.array(idSchema).default([]),
  entryTriggers: z.array(idSchema).default([]),
  stepCount: z.number().int().nonnegative(),
  tagCount: z.number().int().nonnegative(),
  sourcePath: z.string().min(1),
  sourceUrl: z.string().url(),
})
export type ProcedureCatalogItem = z.infer<typeof procedureCatalogItemSchema>

export const procedureCatalogSchema = z.object({
  source: procedureSourceSchema,
  procedures: z.array(procedureCatalogItemSchema),
})
export type ProcedureCatalog = z.infer<typeof procedureCatalogSchema>

export const procedureStepRunStateSchema = z.object({
  stepId: procedureStepIdSchema,
  assessment: procedureAssessmentSchema.default('blank'),
  comment: z.string().max(10_000).optional(),
  favorite: z.boolean().default(false),
  updatedAt: isoTimestampSchema,
  updatedBy: actorIdSchema,
})
export type ProcedureStepRunState = z.infer<typeof procedureStepRunStateSchema>

export const procedureRunStatusSchema = z.enum(['active', 'completed', 'abandoned'])
export type ProcedureRunStatus = z.infer<typeof procedureRunStatusSchema>

export const procedureRunStateSchema = z.object({
  runId: procedureRunIdSchema,
  sourceId: procedureSourceIdSchema,
  sourceRevision: z.string().min(1).optional(),
  procedureId: procedureIdSchema,
  scope: procedureRunScopeSchema,
  title: z.string().min(1),
  status: procedureRunStatusSchema,
  startedAt: isoTimestampSchema,
  startedBy: actorIdSchema,
  closedAt: isoTimestampSchema.optional(),
  closedBy: actorIdSchema.optional(),
  currentStepId: procedureStepIdSchema.optional(),
  stepStates: z.array(procedureStepRunStateSchema).default([]),
})
export type ProcedureRunState = z.infer<typeof procedureRunStateSchema>

export const procedureControlStateSchema = z.object({
  runs: z.array(procedureRunStateSchema).default([]),
})
export type ProcedureControlState = z.infer<typeof procedureControlStateSchema>

export const procedureRunStartPayloadSchema = z.object({
  sourceId: procedureSourceIdSchema,
  procedureId: procedureIdSchema,
  scope: procedureRunScopeSchema,
})
export type ProcedureRunStartPayload = z.infer<typeof procedureRunStartPayloadSchema>

export const procedureStepUpdatePayloadSchema = z.object({
  runId: procedureRunIdSchema,
  stepId: procedureStepIdSchema,
  assessment: procedureAssessmentSchema.optional(),
  comment: z.string().max(10_000).optional(),
  favorite: z.boolean().optional(),
  currentStepId: procedureStepIdSchema.optional(),
}).superRefine((payload, ctx) => {
  if (
    payload.assessment === undefined
      && payload.comment === undefined
      && payload.favorite === undefined
      && payload.currentStepId === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'procedure step update requires assessment, comment, favorite, or currentStepId',
    })
  }
})
export type ProcedureStepUpdatePayload = z.infer<typeof procedureStepUpdatePayloadSchema>

export const procedureRunClosePayloadSchema = z.object({
  runId: procedureRunIdSchema,
  status: z.enum(['completed', 'abandoned']),
})
export type ProcedureRunClosePayload = z.infer<typeof procedureRunClosePayloadSchema>

export const procedureRunResetPayloadSchema = z.object({
  sourceId: procedureSourceIdSchema,
  procedureId: procedureIdSchema,
  scope: procedureRunScopeSchema,
})
export type ProcedureRunResetPayload = z.infer<typeof procedureRunResetPayloadSchema>

export const procedureRunStartedEventSchema = z.object({
  type: z.literal('procedure.run.started'),
  run: procedureRunStateSchema,
})

export const procedureStepUpdatedEventSchema = z.object({
  type: z.literal('procedure.step.updated'),
  runId: procedureRunIdSchema,
  stepId: procedureStepIdSchema,
  update: z.object({
    assessment: procedureAssessmentSchema.optional(),
    comment: z.string().max(10_000).optional(),
    favorite: z.boolean().optional(),
  }),
  currentStepId: procedureStepIdSchema.optional(),
  updatedAt: isoTimestampSchema,
  updatedBy: actorIdSchema,
})

export const procedureRunClosedEventSchema = z.object({
  type: z.literal('procedure.run.closed'),
  runId: procedureRunIdSchema,
  status: z.enum(['completed', 'abandoned']),
  closedAt: isoTimestampSchema,
  closedBy: actorIdSchema,
})

export const procedureRunResetEventSchema = z.object({
  type: z.literal('procedure.run.reset'),
  sourceId: procedureSourceIdSchema,
  procedureId: procedureIdSchema,
  scope: procedureRunScopeSchema,
  resetAt: isoTimestampSchema,
  resetBy: actorIdSchema,
})

export const procedureCommandKindSchema = z.enum([
  'procedure.run.start',
  'procedure.step.update',
  'procedure.run.close',
  'procedure.run.reset',
])
export type ProcedureCommandKind = z.infer<typeof procedureCommandKindSchema>

export const createProcedureRunId = (): ProcedureRunId =>
  procedureRunIdSchema.parse(`procedure-run:${crypto.randomUUID()}`)

export const procedureCommandIdempotencyKey = (commandId: z.infer<typeof commandIdSchema>): string =>
  `procedure-command:${commandId}`
