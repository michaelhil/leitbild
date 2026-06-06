import { parseGraphFragmentSpec, type GraphFragmentSpec } from './graph-fragment.ts'
import { pwrReferenceGraphFragmentEntries } from './pwr-reference-assembly.ts'

export interface ProcessPlantGraphFragmentCatalogEntry {
  readonly ref: string
  readonly fragment: () => GraphFragmentSpec
}

const builtInProcessPlantGraphFragments: ReadonlyMap<string, ProcessPlantGraphFragmentCatalogEntry> = new Map(
  pwrReferenceGraphFragmentEntries.map(entry => [entry.ref, entry]),
)

export const resolveProcessPlantGraphFragmentSpec = (fragmentRef: string): GraphFragmentSpec => {
  const entry = builtInProcessPlantGraphFragments.get(fragmentRef)
  if (entry === undefined) throw new Error(`unknown process plant graph fragmentRef: ${fragmentRef}`)
  return parseGraphFragmentSpec(structuredClone(entry.fragment()))
}

export const listProcessPlantGraphFragmentRefs = (): ReadonlyArray<string> =>
  [...builtInProcessPlantGraphFragments.keys()]
