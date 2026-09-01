import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import { processQuantitySchema, processSignalTagIdSchema, variableDisciplineSchema } from '../graph/index.ts'
import {
  processPlantSignalQuality,
  processPlantSignalReferenceSchema,
  processPlantSignalView,
  resolveProcessPlantSignalBinding,
} from '../signals.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { requirePlant, success } from './common.ts'

const signalsResolveQuerySchema = z.object({
  plantId: idSchema,
  signals: z.array(processPlantSignalReferenceSchema).min(1),
})

const signalsSearchQuerySchema = z.object({
  plantId: idSchema.optional(),
  text: z.string().min(1).optional(),
  tagId: processSignalTagIdSchema.optional(),
  equipmentId: idSchema.optional(),
  discipline: variableDisciplineSchema.optional(),
  quantity: processQuantitySchema.optional(),
  writable: z.boolean().optional(),
  procedureRelevant: z.boolean().optional(),
  publishedOnly: z.boolean().default(false),
})

export const processPlantSignalQueryKinds = [
  'process-plant.signals.resolve',
  'process-plant.signals.read',
  'process-plant.signals.search',
] as const

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
  if (config.text !== undefined) {
    const text = config.text.toLowerCase()
    return Object.values(binding).some(value =>
      typeof value === 'string' && value.toLowerCase().includes(text),
    )
  }
  return true
}

export const answerProcessPlantSignalQuery = (config: {
  readonly request: PackQueryRequest
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (!processPlantSignalQueryKinds.some(kind => kind === config.request.kind)) return undefined
  if (config.request.kind === 'process-plant.signals.resolve') {
    const payload = signalsResolveQuerySchema.parse(config.request.payload)
    const system = requirePlant(config.plants, payload.plantId)
    return success(config.request, {
      plantId: payload.plantId,
      signals: payload.signals.map(signal => processPlantSignalView(resolveProcessPlantSignalBinding(system.plant.graph, signal))),
    }, config.at)
  }
  if (config.request.kind === 'process-plant.signals.read') {
    const payload = signalsResolveQuerySchema.parse(config.request.payload)
    const system = requirePlant(config.plants, payload.plantId)
    return success(config.request, {
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
    }, config.at)
  }
  const payload = signalsSearchQuerySchema.parse(config.request.payload)
  const plants = payload.plantId === undefined
    ? [...config.plants.values()]
    : [requirePlant(config.plants, payload.plantId)]
  return success(config.request, {
    plants: plants.map(system => ({
      plantId: system.plant.id,
      signals: system.plant.graph.signalBindings
        .map(processPlantSignalView)
        .filter(binding => matchesSignalSearch(binding, payload)),
    })),
  }, config.at)
}
