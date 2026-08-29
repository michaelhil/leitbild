import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import { variablePathSchema } from '../graph/index.ts'
import type { ProcessPlantIcLifecycleState } from '../runtime/index.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { failure, requireSystem, success, systemQuerySchema } from './common.ts'

const trendsReadQuerySchema = z.object({
  systemId: idSchema,
  paths: z.array(variablePathSchema).min(1).optional(),
})

const icSummaryFor = (system: ProcessPlantSystemRuntime): {
  readonly configured: boolean
  readonly activeAlarmCount: number
  readonly activeTripCount: number
  readonly activeRuleCount: number
  readonly failureCount: number
  readonly firstOutCount: number
  readonly activeFirstOut: ReadonlyArray<ProcessPlantIcSummaryLifecycle>
  readonly activeHighestSeverity: ProcessPlantIcLifecycleState['severity'] | null
  readonly active: ReadonlyArray<ProcessPlantIcSummaryLifecycle>
} => {
  const snapshot = system.protection?.snapshot()
  if (snapshot === undefined) {
    return {
      configured: false,
      activeAlarmCount: 0,
      activeTripCount: 0,
      activeRuleCount: 0,
      failureCount: 0,
      firstOutCount: 0,
      activeFirstOut: [],
      activeHighestSeverity: null,
      active: [],
    }
  }
  const active = [...snapshot.alarms, ...snapshot.trips].filter(lifecycle => lifecycle.active)
  const activeSummaries = active
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
    .map(summaryLifecycle)
  const firstOut = active.filter(lifecycle => lifecycle.firstOut)
  return {
    configured: true,
    activeAlarmCount: snapshot.alarms.filter(alarm => alarm.active).length,
    activeTripCount: snapshot.trips.filter(trip => trip.active).length,
    activeRuleCount: snapshot.rules.filter(rule => rule.active).length,
    failureCount: snapshot.failures.length,
    firstOutCount: firstOut.length,
    activeFirstOut: firstOut.map(summaryLifecycle),
    activeHighestSeverity: activeSummaries[0]?.severity ?? null,
    active: activeSummaries,
  }
}

interface ProcessPlantIcSummaryLifecycle {
  readonly id: string
  readonly kind: ProcessPlantIcLifecycleState['kind']
  readonly title: string
  readonly severity: ProcessPlantIcLifecycleState['severity']
  readonly firstOut: boolean
  readonly firstOutGroup?: string
  readonly equipmentId?: string
  readonly firstActiveElapsedMs?: number
}

const severityOrder: ReadonlyArray<ProcessPlantIcLifecycleState['severity']> = ['info', 'notice', 'warning', 'critical']

const severityRank = (severity: ProcessPlantIcLifecycleState['severity']): number =>
  severityOrder.indexOf(severity)

const summaryLifecycle = (lifecycle: ProcessPlantIcLifecycleState): ProcessPlantIcSummaryLifecycle => ({
  id: lifecycle.id,
  kind: lifecycle.kind,
  title: lifecycle.title,
  severity: lifecycle.severity,
  firstOut: lifecycle.firstOut,
  ...(lifecycle.annunciator?.firstOutGroup === undefined ? {} : { firstOutGroup: lifecycle.annunciator.firstOutGroup }),
  ...(lifecycle.annunciator?.equipmentId === undefined ? {} : { equipmentId: lifecycle.annunciator.equipmentId }),
  ...(lifecycle.firstActiveElapsedMs === undefined ? {} : { firstActiveElapsedMs: lifecycle.firstActiveElapsedMs }),
})

export const processPlantRuntimeQueryKinds = [
  'process-plant.runtime.status',
  'process-plant.telemetry.published',
  'process-plant.transient.diagnostics',
  'process-plant.trends.read',
] as const

export const answerProcessPlantRuntimeQuery = (config: {
  readonly request: PackQueryRequest
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (!processPlantRuntimeQueryKinds.some(kind => kind === config.request.kind)) return undefined
  if (config.request.kind === 'process-plant.runtime.status') {
    return success(config.request, {
      active: config.systems.size > 0,
      systemCount: config.systems.size,
      systems: [...config.systems.values()].map(({ system, runtime }) => {
        const snapshot = runtime.snapshot()
        return {
          id: system.id,
          elapsedMs: snapshot.elapsedMs,
          remainderMs: snapshot.remainderMs,
          publishedVariableCount: snapshot.variables.filter(variable => variable.published).length,
          variableCount: snapshot.variables.length,
        }
      }),
    }, config.at)
  }
  if (config.request.kind === 'process-plant.telemetry.published') {
    const payload = systemQuerySchema.parse(config.request.payload)
    const system = requireSystem(config.systems, payload.systemId)
    return success(config.request, {
      variables: system.runtime.snapshot().variables.filter(variable => variable.published),
    }, config.at)
  }
  if (config.request.kind === 'process-plant.transient.diagnostics') {
    const payload = systemQuerySchema.parse(config.request.payload)
    const system = requireSystem(config.systems, payload.systemId)
    return success(config.request, {
      systemId: payload.systemId,
      diagnostics: system.runtime.pwrTransientDiagnostics(),
      ic: icSummaryFor(system),
    }, config.at)
  }
  const payload = trendsReadQuerySchema.parse(config.request.payload)
  const system = requireSystem(config.systems, payload.systemId)
  if (!system.telemetry) return failure(config.request, `process plant telemetry is not configured for system: ${payload.systemId}`, config.at)
  return success(config.request, {
    systemId: payload.systemId,
    series: system.telemetry.series(payload.paths),
  }, config.at)
}
