import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import { processQuantitySchema, processSignalTagIdSchema, variableDomainSchema } from '../graph/index.ts'
import {
  processPlantSignalQuality,
  processPlantSignalReferenceSchema,
  processPlantSignalView,
  resolveProcessPlantSignalBinding,
} from '../signals.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { requireSystem, success } from './common.ts'

const signalsResolveQuerySchema = z.object({
  systemId: idSchema,
  signals: z.array(processPlantSignalReferenceSchema).min(1),
})

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

export const answerProcessPlantSignalQuery = (config: {
  readonly request: PackQueryRequest
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (!processPlantSignalQueryKinds.some(kind => kind === config.request.kind)) return undefined
  if (config.request.kind === 'process-plant.signals.resolve') {
    const payload = signalsResolveQuerySchema.parse(config.request.payload)
    const system = requireSystem(config.systems, payload.systemId)
    return success(config.request, {
      systemId: payload.systemId,
      signals: payload.signals.map(signal => processPlantSignalView(resolveProcessPlantSignalBinding(system.system.graph, signal))),
    }, config.at)
  }
  if (config.request.kind === 'process-plant.signals.read') {
    const payload = signalsResolveQuerySchema.parse(config.request.payload)
    const system = requireSystem(config.systems, payload.systemId)
    return success(config.request, {
      systemId: payload.systemId,
      signals: payload.signals.map(signal => {
        const binding = resolveProcessPlantSignalBinding(system.system.graph, signal)
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
