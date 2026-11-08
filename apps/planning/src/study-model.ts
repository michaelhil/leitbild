import { z } from 'zod'
import { isoTimestampSchema, planningSourceBasisSchema, planningSourceRequestSchema, workspaceIdSchema } from '@leitbild/contracts'
import { planningIdSchema, planningProblemSchema, planningScheduleResultSchema, planningSubjectSchema } from './model.ts'

export const sourceBindingSchema = z.object({
  factId: z.string().min(1).max(512),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('duration'), activityId: planningIdSchema }).strict(),
    z.object({ kind: z.literal('remaining'), activityId: planningIdSchema }).strict(),
    z.object({ kind: z.literal('capacity'), supplyId: planningIdSchema }).strict(),
  ]),
}).strict()
export type SourceBinding = z.infer<typeof sourceBindingSchema>

/** Named authored quantities describe the research basis, never become World writes. */
export const planningAssumptionSchema = z.object({
  id: planningIdSchema,
  label: z.string().trim().min(1).max(256),
  value: z.union([z.number().finite(), z.boolean(), z.string().max(1024)]),
  unit: z.string().min(1).max(64).optional(),
  subject: planningSubjectSchema.optional(),
  activityId: planningIdSchema.optional(),
  rationale: z.string().max(2048).optional(),
}).strict()
export type PlanningAssumption = z.infer<typeof planningAssumptionSchema>

export const problemRevisionSchema = z.object({
  id: z.number().int().positive(),
  createdAt: isoTimestampSchema,
  problem: planningProblemSchema,
  basis: planningSourceBasisSchema.optional(),
  sourceRequest: planningSourceRequestSchema.optional(),
  sourceEpochAt: isoTimestampSchema.optional(),
  sourceBindings: z.array(sourceBindingSchema),
  assumptions: z.array(planningAssumptionSchema),
}).strict().superRefine((revision, context) => {
  if ((revision.basis === undefined) !== (revision.sourceRequest === undefined)) context.addIssue({ code: 'custom', path: ['basis'], message: 'Retained source evidence and its capture request must occur together' })
  if ((revision.basis === undefined) !== (revision.sourceEpochAt === undefined)) context.addIssue({ code: 'custom', path: ['sourceEpochAt'], message: 'Sourced revisions retain their original simulation epoch' })
})
export type ProblemRevision = z.infer<typeof problemRevisionSchema>

export const candidateSchema = z.object({
  id: z.uuid(),
  problemRevisionId: z.number().int().positive(),
  createdAt: isoTimestampSchema,
  result: planningScheduleResultSchema,
}).strict()
export type Candidate = z.infer<typeof candidateSchema>

export const studySchema = z.object({
  id: z.uuid(),
  workspaceId: workspaceIdSchema,
  title: z.string().trim().min(1).max(256),
  revision: z.number().int().positive(),
  currentProblemRevisionId: z.number().int().positive(),
  revisions: z.array(problemRevisionSchema).min(1),
  candidates: z.array(candidateSchema),
  baselineCandidateId: z.uuid().optional(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict().superRefine((study, context) => {
  const revisions = new Set<number>()
  for (const [index, revision] of study.revisions.entries()) {
    if (revisions.has(revision.id)) context.addIssue({ code: 'custom', path: ['revisions', index, 'id'], message: 'Duplicate problem revision' })
    revisions.add(revision.id)
    if (revision.problem.axis.run.workspaceId !== study.workspaceId) context.addIssue({ code: 'custom', path: ['revisions', index, 'problem', 'axis'], message: 'Study sources must belong to its Workspace' })
  }
  if (!revisions.has(study.currentProblemRevisionId)) context.addIssue({ code: 'custom', path: ['currentProblemRevisionId'], message: 'Current problem revision is absent' })
  const candidates = new Set<string>()
  for (const [index, candidate] of study.candidates.entries()) {
    if (candidates.has(candidate.id)) context.addIssue({ code: 'custom', path: ['candidates', index, 'id'], message: 'Duplicate candidate' })
    candidates.add(candidate.id)
    if (!revisions.has(candidate.problemRevisionId)) context.addIssue({ code: 'custom', path: ['candidates', index, 'problemRevisionId'], message: 'Candidate problem revision is absent' })
  }
  if (study.baselineCandidateId !== undefined && !candidates.has(study.baselineCandidateId)) context.addIssue({ code: 'custom', path: ['baselineCandidateId'], message: 'Baseline candidate is absent' })
})
export type Study = z.infer<typeof studySchema>

export const currentProblemRevision = (study: Study): ProblemRevision => {
  const current = study.revisions.find(revision => revision.id === study.currentProblemRevisionId)
  if (!current) throw new Error('Study current revision was not retained')
  return current
}
