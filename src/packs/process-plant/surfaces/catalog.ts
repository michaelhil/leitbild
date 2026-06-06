import { processPlantCatalog } from '../catalog-contributions.ts'
import type { CompiledPlantGraph } from '../graph/index.ts'
import { processSurfaceDefinitionSchema, type ProcessSurfaceDefinition } from './model.ts'

const parseSurfaceDefinition = (definition: ProcessSurfaceDefinition): ProcessSurfaceDefinition =>
  processSurfaceDefinitionSchema.parse(structuredClone(definition))

export const resolveProcessPlantSurfaceDefinitionForGraph = (
  surfaceId: string,
  graph: CompiledPlantGraph,
): ProcessSurfaceDefinition => {
  const entry = processPlantCatalog.surfacesById.get(surfaceId)
  if (entry === undefined) throw new Error(`process plant surface not found: ${surfaceId}`)
  return parseSurfaceDefinition(entry.surface({ graph }))
}

export const listProcessPlantSurfaceIds = (): ReadonlyArray<string> =>
  [...processPlantCatalog.surfacesById.keys()]

export const listProcessPlantSurfaceDefinitionsForGraph = (
  graph: CompiledPlantGraph,
): ReadonlyArray<ProcessSurfaceDefinition> =>
  listProcessPlantSurfaceIds().map(surfaceId => resolveProcessPlantSurfaceDefinitionForGraph(surfaceId, graph))
