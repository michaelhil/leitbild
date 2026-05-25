import type { CompiledProcessPlantSystem } from '../../process-systems.ts'
import { resolveProcessPlantSignalBinding } from '../../signals.ts'
import type { ProcessPlantSignalReference } from '../../signals.ts'
import { assertProcessPlantVariableValueValid } from '../variable-validation.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcEffect, ProcessPlantIcRule } from './control-protection-model.ts'

const assertConditionSignalsValid = (
  system: CompiledProcessPlantSystem,
  rule: ProcessPlantIcRule,
  condition: ProcessPlantIcCondition,
): void => {
  if (condition.type === 'comparison') {
    const binding = resolveProcessPlantSignalBinding(system.graph, condition.signal)
    const signalType = binding.quantity === 'boolean' ? 'boolean' : 'number'
    const valueType = typeof condition.value
    if (condition.operator !== '==' && condition.operator !== '!=' && signalType !== 'number') {
      throw new Error(`process plant I&C rule ${rule.id} uses numeric operator ${condition.operator} with non-numeric signal ${binding.path}`)
    }
    if (signalType !== valueType) {
      throw new Error(`process plant I&C rule ${rule.id} compares signal ${binding.path} ${signalType} value with ${valueType} threshold`)
    }
    return
  }
  if (condition.type === 'not') {
    assertConditionSignalsValid(system, rule, condition.condition)
    return
  }
  for (const child of condition.conditions) {
    assertConditionSignalsValid(system, rule, child)
  }
}

const variableFor = (
  system: CompiledProcessPlantSystem,
  reference: ProcessPlantSignalReference,
) => {
  const binding = resolveProcessPlantSignalBinding(system.graph, reference)
  const variable = system.graph.variables.find(candidate => candidate.path === binding.path)
  if (!variable) throw new Error(`process plant signal binding references unknown variable path: ${binding.path}`)
  return { binding, variable }
}

const assertWriteEffectValid = (
  system: CompiledProcessPlantSystem,
  rule: ProcessPlantIcRule,
  effect: Extract<ProcessPlantIcEffect, { readonly type: 'writeSignal' }>,
): void => {
  const { binding, variable } = variableFor(system, effect.signal)
  if (!binding.writable) throw new Error(`process plant I&C rule ${rule.id} writes non-writable signal ${binding.path}`)
  try {
    assertProcessPlantVariableValueValid(variable, effect.value)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`process plant I&C rule ${rule.id} writes invalid value for ${binding.path}: ${message}`)
  }
}

const assertRuleShapeValid = (rule: ProcessPlantIcRule): void => {
  const effectTypes = new Set(rule.effects.map(effect => effect.type))
  const hasGates = rule.commandGates.length > 0
  if (rule.ruleClass === 'alarm') {
    if (hasGates) throw new Error(`process plant I&C alarm rule ${rule.id} cannot define command gates`)
    if (rule.effects.length === 0 || [...effectTypes].some(type => type !== 'alarm.enter')) {
      throw new Error(`process plant I&C alarm rule ${rule.id} must only define alarm.enter effects`)
    }
    return
  }
  if (rule.ruleClass === 'normalControl') {
    if (hasGates) throw new Error(`process plant I&C normalControl rule ${rule.id} cannot define command gates`)
    if (rule.effects.length === 0 || [...effectTypes].some(type => type !== 'writeSignal')) {
      throw new Error(`process plant I&C normalControl rule ${rule.id} must only define writeSignal effects`)
    }
    return
  }
  if (rule.ruleClass === 'protection') {
    if (hasGates) throw new Error(`process plant I&C protection rule ${rule.id} cannot define command gates`)
    if (rule.effects.length === 0 || [...effectTypes].some(type => type === 'alarm.enter')) {
      throw new Error(`process plant I&C protection rule ${rule.id} must define trip.enter and/or writeSignal effects`)
    }
    return
  }
  if (!hasGates) throw new Error(`process plant I&C ${rule.ruleClass} rule ${rule.id} must define command gates`)
  if (rule.effects.length > 0) throw new Error(`process plant I&C ${rule.ruleClass} rule ${rule.id} cannot define effects`)
}

export const assertProcessPlantIcRulesValid = (
  system: CompiledProcessPlantSystem,
  rules: ReadonlyArray<ProcessPlantIcRule>,
): void => {
  for (const rule of rules) {
    assertRuleShapeValid(rule)
    if (rule.modeCondition !== undefined) assertConditionSignalsValid(system, rule, rule.modeCondition)
    assertConditionSignalsValid(system, rule, rule.condition)
    if (rule.clearCondition !== undefined) assertConditionSignalsValid(system, rule, rule.clearCondition)
    if (rule.resetCondition !== undefined) assertConditionSignalsValid(system, rule, rule.resetCondition)
    for (const gate of rule.commandGates) {
      variableFor(system, gate.signal)
    }
    for (const effect of rule.effects) {
      if (effect.type === 'writeSignal') assertWriteEffectValid(system, rule, effect)
    }
  }
}
