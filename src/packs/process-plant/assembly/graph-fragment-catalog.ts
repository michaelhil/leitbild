import { parseGraphFragmentSpec, type GraphFragmentSpec } from './graph-fragment.ts'
import { processPlantCatalog } from '../catalog-contributions.ts'

export const resolveProcessPlantGraphFragmentSpec = (fragmentRef: string): GraphFragmentSpec => {
  const entry = processPlantCatalog.graphFragmentsByRef.get(fragmentRef)
  if (entry === undefined) throw new Error(`unknown process plant graph fragmentRef: ${fragmentRef}`)
  return parseGraphFragmentSpec(structuredClone(entry.fragment()))
}

export const listProcessPlantGraphFragmentRefs = (): ReadonlyArray<string> =>
  [...processPlantCatalog.graphFragmentsByRef.keys()]
