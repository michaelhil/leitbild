import { z } from 'zod'
import { idSchema, matchesLiteralSearch } from '../../../core/model/index.ts'
import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import { processQuantitySchema, processSignalTagIdSchema, variableDisciplineSchema } from '../graph/index.ts'
import {
  findProcessPlantSignalBinding,
  processPlantSignalQuality,
  processPlantSignalReferenceSchema,
  processPlantSignalView,
  resolveProcessPlantSignalBinding,
} from '../signals.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { paginateProcessPlantSearch, processPlantSearchPaginationShape, requirePlant } from './common.ts'

export const signalsResolveQuerySchema = z.object({
  plantId: idSchema,
  signals: z.array(processPlantSignalReferenceSchema).min(1),
}).strict()

export const signalsSearchQuerySchema = z.object({
  plantId: idSchema.optional(),
  text: z.string().min(1).optional(),
  tagId: processSignalTagIdSchema.optional(),
  equipmentId: idSchema.optional(),
  discipline: variableDisciplineSchema.optional(),
  quantity: processQuantitySchema.optional(),
  writable: z.boolean().optional(),
  procedureRelevant: z.boolean().optional(),
  publishedOnly: z.boolean().default(false),
  ...processPlantSearchPaginationShape,
}).strict()

const procedureTagSchema = z.object({
  id: processSignalTagIdSchema,
  description: z.string().min(1).optional(),
  simPath: z.string().min(1).optional(),
  units: z.string().min(1).optional(),
  equipment: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  range: z.array(z.number().finite()).length(2).optional(),
}).strict()

export const procedureTagsValidateQuerySchema = z.object({
  plantId: idSchema,
  tags: z.array(procedureTagSchema),
}).strict()

export const processPlantSignalQueryKinds = [
  'world.process-plant.signals.resolve',
  'world.process-plant.signals.read',
  'world.process-plant.signals.search',
  'world.process-plant.procedure-tags.validate',
] as const

const normalizedSourceKey = (value: string): string =>
  value.trim().toLowerCase().replace(/[-_.\s]/g, '')

const normalizedUnit = (value: string): string =>
  value.trim().toLowerCase().replace(/\s/g, '')

const procedureUnitsCompatible = (requested: string | undefined, actual: string): boolean => {
  if (requested === undefined) return true
  const left = normalizedUnit(requested)
  const right = normalizedUnit(actual)
  if (left === right) return true
  if ((left === 'bool' || left === 'boolean') && right === 'boolean') return true
  if (left.startsWith('enum[') && (right === 'boolean' || right === 'fraction' || right === 'percent')) return true
  return (left === 'degf' && right === 'degc')
    || (left === 'gpm' && right === 'kg/s')
    || (left === 'psig' && (right === 'mpa' || right === 'pa'))
    || (left === 'inhga' && right === 'pa')
    || (left === 'percent_collapsed_liquid' && right === 'percent')
    || (left === 'steps_withdrawn' && right === 'fraction')
}

interface ProcessPlantProcedureTagValidation {
  readonly id: string
  readonly status: 'resolved' | 'resolved-with-warnings' | 'missing'
  readonly signal?: ReturnType<typeof processPlantSignalView>
  readonly warnings: ReadonlyArray<string>
}

const validateProcedureTags = (
  system: ProcessPlantRuntimeInstance,
  tags: ReadonlyArray<z.infer<typeof procedureTagSchema>>,
): ReadonlyArray<ProcessPlantProcedureTagValidation> => tags.map(tag => {
  const binding = findProcessPlantSignalBinding(system.plant.graph, { tagId: tag.id })
  if (binding === undefined) return { id: tag.id, status: 'missing', warnings: [] }

  const signal = processPlantSignalView(binding)
  const externalRefs = signal.externalRefs ?? []
  const resolvedByExternalReference = externalRefs.includes(tag.id)
    || (tag.simPath !== undefined && externalRefs.includes(tag.simPath))
  const warnings = [
    ...(tag.simPath !== undefined && tag.simPath !== signal.path && !externalRefs.includes(tag.simPath)
      ? [`sim-path ${tag.simPath} does not match process path ${signal.path}`]
      : []),
    ...(!resolvedByExternalReference && !procedureUnitsCompatible(tag.units, signal.unit)
      ? [`units ${tag.units} do not match process unit ${signal.unit}`]
      : []),
    ...(tag.equipment !== undefined && signal.equipmentId !== undefined
      && normalizedSourceKey(tag.equipment) !== normalizedSourceKey(signal.equipmentId)
      && !resolvedByExternalReference
      ? [`equipment ${tag.equipment} does not match process equipment ${signal.equipmentId}`]
      : []),
  ]
  return {
    id: tag.id,
    status: warnings.length === 0 ? 'resolved' : 'resolved-with-warnings',
    signal,
    warnings,
  }
})

const matchesSignalSearch = (
  binding: ReturnType<typeof processPlantSignalView>,
  config: z.infer<typeof signalsSearchQuerySchema>,
): boolean => {
  if (config.publishedOnly && binding.published !== true) return false
  if (config.discipline !== undefined && binding.discipline !== config.discipline) return false
  if (config.quantity !== undefined && binding.quantity !== config.quantity) return false
  if (config.writable !== undefined && binding.writable !== config.writable) return false
  if (config.procedureRelevant !== undefined && binding.capabilities?.procedureRelevant !== config.procedureRelevant) return false
  if (config.tagId !== undefined && binding.tagId !== config.tagId) return false
  if (config.equipmentId !== undefined && binding.equipmentId !== config.equipmentId) return false
  return matchesLiteralSearch(config.text, [
    binding.path,
    binding.tagId,
    binding.equipmentId,
    binding.label,
    binding.description,
    binding.kind,
    binding.discipline,
    binding.quantity,
    binding.unit,
    ...(binding.externalRefs ?? []),
  ])
}

export const answerProcessPlantSignalQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
}): unknown | undefined => {
  if (!processPlantSignalQueryKinds.some(kind => kind === config.request.capabilityId)) return undefined
  if (config.request.capabilityId === 'world.process-plant.procedure-tags.validate') {
    const payload = procedureTagsValidateQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    return {
      plantId: payload.plantId,
      tags: validateProcedureTags(system, payload.tags),
    }
  }
  if (config.request.capabilityId === 'world.process-plant.signals.resolve') {
    const payload = signalsResolveQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    return {
      plantId: payload.plantId,
      signals: payload.signals.map(signal => processPlantSignalView(resolveProcessPlantSignalBinding(system.plant.graph, signal))),
    }
  }
  if (config.request.capabilityId === 'world.process-plant.signals.read') {
    const payload = signalsResolveQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    return {
      plantId: payload.plantId,
      signals: payload.signals.map(signal => {
        const binding = resolveProcessPlantSignalBinding(system.plant.graph, signal)
        const variable = system.runtime.readVariableSnapshot(binding.path)
        return {
          signal: processPlantSignalView(binding),
          variable,
          quality: processPlantSignalQuality(variable),
        }
      }),
    }
  }
  const payload = signalsSearchQuerySchema.parse(config.request.input)
  const plants = payload.plantId === undefined
    ? [...config.plants.values()]
    : [requirePlant(config.plants, payload.plantId)]
  const matches = plants.flatMap(system => system.plant.graph.signalBindings
    .map(processPlantSignalView)
    .filter(binding => matchesSignalSearch(binding, payload))
    .map(signal => ({ plantId: system.plant.id, signal })))
  const page = paginateProcessPlantSearch(matches, payload.offset, payload.limit)
  return { total: page.total, offset: page.offset, returned: page.returned, hasMore: page.hasMore, signals: page.items }
}
