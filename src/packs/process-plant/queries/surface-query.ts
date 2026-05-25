import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import type { VariablePath } from '../graph/index.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { requireSystem, success } from './common.ts'
import { compileProcessSurface } from '../surfaces/compiler.ts'
import { processPlantReferenceSurfaces } from '../surfaces/reference-unit-overview.ts'
import type { CompiledProcessSurface, ProcessSurfaceBinding, ProcessSurfaceValue } from '../surfaces/model.ts'

const surfaceQuerySchema = z.object({
  systemId: idSchema,
  surfaceId: idSchema,
})

export const processPlantSurfaceQueryKinds = [
  'process-plant.surfaces.list',
  'process-plant.surface.read',
  'process-plant.surface.snapshot',
] as const

const surfaceFor = (surfaceId: string) => {
  const surface = processPlantReferenceSurfaces.find(candidate => candidate.id === surfaceId)
  if (!surface) throw new Error(`process plant surface not found: ${surfaceId}`)
  return surface
}

const compiledSurfaceFor = (
  system: ProcessPlantSystemRuntime,
  surfaceId: string,
): CompiledProcessSurface =>
  compileProcessSurface({ definition: surfaceFor(surfaceId), graph: system.system.graph })

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
  surface: CompiledProcessSurface,
): ReadonlyArray<ProcessSurfaceValue> => {
  const bindings = bindingByPath(surface)
  return surface.bindingPaths.map(path => {
    const variable = system.runtime.readVariableSnapshot(path)
    const binding = bindings.get(path)
    return {
      path,
      label: binding?.label ?? variable.label,
      unit: variable.unit,
      value: variable.value,
      formatted: binding === undefined ? String(variable.value) : formatValue(variable.value, variable.unit, binding),
    }
  })
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
      })),
    }, config.at)
  }
  const payload = surfaceQuerySchema.parse(config.request.payload)
  const system = requireSystem(config.systems, payload.systemId)
  const surface = compiledSurfaceFor(system, payload.surfaceId)
  if (config.request.kind === 'process-plant.surface.read') {
    return success(config.request, { systemId: system.system.id, surface }, config.at)
  }
  return success(config.request, {
    systemId: system.system.id,
    surfaceId: surface.id,
    values: snapshotValuesFor(system, surface),
  }, config.at)
}
