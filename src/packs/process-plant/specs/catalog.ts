import type { PlantGraphSpec } from '../graph/index.ts'
import { pressurizedWaterReactorPlantSpec } from './pressurized-water-reactor.ts'

export const processPlantPressurizedWaterReactorGraphRef = 'process-plant.pressurized-water-reactor.v1'

const builtInProcessPlantGraphSpecs = new Map<string, PlantGraphSpec>([
  [processPlantPressurizedWaterReactorGraphRef, pressurizedWaterReactorPlantSpec],
])

export const resolveProcessPlantGraphSpec = (graphRef: string): PlantGraphSpec => {
  const spec = builtInProcessPlantGraphSpecs.get(graphRef)
  if (!spec) throw new Error(`unknown process plant graphRef: ${graphRef}`)
  return spec
}

export const listProcessPlantGraphRefs = (): ReadonlyArray<string> =>
  [...builtInProcessPlantGraphSpecs.keys()]
