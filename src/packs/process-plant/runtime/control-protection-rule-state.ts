import type { ProcessPlantIcFailure, ProcessPlantIcRule, ProcessPlantIcRuleSnapshot, ProcessPlantIcSnapshot } from './control-protection-model.ts'
import { processPlantIcLifecycleIdFor } from './control-protection-lifecycle.ts'

export interface MutableRuleState {
  active: boolean
  latched: boolean
  activeSinceElapsedMs?: number
  clearSinceElapsedMs?: number
  lastTransitionElapsedMs?: number
  firedCount: number
}

export const stateForProcessPlantIcRule = (
  ruleId: string,
  restored: ReadonlyMap<string, ProcessPlantIcRuleSnapshot>,
): MutableRuleState => {
  const snapshot = restored.get(ruleId)
  return {
    active: snapshot?.active ?? false,
    latched: snapshot?.latched ?? false,
    ...(snapshot?.activeSinceElapsedMs === undefined ? {} : { activeSinceElapsedMs: snapshot.activeSinceElapsedMs }),
    ...(snapshot?.clearSinceElapsedMs === undefined ? {} : { clearSinceElapsedMs: snapshot.clearSinceElapsedMs }),
    ...(snapshot?.lastTransitionElapsedMs === undefined ? {} : { lastTransitionElapsedMs: snapshot.lastTransitionElapsedMs }),
    firedCount: snapshot?.firedCount ?? 0,
  }
}

export const assertRestoredProcessPlantIcSnapshotMatchesRules = (
  rules: ReadonlyArray<ProcessPlantIcRule>,
  restoredSnapshot: ProcessPlantIcSnapshot | undefined,
): void => {
  if (!restoredSnapshot) return
  const ruleIds = new Set(rules.map(rule => rule.id))
  for (const rule of restoredSnapshot.rules) {
    if (!ruleIds.has(rule.ruleId)) throw new Error(`restored I&C snapshot references unknown rule: ${rule.ruleId}`)
  }
  const lifecycleIds = new Set(rules.flatMap(rule => rule.effects.flatMap(effect => {
    if (effect.type === 'writeSignal') return []
    const kind = effect.type === 'alarm.enter' ? 'alarm' : 'trip'
    return [processPlantIcLifecycleIdFor(kind, rule.id, effect.id)]
  })))
  for (const lifecycle of [...restoredSnapshot.alarms, ...restoredSnapshot.trips]) {
    if (!lifecycleIds.has(lifecycle.id)) throw new Error(`restored I&C snapshot references unknown lifecycle state: ${lifecycle.id}`)
  }
}

export const processPlantIcFailureFor = (config: {
  readonly ruleId: string
  readonly effectId?: string
  readonly elapsedMs: number
  readonly error: unknown
}): ProcessPlantIcFailure => ({
  ruleId: config.ruleId,
  ...(config.effectId === undefined ? {} : { effectId: config.effectId }),
  elapsedMs: config.elapsedMs,
  message: config.error instanceof Error ? config.error.message : String(config.error),
})
