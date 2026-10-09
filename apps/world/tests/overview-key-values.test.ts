import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { equipmentKeyValues, overviewKeyValues } from '../src/packs/process-plant/displays/overview-key-values.ts'

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

describe('the values equipment opened from the overview leads with', () => {
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:equipment-values', loopCount: 4 }))
  const of = (...ids: ReadonlyArray<string>) => equipmentKeyValues(plant, ids.map(id => plant.graph.componentIndexById.get(id as never)!))

  test('are its signals the I&C rules judge, then its key values and instruments; never a demand', () => {
    expect(of('core').slice(0, 2)).toEqual(['core.powerMw', 'core.coolantOutletTemperatureC'] as never)
    // A pump's run command and a valve's position demand are writable: the drawing shows them, the values do not.
    expect(of('feedwaterControlValveA')).toEqual([])
  })

  test('parallel equipment is compared value by value', () => {
    expect(of('sgA', 'sgB')).toEqual(['sgA.levelPercent', 'sgB.levelPercent', 'sgA.secondaryRadiationMSvPerH', 'sgB.secondaryRadiationMSvPerH', 'sgA.pressureMPa', 'sgB.pressureMPa'] as never)
  })
})
