import type { PlantGraphSpec } from '../graph/index.ts'
import { assembleModularPlantGraph, processPlantModularGraphAssemblyRef } from './modular-graph-assembly.ts'
import {
  collectProcessPlantCatalog,
  processPlantCatalogContributions,
  type ProcessPlantAssemblyCatalogEntry,
  type ProcessPlantCatalogContribution,
} from '../catalog-contributions.ts'

const processPlantModularGraphAssemblyContribution: ProcessPlantCatalogContribution = {
  id: 'process-plant.modular-graph-assembly',
  assemblies: [{
    ref: processPlantModularGraphAssemblyRef,
    sourcePath: 'src/packs/process-plant/assembly/modular-graph-assembly.ts',
    assemble: assembleModularPlantGraph,
  }],
}

const processPlantAssemblyCatalog = collectProcessPlantCatalog([
  processPlantModularGraphAssemblyContribution,
  ...processPlantCatalogContributions,
])

export const resolveProcessPlantAssemblySpec = (assemblyRef: string, config: unknown): PlantGraphSpec => {
  const adapter = processPlantAssemblyCatalog.assembliesByRef.get(assemblyRef)
  if (!adapter) throw new Error(`unknown process plant assemblyRef: ${assemblyRef}`)
  return adapter.assemble(config)
}

export const listProcessPlantAssemblyRefs = (): ReadonlyArray<string> =>
  [...processPlantAssemblyCatalog.assembliesByRef.keys()]

export const listProcessPlantAssemblyCatalogEntries = (): ReadonlyArray<ProcessPlantAssemblyCatalogEntry> =>
  [...processPlantAssemblyCatalog.assembliesByRef.values()]
