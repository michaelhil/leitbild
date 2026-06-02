import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import {
  projectProcessGraph,
  type VariablePath,
} from '../graph/index.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import type { ProcessPlantVariableHandle } from '../runtime/variable-table.ts'
import { requireSystem, success } from './common.ts'
import { compileProcessSurface } from '../surfaces/compiler.ts'
import { processPlantReferenceSurfaces } from '../surfaces/reference-unit-overview.ts'
import {
  processSurfaceGraphLensSchema,
  type CompiledProcessSurface,
  type ProcessSurfaceAlarmAnnunciator,
  type ProcessSurfaceAlarmLifecycle,
  type ProcessSurfaceAlarmSeverity,
  type ProcessSurfaceAlarmSnapshot,
  type ProcessSurfaceBinding,
  type ProcessSurfaceValue,
} from '../surfaces/model.ts'
import { projectCompiledProcessSurface } from '../surfaces/projection.ts'
import type { ProcessPlantIcLifecycleState } from '../runtime/index.ts'

const surfaceQuerySchema = z.object({
  systemId: idSchema,
  surfaceId: idSchema,
})

const graphLensQuerySchema = surfaceQuerySchema.extend({
  lens: processSurfaceGraphLensSchema,
})

export const processPlantSurfaceQueryKinds = [
  'process-plant.surfaces.list',
  'process-plant.surface.read',
  'process-plant.surface.snapshot',
  'process-plant.surface.project',
] as const

const surfaceFor = (surfaceId: string) => {
  const surface = processPlantReferenceSurfaces.find(candidate => candidate.id === surfaceId)
  if (!surface) throw new Error(`process plant surface not found: ${surfaceId}`)
  return surface
}

interface CompiledSurfaceRuntimePlan {
  readonly surface: CompiledProcessSurface
  readonly bindings: ReadonlyMap<VariablePath, ProcessSurfaceBinding>
  readonly bindingHandles: ReadonlyArray<ProcessPlantVariableHandle>
}

const compiledSurfaceCache = new WeakMap<ProcessPlantSystemRuntime, Map<string, CompiledSurfaceRuntimePlan>>()

const compiledSurfaceFor = (
  system: ProcessPlantSystemRuntime,
  surfaceId: string,
): CompiledSurfaceRuntimePlan => {
  const existingCache = compiledSurfaceCache.get(system)
  const existingPlan = existingCache?.get(surfaceId)
  if (existingPlan) return existingPlan
  const surface = compileProcessSurface({ definition: surfaceFor(surfaceId), graph: system.system.graph })
  const plan = {
    surface,
    bindings: bindingByPath(surface),
    bindingHandles: surface.bindingPaths.map(path => system.runtime.resolveVariableHandle(path)),
  } satisfies CompiledSurfaceRuntimePlan
  const cache = existingCache ?? new Map<string, CompiledSurfaceRuntimePlan>()
  cache.set(surfaceId, plan)
  if (!existingCache) compiledSurfaceCache.set(system, cache)
  return plan
}

const formatValue = (value: unknown, unit: string, binding: ProcessSurfaceBinding): string => {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value !== 'number') return String(value)
  const digits = binding.digits ?? 1
  if (binding.display === 'percent') return `${(value * (value <= 1 ? 100 : 1)).toFixed(digits)}%`
  return `${value.toFixed(digits)} ${unit}`.trim()
}

const bindingByPath = (surface: CompiledProcessSurface): ReadonlyMap<VariablePath, ProcessSurfaceBinding> => {
  const bindings = new Map<VariablePath, ProcessSurfaceBinding>()
  for (const widget of surface.widgets) {
    for (const binding of Object.values(widget.binds)) bindings.set(binding.path, binding)
  }
  for (const path of surface.paths) {
    for (const binding of Object.values(path.binds)) bindings.set(binding.path, binding)
  }
  return bindings
}

const snapshotValuesFor = (
  system: ProcessPlantSystemRuntime,
  plan: CompiledSurfaceRuntimePlan,
): ReadonlyArray<ProcessSurfaceValue> => {
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

const severityOrder: ReadonlyArray<ProcessSurfaceAlarmSeverity> = ['info', 'notice', 'warning', 'critical']

const severityRank = (severity: ProcessSurfaceAlarmSeverity): number =>
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
): ProcessSurfaceAlarmAnnunciator | undefined => {
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
): ProcessSurfaceAlarmLifecycle => {
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

const alarmSnapshotFor = (system: ProcessPlantSystemRuntime): ProcessSurfaceAlarmSnapshot => {
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
  const activeHighestSeverity = active.reduce<ProcessSurfaceAlarmSeverity | null>((highest, lifecycle) => {
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

export const answerProcessPlantSurfaceQuery = (config: {
  readonly request: PackQueryRequest
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (!processPlantSurfaceQueryKinds.some(kind => kind === config.request.kind)) return undefined
  if (config.request.kind === 'process-plant.surfaces.list') {
    const payload = z.object({ systemId: idSchema }).parse(config.request.payload)
    const system = requireSystem(config.systems, payload.systemId)
    return success(config.request, {
      systemId: system.system.id,
      surfaces: processPlantReferenceSurfaces.map(surface => ({
        id: surface.id,
        title: surface.title,
        description: surface.description,
        lenses: surface.lenses,
      })),
    }, config.at)
  }
  const payload = surfaceQuerySchema.parse(config.request.payload)
  const system = requireSystem(config.systems, payload.systemId)
  const plan = compiledSurfaceFor(system, payload.surfaceId)
  const surface = plan.surface
  if (config.request.kind === 'process-plant.surface.read') {
    return success(config.request, { systemId: system.system.id, surface }, config.at)
  }
  if (config.request.kind === 'process-plant.surface.project') {
    const projectPayload = graphLensQuerySchema.parse(config.request.payload)
    const graphProjection = projectProcessGraph({
      graph: system.system.graph,
      ...projectPayload.lens,
    })
    const surfaceProjection = projectCompiledProcessSurface({
      surface,
      graphProjection,
    })
    return success(config.request, {
      systemId: system.system.id,
      surfaceId: surface.id,
      graphProjection: {
        componentIds: graphProjection.componentIds,
        connectionIds: graphProjection.connectionIds,
        diagnostics: graphProjection.diagnostics,
      },
      surfaceProjection: {
        visibleWidgetIds: surfaceProjection.visibleWidgets.map(widget => widget.id),
        visiblePathIds: surfaceProjection.visiblePaths.map(path => path.id),
        hiddenWidgetIds: surfaceProjection.hiddenWidgets.map(widget => widget.id),
        hiddenPathIds: surfaceProjection.hiddenPaths.map(path => path.id),
      },
    }, config.at)
  }
  return success(config.request, {
    systemId: system.system.id,
    surfaceId: surface.id,
    values: snapshotValuesFor(system, plan),
    alarms: alarmSnapshotFor(system),
  }, config.at)
}
