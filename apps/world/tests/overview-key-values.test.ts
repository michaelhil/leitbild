import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { overviewKeyValues } from '../src/packs/process-plant/displays/overview-key-values.ts'

describe('the values a unit overview leads with', () => {
  test('come from what protection trips on outside the loops, then the energy source and sink', () => {
    for (const loopCount of [4, 6]) {
      const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: `plant:key-values-${loopCount}`, loopCount }))
      const paths = overviewKeyValues(plant)
      expect(paths).toEqual([
        'core.powerMw',
        'vessel.netInventoryFlowKgPerS',
        'pressurizer.pressureMPa',
        'containment.pressureMPa',
        'core.coolantOutletTemperatureC',
        'turbine.electricMw',
      ] as never)
      // A steam generator's low-low level trips the auxiliary feed, but per-loop values stay on their loop.
      for (const path of paths) expect(plant.graph.components[plant.graph.componentIndexById.get(String(path).split('.')[0] as never)!]!.metadata?.loopId).toBeUndefined()
    }
  })
})
