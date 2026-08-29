import { z } from 'zod'
import { actorIdSchema, idSchema, objectIdSchema, type ActorId, type ObjectId } from './ids.ts'
import { knowledgeFactSchema, type KnowledgeFact } from './knowledge.ts'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'

export const contextPerspectiveSchema = z.enum(['asset', 'operator', 'system', 'ai'])
export type ContextPerspective = z.infer<typeof contextPerspectiveSchema>

export const contextReferenceKindSchema = z.enum(['object', 'task', 'mission', 'message', 'external'])
export type ContextReferenceKind = z.infer<typeof contextReferenceKindSchema>

export interface ContextReference {
  readonly kind: ContextReferenceKind
  readonly id: string
  readonly label?: string
}

export interface ContextFact {
  readonly id: string
  readonly key: string
  readonly perspective: ContextPerspective
  readonly fact: KnowledgeFact<unknown>
  readonly relatedObjectIds: ReadonlyArray<ObjectId>
  readonly relatedTaskIds: ReadonlyArray<string>
}

export interface ContextActivityEntry {
  readonly id: string
  readonly at: IsoTimestamp
  readonly source: string
  readonly perspective: ContextPerspective
  readonly summary: string
  readonly relatedObjectIds: ReadonlyArray<ObjectId>
  readonly relatedTaskIds: ReadonlyArray<string>
}

export interface ContextSummary {
  readonly id: string
  readonly createdAt: IsoTimestamp
  readonly perspective: ContextPerspective
  readonly summary: string
  readonly coversActivityIds: ReadonlyArray<string>
}

export interface ObjectContext {
  readonly schemaVersion: 1
  readonly facts: ReadonlyArray<ContextFact>
  readonly activity: ReadonlyArray<ContextActivityEntry>
  readonly references: ReadonlyArray<ContextReference>
  readonly summaries: ReadonlyArray<ContextSummary>
}

export interface AgentContextObjectSummary {
  readonly id: ObjectId
  readonly label: string
  readonly kind: string
  readonly status: string
}

export interface AgentContextView {
  readonly schemaVersion: 1
  readonly generatedAt: IsoTimestamp
  readonly perspective: ContextPerspective
  readonly actorId?: ActorId
  readonly object: AgentContextObjectSummary
  readonly currentAssignment?: string
  readonly importantFacts: ReadonlyArray<ContextFact>
  readonly recentActivity: ReadonlyArray<ContextActivityEntry>
  readonly summaries: ReadonlyArray<ContextSummary>
  readonly relevantObjects: ReadonlyArray<AgentContextObjectSummary>
  readonly allowedCommands: ReadonlyArray<string>
}

export const contextReferenceSchema = z.object({
  kind: contextReferenceKindSchema,
  id: idSchema,
  label: z.string().min(1).optional(),
})

export const contextFactSchema = z.object({
  id: idSchema,
  key: z.string().min(1),
  perspective: contextPerspectiveSchema,
  fact: knowledgeFactSchema(z.unknown()),
  relatedObjectIds: z.array(objectIdSchema).default([]),
  relatedTaskIds: z.array(idSchema).default([]),
})

export const contextActivityEntrySchema = z.object({
  id: idSchema,
  at: isoTimestampSchema,
  source: z.string().min(1),
  perspective: contextPerspectiveSchema,
  summary: z.string().min(1),
  relatedObjectIds: z.array(objectIdSchema).default([]),
  relatedTaskIds: z.array(idSchema).default([]),
})

export const contextSummarySchema = z.object({
  id: idSchema,
  createdAt: isoTimestampSchema,
  perspective: contextPerspectiveSchema,
  summary: z.string().min(1),
  coversActivityIds: z.array(idSchema).default([]),
})

export const objectContextSchema = z.object({
  schemaVersion: z.literal(1),
  facts: z.array(contextFactSchema).default([]),
  activity: z.array(contextActivityEntrySchema).default([]),
  references: z.array(contextReferenceSchema).default([]),
  summaries: z.array(contextSummarySchema).default([]),
})

export const agentContextObjectSummarySchema = z.object({
  id: objectIdSchema,
  label: z.string().min(1),
  kind: z.string().min(1),
  status: z.string().min(1),
})

export const agentContextViewSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: isoTimestampSchema,
  perspective: contextPerspectiveSchema,
  actorId: actorIdSchema.optional(),
  object: agentContextObjectSummarySchema,
  currentAssignment: z.string().min(1).optional(),
  importantFacts: z.array(contextFactSchema).default([]),
  recentActivity: z.array(contextActivityEntrySchema).default([]),
  summaries: z.array(contextSummarySchema).default([]),
  relevantObjects: z.array(agentContextObjectSummarySchema).default([]),
  allowedCommands: z.array(z.string().min(1)).default([]),
})
