import type { IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import type { PackObjectStatusTone } from '../../core/packs/protocol.ts'
import type { ProcessPlantDisplayField } from './graph/index.ts'
import {
  emptyProcessPlantProjection,
  processPlantField,
  processPlantUnitDomainDataSchema,
  type ProcessPlantUnitDomainData,
  type ProcessPlantUnitProjection,
} from './model.ts'
import type { ProcessPlantIcLifecycleState } from './runtime/index.ts'
import type { ProcessPlantVariableHandle } from './runtime/variable-table.ts'
import type { ProcessPlantSystemRuntime } from './system-runtime.ts'

const railDisplayProfileId = 'leitbild-rail'

const severityRank: Readonly<Record<ProcessPlantIcLifecycleState['severity'], number>> = {
  info: 1,
  notice: 2,
  warning: 3,
  critical: 4,
}

const formatValue = (value: unknown, unit: string, digits = 1): string => {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return `${value.toFixed(digits)} ${unit}`
  return `${String(value)} ${unit}`.trim()
}

const formatRuntimePerformance = (system: ProcessPlantSystemRuntime): string => {
  const sample = system.performance.snapshot()
  if (sample === null || sample.simulatedMs <= 0) return 'pending'
  return `RT x${sample.realtimeFactor.toFixed(0)} (${sample.wallMs.toFixed(1)} ms)`
}

interface RailDisplayFieldPlan {
  readonly field: ProcessPlantDisplayField
  readonly handle: ProcessPlantVariableHandle
}

const railDisplayFieldPlanCache = new WeakMap<ProcessPlantSystemRuntime, ReadonlyArray<RailDisplayFieldPlan>>()

const railDisplayFieldPlansFor = (
  system: ProcessPlantSystemRuntime,
): ReadonlyArray<RailDisplayFieldPlan> => {
  const existing = railDisplayFieldPlanCache.get(system)
  if (existing) return existing
  const profile = system.system.graph.displayProfiles.find(candidate => candidate.id === railDisplayProfileId)
  const plans = profile === undefined
    ? []
    : profile.groups.flatMap(group => group.fields.map(field => ({
        field,
        handle: system.runtime.resolveVariableHandle(field.path),
      })))
  railDisplayFieldPlanCache.set(system, plans)
  return plans
}

const readField = (
  system: ProcessPlantSystemRuntime,
  plan: RailDisplayFieldPlan,
): ReturnType<typeof processPlantField> => {
  const variable = system.runtime.readVariableSnapshotHandle(plan.handle)
  const label = plan.field.label ?? variable.label
  return processPlantField(plan.field.key, label, formatValue(variable.value, variable.unit, plan.field.digits))
}

const activeLifecycles = (
  system: ProcessPlantSystemRuntime,
): ReadonlyArray<ProcessPlantIcLifecycleState> => {
  const snapshot = system.protection?.snapshot()
  if (!snapshot) return []
  return [...snapshot.alarms, ...snapshot.trips].filter(lifecycle => lifecycle.active)
}

const statusFor = (
  lifecycles: ReadonlyArray<ProcessPlantIcLifecycleState>,
): {
  readonly tone: PackObjectStatusTone
  readonly label: string
  readonly highestSeverity?: ProcessPlantIcLifecycleState['severity']
} => {
  const highestSeverity = lifecycles
    .map(lifecycle => lifecycle.severity)
    .sort((left, right) => severityRank[right] - severityRank[left])[0]
  if (highestSeverity === 'critical') return { tone: 'error', label: 'Critical alarm or trip active', highestSeverity }
  if (highestSeverity === 'warning') return { tone: 'working', label: 'Warning alarm active', highestSeverity }
  if (highestSeverity === 'notice' || highestSeverity === 'info') return { tone: 'working', label: 'Operational notice active', highestSeverity }
  return { tone: 'ready', label: 'Normal' }
}

export const projectedProcessPlantUnit = (config: {
  readonly object: OperationalObject
  readonly system: ProcessPlantSystemRuntime | undefined
  readonly at: IsoTimestamp
}): OperationalObject => {
  const parsed = processPlantUnitDomainDataSchema.safeParse(config.object.domainData)
  if (!parsed.success) return config.object
  if (!config.system) {
    return {
      ...config.object,
      domainData: {
        ...parsed.data,
        projection: emptyProcessPlantProjection(config.at),
      } satisfies ProcessPlantUnitDomainData,
    }
  }
  const system = config.system
  const lifecycles = activeLifecycles(system)
  const status = statusFor(lifecycles)
  const activeTripCount = lifecycles.filter(lifecycle => lifecycle.kind === 'trip').length
  const fields = [
    ...railDisplayFieldPlansFor(system).map(plan => readField(system, plan)),
    processPlantField('active-alarms', 'Active alarms', String(lifecycles.filter(lifecycle => lifecycle.kind === 'alarm').length)),
    processPlantField('active-trips', 'Active trips', String(activeTripCount)),
    processPlantField('runtime-performance', 'Runtime', formatRuntimePerformance(config.system)),
  ]
  const power = fields.find(field => field.key === 'thermal-power')?.value ?? 'unknown'
  const electric = fields.find(field => field.key === 'electric-output')?.value ?? 'unknown'
  const projection: ProcessPlantUnitProjection = {
    schemaVersion: 1,
    summary: `${power} thermal · ${electric} electric`,
    statusTone: status.tone,
    statusLabel: status.label,
    ...(status.highestSeverity === undefined ? {} : { highestSeverity: status.highestSeverity }),
    activeAlarmCount: lifecycles.filter(lifecycle => lifecycle.kind === 'alarm').length,
    activeTripCount,
    fields,
    updatedAt: config.at,
  }
  return {
    ...config.object,
    revision: config.object.revision + 1,
    operational: {
      ...config.object.operational,
      status: status.tone === 'ready' ? 'normal' : status.tone === 'error' ? 'critical' : 'degraded',
      priority: status.tone === 'error' ? 'critical' : status.tone === 'working' ? 'high' : 'normal',
    },
    domainData: {
      ...parsed.data,
      projection,
    } satisfies ProcessPlantUnitDomainData,
    timestamps: {
      ...config.object.timestamps,
      updatedAt: config.at,
    },
  }
}

export const processPlantProjectionKey = (object: OperationalObject): string => {
  const parsed = processPlantUnitDomainDataSchema.safeParse(object.domainData)
  const projection = parsed.success ? parsed.data.projection : undefined
  return parsed.success
    ? JSON.stringify({
        status: object.operational.status,
        priority: object.operational.priority,
        projection: projection === undefined
          ? undefined
          : {
              ...projection,
              updatedAt: '<ignored>',
            },
      })
    : ''
}
