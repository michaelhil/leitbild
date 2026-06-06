import type { PlantGraphSpec } from '../graph/index.ts'
import { assemblePwrReferencePlantGraph, processPlantPwrReferenceAssemblyRef } from './pwr-reference-assembly.ts'

interface ProcessPlantAssemblyAdapter {
  readonly ref: string
  readonly assemble: (config: unknown) => PlantGraphSpec
}

const builtInProcessPlantAssemblies: ReadonlyMap<string, ProcessPlantAssemblyAdapter> = new Map([
  [processPlantPwrReferenceAssemblyRef, {
    ref: processPlantPwrReferenceAssemblyRef,
    assemble: assemblePwrReferencePlantGraph,
  }],
])

export const resolveProcessPlantAssemblySpec = (assemblyRef: string, config: unknown): PlantGraphSpec => {
  const adapter = builtInProcessPlantAssemblies.get(assemblyRef)
  if (!adapter) throw new Error(`unknown process plant assemblyRef: ${assemblyRef}`)
  return adapter.assemble(config)
}

export const listProcessPlantAssemblyRefs = (): ReadonlyArray<string> =>
  [...builtInProcessPlantAssemblies.keys()]
