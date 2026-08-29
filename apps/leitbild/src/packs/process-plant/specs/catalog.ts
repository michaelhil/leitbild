import { plantGraphSpecSchema, type PlantGraphSpec } from '../graph/index.ts'
import { processPlantCatalog } from '../catalog-contributions.ts'

export {
  processPlantPressurizedWaterReactorGraphRef,
  processPlantPressurizedWaterReactorSixLoopGraphRef,
} from '../pwr-reference-catalog-contribution.ts'

export const resolveProcessPlantGraphSpec = (graphRef: string): PlantGraphSpec => {
  const entry = processPlantCatalog.graphSpecsByRef.get(graphRef)
  if (entry === undefined) throw new Error(`unknown process plant graphRef: ${graphRef}`)
  return plantGraphSpecSchema.parse(structuredClone(entry.graph()))
}

export const listProcessPlantGraphRefs = (): ReadonlyArray<string> =>
  [...processPlantCatalog.graphSpecsByRef.keys()]
