import type { AdapterId, ControlInstanceId, InteractionSignal, SignalId } from '../../../../core/model/index.ts'
import { nowIso } from '../../../../core/model/index.ts'
import type { SimulationEvent } from '../../../../simulation/protocol.ts'
import type {
  ProcessPlantIcEffect,
  ProcessPlantIcLifecyclePhase,
  ProcessPlantIcLifecycleState,
  ProcessPlantIcLifecycleTransition,
  ProcessPlantIcRule,
} from './control-protection-model.ts'

export type MutableLifecycleState = {
  -readonly [Key in keyof ProcessPlantIcLifecycleState]: ProcessPlantIcLifecycleState[Key]
}

export const processPlantIcLifecycleIdFor = (kind: 'alarm' | 'trip', ruleId: string, effectId: string): string =>
  `${kind}:${ruleId}:${effectId}`

export const phaseForProcessPlantIcLifecycle = (
  lifecycle: Pick<
    ProcessPlantIcLifecycleState,
    'active' | 'acknowledged' | 'suppressed' | 'shelved' | 'outOfService' | 'lastClearedElapsedMs'
  >,
): ProcessPlantIcLifecyclePhase => {
  if (lifecycle.outOfService) return 'outOfService'
  if (lifecycle.shelved) return 'shelved'
  if (lifecycle.suppressed) return 'suppressed'
  if (lifecycle.active) return lifecycle.acknowledged ? 'activeAcknowledged' : 'activeUnacknowledged'
  if (lifecycle.lastClearedElapsedMs !== undefined) return lifecycle.acknowledged ? 'clearedAcknowledged' : 'clearedUnacknowledged'
  return lifecycle.acknowledged ? 'clearedAcknowledged' : 'normal'
}

const signalIdFor = (
  systemId: string,
  ruleId: string,
  effectId: string,
  phase: string,
  elapsedMs: number,
): SignalId => `process-plant:${systemId}:${ruleId}:${effectId}:${phase}:${Math.trunc(elapsedMs)}` as SignalId

export const mutableLifecycleFor = (
  effect: Extract<ProcessPlantIcEffect, { readonly type: 'alarm.enter' | 'trip.enter' }>,
  rule: ProcessPlantIcRule,
  restored: ReadonlyMap<string, ProcessPlantIcLifecycleState>,
): MutableLifecycleState => {
  const kind = effect.type === 'alarm.enter' ? 'alarm' : 'trip'
  const id = processPlantIcLifecycleIdFor(kind, rule.id, effect.id)
  const snapshot = restored.get(id)
  return {
    id,
    ruleId: rule.id,
    effectId: effect.id,
    kind,
    title: effect.title,
    message: effect.message,
    severity: effect.severity ?? (kind === 'trip' ? 'critical' : 'warning'),
    ...(effect.annunciator === undefined
      ? snapshot?.annunciator === undefined ? {} : { annunciator: snapshot.annunciator }
      : { annunciator: effect.annunciator }),
    active: snapshot?.active ?? false,
    acknowledged: snapshot?.acknowledged ?? false,
    latched: snapshot?.latched ?? false,
    suppressed: snapshot?.suppressed ?? false,
    shelved: snapshot?.shelved ?? false,
    outOfService: snapshot?.outOfService ?? false,
    resettable: snapshot?.resettable ?? false,
    firstOut: snapshot?.firstOut ?? false,
    ...(snapshot?.firstOutRank === undefined ? {} : { firstOutRank: snapshot.firstOutRank }),
    ...(snapshot?.firstOutElapsedMs === undefined ? {} : { firstOutElapsedMs: snapshot.firstOutElapsedMs }),
    ...(snapshot?.firstActiveElapsedMs === undefined ? {} : { firstActiveElapsedMs: snapshot.firstActiveElapsedMs }),
    ...(snapshot?.lastActiveElapsedMs === undefined ? {} : { lastActiveElapsedMs: snapshot.lastActiveElapsedMs }),
    ...(snapshot?.lastClearedElapsedMs === undefined ? {} : { lastClearedElapsedMs: snapshot.lastClearedElapsedMs }),
    ...(snapshot?.lastAcknowledgedElapsedMs === undefined ? {} : { lastAcknowledgedElapsedMs: snapshot.lastAcknowledgedElapsedMs }),
    ...(snapshot?.lastResetElapsedMs === undefined ? {} : { lastResetElapsedMs: snapshot.lastResetElapsedMs }),
    ...(snapshot?.lastSuppressedElapsedMs === undefined ? {} : { lastSuppressedElapsedMs: snapshot.lastSuppressedElapsedMs }),
    ...(snapshot?.lastShelvedElapsedMs === undefined ? {} : { lastShelvedElapsedMs: snapshot.lastShelvedElapsedMs }),
    ...(snapshot?.shelvedUntilElapsedMs === undefined ? {} : { shelvedUntilElapsedMs: snapshot.shelvedUntilElapsedMs }),
    ...(snapshot?.lastTransitionElapsedMs === undefined ? {} : { lastTransitionElapsedMs: snapshot.lastTransitionElapsedMs }),
    ...(snapshot?.lastActorId === undefined ? {} : { lastActorId: snapshot.lastActorId }),
    ...(snapshot?.lastClientId === undefined ? {} : { lastClientId: snapshot.lastClientId }),
    ...(snapshot?.lastReason === undefined ? {} : { lastReason: snapshot.lastReason }),
    transitionCount: snapshot?.transitionCount ?? 0,
    occurrenceCount: snapshot?.occurrenceCount ?? 0,
    clearCount: snapshot?.clearCount ?? 0,
    acknowledgeCount: snapshot?.acknowledgeCount ?? 0,
    phase: phaseForProcessPlantIcLifecycle(snapshot ?? {
      active: false,
      acknowledged: false,
      suppressed: false,
      shelved: false,
      outOfService: false,
      lastClearedElapsedMs: undefined,
    }),
  }
}

export const eventForProcessPlantIcLifecycleTransition = (config: {
  readonly controlInstanceId: ControlInstanceId
  readonly sourceProviderId: string
  readonly systemId: string
  readonly rule: ProcessPlantIcRule
  readonly lifecycle: ProcessPlantIcLifecycleState
  readonly transition: ProcessPlantIcLifecycleTransition
  readonly elapsedMs: number
  readonly actorId?: string
  readonly clientId?: string
  readonly reason?: string
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
      ...(config.lifecycle.annunciator === undefined ? {} : { annunciator: config.lifecycle.annunciator }),
      elapsedMs: config.elapsedMs,
      phase: config.lifecycle.phase,
      ...(config.actorId === undefined ? {} : { actorId: config.actorId }),
      ...(config.clientId === undefined ? {} : { clientId: config.clientId }),
      ...(config.reason === undefined ? {} : { reason: config.reason }),
    },
  }
  return {
    type: 'interaction.signal',
    signal,
    at,
    provenance: { source: 'simulator', adapterId: config.sourceProviderId as AdapterId },
  }
}
