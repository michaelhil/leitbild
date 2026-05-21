import { z } from 'zod'
import type { IsoTimestamp } from '../../core/model/index.ts'
import { idSchema } from '../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../core/packs/protocol.ts'
import type { CompiledPlantGraph, VariablePath } from './graph/index.ts'
import { processQuantitySchema, variableDomainSchema, variablePathSchema } from './graph/index.ts'
import type { CompiledProcessPlantSystem } from './process-systems.ts'
import type { ProcessPlantRuntime, ProcessPlantVariableSnapshot } from './runtime/index.ts'
import type { ProcessPlantScheduleRunner, ProcessPlantTelemetryRecorder } from './runtime/index.ts'

export interface ProcessPlantSystemRuntime {
  readonly system: CompiledProcessPlantSystem
  readonly runtime: ProcessPlantRuntime
  readonly schedule: ProcessPlantScheduleRunner
  readonly telemetry?: ProcessPlantTelemetryRecorder
}

const systemQuerySchema = z.object({
  systemId: idSchema,
})

const variablesReadQuerySchema = z.object({
  systemId: idSchema,
  paths: z.array(variablePathSchema).min(1),
})

const variablesSearchQuerySchema = z.object({
  systemId: idSchema.optional(),
  text: z.string().min(1).optional(),
  domain: variableDomainSchema.optional(),
  quantity: processQuantitySchema.optional(),
  publishedOnly: z.boolean().default(false),
})

const trendsReadQuerySchema = z.object({
  systemId: idSchema,
  paths: z.array(variablePathSchema).min(1).optional(),
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

const graphView = (graph: CompiledPlantGraph): unknown => ({
  specId: graph.specId,
  title: graph.title,
  timestep: graph.timestep,
  components: graph.components,
  links: graph.links,
  linksByKind: graph.linksByKind,
  variables: graph.variables,
})

const requireSystem = (
  systems: ReadonlyMap<string, ProcessPlantSystemRuntime>,
  systemId: string,
): ProcessPlantSystemRuntime => {
  const system = systems.get(systemId)
  if (!system) throw new Error(`process plant system not found: ${systemId}`)
  return system
}

const snapshotsFor = (
  system: ProcessPlantSystemRuntime,
  paths: ReadonlyArray<VariablePath>,
): ReadonlyArray<ProcessPlantVariableSnapshot> => {
  return paths.map(path => system.runtime.readVariableSnapshot(path))
}

const matchesSearch = (
  variable: ProcessPlantVariableSnapshot,
  config: z.infer<typeof variablesSearchQuerySchema>,
): boolean => {
  if (config.publishedOnly && !variable.published) return false
  if (config.domain !== undefined && variable.domain !== config.domain) return false
  if (config.quantity !== undefined && variable.quantity !== config.quantity) return false
  if (config.text !== undefined) {
    const text = config.text.toLowerCase()
    return String(variable.path).toLowerCase().includes(text)
      || variable.quantity.toLowerCase().includes(text)
      || variable.unit.toLowerCase().includes(text)
  }
  return true
}

export const answerProcessPlantQuery = (config: {
  readonly request: PackQueryRequest
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
}): PackQueryResponse => {
  try {
    if (config.request.kind === 'process-plant.systems.list') {
      return success(config.request, {
        systems: [...config.systems.values()].map(({ system, runtime }) => ({
          id: system.id,
          componentLibrary: system.componentLibrary,
          title: system.graph.title,
          componentCount: system.graph.components.length,
          linkCount: system.graph.links.length,
          variableCount: system.graph.variables.length,
          elapsedMs: runtime.elapsedMs(),
        })),
      }, config.at)
    }
    if (config.request.kind === 'process-plant.graph.read') {
      const payload = systemQuerySchema.parse(config.request.payload)
      const system = requireSystem(config.systems, payload.systemId)
      return success(config.request, { graph: graphView(system.system.graph) }, config.at)
    }
    if (config.request.kind === 'process-plant.variables.read') {
      const payload = variablesReadQuerySchema.parse(config.request.payload)
      const system = requireSystem(config.systems, payload.systemId)
      return success(config.request, { variables: snapshotsFor(system, payload.paths) }, config.at)
    }
    if (config.request.kind === 'process-plant.variables.search') {
      const payload = variablesSearchQuerySchema.parse(config.request.payload)
      const systems = payload.systemId === undefined
        ? [...config.systems.values()]
        : [requireSystem(config.systems, payload.systemId)]
      return success(config.request, {
        systems: systems.map(system => ({
          systemId: system.system.id,
          variables: system.runtime.snapshot().variables.filter(variable => matchesSearch(variable, payload)),
        })),
      }, config.at)
    }
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
    if (config.request.kind === 'process-plant.trends.read') {
      const payload = trendsReadQuerySchema.parse(config.request.payload)
      const system = requireSystem(config.systems, payload.systemId)
      if (!system.telemetry) return failure(config.request, `process plant telemetry is not configured for system: ${payload.systemId}`, config.at)
      return success(config.request, {
        systemId: payload.systemId,
        series: system.telemetry.series(payload.paths),
      }, config.at)
    }
    return failure(config.request, `process plant pack does not support query kind: ${config.request.kind}`, config.at)
  } catch (err) {
    return failure(config.request, err instanceof Error ? err.message : String(err), config.at)
  }
}
