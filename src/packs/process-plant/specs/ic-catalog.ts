import { processPlantCatalog } from '../catalog-contributions.ts'
import type { CompiledPlantGraph } from '../graph/index.ts'
import type { ProcessPlantIcConfig } from '../runtime/index.ts'
import { processPlantIcConfigSchema } from '../runtime/index.ts'

const parseProcessPlantIcConfig = (config: ProcessPlantIcConfig): ProcessPlantIcConfig =>
  processPlantIcConfigSchema.parse(structuredClone(config))

export const resolveProcessPlantIcConfig = (icRef: string): ProcessPlantIcConfig => {
  const exactEntry = processPlantCatalog.icConfigsByRef.get(icRef)
  if (exactEntry !== undefined) return parseProcessPlantIcConfig(exactEntry.config())
  for (const dynamicEntry of processPlantCatalog.dynamicIcConfigsById.values()) {
    if (dynamicEntry.matches(icRef)) return parseProcessPlantIcConfig(dynamicEntry.config(icRef))
  }
  if (processPlantCatalog.graphIcConfigsByRef.has(icRef)) {
    throw new Error(`process plant icRef requires a compiled graph: ${icRef}`)
  }
  throw new Error(`unknown process plant icRef: ${icRef}`)
}

export const resolveProcessPlantIcConfigForGraph = (icRef: string, graph: CompiledPlantGraph): ProcessPlantIcConfig => {
  const graphEntry = processPlantCatalog.graphIcConfigsByRef.get(icRef)
  if (graphEntry !== undefined) return parseProcessPlantIcConfig(graphEntry.configForGraph(graph))
  return resolveProcessPlantIcConfig(icRef)
}

export const listProcessPlantIcRefs = (): ReadonlyArray<string> => [
  ...processPlantCatalog.icConfigsByRef.keys(),
  ...processPlantCatalog.graphIcConfigsByRef.keys(),
  ...[...processPlantCatalog.dynamicIcConfigsById.values()].flatMap(entry => entry.listedRefs?.() ?? []),
]
