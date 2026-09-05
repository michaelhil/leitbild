import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { idSchema } from '../../../core/model/index.ts'
import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import type { CompiledPlantGraph, ComponentId, ProcessPlantDisplayField } from '../graph/index.ts'
import { plantGraphToMermaid } from '../graph/index.ts'
import type { ProcessPlantVariableHandle } from '../runtime/variable-table.ts'
import { processPlantComponentBehaviorSourcePathByKind } from '../runtime/behaviors/index.ts'
import { compileProcessDisplay } from '../displays/compiler.ts'
import { resolveProcessPlantDisplayDefinitionForGraph } from '../displays/catalog.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { capabilityTargetNotFound, requirePlant, plantQuerySchema } from './common.ts'

export const artifactReadQuerySchema = z.object({
  plantId: idSchema,
  artifact: z.enum(['authored-spec', 'compiled-graph-mermaid']),
}).strict()

export const componentsSearchQuerySchema = z.object({
  plantId: idSchema,
  query: z.string().trim().min(1).optional(),
  componentIds: z.array(idSchema).optional(),
  kinds: z.array(z.string().trim().min(1)).optional(),
  includeParameters: z.boolean().default(false),
}).strict()

interface ArtifactComponentView {
  readonly id: ComponentId
  readonly label: string
  readonly kind: string
  readonly shownOnOverview: boolean
  readonly sourcePath: string | null
  readonly sourceLinks: ReadonlyArray<ComponentSourceImportView>
}

interface ComponentSourceImportView {
  readonly symbol: string
  readonly importedName: string
  readonly targetPath: string
  readonly targetLineIndex: number | null
}

interface ArtifactSourceFileView {
  readonly path: string
  readonly content: string
}

const sourceRoot = new URL('../../../..', import.meta.url)
const processPlantSourceRoot = new URL('src/packs/process-plant/', sourceRoot)
const componentSourceCache = new Map<string, string>()
const componentSourceImportCache = new Map<string, ReadonlyArray<ComponentSourceImportView>>()

const sourceUrlFor = (sourcePath: string): URL => {
  const url = new URL(sourcePath, sourceRoot)
  if (!url.href.startsWith(processPlantSourceRoot.href)) {
    throw new Error(`process plant source path leaves the Pack boundary: ${sourcePath}`)
  }
  return url
}

const sourceTextFor = (sourcePath: string): string => {
  const existing = componentSourceCache.get(sourcePath)
  if (existing !== undefined) return existing
  const content = readFileSync(sourceUrlFor(sourcePath), 'utf8')
  componentSourceCache.set(sourcePath, content)
  return content
}

const importDeclarationPattern = /(?:^|\n)\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
const identifierCharacters = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const relativeSourcePathFor = (url: URL): string | null => {
  if (!url.href.startsWith(processPlantSourceRoot.href)) return null
  return decodeURIComponent(url.href.slice(sourceRoot.href.length))
}

const resolveRelativeSourcePath = (sourcePath: string, importPath: string): string | null => {
  if (!importPath.startsWith('.')) return null
  const resolved = new URL(importPath, sourceUrlFor(sourcePath))
  if (!resolved.pathname.endsWith('.ts')) resolved.pathname = `${resolved.pathname}.ts`
  return relativeSourcePathFor(resolved)
}

const importedSymbolsFor = (importClause: string): ReadonlyArray<{ readonly symbol: string; readonly importedName: string }> => {
  const namedImportBody = /\{([\s\S]*?)\}/.exec(importClause)?.[1]
  if (namedImportBody === undefined) return []
  return namedImportBody
    .split(',')
    .map(part => part.trim().replace(/^type\s+/, '').trim())
    .filter(part => part.length > 0)
    .flatMap(part => {
      const [imported, alias] = part.split(/\s+as\s+/).map(value => value.trim())
      if (!imported || !identifierCharacters.test(imported)) return []
      const symbol = alias && identifierCharacters.test(alias) ? alias : imported
      return [{ symbol, importedName: imported }]
    })
}

const escapedIdentifier = (identifier: string): string => identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const definitionLineIndexFor = (content: string, exportedName: string): number | null => {
  const pattern = new RegExp(`^\\s*export\\s+(?:const|function|interface|type|enum)\\s+${escapedIdentifier(exportedName)}\\b`)
  const index = content.split(/\r\n|\r|\n/).findIndex(line => pattern.test(line))
  return index < 0 ? null : index
}

const componentSourceImportsFor = (sourcePath: string): ReadonlyArray<ComponentSourceImportView> => {
  const cached = componentSourceImportCache.get(sourcePath)
  if (cached) return cached
  const imports: ComponentSourceImportView[] = []
  const seen = new Set<string>()
  for (const match of sourceTextFor(sourcePath).matchAll(importDeclarationPattern)) {
    const targetPath = resolveRelativeSourcePath(sourcePath, match[2] ?? '')
    if (!targetPath) continue
    const targetContent = sourceTextFor(targetPath)
    for (const imported of importedSymbolsFor(match[1] ?? '')) {
      const key = `${imported.symbol}:${targetPath}:${imported.importedName}`
      if (seen.has(key)) continue
      seen.add(key)
      imports.push({
        ...imported,
        targetPath,
        targetLineIndex: definitionLineIndexFor(targetContent, imported.importedName),
      })
    }
  }
  componentSourceImportCache.set(sourcePath, imports)
  return imports
}

export const displayProfileReadQuerySchema = z.object({
  plantId: idSchema,
  profileId: idSchema,
}).strict()

export const processPlantGraphQueryKinds = [
  'world.process-plant.plants.list',
  'world.process-plant.components.search',
  'world.process-plant.graph.read',
  'world.process-plant.artifact.read',
  'world.process-plant.display-profile.read',
] as const

const componentSearchView = (
  system: ProcessPlantRuntimeInstance,
  input: z.infer<typeof componentsSearchQuerySchema>,
): unknown => {
  const idSet = input.componentIds ? new Set(input.componentIds) : undefined
  const kindSet = input.kinds ? new Set(input.kinds) : undefined
  const needle = input.query?.toLocaleLowerCase()
  const matches = system.plant.graph.components.filter(component => {
    if (idSet && !idSet.has(component.id)) return false
    if (kindSet && !kindSet.has(component.kind)) return false
    if (!needle) return true
    return [component.id, component.kind, component.label]
      .some(value => value.toLocaleLowerCase().includes(needle))
  })
  const byKind: Record<string, number> = {}
  for (const component of system.plant.graph.components) {
    byKind[component.kind] = (byKind[component.kind] ?? 0) + 1
  }
  return {
    plantId: system.plant.id,
    specification: {
      id: system.plant.graph.specId,
      title: system.plant.graph.title,
      timestep: system.plant.graph.timestep,
    },
    totalComponents: system.plant.graph.components.length,
    matchedComponents: matches.length,
    byKind,
    components: matches.map(component => ({
      id: component.id,
      kind: component.kind,
      label: component.label,
      ...(component.metadata ? { metadata: component.metadata } : {}),
      ...(input.includeParameters ? { parameters: component.parameters } : {}),
    })),
  }
}

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
  return graph.components.map(component => {
    const sourcePath = processPlantComponentBehaviorSourcePathByKind.get(component.kind) ?? null
    return {
      id: component.id,
      label: component.label,
      kind: component.kind,
      shownOnOverview: overviewComponentIds.has(component.id),
      sourcePath,
      sourceLinks: sourcePath === null ? [] : componentSourceImportsFor(sourcePath),
    }
  })
}

const artifactSourceFiles = (components: ReadonlyArray<ArtifactComponentView>): ReadonlyArray<ArtifactSourceFileView> => {
  const paths = new Set<string>()
  for (const component of components) {
    if (component.sourcePath !== null) paths.add(component.sourcePath)
    for (const link of component.sourceLinks) paths.add(link.targetPath)
  }
  return [...paths].sort().map(path => ({ path, content: sourceTextFor(path) }))
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
      sourceFiles: artifactSourceFiles(components),
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
    sourceFiles: artifactSourceFiles(components),
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
  if (!profile) return capabilityTargetNotFound(
    `Process Plant display profile not found: ${profileId}. Discover exact profile ids with world.process-plant.plants.list.`,
  )
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
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
}): unknown | undefined => {
  if (!processPlantGraphQueryKinds.some(kind => kind === config.request.capabilityId)) return undefined
  if (config.request.capabilityId === 'world.process-plant.plants.list') {
    return {
      plants: [...config.plants.values()].map(({ plant, runtime }) => ({
        id: plant.id,
        componentLibrary: plant.componentLibrary,
        title: plant.graph.title,
        componentCount: plant.graph.components.length,
        linkCount: plant.graph.links.length,
        variableCount: plant.graph.variables.length,
        elapsedMs: runtime.elapsedMs(),
        displayProfiles: plant.graph.displayProfiles.map(profile => ({ id: profile.id, label: profile.label })),
      })),
    }
  }
  if (config.request.capabilityId === 'world.process-plant.graph.read') {
    const payload = plantQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    return { graph: graphView(system.plant.graph) }
  }
  if (config.request.capabilityId === 'world.process-plant.components.search') {
    const payload = componentsSearchQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    return componentSearchView(system, payload)
  }
  if (config.request.capabilityId === 'world.process-plant.artifact.read') {
    const payload = artifactReadQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    return artifactView(system, payload.artifact)
  }
  const payload = displayProfileReadQuerySchema.parse(config.request.input)
  const system = requirePlant(config.plants, payload.plantId)
  return displayProfileView(system, payload.profileId)
}
