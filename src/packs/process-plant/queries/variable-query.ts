import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import type { VariablePath } from '../graph/index.ts'
import { processQuantitySchema, variableDomainSchema, variablePathSchema } from '../graph/index.ts'
import type { ProcessPlantVariableSnapshot } from '../runtime/index.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { requireSystem, success } from './common.ts'

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

export const processPlantVariableQueryKinds = [
  'process-plant.variables.read',
  'process-plant.variables.search',
] as const

const snapshotsFor = (
  system: ProcessPlantSystemRuntime,
  paths: ReadonlyArray<VariablePath>,
): ReadonlyArray<ProcessPlantVariableSnapshot> => paths.map(path => system.runtime.readVariableSnapshot(path))

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

export const answerProcessPlantVariableQuery = (config: {
  readonly request: PackQueryRequest
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (!processPlantVariableQueryKinds.some(kind => kind === config.request.kind)) return undefined
  if (config.request.kind === 'process-plant.variables.read') {
    const payload = variablesReadQuerySchema.parse(config.request.payload)
    const system = requireSystem(config.systems, payload.systemId)
    return success(config.request, { variables: snapshotsFor(system, payload.paths) }, config.at)
  }
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
