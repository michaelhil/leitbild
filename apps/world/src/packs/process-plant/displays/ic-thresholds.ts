import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule } from '../runtime/index.ts'
import { resolveProcessPlantSignalPath } from '../signals.ts'

// Thresholds drawn on composed displays come only from the Plant's configured
// I&C rules. They are named I&C thresholds, not variable limits: they state
// where a rule acts, not a qualified operating envelope.
export type ComposedDisplayThresholdKind = 'trip' | 'alarm' | 'control'

export interface ComposedDisplayThreshold {
  readonly ruleId: string
  readonly label: string
  readonly kind: ComposedDisplayThresholdKind
  readonly operator: '<' | '<=' | '>' | '>='
  /** Low thresholds act when the value falls; high ones when it rises. */
  readonly direction: 'low' | 'high'
  readonly value: number
  /** Present when the rule only acts in a qualified mode; drawn dashed. */
  readonly modeLabel?: string
}

/** A rule that watches the signal inside a combined condition (vote, all,
 * any, not). Its action does not follow from one value, so it is listed, not
 * drawn. */
export interface ComposedDisplayCombinedRule {
  readonly ruleId: string
  readonly label: string
  readonly kind: ComposedDisplayThresholdKind
}

export interface ComposedDisplayIcThresholds {
  readonly thresholds: ReadonlyArray<ComposedDisplayThreshold>
  readonly combinedRules: ReadonlyArray<ComposedDisplayCombinedRule>
}

const kindFor = (rule: ProcessPlantIcRule): ComposedDisplayThresholdKind => {
  if (rule.effects.some(effect => effect.type === 'trip.enter')) return 'trip'
  if (rule.effects.some(effect => effect.type === 'alarm.enter')) return 'alarm'
  return 'control'
}

const labelFor = (rule: ProcessPlantIcRule): string => {
  for (const effect of rule.effects) {
    if (effect.type === 'trip.enter' || effect.type === 'alarm.enter') return effect.title
  }
  return rule.label ?? rule.id
}

const modeLabelFor = (rule: ProcessPlantIcRule): string | undefined =>
  rule.modeLabel ?? (rule.modeCondition === undefined ? undefined : 'qualified mode')

const conditionWatches = (
  plant: CompiledProcessPlant,
  condition: ProcessPlantIcCondition,
  path: VariablePath,
): boolean => {
  if (condition.type === 'comparison') return resolveProcessPlantSignalPath(plant.graph, condition.signal) === path
  if (condition.type === 'not') return conditionWatches(plant, condition.condition, path)
  return condition.conditions.some(child => conditionWatches(plant, child, path))
}

export const icThresholdsForSignal = (
  plant: CompiledProcessPlant,
  path: VariablePath,
): ComposedDisplayIcThresholds => {
  const thresholds: ComposedDisplayThreshold[] = []
  const combinedRules: ComposedDisplayCombinedRule[] = []
  for (const rule of plant.automation.rules) {
    if (!rule.enabled) continue
    const condition = rule.condition
    if (condition.type === 'comparison') {
      if (resolveProcessPlantSignalPath(plant.graph, condition.signal) !== path) continue
      // Equality rules act on discrete states; they have no position on a value axis.
      if (typeof condition.value !== 'number' || condition.operator === '==' || condition.operator === '!=') continue
      const modeLabel = modeLabelFor(rule)
      thresholds.push({
        ruleId: rule.id,
        label: labelFor(rule),
        kind: kindFor(rule),
        operator: condition.operator,
        direction: condition.operator === '<' || condition.operator === '<=' ? 'low' : 'high',
        value: condition.value,
        ...(modeLabel === undefined ? {} : { modeLabel }),
      })
      continue
    }
    if (conditionWatches(plant, condition, path)) {
      combinedRules.push({ ruleId: rule.id, label: labelFor(rule), kind: kindFor(rule) })
    }
  }
  return {
    thresholds: thresholds.sort((left, right) => left.value - right.value || left.ruleId.localeCompare(right.ruleId)),
    combinedRules: combinedRules.sort((left, right) => left.ruleId.localeCompare(right.ruleId)),
  }
}
