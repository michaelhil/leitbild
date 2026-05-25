import type { CompiledProcessPlantSystem } from '../../process-systems.ts'
import { processPlantSignalView, resolveProcessPlantSignalBinding } from '../../signals.ts'
import type { ProcessPlantSignalReference, ProcessPlantSignalView } from '../../signals.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcEffect, ProcessPlantIcRule } from './control-protection-model.ts'

export interface ProcessPlantIcEffectCatalogEntry {
  readonly id: string
  readonly type: ProcessPlantIcEffect['type']
  readonly title?: string
  readonly severity?: string
  readonly signal?: ProcessPlantSignalView
  readonly value?: number | boolean
  readonly annunciator?: unknown
}

export interface ProcessPlantIcCommandGateCatalogEntry {
  readonly signal: ProcessPlantSignalView
  readonly message?: string
}

export interface ProcessPlantIcRuleCatalogEntry {
  readonly id: string
  readonly label?: string
  readonly enabled: boolean
  readonly ruleClass: ProcessPlantIcRule['ruleClass']
  readonly modeLabel?: string
  readonly watchedSignals: ReadonlyArray<ProcessPlantSignalView>
  readonly effects: ReadonlyArray<ProcessPlantIcEffectCatalogEntry>
  readonly commandGates: ReadonlyArray<ProcessPlantIcCommandGateCatalogEntry>
}

export interface ProcessPlantIcCatalog {
  readonly systemId: string
  readonly ruleCount: number
  readonly rules: ReadonlyArray<ProcessPlantIcRuleCatalogEntry>
}

const collectConditionSignals = (
  condition: ProcessPlantIcCondition,
  into: ProcessPlantSignalReference[],
): void => {
  if (condition.type === 'comparison') {
    into.push(condition.signal)
    return
  }
  if (condition.type === 'not') {
    collectConditionSignals(condition.condition, into)
    return
  }
  for (const child of condition.conditions) collectConditionSignals(child, into)
}

const uniqueSignalViews = (
  system: CompiledProcessPlantSystem,
  references: ReadonlyArray<ProcessPlantSignalReference>,
): ReadonlyArray<ProcessPlantSignalView> => {
  const byPath = new Map<string, ProcessPlantSignalView>()
  for (const reference of references) {
    const view = processPlantSignalView(resolveProcessPlantSignalBinding(system.graph, reference))
    byPath.set(String(view.path), view)
  }
  return [...byPath.values()]
}

const effectCatalogEntry = (
  system: CompiledProcessPlantSystem,
  effect: ProcessPlantIcEffect,
): ProcessPlantIcEffectCatalogEntry => {
  if (effect.type === 'writeSignal') {
    return {
      id: effect.id,
      type: effect.type,
      signal: processPlantSignalView(resolveProcessPlantSignalBinding(system.graph, effect.signal)),
      value: effect.value,
    }
  }
  return {
    id: effect.id,
    type: effect.type,
    title: effect.title,
    ...(effect.severity === undefined ? {} : { severity: effect.severity }),
    ...(effect.annunciator === undefined ? {} : { annunciator: effect.annunciator }),
  }
}

export const catalogForProcessPlantIcRules = (
  system: CompiledProcessPlantSystem,
  rules: ReadonlyArray<ProcessPlantIcRule>,
): ProcessPlantIcCatalog => ({
  systemId: system.id,
  ruleCount: rules.length,
  rules: rules.map(rule => {
    const watchedSignals: ProcessPlantSignalReference[] = []
    collectConditionSignals(rule.condition, watchedSignals)
    if (rule.modeCondition !== undefined) collectConditionSignals(rule.modeCondition, watchedSignals)
    if (rule.clearCondition !== undefined) collectConditionSignals(rule.clearCondition, watchedSignals)
    if (rule.resetCondition !== undefined) collectConditionSignals(rule.resetCondition, watchedSignals)
    for (const effect of rule.effects) {
      if (effect.type === 'writeSignal') watchedSignals.push(effect.signal)
    }
    for (const gate of rule.commandGates) watchedSignals.push(gate.signal)
    return {
      id: rule.id,
      ...(rule.label === undefined ? {} : { label: rule.label }),
      enabled: rule.enabled,
      ruleClass: rule.ruleClass,
      ...(rule.modeLabel === undefined ? {} : { modeLabel: rule.modeLabel }),
      watchedSignals: uniqueSignalViews(system, watchedSignals),
      effects: rule.effects.map(effect => effectCatalogEntry(system, effect)),
      commandGates: rule.commandGates.map(gate => ({
        signal: processPlantSignalView(resolveProcessPlantSignalBinding(system.graph, gate.signal)),
        ...(gate.message === undefined ? {} : { message: gate.message }),
      })),
    }
  }),
})
