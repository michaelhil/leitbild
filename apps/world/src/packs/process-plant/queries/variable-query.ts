import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import type { VariablePath } from '../graph/index.ts'
import { processQuantitySchema, variableDisciplineSchema, variablePathSchema } from '../graph/index.ts'
import type { ProcessPlantVariableSnapshot } from '../runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { requirePlant, success } from './common.ts'

const variablesReadQuerySchema = z.object({
  plantId: idSchema,
  paths: z.array(variablePathSchema).min(1),
})

const variablesSearchQuerySchema = z.object({
  plantId: idSchema.optional(),
  text: z.string().min(1).optional(),
  discipline: variableDisciplineSchema.optional(),
  quantity: processQuantitySchema.optional(),
  publishedOnly: z.boolean().default(false),
})

export const processPlantVariableQueryKinds = [
  'process-plant.variables.read',
  'process-plant.variables.search',
] as const

const snapshotsFor = (
  system: ProcessPlantRuntimeInstance,
  paths: ReadonlyArray<VariablePath>,
): ReadonlyArray<ProcessPlantVariableSnapshot> => paths.map(path => system.runtime.readVariableSnapshot(path))

const matchesSearch = (
  variable: ProcessPlantVariableSnapshot,
  config: z.infer<typeof variablesSearchQuerySchema>,
): boolean => {
  if (config.publishedOnly && !variable.published) return false
  if (config.discipline !== undefined && variable.discipline !== config.discipline) return false
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

export const answerProcessPlantVariableQuery = (config: {
  readonly request: PackQueryRequest
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (!processPlantVariableQueryKinds.some(kind => kind === config.request.kind)) return undefined
  if (config.request.kind === 'process-plant.variables.read') {
    const payload = variablesReadQuerySchema.parse(config.request.payload)
    const system = requirePlant(config.plants, payload.plantId)
    return success(config.request, { variables: snapshotsFor(system, payload.paths) }, config.at)
  }
  const payload = variablesSearchQuerySchema.parse(config.request.payload)
  const plants = payload.plantId === undefined
    ? [...config.plants.values()]
    : [requirePlant(config.plants, payload.plantId)]
  return success(config.request, {
    plants: plants.map(system => ({
      plantId: system.plant.id,
      variables: system.runtime.snapshot().variables.filter(variable => matchesSearch(variable, payload)),
    })),
  }, config.at)
}
