import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import type { CompiledPlantGraph, ComponentId, ProcessPlantDisplayField } from '../graph/index.ts'
import { plantGraphToMermaid } from '../graph/index.ts'
import type { ProcessPlantVariableHandle } from '../runtime/variable-table.ts'
import { compileProcessDisplay } from '../displays/compiler.ts'
import { resolveProcessPlantDisplayDefinitionForGraph } from '../displays/catalog.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { requirePlant, success, plantQuerySchema } from './common.ts'

const artifactReadQuerySchema = z.object({
  plantId: idSchema,
  artifact: z.enum(['authored-spec', 'compiled-graph-mermaid']),
})

interface ArtifactComponentView {
  readonly id: ComponentId
  readonly label: string
  readonly kind: string
  readonly shownOnOverview: boolean
}

const displayProfileReadQuerySchema = z.object({
  plantId: idSchema,
  profileId: idSchema,
})

export const processPlantGraphQueryKinds = [
  'process-plant.plants.list',
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

const overviewComponentIdsCache = new WeakMap<ProcessPlantRuntimeInstance, ReadonlySet<ComponentId>>()

const overviewComponentIdsFor = (system: ProcessPlantRuntimeInstance): ReadonlySet<ComponentId> => {
  const existing = overviewComponentIdsCache.get(system)
  if (existing) return existing
  const ids = new Set<ComponentId>()
  const display = resolveProcessPlantDisplayDefinitionForGraph('unit-overview', system.plant.graph)
  const compiled = compileProcessDisplay({ definition: display, graph: system.plant.graph })
  for (const widget of compiled.widgets) {
    for (const componentId of widget.source?.componentIds ?? []) ids.add(componentId)
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
  overviewComponentIds: ReadonlySet<ComponentId>,
): ReadonlyArray<ArtifactComponentView> => {
  return graph.components.map(component => ({
    id: component.id,
    label: component.label,
    kind: component.kind,
    shownOnOverview: overviewComponentIds.has(component.id),
  }))
}

const artifactView = (
  system: ProcessPlantRuntimeInstance,
  artifact: 'authored-spec' | 'compiled-graph-mermaid',
): unknown => {
  const overviewComponentIds = overviewComponentIdsFor(system)
  const components = artifactComponents(system.plant.graph, overviewComponentIds)
  if (artifact === 'authored-spec') {
    return {
      plantId: system.plant.id,
      artifact,
      title: `${system.plant.graph.title} source specification`,
      language: 'json',
      content: JSON.stringify(system.plant.sourceGraph, null, 2),
      components,
      metadata: artifactMetadata(system.plant.graph, overviewComponentIds),
    }
  }
  return {
    plantId: system.plant.id,
    artifact,
    title: `${system.plant.graph.title} full component graph`,
    language: 'mermaid',
    content: plantGraphToMermaid(system.plant.graph, { highlightedComponentIds: overviewComponentIds }),
    components,
    metadata: artifactMetadata(system.plant.graph, overviewComponentIds),
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

const displayProfileCache = new WeakMap<ProcessPlantRuntimeInstance, Map<string, DisplayProfileRuntimePlan>>()

const displayProfilePlanFor = (
  system: ProcessPlantRuntimeInstance,
  profileId: string,
): DisplayProfileRuntimePlan => {
  const existingCache = displayProfileCache.get(system)
  const existingPlan = existingCache?.get(profileId)
  if (existingPlan) return existingPlan
  const profile = system.plant.graph.displayProfiles.find(candidate => candidate.id === profileId)
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
  system: ProcessPlantRuntimeInstance,
  profileId: string,
): unknown => {
  const plan = displayProfilePlanFor(system, profileId)
  return {
    plantId: system.plant.id,
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
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly at: IsoTimestamp
}): PackQueryResponse | undefined => {
  if (!processPlantGraphQueryKinds.some(kind => kind === config.request.kind)) return undefined
  if (config.request.kind === 'process-plant.plants.list') {
    return success(config.request, {
      plants: [...config.plants.values()].map(({ plant, runtime }) => ({
        id: plant.id,
        componentLibrary: plant.componentLibrary,
        title: plant.graph.title,
        componentCount: plant.graph.components.length,
        linkCount: plant.graph.links.length,
        variableCount: plant.graph.variables.length,
        elapsedMs: runtime.elapsedMs(),
      })),
    }, config.at)
  }
  if (config.request.kind === 'process-plant.graph.read') {
    const payload = plantQuerySchema.parse(config.request.payload)
    const system = requirePlant(config.plants, payload.plantId)
    return success(config.request, { graph: graphView(system.plant.graph) }, config.at)
  }
  if (config.request.kind === 'process-plant.artifact.read') {
    const payload = artifactReadQuerySchema.parse(config.request.payload)
    const system = requirePlant(config.plants, payload.plantId)
    return success(config.request, artifactView(system, payload.artifact), config.at)
  }
  const payload = displayProfileReadQuerySchema.parse(config.request.payload)
  const system = requirePlant(config.plants, payload.plantId)
  return success(config.request, displayProfileView(system, payload.profileId), config.at)
}
