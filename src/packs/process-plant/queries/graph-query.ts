import { readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path/posix'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../core/packs/protocol.ts'
import type { CompiledPlantGraph, ComponentId, ProcessPlantDisplayField } from '../graph/index.ts'
import { plantGraphToMermaid } from '../graph/index.ts'
import { processPlantComponentBehaviorSourcePathByKind } from '../runtime/behaviors/index.ts'
import type { ProcessPlantVariableHandle } from '../runtime/variable-table.ts'
import { compileProcessSurface } from '../surfaces/compiler.ts'
import { processPlantUnitOverviewSurfaceForGraph } from '../surfaces/reference-unit-overview.ts'
import type { ProcessPlantSystemRuntime } from '../system-runtime.ts'
import { requireSystem, success, systemQuerySchema } from './common.ts'

const artifactReadQuerySchema = z.object({
  systemId: idSchema,
  artifact: z.enum(['authored-spec', 'compiled-graph-mermaid']),
})

const sourceRoot = fileURLToPath(new URL('../../../..', import.meta.url))

interface ComponentSourceView {
  readonly path: string
  readonly content: string
  readonly imports: ReadonlyArray<ComponentSourceImportView>
}

interface ComponentSourceImportView {
  readonly symbol: string
  readonly importedName: string
  readonly targetPath: string
  readonly targetLineIndex: number | null
}

interface ArtifactComponentView {
  readonly id: ComponentId
  readonly label: string
  readonly kind: string
  readonly shownOnOverview: boolean
  readonly source: string
  readonly sourcePath: string
  readonly sourceLinks: ReadonlyArray<ComponentSourceImportView>
}

const componentSourceCache = new Map<string, string>()
const componentSourceImportCache = new Map<string, ReadonlyArray<ComponentSourceImportView>>()

const sourceTextFor = (sourcePath: string): string => {
  const existing = componentSourceCache.get(sourcePath)
  if (existing !== undefined) return existing
  const content = readFileSync(`${sourceRoot}/${sourcePath}`, 'utf8')
  componentSourceCache.set(sourcePath, content)
  return content
}

const importDeclarationPattern = /(?:^|\n)\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
const identifierCharacters = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const resolveRelativeSourcePath = (sourcePath: string, importPath: string): string | null => {
  if (!importPath.startsWith('.')) return null
  const resolved = normalize(join(dirname(sourcePath), importPath))
  if (!resolved.startsWith('src/')) return null
  return resolved.endsWith('.ts') ? resolved : `${resolved}.ts`
}

const importedSymbolsFor = (importClause: string): ReadonlyArray<{ readonly symbol: string; readonly importedName: string }> => {
  const namedImportMatch = /\{([\s\S]*?)\}/.exec(importClause)
  if (!namedImportMatch) return []
  const namedImportBody = namedImportMatch[1]
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
  const declarationPattern = new RegExp(`^\\s*export\\s+(?:const|function|interface|type|enum)\\s+${escapedIdentifier(exportedName)}\\b`)
  const lines = content.split(/\r\n|\r|\n/)
  const index = lines.findIndex(line => declarationPattern.test(line))
  return index < 0 ? null : index
}

const componentSourceImportsFor = (sourcePath: string): ReadonlyArray<ComponentSourceImportView> => {
  const cached = componentSourceImportCache.get(sourcePath)
  if (cached) return cached
  const content = sourceTextFor(sourcePath)
  const imports: ComponentSourceImportView[] = []
  const seen = new Set<string>()
  for (const match of content.matchAll(importDeclarationPattern)) {
    const importClause = match[1] ?? ''
    const importedFrom = match[2] ?? ''
    const targetPath = resolveRelativeSourcePath(sourcePath, importedFrom)
    if (!targetPath) continue
    const targetContent = sourceTextFor(targetPath)
    for (const symbol of importedSymbolsFor(importClause)) {
      const key = `${symbol.symbol}:${targetPath}:${symbol.importedName}`
      if (seen.has(key)) continue
      seen.add(key)
      imports.push({
        symbol: symbol.symbol,
        importedName: symbol.importedName,
        targetPath,
        targetLineIndex: definitionLineIndexFor(targetContent, symbol.importedName),
      })
    }
  }
  componentSourceImportCache.set(sourcePath, imports)
  return imports
}

const componentSourceViewFor = (component: CompiledPlantGraph['components'][number]): ComponentSourceView => {
  const sourcePath = processPlantComponentBehaviorSourcePathByKind.get(component.kind)
  if (!sourcePath) {
    return {
      path: 'unknown',
      content: `Component behavior source not found for kind ${component.kind}`,
      imports: [],
    }
  }
  return { path: sourcePath, content: sourceTextFor(sourcePath), imports: componentSourceImportsFor(sourcePath) }
}

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
  const surface = processPlantUnitOverviewSurfaceForGraph(system.system.graph)
  const compiled = compileProcessSurface({ definition: surface, graph: system.system.graph })
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
    const source = componentSourceViewFor(component)
    return {
      id: component.id,
      label: component.label,
      kind: component.kind,
      shownOnOverview: overviewComponentIds.has(component.id),
      source: source.content,
      sourcePath: source.path,
      sourceLinks: source.imports,
    }
  })
}

const artifactSourceFiles = (components: ReadonlyArray<ArtifactComponentView>): ReadonlyArray<Record<string, unknown>> => {
  const targetPaths = new Set<string>()
  for (const component of components) {
    for (const link of component.sourceLinks) targetPaths.add(link.targetPath)
  }
  return [...targetPaths].sort().map(path => ({
    path,
    content: sourceTextFor(path),
  }))
}

const artifactView = (
  system: ProcessPlantSystemRuntime,
  artifact: 'authored-spec' | 'compiled-graph-mermaid',
): unknown => {
  const overviewComponentIds = overviewComponentIdsFor(system)
  const components = artifactComponents(system.system.graph, overviewComponentIds)
  if (artifact === 'authored-spec') {
    return {
      systemId: system.system.id,
      artifact,
      title: `${system.system.graph.title} source specification`,
      language: 'json',
      content: JSON.stringify(system.system.sourceGraph, null, 2),
      components,
      sourceFiles: artifactSourceFiles(components),
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
    sourceFiles: artifactSourceFiles(components),
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
