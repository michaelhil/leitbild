import { z } from 'zod'
import type { AdapterId, ControlInstanceId, InteractionSignal, SignalId } from '../../../core/model/index.ts'
import { idSchema, nowIso } from '../../../core/model/index.ts'
import type { SimulationEvent } from '../../../simulation/protocol.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { processVariableValueSchema } from '../graph/index.ts'
import type { ProcessPlantRuntime } from './model.ts'
import { processPlantSignalReferenceSchema, resolveProcessPlantSignalBinding, type ProcessPlantSignalReference } from '../signals.ts'

const comparisonOperatorSchema = z.enum(['<', '<=', '>', '>=', '==', '!='])
type ComparisonOperator = z.infer<typeof comparisonOperatorSchema>

const severitySchema = z.enum(['info', 'notice', 'warning', 'critical'])
type ProtectionSeverity = z.infer<typeof severitySchema>

type ProcessPlantProtectionCondition =
  | {
      readonly type: 'comparison'
      readonly signal: ProcessPlantSignalReference
      readonly operator: ComparisonOperator
      readonly value: number | boolean
    }
  | {
      readonly type: 'all'
      readonly conditions: ReadonlyArray<ProcessPlantProtectionCondition>
    }
  | {
      readonly type: 'any'
      readonly conditions: ReadonlyArray<ProcessPlantProtectionCondition>
    }
  | {
      readonly type: 'not'
      readonly condition: ProcessPlantProtectionCondition
    }
  | {
      readonly type: 'vote'
      readonly required: number
      readonly conditions: ReadonlyArray<ProcessPlantProtectionCondition>
    }

type ProcessPlantProtectionEffect =
  | {
      readonly type: 'alarm'
      readonly id: string
      readonly title: string
      readonly message: string
      readonly severity?: ProtectionSeverity
    }
  | {
      readonly type: 'trip'
      readonly id: string
      readonly title: string
      readonly message: string
      readonly severity?: ProtectionSeverity
    }
  | {
      readonly type: 'write'
      readonly id: string
      readonly signal: ProcessPlantSignalReference
      readonly value: number | boolean
    }

const conditionSchema: z.ZodType<ProcessPlantProtectionCondition> = z.lazy(() => z.union([
  z.object({
    type: z.literal('comparison'),
    signal: processPlantSignalReferenceSchema,
    operator: comparisonOperatorSchema,
    value: z.union([z.number().finite(), z.boolean()]),
  }).strict(),
  z.object({
    type: z.literal('all'),
    conditions: z.array(conditionSchema).min(1),
  }).strict(),
  z.object({
    type: z.literal('any'),
    conditions: z.array(conditionSchema).min(1),
  }).strict(),
  z.object({
    type: z.literal('not'),
    condition: conditionSchema,
  }).strict(),
  z.object({
    type: z.literal('vote'),
    required: z.number().int().positive(),
    conditions: z.array(conditionSchema).min(1),
  }).strict().superRefine((condition, ctx) => {
    if (condition.required > condition.conditions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['required'],
        message: 'vote required count cannot exceed condition count',
      })
    }
  }),
]) as unknown as z.ZodType<ProcessPlantProtectionCondition>)

const effectSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('alarm'),
    id: idSchema,
    title: z.string().min(1),
    message: z.string().min(1),
    severity: severitySchema.default('warning'),
  }).strict(),
  z.object({
    type: z.literal('trip'),
    id: idSchema,
    title: z.string().min(1),
    message: z.string().min(1),
    severity: severitySchema.default('critical'),
  }).strict(),
  z.object({
    type: z.literal('write'),
    id: idSchema,
    signal: processPlantSignalReferenceSchema,
    value: processVariableValueSchema,
  }).strict(),
])

export const processPlantProtectionRuleSchema = z.object({
  id: idSchema,
  label: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  condition: conditionSchema,
  delayMs: z.number().finite().nonnegative().default(0),
  latch: z.boolean().default(true),
  resetWhenClear: z.boolean().default(false),
  effects: z.array(effectSchema).min(1),
}).strict()
export type ProcessPlantProtectionRule = z.infer<typeof processPlantProtectionRuleSchema>

export const processPlantProtectionConfigSchema = z.object({
  rules: z.array(processPlantProtectionRuleSchema).default([]),
}).strict()
export type ProcessPlantProtectionConfig = z.infer<typeof processPlantProtectionConfigSchema>

export const processPlantProtectionRuleSnapshotSchema = z.object({
  ruleId: idSchema,
  active: z.boolean(),
  latched: z.boolean(),
  activeSinceElapsedMs: z.number().finite().nonnegative().optional(),
  lastTransitionElapsedMs: z.number().finite().nonnegative().optional(),
  firedCount: z.number().int().nonnegative(),
})
export type ProcessPlantProtectionRuleSnapshot = z.infer<typeof processPlantProtectionRuleSnapshotSchema>

export const processPlantProtectionSnapshotSchema = z.object({
  rules: z.array(processPlantProtectionRuleSnapshotSchema),
})
export type ProcessPlantProtectionSnapshot = z.infer<typeof processPlantProtectionSnapshotSchema>

export interface ProcessPlantProtectionRunner {
  readonly evaluate: (config: {
    readonly runtime: ProcessPlantRuntime
    readonly elapsedMs: number
    readonly controlInstanceId: ControlInstanceId
    readonly sourceProviderId: string
  }) => ReadonlyArray<SimulationEvent>
  readonly snapshot: () => ProcessPlantProtectionSnapshot
}

interface MutableRuleState {
  active: boolean
  latched: boolean
  activeSinceElapsedMs?: number
  lastTransitionElapsedMs?: number
  firedCount: number
}

const compareValues = (
  left: number | boolean,
  operator: ComparisonOperator,
  right: number | boolean,
): boolean => {
  if (operator === '==' || operator === '!=') return operator === '==' ? left === right : left !== right
  if (typeof left !== 'number' || typeof right !== 'number') throw new Error(`operator ${operator} requires numeric values`)
  if (operator === '<') return left < right
  if (operator === '<=') return left <= right
  if (operator === '>') return left > right
  return left >= right
}

const conditionMatches = (
  system: CompiledProcessPlantSystem,
  runtime: ProcessPlantRuntime,
  condition: ProcessPlantProtectionCondition,
): boolean => {
  if (condition.type === 'comparison') {
    const binding = resolveProcessPlantSignalBinding(system.graph, condition.signal)
    const snapshot = runtime.readVariableSnapshot(binding.path)
    return compareValues(snapshot.value, condition.operator, condition.value)
  }
  if (condition.type === 'all') return condition.conditions.every(child => conditionMatches(system, runtime, child))
  if (condition.type === 'any') return condition.conditions.some(child => conditionMatches(system, runtime, child))
  if (condition.type === 'not') return !conditionMatches(system, runtime, condition.condition)
  const matchingCount = condition.conditions.filter(child => conditionMatches(system, runtime, child)).length
  return matchingCount >= condition.required
}

const signalIdFor = (
  systemId: string,
  ruleId: string,
  effectId: string,
  elapsedMs: number,
): SignalId => `process-plant:${systemId}:${ruleId}:${effectId}:${Math.trunc(elapsedMs)}` as SignalId

const eventForEffect = (config: {
  readonly controlInstanceId: ControlInstanceId
  readonly sourceProviderId: string
  readonly systemId: string
  readonly rule: ProcessPlantProtectionRule
  readonly effect: Extract<ProcessPlantProtectionEffect, { readonly type: 'alarm' | 'trip' }>
  readonly elapsedMs: number
}): SimulationEvent => {
  const at = nowIso()
  const signal: InteractionSignal = {
    id: signalIdFor(config.systemId, config.rule.id, config.effect.id, config.elapsedMs),
    controlInstanceId: config.controlInstanceId,
    at,
    source: { kind: 'simulation', id: config.sourceProviderId },
    targets: [{ kind: 'broadcast' }],
    type: `process-plant.${config.effect.type}.entered`,
    severity: config.effect.severity ?? (config.effect.type === 'trip' ? 'critical' : 'warning'),
    payload: {
      systemId: config.systemId,
      ruleId: config.rule.id,
      effectId: config.effect.id,
      title: config.effect.title,
      message: config.effect.message,
      elapsedMs: config.elapsedMs,
    },
  }
  return {
    type: 'interaction.signal',
    signal,
    at,
    provenance: { source: 'simulator', adapterId: config.sourceProviderId as AdapterId },
  }
}

const applyEffect = (config: {
  readonly system: CompiledProcessPlantSystem
  readonly runtime: ProcessPlantRuntime
  readonly rule: ProcessPlantProtectionRule
  readonly effect: ProcessPlantProtectionEffect
  readonly elapsedMs: number
  readonly controlInstanceId: ControlInstanceId
  readonly sourceProviderId: string
}): ReadonlyArray<SimulationEvent> => {
  if (config.effect.type === 'write') {
    const binding = resolveProcessPlantSignalBinding(config.system.graph, config.effect.signal)
    config.runtime.writeCommand({
      type: 'setVariable',
      path: binding.path,
      value: config.effect.value,
    })
    return []
  }
  return [eventForEffect({
    controlInstanceId: config.controlInstanceId,
    sourceProviderId: config.sourceProviderId,
    systemId: config.system.id,
    rule: config.rule,
    effect: config.effect,
    elapsedMs: config.elapsedMs,
  })]
}

const stateFor = (
  ruleId: string,
  restored: ReadonlyMap<string, ProcessPlantProtectionRuleSnapshot>,
): MutableRuleState => {
  const snapshot = restored.get(ruleId)
  return {
    active: snapshot?.active ?? false,
    latched: snapshot?.latched ?? false,
    ...(snapshot?.activeSinceElapsedMs === undefined ? {} : { activeSinceElapsedMs: snapshot.activeSinceElapsedMs }),
    ...(snapshot?.lastTransitionElapsedMs === undefined ? {} : { lastTransitionElapsedMs: snapshot.lastTransitionElapsedMs }),
    firedCount: snapshot?.firedCount ?? 0,
  }
}

export const createProcessPlantProtectionRunner = (config: {
  readonly system: CompiledProcessPlantSystem
  readonly protection: ProcessPlantProtectionConfig
  readonly restoredSnapshot?: ProcessPlantProtectionSnapshot
}): ProcessPlantProtectionRunner => {
  const rules = config.protection.rules.map(rule => processPlantProtectionRuleSchema.parse(rule))
  const ruleIds = new Set<string>()
  for (const rule of rules) {
    if (ruleIds.has(rule.id)) throw new Error(`duplicate process plant protection rule id: ${rule.id}`)
    ruleIds.add(rule.id)
  }
  const restored = new Map((config.restoredSnapshot?.rules ?? []).map(rule => [rule.ruleId, rule]))
  const states = new Map(rules.map(rule => [rule.id, stateFor(rule.id, restored)]))

  return {
    evaluate: ({ runtime, elapsedMs, controlInstanceId, sourceProviderId }): ReadonlyArray<SimulationEvent> => {
      const events: SimulationEvent[] = []
      for (const rule of rules) {
        const state = states.get(rule.id)
        if (!state) throw new Error(`process plant protection state missing for rule: ${rule.id}`)
        if (!rule.enabled) continue
        const matches = conditionMatches(config.system, runtime, rule.condition)
        if (matches && state.activeSinceElapsedMs === undefined) state.activeSinceElapsedMs = elapsedMs
        if (!matches) {
          delete state.activeSinceElapsedMs
          if (state.active) {
            state.active = false
            state.lastTransitionElapsedMs = elapsedMs
          }
          if (rule.resetWhenClear) state.latched = false
          continue
        }
        const delaySatisfied = state.activeSinceElapsedMs !== undefined && elapsedMs - state.activeSinceElapsedMs >= rule.delayMs
        if (!delaySatisfied || state.active || (rule.latch && state.latched)) continue
        for (const effect of rule.effects) {
          events.push(...applyEffect({
            system: config.system,
            runtime,
            rule,
            effect,
            elapsedMs,
            controlInstanceId,
            sourceProviderId,
          }))
        }
        state.active = true
        state.latched = rule.latch
        state.lastTransitionElapsedMs = elapsedMs
        state.firedCount += 1
      }
      return events
    },
    snapshot: (): ProcessPlantProtectionSnapshot => ({
      rules: rules.map(rule => {
        const state = states.get(rule.id)
        if (!state) throw new Error(`process plant protection state missing for rule: ${rule.id}`)
        return {
          ruleId: rule.id,
          active: state.active,
          latched: state.latched,
          ...(state.activeSinceElapsedMs === undefined ? {} : { activeSinceElapsedMs: state.activeSinceElapsedMs }),
          ...(state.lastTransitionElapsedMs === undefined ? {} : { lastTransitionElapsedMs: state.lastTransitionElapsedMs }),
          firedCount: state.firedCount,
        }
      }),
    }),
  }
}
