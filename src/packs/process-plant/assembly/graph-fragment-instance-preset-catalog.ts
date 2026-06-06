import { parseGraphFragmentInstance, type GraphFragmentInstance } from './graph-fragment.ts'
import { processPlantCatalog } from '../catalog-contributions.ts'

export const resolveProcessPlantGraphFragmentInstancePreset = (
  presetRef: string,
  config: unknown,
): GraphFragmentInstance => {
  const entry = processPlantCatalog.graphFragmentInstancePresetsByRef.get(presetRef)
  if (entry === undefined) throw new Error(`unknown process plant graph fragment instance presetRef: ${presetRef}`)
  return parseGraphFragmentInstance(structuredClone(entry.instance(config)))
}

export const listProcessPlantGraphFragmentInstancePresetRefs = (): ReadonlyArray<string> =>
  [...processPlantCatalog.graphFragmentInstancePresetsByRef.keys()]
