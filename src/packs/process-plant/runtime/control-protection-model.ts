import { z } from 'zod'
import { idSchema } from '../../../core/model/index.ts'
import { processVariableValueSchema } from '../graph/index.ts'
import { processPlantSignalReferenceSchema, type ProcessPlantSignalReference } from '../signals.ts'

export const processPlantIcRuleClassSchema = z.enum([
  'normalControl',
  'protection',
  'alarm',
  'permissive',
  'interlock',
])
export type ProcessPlantIcRuleClass = z.infer<typeof processPlantIcRuleClassSchema>

export const processPlantIcComparisonOperatorSchema = z.enum(['<', '<=', '>', '>=', '==', '!='])
export type ProcessPlantIcComparisonOperator = z.infer<typeof processPlantIcComparisonOperatorSchema>

export const processPlantIcSeveritySchema = z.enum(['info', 'notice', 'warning', 'critical'])
export type ProcessPlantIcSeverity = z.infer<typeof processPlantIcSeveritySchema>

export const processPlantIcAnnunciatorPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent'])
export type ProcessPlantIcAnnunciatorPriority = z.infer<typeof processPlantIcAnnunciatorPrioritySchema>

export const processPlantIcAnnunciatorRoleSchema = z.enum(['symptom', 'cause', 'automaticAction', 'status'])
export type ProcessPlantIcAnnunciatorRole = z.infer<typeof processPlantIcAnnunciatorRoleSchema>

export const processPlantIcAnnunciatorSchema = z.object({
  system: z.string().min(1).optional(),
  equipmentId: idSchema.optional(),
  group: z.string().min(1).optional(),
  firstOutGroup: z.string().min(1).optional(),
  priority: processPlantIcAnnunciatorPrioritySchema.default('medium'),
  role: processPlantIcAnnunciatorRoleSchema.default('symptom'),
}).strict()
export type ProcessPlantIcAnnunciator = z.infer<typeof processPlantIcAnnunciatorSchema>

export type ProcessPlantIcCondition =
  | {
      readonly type: 'comparison'
      readonly signal: ProcessPlantSignalReference
      readonly operator: ProcessPlantIcComparisonOperator
      readonly value: number | boolean
    }
  | {
      readonly type: 'all'
      readonly conditions: ReadonlyArray<ProcessPlantIcCondition>
    }
  | {
      readonly type: 'any'
      readonly conditions: ReadonlyArray<ProcessPlantIcCondition>
    }
  | {
      readonly type: 'not'
      readonly condition: ProcessPlantIcCondition
    }
  | {
      readonly type: 'vote'
      readonly required: number
      readonly conditions: ReadonlyArray<ProcessPlantIcCondition>
    }

export const processPlantIcConditionSchema: z.ZodType<ProcessPlantIcCondition> = z.lazy(() => z.union([
  z.object({
    type: z.literal('comparison'),
    signal: processPlantSignalReferenceSchema,
    operator: processPlantIcComparisonOperatorSchema,
    value: z.union([z.number().finite(), z.boolean()]),
  }).strict(),
  z.object({
    type: z.literal('all'),
    conditions: z.array(processPlantIcConditionSchema).min(1),
  }).strict(),
  z.object({
    type: z.literal('any'),
    conditions: z.array(processPlantIcConditionSchema).min(1),
  }).strict(),
  z.object({
    type: z.literal('not'),
    condition: processPlantIcConditionSchema,
  }).strict(),
  z.object({
    type: z.literal('vote'),
    required: z.number().int().positive(),
    conditions: z.array(processPlantIcConditionSchema).min(1),
  }).strict().superRefine((condition, ctx) => {
    if (condition.required > condition.conditions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['required'],
        message: 'vote required count cannot exceed condition count',
      })
    }
  }),
]) as unknown as z.ZodType<ProcessPlantIcCondition>)

export type ProcessPlantIcEffect =
  | {
      readonly type: 'alarm.enter'
      readonly id: string
      readonly title: string
      readonly message: string
      readonly severity?: ProcessPlantIcSeverity
      readonly annunciator?: ProcessPlantIcAnnunciator | undefined
    }
  | {
      readonly type: 'trip.enter'
      readonly id: string
      readonly title: string
      readonly message: string
      readonly severity?: ProcessPlantIcSeverity
      readonly annunciator?: ProcessPlantIcAnnunciator | undefined
    }
  | {
      readonly type: 'writeSignal'
      readonly id: string
      readonly signal: ProcessPlantSignalReference
      readonly value: number | boolean
    }

export interface ProcessPlantIcCommandGate {
  readonly signal: ProcessPlantSignalReference
  readonly message?: string
}

export const processPlantIcEffectSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('alarm.enter'),
    id: idSchema,
    title: z.string().min(1),
    message: z.string().min(1),
    severity: processPlantIcSeveritySchema.default('warning'),
    annunciator: processPlantIcAnnunciatorSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('trip.enter'),
    id: idSchema,
    title: z.string().min(1),
    message: z.string().min(1),
    severity: processPlantIcSeveritySchema.default('critical'),
    annunciator: processPlantIcAnnunciatorSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('writeSignal'),
    id: idSchema,
    signal: processPlantSignalReferenceSchema,
    value: processVariableValueSchema,
  }).strict(),
])

export const processPlantIcCommandGateSchema = z.object({
  signal: processPlantSignalReferenceSchema,
  message: z.string().min(1).optional(),
}).strict()

export const processPlantIcRuleSchema = z.object({
  id: idSchema,
  label: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  ruleClass: processPlantIcRuleClassSchema.default('protection'),
  modeLabel: z.string().min(1).optional(),
  modeCondition: processPlantIcConditionSchema.optional(),
  condition: processPlantIcConditionSchema,
  delayMs: z.number().finite().nonnegative().default(0),
  latch: z.boolean().default(true),
  resetWhenClear: z.boolean().default(false),
  resetCondition: processPlantIcConditionSchema.optional(),
  effects: z.array(processPlantIcEffectSchema).default([]),
  commandGates: z.array(processPlantIcCommandGateSchema).default([]),
}).strict()
export type ProcessPlantIcRule = z.infer<typeof processPlantIcRuleSchema>

export const processPlantIcConfigSchema = z.object({
  rules: z.array(processPlantIcRuleSchema).default([]),
}).strict()
export type ProcessPlantIcConfig = z.infer<typeof processPlantIcConfigSchema>

export const processPlantIcRuleSnapshotSchema = z.object({
  ruleId: idSchema,
  active: z.boolean(),
  latched: z.boolean(),
  activeSinceElapsedMs: z.number().finite().nonnegative().optional(),
  lastTransitionElapsedMs: z.number().finite().nonnegative().optional(),
  firedCount: z.number().int().nonnegative(),
})
export type ProcessPlantIcRuleSnapshot = z.infer<typeof processPlantIcRuleSnapshotSchema>

export const processPlantIcLifecycleStateSchema = z.object({
  id: idSchema,
  ruleId: idSchema,
  effectId: idSchema,
  kind: z.enum(['alarm', 'trip']),
  title: z.string().min(1),
  message: z.string().min(1),
  severity: processPlantIcSeveritySchema,
  annunciator: processPlantIcAnnunciatorSchema.optional(),
  active: z.boolean(),
  acknowledged: z.boolean(),
  latched: z.boolean(),
  suppressed: z.boolean(),
  resettable: z.boolean(),
  firstActiveElapsedMs: z.number().finite().nonnegative().optional(),
  lastActiveElapsedMs: z.number().finite().nonnegative().optional(),
  lastClearedElapsedMs: z.number().finite().nonnegative().optional(),
  lastTransitionElapsedMs: z.number().finite().nonnegative().optional(),
  transitionCount: z.number().int().nonnegative(),
})
export type ProcessPlantIcLifecycleState = z.infer<typeof processPlantIcLifecycleStateSchema>

export const processPlantIcFailureSchema = z.object({
  ruleId: idSchema,
  effectId: idSchema.optional(),
  elapsedMs: z.number().finite().nonnegative(),
  message: z.string().min(1),
})
export type ProcessPlantIcFailure = z.infer<typeof processPlantIcFailureSchema>

export const processPlantIcSnapshotSchema = z.object({
  rules: z.array(processPlantIcRuleSnapshotSchema),
  alarms: z.array(processPlantIcLifecycleStateSchema),
  trips: z.array(processPlantIcLifecycleStateSchema),
  failures: z.array(processPlantIcFailureSchema),
})
export type ProcessPlantIcSnapshot = z.infer<typeof processPlantIcSnapshotSchema>

export const processPlantProtectionRuleSchema = processPlantIcRuleSchema
export type ProcessPlantProtectionRule = ProcessPlantIcRule
export const processPlantProtectionConfigSchema = processPlantIcConfigSchema
export type ProcessPlantProtectionConfig = ProcessPlantIcConfig
export const processPlantProtectionRuleSnapshotSchema = processPlantIcRuleSnapshotSchema
export type ProcessPlantProtectionRuleSnapshot = ProcessPlantIcRuleSnapshot
export const processPlantProtectionSnapshotSchema = processPlantIcSnapshotSchema
export type ProcessPlantProtectionSnapshot = ProcessPlantIcSnapshot
