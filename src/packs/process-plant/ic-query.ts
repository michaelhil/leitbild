import { z } from 'zod'
import type { IsoTimestamp } from '../../core/model/index.ts'
import { idSchema } from '../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../core/packs/protocol.ts'
import type { ProcessPlantIcLifecycleState, ProcessPlantIcSnapshot } from './runtime/index.ts'
import type { ProcessPlantSystemRuntime } from './system-runtime.ts'

const systemQuerySchema = z.object({
  systemId: idSchema,
})

const success = (
  request: PackQueryRequest,
  result: unknown,
  generatedAt: IsoTimestamp,
): PackQueryResponse => ({
  ok: true,
  packId: request.packId,
  kind: request.kind,
  result,
  generatedAt,
})

const failure = (
  request: PackQueryRequest,
  reason: string,
  generatedAt: IsoTimestamp,
): PackQueryResponse => ({
  ok: false,
  packId: request.packId,
  kind: request.kind,
  reason,
  generatedAt,
})

export const processPlantIcQueryKinds = [
  'process-plant.ic.status',
  'process-plant.ic.catalog',
  'process-plant.alarms.status',
  'process-plant.alarms.summary',
  'process-plant.alarms.history',
] as const

const requireSystem = (
  systems: ReadonlyMap<string, ProcessPlantSystemRuntime>,
  systemId: string,
): ProcessPlantSystemRuntime => {
  const system = systems.get(systemId)
  if (!system) throw new Error(`process plant system not found: ${systemId}`)
  return system
}

const alarmLifecycleStates = (
  snapshot: ProcessPlantIcSnapshot,
): ReadonlyArray<ProcessPlantIcLifecycleState> => [
  ...snapshot.alarms,
  ...snapshot.trips,
]

const alarmSummaryFor = (snapshot: ProcessPlantIcSnapshot): unknown => {
  const lifecycles = alarmLifecycleStates(snapshot)
  const active = lifecycles.filter(lifecycle => lifecycle.active)
  const unacknowledged = lifecycles.filter(lifecycle => !lifecycle.acknowledged && (lifecycle.active || lifecycle.lastClearedElapsedMs !== undefined))
  const firstOut = lifecycles.filter(lifecycle => lifecycle.firstOut)
  const bySeverity = Object.fromEntries(['info', 'notice', 'warning', 'critical'].map(severity => [
    severity,
    active.filter(lifecycle => lifecycle.severity === severity).length,
  ]))
  const byKind = Object.fromEntries(['alarm', 'trip'].map(kind => [
    kind,
    active.filter(lifecycle => lifecycle.kind === kind).length,
  ]))
  const byRole = lifecycles.reduce<Record<string, number>>((acc, lifecycle) => {
    if (!lifecycle.active) return acc
    const role = lifecycle.annunciator?.role ?? 'unclassified'
    acc[role] = (acc[role] ?? 0) + 1
    return acc
  }, {})
  const groups = lifecycles.reduce<Record<string, { readonly active: number; readonly unacknowledged: number }>>((acc, lifecycle) => {
    const group = lifecycle.annunciator?.group
    if (group === undefined) return acc
    const current = acc[group] ?? { active: 0, unacknowledged: 0 }
    acc[group] = {
      active: current.active + (lifecycle.active ? 1 : 0),
      unacknowledged: current.unacknowledged + (!lifecycle.acknowledged && lifecycle.active ? 1 : 0),
    }
    return acc
  }, {})
  return {
    activeCount: active.length,
    unacknowledgedCount: unacknowledged.length,
    shelvedCount: lifecycles.filter(lifecycle => lifecycle.shelved).length,
    suppressedCount: lifecycles.filter(lifecycle => lifecycle.suppressed).length,
    firstOutCount: firstOut.length,
    bySeverity,
    byKind,
    byRole,
    groups,
    firstOut,
  }
}

export const answerProcessPlantIcQuery = (config: {
  readonly request: PackQueryRequest
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  const supportedKinds = new Set<string>(processPlantIcQueryKinds)
  if (!supportedKinds.has(config.request.kind)) {
    return undefined
  }
  try {
    const payload = systemQuerySchema.parse(config.request.payload)
    const system = requireSystem(config.systems, payload.systemId)
    if (!system.protection) return failure(config.request, `process plant I&C is not configured for system: ${payload.systemId}`, config.at)
    const snapshot = system.protection.snapshot()
    if (config.request.kind === 'process-plant.ic.status') {
      return success(config.request, {
        systemId: payload.systemId,
        ic: snapshot,
      }, config.at)
    }
    if (config.request.kind === 'process-plant.alarms.status') {
      return success(config.request, {
        systemId: payload.systemId,
        alarms: snapshot.alarms,
        trips: snapshot.trips,
        summary: alarmSummaryFor(snapshot),
      }, config.at)
    }
    if (config.request.kind === 'process-plant.alarms.summary') {
      return success(config.request, {
        systemId: payload.systemId,
        summary: alarmSummaryFor(snapshot),
      }, config.at)
    }
    if (config.request.kind === 'process-plant.alarms.history') {
      return success(config.request, {
        systemId: payload.systemId,
        history: snapshot.history,
      }, config.at)
    }
    return success(config.request, {
      systemId: payload.systemId,
      ic: system.protection.catalog(),
    }, config.at)
  } catch (err) {
    return failure(config.request, err instanceof Error ? err.message : String(err), config.at)
  }
}
