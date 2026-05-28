import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import type { CompiledPlantGraph, ProcessPlantDisplayField } from '../graph/index.ts'
import { plantGraphToMermaid } from '../graph/index.ts'
import type { ProcessPlantVariableHandle } from '../runtime/variable-table.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { requireSystem, success, systemQuerySchema } from './common.ts'

const artifactReadQuerySchema = z.object({
  systemId: idSchema,
  artifact: z.enum(['authored-spec', 'compiled-graph-mermaid']),
})

const displayProfileReadQuerySchema = z.object({
  systemId: idSchema,
  profileId: idSchema,
})

export const processPlantGraphQueryKinds = [
  'process-plant.systems.list',
  'process-plant.graph.read',
  'process-plant.artifact.read',
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

const artifactMetadata = (graph: CompiledPlantGraph): Record<string, unknown> => ({
  specId: graph.specId,
  componentCount: graph.components.length,
  linkCount: graph.links.length,
  variableCount: graph.variables.length,
})

const artifactView = (
  system: ProcessPlantSystemRuntime,
  artifact: 'authored-spec' | 'compiled-graph-mermaid',
): unknown => {
  if (artifact === 'authored-spec') {
    return {
      systemId: system.system.id,
      artifact,
      title: `${system.system.graph.title} source specification`,
      language: 'json',
      content: JSON.stringify(system.system.sourceGraph, null, 2),
      metadata: artifactMetadata(system.system.graph),
    }
  }
  return {
    systemId: system.system.id,
    artifact,
    title: `${system.system.graph.title} full component graph`,
    language: 'mermaid',
    content: plantGraphToMermaid(system.system.graph),
    metadata: artifactMetadata(system.system.graph),
  }
}

interface DisplayProfileRuntimePlan {
  readonly profile: CompiledPlantGraph['displayProfiles'][number]
  readonly groups: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly fields: ReadonlyArray<{
      readonly field: ProcessPlantDisplayField
      readonly handle: ProcessPlantVariableHandle
    }>
  }>
}

const displayProfileCache = new WeakMap<ProcessPlantSystemRuntime, Map<string, DisplayProfileRuntimePlan>>()

const displayProfilePlanFor = (
  system: ProcessPlantSystemRuntime,
  profileId: string,
): DisplayProfileRuntimePlan => {
  const existingCache = displayProfileCache.get(system)
  const existingPlan = existingCache?.get(profileId)
  if (existingPlan) return existingPlan
  const profile = system.system.graph.displayProfiles.find(candidate => candidate.id === profileId)
  if (!profile) throw new Error(`process plant display profile not found: ${profileId}`)
  const plan = {
    profile,
    groups: profile.groups.map(group => ({
      id: group.id,
      label: group.label,
      fields: group.fields.map(field => ({
        field,
        handle: system.runtime.resolveVariableHandle(field.path),
      })),
    })),
  } satisfies DisplayProfileRuntimePlan
  const cache = existingCache ?? new Map<string, DisplayProfileRuntimePlan>()
  cache.set(profileId, plan)
  if (!existingCache) displayProfileCache.set(system, cache)
  return plan
}

const displayProfileView = (
  system: ProcessPlantSystemRuntime,
  profileId: string,
): unknown => {
  const plan = displayProfilePlanFor(system, profileId)
  return {
    systemId: system.system.id,
    profile: plan.profile,
    groups: plan.groups.map(group => ({
      id: group.id,
      label: group.label,
      fields: group.fields.map(field => {
        const variable = system.runtime.readVariableSnapshotHandle(field.handle)
        return {
          key: field.field.key,
          label: field.field.label ?? variable.label,
          path: field.field.path,
          ...(field.field.digits === undefined ? {} : { digits: field.field.digits }),
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
  if (config.request.kind === 'process-plant.artifact.read') {
    const payload = artifactReadQuerySchema.parse(config.request.payload)
    const system = requireSystem(config.systems, payload.systemId)
    return success(config.request, artifactView(system, payload.artifact), config.at)
  }
  const payload = displayProfileReadQuerySchema.parse(config.request.payload)
  const system = requireSystem(config.systems, payload.systemId)
  return success(config.request, displayProfileView(system, payload.profileId), config.at)
}
