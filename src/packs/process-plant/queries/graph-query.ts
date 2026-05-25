import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import type { CompiledPlantGraph } from '../graph/index.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { requireSystem, success, systemQuerySchema } from './common.ts'

const displayProfileReadQuerySchema = z.object({
  systemId: idSchema,
  profileId: idSchema,
})

export const processPlantGraphQueryKinds = [
  'process-plant.systems.list',
  'process-plant.graph.read',
  'process-plant.display-profile.read',
] as const

const graphView = (graph: CompiledPlantGraph): unknown => ({
  specId: graph.specId,
  title: graph.title,
  timestep: graph.timestep,
  components: graph.components,
  links: graph.links,
  linksByKind: graph.linksByKind,
  variables: graph.variables,
  displayProfiles: graph.displayProfiles,
})

const displayProfileView = (
  system: ProcessPlantSystemRuntime,
  profileId: string,
): unknown => {
  const profile = system.system.graph.displayProfiles.find(candidate => candidate.id === profileId)
  if (!profile) throw new Error(`process plant display profile not found: ${profileId}`)
  return {
    systemId: system.system.id,
    profile,
    groups: profile.groups.map(group => ({
      id: group.id,
      label: group.label,
      fields: group.fields.map(field => {
        const variable = system.runtime.readVariableSnapshot(field.path)
        return {
          key: field.key,
          label: field.label ?? variable.label,
          path: field.path,
          ...(field.digits === undefined ? {} : { digits: field.digits }),
          variable,
        }
      }),
    })),
  }
}

export const answerProcessPlantGraphQuery = (config: {
  readonly request: PackQueryRequest
  readonly systems: ReadonlyMap<string, ProcessPlantSystemRuntime>
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (!processPlantGraphQueryKinds.some(kind => kind === config.request.kind)) return undefined
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
  const payload = displayProfileReadQuerySchema.parse(config.request.payload)
  const system = requireSystem(config.systems, payload.systemId)
  return success(config.request, displayProfileView(system, payload.profileId), config.at)
}
