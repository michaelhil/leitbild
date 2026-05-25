import type { CompiledProcessPlantSystem } from '../../process-systems.ts'
import { processPlantSignalView, resolveProcessPlantSignalBinding } from '../../signals.ts'
import type { ProcessPlantSignalView } from '../../signals.ts'
import type { ProcessPlantRuntime, ProcessPlantVariableSnapshot } from '../model.ts'
import type { ProcessPlantIcComparisonOperator, ProcessPlantIcCondition } from './control-protection-model.ts'

export interface ProcessPlantIcSignalRead {
  readonly signal: ProcessPlantSignalView
  readonly variable: ProcessPlantVariableSnapshot
}

export interface ProcessPlantIcConditionEvaluation {
  readonly matches: boolean
  readonly signalsRead: ReadonlyArray<ProcessPlantIcSignalRead>
}

const compareValues = (
  left: number | boolean,
  operator: ProcessPlantIcComparisonOperator,
  right: number | boolean,
): boolean => {
  if (operator === '==' || operator === '!=') return operator === '==' ? left === right : left !== right
  if (typeof left !== 'number' || typeof right !== 'number') throw new Error(`operator ${operator} requires numeric values`)
  if (operator === '<') return left < right
  if (operator === '<=') return left <= right
  if (operator === '>') return left > right
  return left >= right
}

export const evaluateProcessPlantIcCondition = (config: {
  readonly system: CompiledProcessPlantSystem
  readonly runtime: ProcessPlantRuntime
  readonly condition: ProcessPlantIcCondition
}): ProcessPlantIcConditionEvaluation => {
  const signalsRead: ProcessPlantIcSignalRead[] = []

  const evaluate = (condition: ProcessPlantIcCondition): boolean => {
    if (condition.type === 'comparison') {
      const binding = resolveProcessPlantSignalBinding(config.system.graph, condition.signal)
      const variable = config.runtime.readVariableSnapshot(binding.path)
      signalsRead.push({ signal: processPlantSignalView(binding), variable })
      return compareValues(variable.value, condition.operator, condition.value)
    }
    if (condition.type === 'all') {
      const childResults = condition.conditions.map(evaluate)
      return childResults.every(Boolean)
    }
    if (condition.type === 'any') {
      const childResults = condition.conditions.map(evaluate)
      return childResults.some(Boolean)
    }
    if (condition.type === 'not') return !evaluate(condition.condition)
    const matchingCount = condition.conditions.filter(evaluate).length
    return matchingCount >= condition.required
  }

  return {
    matches: evaluate(config.condition),
    signalsRead,
  }
}
