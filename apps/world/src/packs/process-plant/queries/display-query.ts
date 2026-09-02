import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import {
  projectProcessGraph,
  type VariablePath,
} from '../graph/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import type { ProcessPlantVariableHandle } from '../runtime/variable-table.ts'
import { requirePlant, success } from './common.ts'
import { compileProcessDisplay } from '../displays/compiler.ts'
import {
  listProcessPlantDisplayDefinitionsForGraph,
  resolveProcessPlantDisplayDefinitionForGraph,
} from '../displays/catalog.ts'
import {
  processDisplayGraphLensSchema,
  type CompiledProcessDisplay,
  type ProcessDisplayAlarmAnnunciator,
  type ProcessDisplayAlarmLifecycle,
  type ProcessDisplayAlarmSeverity,
  type ProcessDisplayAlarmSnapshot,
  type ProcessDisplayBinding,
  type ProcessDisplayValue,
} from '../displays/model.ts'
import { projectCompiledProcessDisplay } from '../displays/projection.ts'
import type { ProcessPlantIcLifecycleState } from '../runtime/index.ts'

export const displayQuerySchema = z.object({
  plantId: idSchema,
  displayId: idSchema,
})

export const graphLensQuerySchema = displayQuerySchema.extend({
  lens: processDisplayGraphLensSchema,
})

export const processPlantDisplayQueryKinds = [
  'world.process-plant.displays.list',
  'world.process-plant.display.read',
  'world.process-plant.display.snapshot',
  'world.process-plant.display.project',
] as const

interface CompiledDisplayRuntimePlan {
  readonly display: CompiledProcessDisplay
  readonly bindings: ReadonlyMap<VariablePath, ProcessDisplayBinding>
  readonly bindingHandles: ReadonlyArray<ProcessPlantVariableHandle>
}

const compiledDisplayCache = new WeakMap<ProcessPlantRuntimeInstance, Map<string, CompiledDisplayRuntimePlan>>()

const compiledDisplayFor = (
  system: ProcessPlantRuntimeInstance,
  displayId: string,
): CompiledDisplayRuntimePlan => {
  const existingCache = compiledDisplayCache.get(system)
  const existingPlan = existingCache?.get(displayId)
  if (existingPlan) return existingPlan
  const display = compileProcessDisplay({
    definition: resolveProcessPlantDisplayDefinitionForGraph(displayId, system.plant.graph),
    graph: system.plant.graph,
  })
  const plan = {
    display,
    bindings: bindingByPath(display),
    bindingHandles: display.bindingPaths.map(path => system.runtime.resolveVariableHandle(path)),
  } satisfies CompiledDisplayRuntimePlan
  const cache = existingCache ?? new Map<string, CompiledDisplayRuntimePlan>()
  cache.set(displayId, plan)
  if (!existingCache) compiledDisplayCache.set(system, cache)
  return plan
}

const formatValue = (value: unknown, unit: string, binding: ProcessDisplayBinding): string => {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value !== 'number') return String(value)
  const digits = binding.digits ?? 1
  if (binding.display === 'percent') return `${(value * (value <= 1 ? 100 : 1)).toFixed(digits)}%`
  return `${value.toFixed(digits)} ${unit}`.trim()
}

const bindingByPath = (display: CompiledProcessDisplay): ReadonlyMap<VariablePath, ProcessDisplayBinding> => {
  const bindings = new Map<VariablePath, ProcessDisplayBinding>()
  for (const widget of display.widgets) {
    for (const binding of Object.values(widget.binds)) bindings.set(binding.path, binding)
  }
  for (const path of display.paths) {
    for (const binding of Object.values(path.binds)) bindings.set(binding.path, binding)
  }
  return bindings
}

const snapshotValuesFor = (
  system: ProcessPlantRuntimeInstance,
  plan: CompiledDisplayRuntimePlan,
): ReadonlyArray<ProcessDisplayValue> => {
  return plan.bindingHandles.map(handle => {
    const variable = system.runtime.readVariableSnapshotHandle(handle)
    const binding = plan.bindings.get(handle.path)
    return {
      path: handle.path,
      label: binding?.label ?? variable.label,
      unit: variable.unit,
      value: variable.value,
      formatted: binding === undefined ? String(variable.value) : formatValue(variable.value, variable.unit, binding),
    }
  })
}

const severityOrder: ReadonlyArray<ProcessDisplayAlarmSeverity> = ['info', 'notice', 'warning', 'critical']

const severityRank = (severity: ProcessDisplayAlarmSeverity): number =>
  severityOrder.indexOf(severity)

const compareAlarmLifecycle = (
  left: ProcessPlantIcLifecycleState,
  right: ProcessPlantIcLifecycleState,
): number => {
  if (left.firstOut && right.firstOut) {
    return (left.firstOutRank ?? Number.MAX_SAFE_INTEGER) - (right.firstOutRank ?? Number.MAX_SAFE_INTEGER)
  }
  if (left.firstOut !== right.firstOut) return left.firstOut ? -1 : 1
  const severityDelta = severityRank(right.severity) - severityRank(left.severity)
  if (severityDelta !== 0) return severityDelta
  return (left.firstActiveElapsedMs ?? left.lastActiveElapsedMs ?? Number.MAX_SAFE_INTEGER)
    - (right.firstActiveElapsedMs ?? right.lastActiveElapsedMs ?? Number.MAX_SAFE_INTEGER)
}

const alarmAnnunciatorFor = (
  lifecycle: ProcessPlantIcLifecycleState,
): ProcessDisplayAlarmAnnunciator | undefined => {
  const annunciator = lifecycle.annunciator
  if (annunciator === undefined) return undefined
  return {
    ...(annunciator.system === undefined ? {} : { system: annunciator.system }),
    ...(annunciator.equipmentId === undefined ? {} : { equipmentId: annunciator.equipmentId }),
    ...(annunciator.group === undefined ? {} : { group: annunciator.group }),
    ...(annunciator.firstOutGroup === undefined ? {} : { firstOutGroup: annunciator.firstOutGroup }),
    priority: annunciator.priority,
    role: annunciator.role,
  }
}

const alarmLifecycleFor = (
  lifecycle: ProcessPlantIcLifecycleState,
): ProcessDisplayAlarmLifecycle => {
  const annunciator = alarmAnnunciatorFor(lifecycle)
  return {
    id: lifecycle.id,
    kind: lifecycle.kind,
    title: lifecycle.title,
    message: lifecycle.message,
    severity: lifecycle.severity,
    phase: lifecycle.phase,
    active: lifecycle.active,
    acknowledged: lifecycle.acknowledged,
    firstOut: lifecycle.firstOut,
    resettable: lifecycle.resettable,
    ...(annunciator === undefined ? {} : { annunciator }),
    ...(lifecycle.firstOutRank === undefined ? {} : { firstOutRank: lifecycle.firstOutRank }),
    ...(lifecycle.firstActiveElapsedMs === undefined ? {} : { firstActiveElapsedMs: lifecycle.firstActiveElapsedMs }),
    ...(lifecycle.lastActiveElapsedMs === undefined ? {} : { lastActiveElapsedMs: lifecycle.lastActiveElapsedMs }),
    ...(lifecycle.lastClearedElapsedMs === undefined ? {} : { lastClearedElapsedMs: lifecycle.lastClearedElapsedMs }),
  }
}

const alarmSnapshotFor = (system: ProcessPlantRuntimeInstance): ProcessDisplayAlarmSnapshot => {
  const snapshot = system.protection?.snapshot()
  if (snapshot === undefined) {
    return {
      configured: false,
      activeAlarmCount: 0,
      activeTripCount: 0,
      unacknowledgedCount: 0,
      firstOutCount: 0,
      activeHighestSeverity: null,
      activeFirstOut: [],
      active: [],
    }
  }
  const lifecycles = [...snapshot.alarms, ...snapshot.trips]
  const active = lifecycles.filter(lifecycle => lifecycle.active).sort(compareAlarmLifecycle)
  const activeFirstOut = active.filter(lifecycle => lifecycle.firstOut)
  const unacknowledged = lifecycles.filter(lifecycle => !lifecycle.acknowledged && (lifecycle.active || lifecycle.lastClearedElapsedMs !== undefined))
  const activeHighestSeverity = active.reduce<ProcessDisplayAlarmSeverity | null>((highest, lifecycle) => {
    if (highest === null) return lifecycle.severity
    return severityRank(lifecycle.severity) > severityRank(highest) ? lifecycle.severity : highest
  }, null)
  return {
    configured: true,
    activeAlarmCount: snapshot.alarms.filter(lifecycle => lifecycle.active).length,
    activeTripCount: snapshot.trips.filter(lifecycle => lifecycle.active).length,
    unacknowledgedCount: unacknowledged.length,
    firstOutCount: activeFirstOut.length,
    activeHighestSeverity,
    activeFirstOut: activeFirstOut.map(alarmLifecycleFor),
    active: active.map(alarmLifecycleFor),
  }
}

export const answerProcessPlantDisplayQuery = (config: {
  readonly request: PackQueryRequest
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (!processPlantDisplayQueryKinds.some(kind => kind === config.request.kind)) return undefined
  if (config.request.kind === 'world.process-plant.displays.list') {
    const payload = z.object({ plantId: idSchema }).parse(config.request.payload)
    const system = requirePlant(config.plants, payload.plantId)
    const displays = listProcessPlantDisplayDefinitionsForGraph(system.plant.graph)
    return success(config.request, {
      plantId: system.plant.id,
      displays: displays.map(display => ({
        id: display.id,
        title: display.title,
        description: display.description,
        lenses: display.lenses,
      })),
    }, config.at)
  }
  const payload = displayQuerySchema.parse(config.request.payload)
  const system = requirePlant(config.plants, payload.plantId)
  const plan = compiledDisplayFor(system, payload.displayId)
  const display = plan.display
  if (config.request.kind === 'world.process-plant.display.read') {
    return success(config.request, { plantId: system.plant.id, display }, config.at)
  }
  if (config.request.kind === 'world.process-plant.display.project') {
    const projectPayload = graphLensQuerySchema.parse(config.request.payload)
    const graphProjection = projectProcessGraph({
      graph: system.plant.graph,
      ...projectPayload.lens,
    })
    const displayProjection = projectCompiledProcessDisplay({
      display,
      graphProjection,
    })
    return success(config.request, {
      plantId: system.plant.id,
      displayId: display.id,
      graphProjection: {
        componentIds: graphProjection.componentIds,
        connectionIds: graphProjection.connectionIds,
        diagnostics: graphProjection.diagnostics,
      },
      displayProjection: {
        visibleWidgetIds: displayProjection.visibleWidgets.map(widget => widget.id),
        visiblePathIds: displayProjection.visiblePaths.map(path => path.id),
        hiddenWidgetIds: displayProjection.hiddenWidgets.map(widget => widget.id),
        hiddenPathIds: displayProjection.hiddenPaths.map(path => path.id),
      },
    }, config.at)
  }
  return success(config.request, {
    plantId: system.plant.id,
    displayId: display.id,
    values: snapshotValuesFor(system, plan),
    alarms: alarmSnapshotFor(system),
  }, config.at)
}
