import { describe, expect, test } from 'bun:test'
import { compileProcessPlant } from '../src/packs/process-plant/plant-compiler.ts'
import { createPwrReferencePlantDefinition, processPlantDefinitionCatalog } from '../src/packs/process-plant/plant-definitions.ts'
import { createProcessPlantRuntime } from '../src/packs/process-plant/runtime/runtime.ts'
import type { VariablePath } from '../src/packs/process-plant/graph/index.ts'

describe('authoritative PWR full-power operating point', () => {
  for (const loopCount of [2, 3, 4, 5, 6]) {
    test(`resolves real initialized power and all ${loopCount} steam generators`, () => {
      const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'test:plant', loopCount }))
      const runtime = createProcessPlantRuntime({ system })
      const read = (path: string) => Number(runtime.readVariable(path as VariablePath))
      expect(read('core.powerMw')).toBe(3400)
      expect(read('turbine.electricMw')).toBe(1100)
      expect(read('turbine.loadFraction')).toBe(1)
      for (const component of system.sourceGraph.components.filter(component => component.kind === 'steamGenerator')) {
        expect(read(`${component.id}.steamFlowKgPerS`)).toBe(335)
      }
      runtime.tick(100)
      expect(read('core.temperatureFeedbackPcm')).toBeCloseTo(0, 10)
      expect(read('core.powerMw')).toBeCloseTo(3400, 8)
      // The operating point initializes real state; it must never clamp power.
      runtime.writeCommand({ type: 'setVariable', path: 'core.rodInsertionFraction' as VariablePath, value: 1 })
      for (let step = 0; step < 150; step++) runtime.tick(100)
      expect(read('core.powerMw')).toBeLessThan(340)
    })
  }

  test('sparse explicit overrides merge with point defaults and are validated', () => {
    const definition = createPwrReferencePlantDefinition({
      id: 'test:custom',
      parameterOverrides: { core: { ratedPowerMw: 3000 }, turbine: { initialLoadFraction: 0.7 } },
    })
    const runtime = createProcessPlantRuntime({ system: compileProcessPlant(definition) })
    expect(runtime.readVariable('core.powerMw' as VariablePath)).toBe(3000)
    expect(runtime.readVariable('turbine.loadFraction' as VariablePath)).toBe(0.7)
    expect(() => compileProcessPlant(createPwrReferencePlantDefinition({ id: 'bad', parameterOverrides: { core: { initialPowerFraction: 2 } } }))).toThrow()
    expect(() => compileProcessPlant(createPwrReferencePlantDefinition({ id: 'bad', parameterOverrides: { missing: {} } }))).toThrow('unknown component')
    expect(processPlantDefinitionCatalog().operatingPoints[0]?.description).toContain('100%')
  })

  test('restore retains actual progressed state instead of reapplying the operating point', () => {
    const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'test:restore' }))
    const runtime = createProcessPlantRuntime({ system })
    runtime.tick(1000)
    const checkpoint = runtime.checkpoint()
    const restored = createProcessPlantRuntime({ system, restoredCheckpoint: checkpoint })
    expect(restored.snapshot()).toEqual(runtime.snapshot())
  })
})
