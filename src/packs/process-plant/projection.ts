import type { IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import type { PackObjectStatusTone } from '../../core/packs/protocol.ts'
import type { VariablePath } from './graph/index.ts'
import {
  emptyProcessPlantProjection,
  processPlantField,
  processPlantUnitDomainDataSchema,
  type ProcessPlantUnitDomainData,
  type ProcessPlantUnitProjection,
} from './model.ts'
import type { ProcessPlantIcLifecycleState, ProcessPlantRuntime } from './runtime/index.ts'
import type { ProcessPlantSystemRuntime } from './system-runtime.ts'

const selectedVariables: ReadonlyArray<{
  readonly key: string
  readonly label: string
  readonly path: VariablePath
  readonly digits?: number
}> = [
  { key: 'thermal-power', label: 'Thermal power', path: 'core.totalThermalPowerMw' as VariablePath, digits: 0 },
  { key: 'electric-output', label: 'Electric output', path: 'turbine.electricMw' as VariablePath, digits: 0 },
  { key: 'pzr-pressure', label: 'PZR pressure', path: 'pressurizer.pressureMPa' as VariablePath, digits: 2 },
  { key: 'pzr-level', label: 'PZR level', path: 'pressurizer.levelPercent' as VariablePath, digits: 0 },
  { key: 'sg-a-level', label: 'SG A level', path: 'sgA.levelPercent' as VariablePath, digits: 0 },
  { key: 'sg-b-level', label: 'SG B level', path: 'sgB.levelPercent' as VariablePath, digits: 0 },
  { key: 'sg-a-radiation', label: 'SG A radiation', path: 'sgA.secondaryRadiationMSvPerH' as VariablePath, digits: 2 },
  { key: 'containment-pressure', label: 'Containment pressure', path: 'containment.pressureMPa' as VariablePath, digits: 3 },
]

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

const readField = (
  variables: ReturnType<ProcessPlantRuntime['snapshot']>['variables'],
  config: typeof selectedVariables[number],
): ReturnType<typeof processPlantField> => {
  const variable = variables.find(candidate => candidate.path === config.path)
  return variable
    ? processPlantField(config.key, config.label, formatValue(variable.value, variable.unit, config.digits))
    : processPlantField(config.key, config.label, 'not in graph')
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
  const lifecycles = activeLifecycles(config.system)
  const runtimeSnapshot = config.system.runtime.snapshot()
  const status = statusFor(lifecycles)
  const activeTripCount = lifecycles.filter(lifecycle => lifecycle.kind === 'trip').length
  const fields = [
    ...selectedVariables.map(variable => readField(runtimeSnapshot.variables, variable)),
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
