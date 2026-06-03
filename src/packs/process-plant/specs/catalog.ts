import type { PlantGraphSpec } from '../graph/index.ts'
import { pressurizedWaterReactorSixLoopPlantSpec } from './pressurized-water-reactor-6-loop.ts'
import { pressurizedWaterReactorPlantSpec } from './pressurized-water-reactor.ts'

export const processPlantPressurizedWaterReactorGraphRef = 'process-plant.pressurized-water-reactor.v1'
export const processPlantPressurizedWaterReactorSixLoopGraphRef = 'process-plant.pressurized-water-reactor-6-loop.v1'

const builtInProcessPlantGraphSpecs = new Map<string, PlantGraphSpec>([
  [processPlantPressurizedWaterReactorGraphRef, pressurizedWaterReactorPlantSpec],
  [processPlantPressurizedWaterReactorSixLoopGraphRef, pressurizedWaterReactorSixLoopPlantSpec],
])

export const resolveProcessPlantGraphSpec = (graphRef: string): PlantGraphSpec => {
  const spec = builtInProcessPlantGraphSpecs.get(graphRef)
  if (!spec) throw new Error(`unknown process plant graphRef: ${graphRef}`)
  return spec
}

export const listProcessPlantGraphRefs = (): ReadonlyArray<string> =>
  [...builtInProcessPlantGraphSpecs.keys()]
