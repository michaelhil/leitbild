import { z } from 'zod'
import { processUnitSchema, type ProcessUnit, type VariablePath } from './graph/index.ts'
import { processPlantSignalReferenceSchema, findProcessPlantSignalBinding, processPlantSignalView } from './signals.ts'
import type { ProcessPlantSignalReference, ProcessPlantSignalView } from './signals.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import type { ProcessPlantVariableSnapshot } from './runtime/model.ts'
import { processPlantIcComparisonOperatorSchema, type ProcessPlantIcComparisonOperator } from './runtime/ic/control-protection-model.ts'

export type ProcedureConditionStatus = 'satisfied' | 'challenged' | 'unknown'
export type ProcessPlantProcedureCondition =
  | { readonly type: 'comparison'; readonly signal: ProcessPlantSignalReference; readonly operator: ProcessPlantIcComparisonOperator; readonly value: number | boolean; readonly unit: ProcessUnit }
  | { readonly type: 'all' | 'any'; readonly conditions: ReadonlyArray<ProcessPlantProcedureCondition> }
  | { readonly type: 'not'; readonly condition: ProcessPlantProcedureCondition }
  | { readonly type: 'vote'; readonly required: number; readonly conditions: ReadonlyArray<ProcessPlantProcedureCondition> }

const conditionTreeSchema: z.ZodType<ProcessPlantProcedureCondition> = z.lazy(() => z.union([
  z.object({ type: z.literal('comparison'), signal: processPlantSignalReferenceSchema, operator: processPlantIcComparisonOperatorSchema, value: z.union([z.number().finite(), z.boolean()]), unit: processUnitSchema }).strict(),
  z.object({ type: z.enum(['all', 'any']), conditions: z.array(conditionTreeSchema).min(1).max(128) }).strict(),
  z.object({ type: z.literal('not'), condition: conditionTreeSchema }).strict(),
  z.object({ type: z.literal('vote'), required: z.number().int().positive(), conditions: z.array(conditionTreeSchema).min(1).max(128) }).strict().refine(value => value.required <= value.conditions.length, 'vote required count cannot exceed condition count'),
]) as z.ZodType<ProcessPlantProcedureCondition>)

// Bound untrusted trees before Zod's recursive structural validation runs.
export const processPlantProcedureConditionSchema = z.preprocess((input, context) => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]
  let count = 0
  while (pending.length > 0) {
    const item = pending.pop()!
    if (++count > 512 || item.depth > 32) {
      context.addIssue({ code: 'custom', message: 'Procedure condition exceeds the 512-node or 32-level input limit.' })
      return z.NEVER
    }
    if (item.value === null || typeof item.value !== 'object' || Array.isArray(item.value)) continue
    const node = item.value as Record<string, unknown>
    if (Array.isArray(node.conditions)) {
      if (node.conditions.length > 128) {
        context.addIssue({ code: 'custom', message: 'Procedure condition may have at most 128 children per node.' })
        return z.NEVER
      }
      for (const child of node.conditions) pending.push({ value: child, depth: item.depth + 1 })
    }
    if (node.condition !== undefined) pending.push({ value: node.condition, depth: item.depth + 1 })
  }
  return input
}, conditionTreeSchema)

export const processPlantProcedureBasisSchema = z.object({
  modelRef: z.string().min(1),
  modelDigest: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.string().min(1).max(2048),
  description: z.string().min(1).max(2048),
}).strict()
export type ProcessPlantProcedureBasis = z.infer<typeof processPlantProcedureBasisSchema>

export interface ProcessPlantProcedureEvidence {
  readonly reference: ProcessPlantSignalReference
  readonly signal?: ProcessPlantSignalView
  readonly variable?: ProcessPlantVariableSnapshot
  readonly provenance: 'runtime-model'
  readonly instrumentationValidity: 'not-established'
  readonly rangeValidity: 'within-declared-range' | 'outside-declared-range' | 'no-declared-range' | 'unavailable'
  readonly comparison: { readonly operator: ProcessPlantIcComparisonOperator; readonly value: number | boolean; readonly unit: ProcessUnit }
  readonly status: ProcedureConditionStatus
  readonly reason?: string
}

const compare = (left: number | boolean, operator: ProcessPlantIcComparisonOperator, right: number | boolean): boolean => {
  if (operator === '==') return left === right
  if (operator === '!=') return left !== right
  if (typeof left !== 'number' || typeof right !== 'number') throw new Error('Ordered comparisons require numeric values.')
  if (operator === '<') return left < right
  if (operator === '<=') return left <= right
  if (operator === '>') return left > right
  return left >= right
}

/** Read-only evidence assessment. It never changes the independent I&C evaluator. */
export const evaluateProcessPlantProcedureCondition = (config: {
  readonly plant: ProcessPlantRuntimeInstance
  readonly condition: ProcessPlantProcedureCondition
  readonly basis: ProcessPlantProcedureBasis
}) => {
  const evidence: ProcessPlantProcedureEvidence[] = []
  const plant = config.plant
  const simTimeMs = plant.runtime.elapsedMs()
  const identity = {
    modelRef: plant.plant.modelRef, modelDigest: plant.plant.modelDigest, simTimeMs,
    basis: { ...config.basis, qualification: 'authored-comparison' as const },
    automaticCsfQualified: false,
  }
  if (config.basis.modelRef !== plant.plant.modelRef || config.basis.modelDigest !== plant.plant.modelDigest) {
    return { ...identity, status: 'unknown' as const, reason: 'Procedure basis does not match the current Plant model and digest.', evidence }
  }
  const snapshots = new Map<VariablePath, ProcessPlantVariableSnapshot>()
  const unavailableSnapshots = new Map<VariablePath, string>()
  let visited = 0
  const evaluate = (condition: ProcessPlantProcedureCondition, depth: number): ProcedureConditionStatus => {
    if (++visited > 512 || depth > 32) throw new Error('Procedure condition exceeds the 512-node or 32-level evaluation limit.')
    if (condition.type === 'comparison') {
      const binding = findProcessPlantSignalBinding(plant.plant.graph, condition.signal)
      const comparison = { operator: condition.operator, value: condition.value, unit: condition.unit }
      const base = { reference: condition.signal, comparison, provenance: 'runtime-model' as const, instrumentationValidity: 'not-established' as const }
      if (binding === undefined) {
        evidence.push({ ...base, status: 'unknown', rangeValidity: 'unavailable', reason: 'Signal is absent from the current Plant graph.' })
        return 'unknown'
      }
      let variable = snapshots.get(binding.path)
      if (variable === undefined) {
        if (!unavailableSnapshots.has(binding.path)) {
          try {
            variable = plant.runtime.readVariableSnapshot(binding.path)
            snapshots.set(binding.path, variable)
          } catch (error) {
            unavailableSnapshots.set(binding.path, error instanceof Error ? error.message : String(error))
          }
        }
        if (variable === undefined) {
          evidence.push({ ...base, signal: processPlantSignalView(binding), status: 'unknown', rangeValidity: 'unavailable', reason: unavailableSnapshots.get(binding.path) ?? 'Signal acquisition is unavailable.' })
          return 'unknown'
        }
      }
      const hardRange = variable.limits?.hardRange
      const rangeValidity = typeof variable.value === 'number' && hardRange !== undefined
        ? variable.value < hardRange.min || variable.value > hardRange.max ? 'outside-declared-range' as const : 'within-declared-range' as const
        : 'no-declared-range' as const
      const reason = variable.unit !== condition.unit ? `Condition unit ${condition.unit} does not match native signal unit ${variable.unit}.`
        : typeof variable.value !== typeof condition.value ? 'Condition value type does not match the signal value type.'
          : typeof variable.value === 'number' && !Number.isFinite(variable.value) ? 'Signal value is not finite.'
            : rangeValidity === 'outside-declared-range' ? 'Signal value is outside its declared hard range; no qualified range-bound interpretation is available.'
              : typeof variable.value === 'boolean' && condition.operator !== '==' && condition.operator !== '!=' ? 'Ordered comparisons require numeric values.' : undefined
      const status = reason === undefined ? compare(variable.value, condition.operator, condition.value) ? 'satisfied' : 'challenged' : 'unknown'
      evidence.push({ ...base, signal: processPlantSignalView(binding), variable, rangeValidity, status, ...(reason === undefined ? {} : { reason }) })
      return status
    }
    if (condition.type === 'not') {
      const status = evaluate(condition.condition, depth + 1)
      return status === 'unknown' ? 'unknown' : status === 'satisfied' ? 'challenged' : 'satisfied'
    }
    // Evaluate every leaf, including irrelevant branches, to preserve the complete frame.
    const statuses = condition.conditions.map(child => evaluate(child, depth + 1))
    const satisfied = statuses.filter(status => status === 'satisfied').length
    const unknown = statuses.filter(status => status === 'unknown').length
    const required = condition.type === 'vote' ? condition.required : condition.type === 'all' ? statuses.length : 1
    return satisfied >= required ? 'satisfied' : satisfied + unknown < required ? 'challenged' : 'unknown'
  }
  try {
    const status = evaluate(config.condition, 0)
    return { ...identity, status, ...(status === 'unknown' ? { reason: 'The declared condition cannot be established from the available model evidence.' } : {}), evidence }
  } catch (error) {
    return { ...identity, status: 'unknown' as const, reason: error instanceof Error ? error.message : String(error), evidence }
  }
}
