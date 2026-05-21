import { describe, expect, test } from 'bun:test'
import {
  compileProcessPlantSystem,
  createProcessPlantRuntime,
  createProcessPlantTestbed,
  pressurizedWaterReactorPlantSpec,
  processPlantSolverPhases,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'

const compiledSystem = () => compileProcessPlantSystem({
  id: 'plant',
  pack: 'process-plant',
  componentLibrary: 'process-plant',
  graph: pressurizedWaterReactorPlantSpec,
})

const valueOf = (path: string): VariablePath => path as VariablePath

describe('process plant runtime', () => {
  test('initializes a headless runtime from scenario-owned graph data', () => {
    const runtime = createProcessPlantRuntime(compiledSystem())
    const snapshot = runtime.snapshot()

    expect(snapshot.elapsedMs).toBe(0)
    expect(snapshot.variables.find(variable => variable.path === valueOf('core.powerMw'))).toMatchObject({
      value: 2890,
      quantity: 'power',
      unit: 'MW',
      published: true,
    })
    const level = snapshot.variables.find(variable => variable.path === valueOf('sgA.levelPercent'))
    expect(level).toMatchObject({
      quantity: 'ratio',
      unit: 'percent',
    })
    expect(Number(level?.value)).toBeCloseTo(55, 6)
    expect(Number(level?.canonicalValue)).toBeCloseTo(0.55, 6)
  })

  test('runs the declared solver phases and publishes telemetry', () => {
    const runtime = createProcessPlantRuntime(compiledSystem())
    const tick = runtime.tick(1_000)

    expect(tick.simulatedMs).toBe(1_000)
    expect(tick.phases).toEqual(processPlantSolverPhases)
    expect(tick.publishedVariables.map(variable => String(variable.path))).toEqual([
      'core.powerMw',
      'sgA.levelPercent',
      'sgA.pressureMPa',
      'rcpA.running',
      'feedwaterA.flowKgPerS',
      'turbine.electricMw',
      'sg-a-steam-to-turbine.flowKgPerS',
      'sg-a-steam-to-turbine.pressureMPa',
      'sg-a-steam-to-turbine.radiationMSvPerH',
      'sg-a-steam-to-turbine.valve.positionFraction',
      'sg-a-steam-to-turbine.leak.areaFraction',
    ])
  })

  test('rejects writes to non-writable variables', () => {
    const runtime = createProcessPlantRuntime(compiledSystem())

    expect(() => runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('core.powerMw'),
      value: 100,
    })).toThrow('not writable')
  })

  test('applies operator commands through the fixed-step update loop', () => {
    const runtime = createProcessPlantRuntime(compiledSystem())

    runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('rcpA.running'),
      value: false,
    })
    runtime.tick(100)

    expect(runtime.readVariable(valueOf('rcpA.running'))).toBe(false)
    expect(runtime.readVariable(valueOf('rcpA.flowKgPerS'))).toBe(0)
  })

  test('evolves plant variables without coupling behavior to the caller tick size', () => {
    const oneBigTick = createProcessPlantRuntime(compiledSystem())
    const repeatedTicks = createProcessPlantRuntime(compiledSystem())

    oneBigTick.writeCommand({ type: 'setVariable', path: valueOf('core.rodInsertionFraction'), value: 0.6 })
    repeatedTicks.writeCommand({ type: 'setVariable', path: valueOf('core.rodInsertionFraction'), value: 0.6 })
    oneBigTick.tick(1_000)
    for (let index = 0; index < 10; index += 1) repeatedTicks.tick(100)

    expect(oneBigTick.readVariable(valueOf('core.powerMw'))).toBeCloseTo(Number(repeatedTicks.readVariable(valueOf('core.powerMw'))), 6)
    expect(Number(oneBigTick.readVariable(valueOf('core.powerMw')))).toBeLessThan(2890)
  })

  test('testbed runs the compiled system and returns a runtime snapshot', () => {
    const testbed = createProcessPlantTestbed(compiledSystem())
    const snapshot = testbed.runFor(500)

    expect(snapshot.elapsedMs).toBe(500)
    expect(snapshot.variables.length).toBeGreaterThan(0)
  })

  test('process link variables behave as readable sensors and writable flow modifiers', () => {
    const runtime = createProcessPlantRuntime(compiledSystem())

    runtime.tick(1_000)
    const openFlow = Number(runtime.readVariable(valueOf('sg-a-steam-to-turbine.flowKgPerS')))
    expect(openFlow).toBeGreaterThan(0)

    runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('sg-a-steam-to-turbine.valve.positionFraction'),
      value: 0.5,
    })
    runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('sg-a-steam-to-turbine.leak.areaFraction'),
      value: 0.1,
    })
    runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('sg-a-steam-to-turbine.flowKgPerS')))).toBeLessThan(openFlow)
    expect(Number(runtime.readVariable(valueOf('sg-a-steam-to-turbine.radiationMSvPerH')))).toBeGreaterThan(0.02)
    expect(() => runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('sg-a-steam-to-turbine.pressureMPa'),
      value: 1,
    })).toThrow('not writable')
  })
})
