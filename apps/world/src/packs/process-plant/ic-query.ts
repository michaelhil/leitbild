import type { PackRuntimeQuery } from '../../simulation/protocol.ts'
import type { ProcessPlantIcLifecycleState, ProcessPlantIcSnapshot } from './runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import { failure, plantQuerySchema, requirePlant } from './queries/common.ts'

export const processPlantIcQueryKinds = [
  'world.process-plant.ic.status',
  'world.process-plant.ic.catalog',
  'world.process-plant.alarms.status',
  'world.process-plant.alarms.summary',
  'world.process-plant.alarms.history',
] as const

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
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
}): unknown | undefined => {
  const supportedKinds = new Set<string>(processPlantIcQueryKinds)
  if (!supportedKinds.has(config.request.capabilityId)) {
    return undefined
  }
  const payload = plantQuerySchema.parse(config.request.input)
  const system = requirePlant(config.plants, payload.plantId)
  if (!system.protection) return failure(`process plant I&C is not configured for plant: ${payload.plantId}`)
  const snapshot = system.protection.snapshot()
  if (config.request.capabilityId === 'world.process-plant.ic.status') {
    return {
        plantId: payload.plantId,
        ic: snapshot,
      }
  }
  if (config.request.capabilityId === 'world.process-plant.alarms.status') {
    return {
        plantId: payload.plantId,
        alarms: snapshot.alarms,
        trips: snapshot.trips,
        summary: alarmSummaryFor(snapshot),
      }
  }
  if (config.request.capabilityId === 'world.process-plant.alarms.summary') {
    return {
        plantId: payload.plantId,
        summary: alarmSummaryFor(snapshot),
      }
  }
  if (config.request.capabilityId === 'world.process-plant.alarms.history') {
    return {
        plantId: payload.plantId,
        history: snapshot.history,
      }
  }
  return {
    plantId: payload.plantId,
    ic: system.protection.catalog(),
  }
}
