import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { processPlantSignalView, resolveProcessPlantSignalBinding } from '../../signals.ts'
import type { ProcessPlantSignalView } from '../../signals.ts'
import type { ProcessPlantRuntime, ProcessPlantVariableSnapshot } from '../model.ts'
import type { ProcessPlantIcComparisonOperator, ProcessPlantIcCondition } from './control-protection-model.ts'

export interface ProcessPlantIcSignalRead {
  readonly signal: ProcessPlantSignalView
  readonly variable: ProcessPlantVariableSnapshot
  readonly comparison?: {
    readonly operator: ProcessPlantIcComparisonOperator
    readonly value: number | boolean
    readonly matches: boolean
  }
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
  readonly system: CompiledProcessPlant
  readonly runtime: ProcessPlantRuntime
  readonly condition: ProcessPlantIcCondition
}): ProcessPlantIcConditionEvaluation => {
  const signalsRead: ProcessPlantIcSignalRead[] = []

  const evaluate = (condition: ProcessPlantIcCondition): boolean => {
    if (condition.type === 'comparison') {
      const binding = resolveProcessPlantSignalBinding(config.system.graph, condition.signal)
      const variable = config.runtime.readVariableSnapshot(binding.path)
      const matches = compareValues(variable.value, condition.operator, condition.value)
      signalsRead.push({
        signal: processPlantSignalView(binding),
        variable,
        comparison: {
          operator: condition.operator,
          value: condition.value,
          matches,
        },
      })
      return matches
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
