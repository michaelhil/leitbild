import { parseGraphFragmentInstance, type GraphFragmentInstance } from './graph-fragment.ts'
import { pwrReferenceGraphFragmentInstancePresetEntries } from './pwr-reference-assembly.ts'

export interface ProcessPlantGraphFragmentInstancePresetCatalogEntry {
  readonly ref: string
  readonly instance: (config: unknown) => GraphFragmentInstance
}

const builtInProcessPlantGraphFragmentInstancePresets: ReadonlyMap<string, ProcessPlantGraphFragmentInstancePresetCatalogEntry> = new Map(
  pwrReferenceGraphFragmentInstancePresetEntries.map(entry => [entry.ref, entry]),
)

export const resolveProcessPlantGraphFragmentInstancePreset = (
  presetRef: string,
  config: unknown,
): GraphFragmentInstance => {
  const entry = builtInProcessPlantGraphFragmentInstancePresets.get(presetRef)
  if (entry === undefined) throw new Error(`unknown process plant graph fragment instance presetRef: ${presetRef}`)
  return parseGraphFragmentInstance(structuredClone(entry.instance(config)))
}

export const listProcessPlantGraphFragmentInstancePresetRefs = (): ReadonlyArray<string> =>
  [...builtInProcessPlantGraphFragmentInstancePresets.keys()]
