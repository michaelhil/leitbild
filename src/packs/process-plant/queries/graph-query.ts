import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import type { CompiledPlantGraph, ComponentId, ComponentInstanceSpec, ProcessPlantDisplayField } from '../graph/index.ts'
import { plantGraphToMermaid } from '../graph/index.ts'
import type { ProcessPlantVariableHandle } from '../runtime/variable-table.ts'
import { compileProcessSurface } from '../surfaces/compiler.ts'
import { processPlantReferenceSurfaces } from '../surfaces/reference-unit-overview.ts'
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

const overviewComponentIdsCache = new WeakMap<ProcessPlantSystemRuntime, ReadonlySet<ComponentId>>()

const overviewComponentIdsFor = (system: ProcessPlantSystemRuntime): ReadonlySet<ComponentId> => {
  const existing = overviewComponentIdsCache.get(system)
  if (existing) return existing
  const ids = new Set<ComponentId>()
  const surface = processPlantReferenceSurfaces.find(candidate => candidate.id === 'unit-overview')
  if (surface) {
    const compiled = compileProcessSurface({ definition: surface, graph: system.system.graph })
    for (const widget of compiled.widgets) {
      for (const componentId of widget.source?.componentIds ?? []) ids.add(componentId)
    }
  }
  overviewComponentIdsCache.set(system, ids)
  return ids
}

const artifactMetadata = (
  graph: CompiledPlantGraph,
  overviewComponentIds: ReadonlySet<ComponentId>,
): Record<string, unknown> => ({
  specId: graph.specId,
  componentCount: graph.components.length,
  linkCount: graph.links.length,
  variableCount: graph.variables.length,
  overviewComponentCount: overviewComponentIds.size,
})

const artifactComponents = (
  graph: CompiledPlantGraph,
  sourceComponents: ReadonlyArray<ComponentInstanceSpec>,
  overviewComponentIds: ReadonlySet<ComponentId>,
): ReadonlyArray<Record<string, unknown>> => {
  const sourceById = new Map(sourceComponents.map(component => [component.id, component]))
  return graph.components.map(component => {
    const source = sourceById.get(component.id) ?? {
      id: component.id,
      kind: component.kind,
      label: component.label,
      parameters: component.parameters,
      variables: [],
    } satisfies ComponentInstanceSpec
    return {
      id: component.id,
      label: component.label,
      kind: component.kind,
      shownOnOverview: overviewComponentIds.has(component.id),
      source: JSON.stringify(source, null, 2),
    }
  })
}

const artifactView = (
  system: ProcessPlantSystemRuntime,
  artifact: 'authored-spec' | 'compiled-graph-mermaid',
): unknown => {
  const overviewComponentIds = overviewComponentIdsFor(system)
  const components = artifactComponents(system.system.graph, system.system.sourceGraph.components, overviewComponentIds)
  if (artifact === 'authored-spec') {
    return {
      systemId: system.system.id,
      artifact,
      title: `${system.system.graph.title} source specification`,
      language: 'json',
      content: JSON.stringify(system.system.sourceGraph, null, 2),
      components,
      metadata: artifactMetadata(system.system.graph, overviewComponentIds),
    }
  }
  return {
    systemId: system.system.id,
    artifact,
    title: `${system.system.graph.title} full component graph`,
    language: 'mermaid',
    content: plantGraphToMermaid(system.system.graph, { highlightedComponentIds: overviewComponentIds }),
    components,
    metadata: artifactMetadata(system.system.graph, overviewComponentIds),
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
