import { processPlantCatalog } from '../catalog-contributions.ts'
import type { CompiledPlantGraph } from '../graph/index.ts'
import { processDisplayDefinitionSchema, type ProcessDisplayDefinition } from './model.ts'

const parseDisplayDefinition = (definition: ProcessDisplayDefinition): ProcessDisplayDefinition =>
  processDisplayDefinitionSchema.parse(structuredClone(definition))

export const resolveProcessPlantDisplayDefinitionForGraph = (
  displayId: string,
  graph: CompiledPlantGraph,
): ProcessDisplayDefinition => {
  const entry = processPlantCatalog.displaysById.get(displayId)
  if (entry === undefined) throw new Error(`process plant display not found: ${displayId}`)
  return parseDisplayDefinition(entry.display({ graph }))
}

export const listProcessPlantDisplayIds = (): ReadonlyArray<string> =>
  [...processPlantCatalog.displaysById.keys()]

export const listProcessPlantDisplayDefinitionsForGraph = (
  graph: CompiledPlantGraph,
): ReadonlyArray<ProcessDisplayDefinition> =>
  listProcessPlantDisplayIds().map(displayId => resolveProcessPlantDisplayDefinitionForGraph(displayId, graph))
