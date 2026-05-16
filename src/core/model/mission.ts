import { z } from 'zod'
import { actorIdSchema, idSchema, objectIdSchema, type ActorId, type ObjectId } from './ids.ts'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'

export const missionObjectiveStatusSchema = z.enum(['inactive', 'active', 'successful', 'failed', 'aborted'])
export type MissionObjectiveStatus = z.infer<typeof missionObjectiveStatusSchema>

export const missionTaskStatusSchema = z.enum(['unassigned', 'assigned', 'in_progress', 'completed', 'failed', 'cancelled'])
export type MissionTaskStatus = z.infer<typeof missionTaskStatusSchema>

export const missionTriggerKindSchema = z.enum([
  'object_reaches_target',
  'object_enters_zone',
  'task_assigned',
  'task_completed',
  'fact_changed',
  'timer_elapsed',
  'resource_threshold_crossed',
])
export type MissionTriggerKind = z.infer<typeof missionTriggerKindSchema>

export const missionActionKindSchema = z.enum([
  'activate_stage',
  'complete_objective',
  'fail_objective',
  'abort_objective',
  'assign_task',
  'append_context_activity',
  'raise_alert',
])
export type MissionActionKind = z.infer<typeof missionActionKindSchema>

export interface MissionGoal {
  readonly id: string
  readonly title: string
  readonly description?: string
}

export interface MissionObjective {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly stageId?: string
  readonly successCriteria: string
  readonly failureCriteria?: string
}

export interface MissionTask {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly objectiveId?: string
  readonly targetObjectIds: ReadonlyArray<ObjectId>
  readonly assigneeActorId?: ActorId
  readonly assigneeObjectId?: ObjectId
}

export interface MissionStage {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly objectiveIds: ReadonlyArray<string>
  readonly activeOnStart: boolean
}

export interface MissionTrigger {
  readonly id: string
  readonly kind: MissionTriggerKind
  readonly activeInStageIds: ReadonlyArray<string>
  readonly condition: Record<string, unknown>
  readonly oneShot: boolean
}

export interface MissionAction {
  readonly id: string
  readonly kind: MissionActionKind
  readonly triggerId?: string
  readonly payload: Record<string, unknown>
}

export interface MissionEvaluationMetric {
  readonly id: string
  readonly label: string
  readonly description?: string
}

export interface MissionDefinition {
  readonly id: string
  readonly schemaVersion: 1
  readonly title: string
  readonly briefing?: string
  readonly scenarioId?: string
  readonly goals: ReadonlyArray<MissionGoal>
  readonly objectives: ReadonlyArray<MissionObjective>
  readonly tasks: ReadonlyArray<MissionTask>
  readonly stages: ReadonlyArray<MissionStage>
  readonly triggers: ReadonlyArray<MissionTrigger>
  readonly actions: ReadonlyArray<MissionAction>
  readonly evaluationMetrics: ReadonlyArray<MissionEvaluationMetric>
}

export interface ObjectiveProgress {
  readonly objectiveId: string
  readonly status: MissionObjectiveStatus
  readonly updatedAt: IsoTimestamp
}

export interface TaskProgress {
  readonly taskId: string
  readonly status: MissionTaskStatus
  readonly updatedAt: IsoTimestamp
}

export interface MissionProgressState {
  readonly missionId: string
  readonly schemaVersion: 1
  readonly activeStageIds: ReadonlyArray<string>
  readonly objectives: ReadonlyArray<ObjectiveProgress>
  readonly tasks: ReadonlyArray<TaskProgress>
  readonly firedTriggerIds: ReadonlyArray<string>
  readonly startedAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

export const missionGoalSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
})

export const missionObjectiveSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  stageId: idSchema.optional(),
  successCriteria: z.string().min(1),
  failureCriteria: z.string().min(1).optional(),
})

export const missionTaskSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  objectiveId: idSchema.optional(),
  targetObjectIds: z.array(objectIdSchema).default([]),
  assigneeActorId: actorIdSchema.optional(),
  assigneeObjectId: objectIdSchema.optional(),
})

export const missionStageSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  objectiveIds: z.array(idSchema).default([]),
  activeOnStart: z.boolean().default(false),
})

export const missionTriggerSchema = z.object({
  id: idSchema,
  kind: missionTriggerKindSchema,
  activeInStageIds: z.array(idSchema).default([]),
  condition: z.record(z.unknown()).default({}),
  oneShot: z.boolean().default(true),
})

export const missionActionSchema = z.object({
  id: idSchema,
  kind: missionActionKindSchema,
  triggerId: idSchema.optional(),
  payload: z.record(z.unknown()).default({}),
})

export const missionEvaluationMetricSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
})

export const missionDefinitionSchema = z.object({
  id: idSchema,
  schemaVersion: z.literal(1),
  title: z.string().min(1),
  briefing: z.string().min(1).optional(),
  scenarioId: idSchema.optional(),
  goals: z.array(missionGoalSchema).default([]),
  objectives: z.array(missionObjectiveSchema).default([]),
  tasks: z.array(missionTaskSchema).default([]),
  stages: z.array(missionStageSchema).default([]),
  triggers: z.array(missionTriggerSchema).default([]),
  actions: z.array(missionActionSchema).default([]),
  evaluationMetrics: z.array(missionEvaluationMetricSchema).default([]),
})

export const objectiveProgressSchema = z.object({
  objectiveId: idSchema,
  status: missionObjectiveStatusSchema,
  updatedAt: isoTimestampSchema,
})

export const taskProgressSchema = z.object({
  taskId: idSchema,
  status: missionTaskStatusSchema,
  updatedAt: isoTimestampSchema,
})

export const missionProgressStateSchema = z.object({
  missionId: idSchema,
  schemaVersion: z.literal(1),
  activeStageIds: z.array(idSchema).default([]),
  objectives: z.array(objectiveProgressSchema).default([]),
  tasks: z.array(taskProgressSchema).default([]),
  firedTriggerIds: z.array(idSchema).default([]),
  startedAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
})
