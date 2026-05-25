import type { ProcessPlantIcLifecycleHistoryEntry } from './control-protection-model.ts'
import { phaseForProcessPlantIcLifecycle, type MutableLifecycleState } from './control-protection-lifecycle.ts'

const maxLifecycleHistoryEntries = 1_000

const lifecycleHistoryIdFor = (
  lifecycleId: string,
  transition: string,
  elapsedMs: number,
  count: number,
): string => `${lifecycleId}:${transition}:${Math.trunc(elapsedMs)}:${count}`

export const updateProcessPlantIcLifecyclePhase = (lifecycle: MutableLifecycleState): void => {
  lifecycle.phase = phaseForProcessPlantIcLifecycle(lifecycle)
}

export const rememberProcessPlantIcLifecycleHistory = (config: {
  readonly history: ProcessPlantIcLifecycleHistoryEntry[]
  readonly lifecycle: MutableLifecycleState
  readonly transition: ProcessPlantIcLifecycleHistoryEntry['transition']
  readonly elapsedMs: number
  readonly actorId?: string
  readonly clientId?: string
  readonly reason?: string
}): void => {
  updateProcessPlantIcLifecyclePhase(config.lifecycle)
  config.history.push({
    id: lifecycleHistoryIdFor(config.lifecycle.id, config.transition, config.elapsedMs, config.history.length),
    lifecycleId: config.lifecycle.id,
    ruleId: config.lifecycle.ruleId,
    effectId: config.lifecycle.effectId,
    kind: config.lifecycle.kind,
    transition: config.transition,
    elapsedMs: config.elapsedMs,
    title: config.lifecycle.title,
    severity: config.lifecycle.severity,
    phase: config.lifecycle.phase,
    ...(config.actorId === undefined ? {} : { actorId: config.actorId }),
    ...(config.clientId === undefined ? {} : { clientId: config.clientId }),
    ...(config.reason === undefined ? {} : { reason: config.reason }),
  })
  if (config.history.length > maxLifecycleHistoryEntries) {
    config.history.splice(0, config.history.length - maxLifecycleHistoryEntries)
  }
}
