import type { AdapterId, ControlInstanceId, InteractionSignal, SignalId } from '../../../core/model/index.ts'
import { nowIso } from '../../../core/model/index.ts'
import type { SimulationEvent } from '../../../simulation/protocol.ts'
import type { CompiledProcessPlantSystem } from '../process-systems.ts'
import { resolveProcessPlantSignalBinding } from '../signals.ts'
import type { ProcessPlantRuntime } from './model.ts'
import { evaluateProcessPlantIcCondition } from './control-protection-conditions.ts'
import {
  processPlantIcConfigSchema,
  processPlantIcRuleSchema,
  type ProcessPlantIcCondition,
  type ProcessPlantIcConfig,
  type ProcessPlantIcEffect,
  type ProcessPlantIcFailure,
  type ProcessPlantIcLifecycleState,
  type ProcessPlantIcRule,
  type ProcessPlantIcRuleSnapshot,
  type ProcessPlantIcSnapshot,
} from './control-protection-model.ts'
export * from './control-protection-model.ts'
export * from './control-protection-conditions.ts'

export interface ProcessPlantProtectionRunner {
  readonly evaluate: (config: {
    readonly runtime: ProcessPlantRuntime
    readonly elapsedMs: number
    readonly controlInstanceId: ControlInstanceId
    readonly sourceProviderId: string
  }) => ReadonlyArray<SimulationEvent>
  readonly snapshot: () => ProcessPlantIcSnapshot
  readonly acknowledge: (id: string, elapsedMs: number) => void
}

interface MutableRuleState {
  active: boolean
  latched: boolean
  activeSinceElapsedMs?: number
  lastTransitionElapsedMs?: number
  firedCount: number
}

type MutableLifecycleState = {
  -readonly [Key in keyof ProcessPlantIcLifecycleState]: ProcessPlantIcLifecycleState[Key]
}

const signalIdFor = (
  systemId: string,
  ruleId: string,
  effectId: string,
  phase: string,
  elapsedMs: number,
): SignalId => `process-plant:${systemId}:${ruleId}:${effectId}:${phase}:${Math.trunc(elapsedMs)}` as SignalId

const lifecycleIdFor = (kind: 'alarm' | 'trip', ruleId: string, effectId: string): string =>
  `${kind}:${ruleId}:${effectId}`

const lifecycleFor = (
  effect: Extract<ProcessPlantIcEffect, { readonly type: 'alarm.enter' | 'trip.enter' }>,
  rule: ProcessPlantIcRule,
  restored: ReadonlyMap<string, ProcessPlantIcLifecycleState>,
): MutableLifecycleState => {
  const kind = effect.type === 'alarm.enter' ? 'alarm' : 'trip'
  const id = lifecycleIdFor(kind, rule.id, effect.id)
  const snapshot = restored.get(id)
  return {
    id,
    ruleId: rule.id,
    effectId: effect.id,
    kind,
    title: effect.title,
    message: effect.message,
    severity: effect.severity ?? (kind === 'trip' ? 'critical' : 'warning'),
    active: snapshot?.active ?? false,
    acknowledged: snapshot?.acknowledged ?? false,
    latched: snapshot?.latched ?? false,
    suppressed: snapshot?.suppressed ?? false,
    resettable: snapshot?.resettable ?? false,
    ...(snapshot?.firstActiveElapsedMs === undefined ? {} : { firstActiveElapsedMs: snapshot.firstActiveElapsedMs }),
    ...(snapshot?.lastActiveElapsedMs === undefined ? {} : { lastActiveElapsedMs: snapshot.lastActiveElapsedMs }),
    ...(snapshot?.lastClearedElapsedMs === undefined ? {} : { lastClearedElapsedMs: snapshot.lastClearedElapsedMs }),
    ...(snapshot?.lastTransitionElapsedMs === undefined ? {} : { lastTransitionElapsedMs: snapshot.lastTransitionElapsedMs }),
    transitionCount: snapshot?.transitionCount ?? 0,
  }
}

const eventForLifecycleTransition = (config: {
  readonly controlInstanceId: ControlInstanceId
  readonly sourceProviderId: string
  readonly systemId: string
  readonly rule: ProcessPlantIcRule
  readonly lifecycle: ProcessPlantIcLifecycleState
  readonly transition: 'entered' | 'cleared' | 'acknowledged'
  readonly elapsedMs: number
}): SimulationEvent => {
  const at = nowIso()
  const signal: InteractionSignal = {
    id: signalIdFor(config.systemId, config.rule.id, config.lifecycle.effectId, config.transition, config.elapsedMs),
    controlInstanceId: config.controlInstanceId,
    at,
    source: { kind: 'simulation', id: config.sourceProviderId },
    targets: [{ kind: 'broadcast' }],
    type: `process-plant.${config.lifecycle.kind}.${config.transition}`,
    severity: config.lifecycle.severity,
    payload: {
      systemId: config.systemId,
      ruleId: config.rule.id,
      ruleClass: config.rule.ruleClass,
      effectId: config.lifecycle.effectId,
      lifecycleId: config.lifecycle.id,
      title: config.lifecycle.title,
      message: config.lifecycle.message,
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

const stateFor = (
  ruleId: string,
  restored: ReadonlyMap<string, ProcessPlantIcRuleSnapshot>,
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

const assertRestoredSnapshotMatchesRules = (
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
    return [lifecycleIdFor(kind, rule.id, effect.id)]
  })))
  for (const lifecycle of [...restoredSnapshot.alarms, ...restoredSnapshot.trips]) {
    if (!lifecycleIds.has(lifecycle.id)) throw new Error(`restored I&C snapshot references unknown lifecycle state: ${lifecycle.id}`)
  }
}

const failureFor = (config: {
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

const applyWriteEffect = (config: {
  readonly system: CompiledProcessPlantSystem
  readonly runtime: ProcessPlantRuntime
  readonly effect: Extract<ProcessPlantIcEffect, { readonly type: 'writeSignal' }>
}): void => {
  const binding = resolveProcessPlantSignalBinding(config.system.graph, config.effect.signal)
  config.runtime.writeCommand({
    type: 'setVariable',
    path: binding.path,
    value: config.effect.value,
  })
}

const shouldResetLatchedState = (config: {
  readonly system: CompiledProcessPlantSystem
  readonly runtime: ProcessPlantRuntime
  readonly rule: ProcessPlantIcRule
}): boolean => {
  if (config.rule.resetCondition === undefined) return false
  return evaluateProcessPlantIcCondition({
    system: config.system,
    runtime: config.runtime,
    condition: config.rule.resetCondition as ProcessPlantIcCondition,
  }).matches
}

export const createProcessPlantProtectionRunner = (config: {
  readonly system: CompiledProcessPlantSystem
  readonly protection: ProcessPlantIcConfig
  readonly restoredSnapshot?: ProcessPlantIcSnapshot
}): ProcessPlantProtectionRunner => {
  const protection = processPlantIcConfigSchema.parse(config.protection)
  const rules = protection.rules.map(rule => processPlantIcRuleSchema.parse(rule))
  const ruleIds = new Set<string>()
  const effectIds = new Set<string>()
  for (const rule of rules) {
    if (ruleIds.has(rule.id)) throw new Error(`duplicate process plant I&C rule id: ${rule.id}`)
    ruleIds.add(rule.id)
    for (const effect of rule.effects) {
      const scopedEffectId = `${rule.id}:${effect.id}`
      if (effectIds.has(scopedEffectId)) throw new Error(`duplicate process plant I&C effect id for rule ${rule.id}: ${effect.id}`)
      effectIds.add(scopedEffectId)
    }
  }
  assertRestoredSnapshotMatchesRules(rules, config.restoredSnapshot)

  const restoredRules = new Map((config.restoredSnapshot?.rules ?? []).map(rule => [rule.ruleId, rule]))
  const restoredLifecycles = new Map([
    ...(config.restoredSnapshot?.alarms ?? []),
    ...(config.restoredSnapshot?.trips ?? []),
  ].map(lifecycle => [lifecycle.id, lifecycle]))
  const states = new Map(rules.map(rule => [rule.id, stateFor(rule.id, restoredRules)]))
  const lifecycles = new Map<string, MutableLifecycleState>()
  for (const rule of rules) {
    for (const effect of rule.effects) {
      if (effect.type === 'writeSignal') continue
      const lifecycle = lifecycleFor(effect, rule, restoredLifecycles)
      lifecycles.set(lifecycle.id, lifecycle)
    }
  }
  const failures: ProcessPlantIcFailure[] = [...(config.restoredSnapshot?.failures ?? [])]

  const enterLifecycle = (input: {
    readonly rule: ProcessPlantIcRule
    readonly effect: Extract<ProcessPlantIcEffect, { readonly type: 'alarm.enter' | 'trip.enter' }>
    readonly elapsedMs: number
    readonly controlInstanceId: ControlInstanceId
    readonly sourceProviderId: string
  }): ReadonlyArray<SimulationEvent> => {
    const kind = input.effect.type === 'alarm.enter' ? 'alarm' : 'trip'
    const lifecycle = lifecycles.get(lifecycleIdFor(kind, input.rule.id, input.effect.id))
    if (!lifecycle) throw new Error(`process plant I&C lifecycle state missing for effect: ${input.rule.id}/${input.effect.id}`)
    if (lifecycle.active && lifecycle.latched) return []
    if (lifecycle.active) return []
    lifecycle.active = true
    lifecycle.acknowledged = false
    lifecycle.latched = input.rule.latch
    lifecycle.resettable = false
    lifecycle.firstActiveElapsedMs ??= input.elapsedMs
    lifecycle.lastActiveElapsedMs = input.elapsedMs
    lifecycle.lastTransitionElapsedMs = input.elapsedMs
    lifecycle.transitionCount += 1
    return [eventForLifecycleTransition({
      controlInstanceId: input.controlInstanceId,
      sourceProviderId: input.sourceProviderId,
      systemId: config.system.id,
      rule: input.rule,
      lifecycle,
      transition: 'entered',
      elapsedMs: input.elapsedMs,
    })]
  }

  const clearLifecycle = (input: {
    readonly rule: ProcessPlantIcRule
    readonly elapsedMs: number
    readonly controlInstanceId: ControlInstanceId
    readonly sourceProviderId: string
  }): ReadonlyArray<SimulationEvent> => {
    const events: SimulationEvent[] = []
    for (const effect of input.rule.effects) {
      if (effect.type === 'writeSignal') continue
      const kind = effect.type === 'alarm.enter' ? 'alarm' : 'trip'
      const lifecycle = lifecycles.get(lifecycleIdFor(kind, input.rule.id, effect.id))
      if (!lifecycle || !lifecycle.active) continue
      if (lifecycle.latched && !input.rule.resetWhenClear) {
        lifecycle.resettable = true
        continue
      }
      lifecycle.active = false
      lifecycle.resettable = false
      lifecycle.lastClearedElapsedMs = input.elapsedMs
      lifecycle.lastTransitionElapsedMs = input.elapsedMs
      lifecycle.transitionCount += 1
      events.push(eventForLifecycleTransition({
        controlInstanceId: input.controlInstanceId,
        sourceProviderId: input.sourceProviderId,
        systemId: config.system.id,
        rule: input.rule,
        lifecycle,
        transition: 'cleared',
        elapsedMs: input.elapsedMs,
      }))
    }
    return events
  }

  return {
    evaluate: ({ runtime, elapsedMs, controlInstanceId, sourceProviderId }): ReadonlyArray<SimulationEvent> => {
      const events: SimulationEvent[] = []
      for (const rule of rules) {
        const state = states.get(rule.id)
        if (!state) throw new Error(`process plant I&C state missing for rule: ${rule.id}`)
        if (!rule.enabled) continue
        let matches = false
        try {
          matches = evaluateProcessPlantIcCondition({ system: config.system, runtime, condition: rule.condition }).matches
        } catch (error) {
          failures.push(failureFor({ ruleId: rule.id, elapsedMs, error }))
          continue
        }
        if (shouldResetLatchedState({ system: config.system, runtime, rule })) {
          state.latched = false
          for (const lifecycle of lifecycles.values()) {
            if (lifecycle.ruleId !== rule.id || !lifecycle.latched) continue
            lifecycle.latched = false
            lifecycle.resettable = false
            if (!matches) lifecycle.active = false
          }
        }
        if (matches && state.activeSinceElapsedMs === undefined) state.activeSinceElapsedMs = elapsedMs
        if (!matches) {
          delete state.activeSinceElapsedMs
          if (state.active) {
            state.active = false
            state.lastTransitionElapsedMs = elapsedMs
          }
          if (rule.resetWhenClear) state.latched = false
          events.push(...clearLifecycle({ rule, elapsedMs, controlInstanceId, sourceProviderId }))
          continue
        }
        const delaySatisfied = state.activeSinceElapsedMs !== undefined && elapsedMs - state.activeSinceElapsedMs >= rule.delayMs
        if (!delaySatisfied || state.active || (rule.latch && state.latched)) continue
        for (const effect of rule.effects) {
          try {
            if (effect.type === 'writeSignal') {
              applyWriteEffect({ system: config.system, runtime, effect })
              continue
            }
            events.push(...enterLifecycle({ rule, effect, elapsedMs, controlInstanceId, sourceProviderId }))
          } catch (error) {
            failures.push(failureFor({ ruleId: rule.id, effectId: effect.id, elapsedMs, error }))
          }
        }
        state.active = true
        state.latched = rule.latch
        state.lastTransitionElapsedMs = elapsedMs
        state.firedCount += 1
      }
      return events
    },
    snapshot: (): ProcessPlantIcSnapshot => ({
      rules: rules.map(rule => {
        const state = states.get(rule.id)
        if (!state) throw new Error(`process plant I&C state missing for rule: ${rule.id}`)
        return {
          ruleId: rule.id,
          active: state.active,
          latched: state.latched,
          ...(state.activeSinceElapsedMs === undefined ? {} : { activeSinceElapsedMs: state.activeSinceElapsedMs }),
          ...(state.lastTransitionElapsedMs === undefined ? {} : { lastTransitionElapsedMs: state.lastTransitionElapsedMs }),
          firedCount: state.firedCount,
        }
      }),
      alarms: [...lifecycles.values()].filter(lifecycle => lifecycle.kind === 'alarm'),
      trips: [...lifecycles.values()].filter(lifecycle => lifecycle.kind === 'trip'),
      failures: [...failures],
    }),
    acknowledge: (id: string, elapsedMs: number): void => {
      const lifecycle = lifecycles.get(id)
      if (!lifecycle) throw new Error(`unknown process plant I&C lifecycle id: ${id}`)
      lifecycle.acknowledged = true
      lifecycle.lastTransitionElapsedMs = elapsedMs
    },
  }
}
