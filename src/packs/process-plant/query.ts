import { z } from 'zod'
import type { IsoTimestamp } from '../../core/model/index.ts'
import { idSchema } from '../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../core/packs/protocol.ts'
import { processPlantControlWritePayloadSchema } from './commands.ts'
import { validateProcessPlantControlWrite } from './control-write-validation.ts'
import type { CompiledPlantGraph, VariablePath } from './graph/index.ts'
import { processQuantitySchema, processSignalTagIdSchema, variableDomainSchema, variablePathSchema } from './graph/index.ts'
import { answerProcessPlantIcQuery } from './ic-query.ts'
import type { ProcessPlantVariableSnapshot } from './runtime/index.ts'
import { evaluateProcessPlantIcCondition, processPlantIcConditionSchema } from './runtime/index.ts'
import { processPlantSignalReferenceSchema, processPlantSignalView, resolveProcessPlantSignalBinding } from './signals.ts'
import type { ProcessPlantSystemRuntime } from './system-runtime.ts'

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

const signalsResolveQuerySchema = z.object({
  systemId: idSchema,
  signals: z.array(processPlantSignalReferenceSchema).min(1),
})

const signalsReadQuerySchema = signalsResolveQuerySchema

const signalsSearchQuerySchema = z.object({
  systemId: idSchema.optional(),
  text: z.string().min(1).optional(),
  tagId: processSignalTagIdSchema.optional(),
  equipmentId: idSchema.optional(),
  domain: variableDomainSchema.optional(),
  quantity: processQuantitySchema.optional(),
  writable: z.boolean().optional(),
  procedureRelevant: z.boolean().optional(),
  publishedOnly: z.boolean().default(false),
})

const conditionsEvaluateQuerySchema = z.object({
  systemId: idSchema,
  condition: processPlantIcConditionSchema,
})

const procedureTagValidateQuerySchema = z.object({
  systemId: idSchema,
  tags: z.array(z.object({
    id: processSignalTagIdSchema,
    description: z.string().min(1).optional(),
    simPath: z.string().min(1).optional(),
    units: z.string().min(1).optional(),
    equipment: z.string().min(1).optional(),
  }).strict()).min(1),
}).strict()

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
      || variable.label.toLowerCase().includes(text)
      || variable.quantity.toLowerCase().includes(text)
      || variable.unit.toLowerCase().includes(text)
      || (variable.tagId?.toLowerCase().includes(text) ?? false)
      || (variable.equipmentId?.toLowerCase().includes(text) ?? false)
      || (variable.description?.toLowerCase().includes(text) ?? false)
  }
  return true
}

const matchesSignalSearch = (
  binding: ReturnType<typeof processPlantSignalView>,
  config: z.infer<typeof signalsSearchQuerySchema>,
): boolean => {
  if (config.publishedOnly && binding.published !== true) return false
  if (config.domain !== undefined && binding.domain !== config.domain) return false
  if (config.quantity !== undefined && binding.quantity !== config.quantity) return false
  if (config.writable !== undefined && binding.writable !== config.writable) return false
  if (config.procedureRelevant !== undefined && binding.capabilities?.procedureRelevant !== config.procedureRelevant) return false
  if (config.tagId !== undefined && binding.tagId !== config.tagId) return false
  if (config.equipmentId !== undefined && binding.equipmentId !== config.equipmentId) return false
  if (config.text !== undefined) {
    const text = config.text.toLowerCase()
    return Object.values(binding).some(value =>
      typeof value === 'string' && value.toLowerCase().includes(text),
    )
  }
  return true
}

const validateProcedureTags = (
  system: ProcessPlantSystemRuntime,
  payload: z.infer<typeof procedureTagValidateQuerySchema>,
): unknown => ({
  systemId: payload.systemId,
  tags: payload.tags.map(tag => {
    const binding = system.system.graph.signalBindingByTagId.get(tag.id)
    if (!binding) {
      return {
        id: tag.id,
        status: 'missing',
        warnings: [],
      }
    }
    const view = processPlantSignalView(binding)
    const warnings = [
      ...(tag.simPath !== undefined && tag.simPath !== String(binding.path) && !(binding.externalRefs ?? []).includes(tag.simPath)
        ? [`sim-path ${tag.simPath} does not match process path ${binding.path}`]
        : []),
      ...(tag.units !== undefined && tag.units !== binding.unit
        ? [`units ${tag.units} do not match process unit ${binding.unit}`]
        : []),
      ...(tag.equipment !== undefined && binding.equipmentId !== undefined && tag.equipment !== binding.equipmentId
        ? [`equipment ${tag.equipment} does not match process equipment ${binding.equipmentId}`]
        : []),
    ]
    return {
      id: tag.id,
      status: warnings.length === 0 ? 'resolved' : 'resolved-with-warnings',
      signal: view,
      warnings,
    }
  }),
})

export const answerProcessPlantQuery = (config: {
  readonly request: PackQueryRequest
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
}): PackQueryResponse => {
  const icResponse = answerProcessPlantIcQuery(config)
  if (icResponse !== undefined) return icResponse
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
    if (config.request.kind === 'process-plant.signals.resolve') {
      const payload = signalsResolveQuerySchema.parse(config.request.payload)
      const system = requireSystem(config.systems, payload.systemId)
      return success(config.request, {
        systemId: payload.systemId,
        signals: payload.signals.map(signal => processPlantSignalView(resolveProcessPlantSignalBinding(system.system.graph, signal))),
      }, config.at)
    }
    if (config.request.kind === 'process-plant.signals.read') {
      const payload = signalsReadQuerySchema.parse(config.request.payload)
      const system = requireSystem(config.systems, payload.systemId)
      return success(config.request, {
        systemId: payload.systemId,
        signals: payload.signals.map(signal => {
          const binding = resolveProcessPlantSignalBinding(system.system.graph, signal)
          return {
            signal: processPlantSignalView(binding),
            variable: system.runtime.readVariableSnapshot(binding.path),
          }
        }),
      }, config.at)
    }
    if (config.request.kind === 'process-plant.signals.search') {
      const payload = signalsSearchQuerySchema.parse(config.request.payload)
      const systems = payload.systemId === undefined
        ? [...config.systems.values()]
        : [requireSystem(config.systems, payload.systemId)]
      return success(config.request, {
        systems: systems.map(system => ({
          systemId: system.system.id,
          signals: system.system.graph.signalBindings
            .map(processPlantSignalView)
            .filter(binding => matchesSignalSearch(binding, payload)),
        })),
      }, config.at)
    }
    if (config.request.kind === 'process-plant.conditions.evaluate') {
      const payload = conditionsEvaluateQuerySchema.parse(config.request.payload)
      const system = requireSystem(config.systems, payload.systemId)
      const evaluation = evaluateProcessPlantIcCondition({
        system: system.system,
        runtime: system.runtime,
        condition: payload.condition,
      })
      return success(config.request, {
        systemId: payload.systemId,
        matches: evaluation.matches,
        signalsRead: evaluation.signalsRead,
      }, config.at)
    }
    if (config.request.kind === 'process-plant.procedure-tags.validate') {
      const payload = procedureTagValidateQuerySchema.parse(config.request.payload)
      const system = requireSystem(config.systems, payload.systemId)
      return success(config.request, validateProcedureTags(system, payload), config.at)
    }
    if (config.request.kind === 'process-plant.control.validate') {
      const payload = processPlantControlWritePayloadSchema.parse(config.request.payload)
      const system = requireSystem(config.systems, payload.systemId)
      return success(config.request, validateProcessPlantControlWrite({
        system: system.system,
        runtime: system.runtime,
        ...(system.protection === undefined ? {} : { protection: system.protection }),
        payload,
      }), config.at)
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
