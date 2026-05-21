import { describe, expect, test } from 'bun:test'
import {
  componentVariablePath,
  compileProcessPlantSystem,
  createBehaviorContext,
  createProcessPlantRuntime,
  createProcessPlantTestbed,
  pressurizedWaterReactorPlantSpec,
  processPlantSolverPhases,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { componentBehaviorDefinitions, initialComponentValueFor } from '../src/packs/process-plant/runtime/component-behaviors.ts'
import { processLinkBehaviorDefinitions } from '../src/packs/process-plant/runtime/process-link-behaviors.ts'
import { createProcessPlantVariableTable } from '../src/packs/process-plant/runtime/variable-table.ts'

const compiledSystem = () => compileProcessPlantSystem({
  id: 'plant',
  pack: 'process-plant',
  componentLibrary: 'process-plant',
  graph: pressurizedWaterReactorPlantSpec,
})

const valueOf = (path: string): VariablePath => path as VariablePath

describe('process plant runtime', () => {
  test('initializes a headless runtime from scenario-owned graph data', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })
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
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })
    const tick = runtime.tick(1_000)

    expect(tick.simulatedMs).toBe(1_000)
    expect(tick.phases).toEqual(processPlantSolverPhases)
    expect(tick.phases).toEqual([
      'applyCommands',
      'updateControlLogic',
      'solveFluidFlowComponents',
      'solveFluidFlowLinks',
      'solveThermalTransfer',
      'solveElectrical',
      'updateComponentState',
      'updateProcessLinkState',
    ])
    const publishedPaths = tick.publishedVariables.map(variable => String(variable.path))
    expect(publishedPaths).toEqual(expect.arrayContaining([
      'core.powerMw',
      'core.coolantInletTemperatureC',
      'core.coolantOutletTemperatureC',
      'core.heatToCoolantMw',
      'sgA.levelPercent',
      'sgA.pressureMPa',
      'sgA.heatTransferMw',
      'sgA.primaryInletTemperatureC',
      'sgA.primaryOutletTemperatureC',
      'sgA.secondaryTemperatureC',
      'sgA.steamFlowKgPerS',
      'sgA.secondaryInventoryKg',
      'sgB.steamFlowKgPerS',
      'sgC.steamFlowKgPerS',
      'sgD.steamFlowKgPerS',
      'rcpA.running',
      'rcpB.running',
      'rcpC.running',
      'rcpD.running',
      'mainFeedwaterPumpA.running',
      'mainFeedwaterPumpB.running',
      'turbine.electricMw',
      'turbine.steamFlowKgPerS',
      'condenser.steamFlowKgPerS',
      'condenser.condensateTemperatureC',
      'condenser.backPressurePa',
      'rcs-hot-leg-a.flowKgPerS',
      'rcs-hot-leg-a.temperatureC',
      'rcs-cold-leg-a.flowKgPerS',
      'rcs-cold-leg-a.temperatureC',
      'feedwater-control-valve-a-to-sg-a.flowKgPerS',
      'sg-a-steam-to-msiv-a.flowKgPerS',
      'sg-a-steam-to-msiv-a.pressureMPa',
      'sg-a-steam-to-msiv-a.radiationMSvPerH',
      'sg-a-steam-to-msiv-a.valve.positionFraction',
      'sg-a-steam-to-msiv-a.leak.areaFraction',
      'turbine-exhaust-to-condenser.flowKgPerS',
      'turbine-exhaust-to-condenser.temperatureC',
    ]))
    expect(publishedPaths.length).toBeGreaterThan(80)
  })

  test('rejects writes to non-writable variables', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    expect(() => runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('core.powerMw'),
      value: 100,
    })).toThrow('not writable')
  })

  test('applies operator commands through the fixed-step update loop', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

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
    const oneBigTick = createProcessPlantRuntime({ system: compiledSystem() })
    const repeatedTicks = createProcessPlantRuntime({ system: compiledSystem() })

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
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    runtime.tick(1_000)
    const openFlow = Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.flowKgPerS')))
    expect(openFlow).toBeGreaterThan(0)

    runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('sg-a-steam-to-msiv-a.valve.positionFraction'),
      value: 0.5,
    })
    runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('sg-a-steam-to-msiv-a.leak.areaFraction'),
      value: 0.1,
    })
    runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.flowKgPerS')))).toBeLessThan(openFlow)
    expect(Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.radiationMSvPerH')))).toBeGreaterThan(0.02)
    expect(() => runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('sg-a-steam-to-msiv-a.pressureMPa'),
      value: 1,
    })).toThrow('not writable')
  })

  test('couples reactor heat, primary flow, steam generation, turbine load, and condenser sink', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    runtime.tick(1_000)

    expect(Number(runtime.readVariable(valueOf('core.coolantOutletTemperatureC'))))
      .toBeGreaterThan(Number(runtime.readVariable(valueOf('core.coolantInletTemperatureC'))))
    expect(Number(runtime.readVariable(valueOf('sgA.primaryOutletTemperatureC'))))
      .toBeLessThan(Number(runtime.readVariable(valueOf('sgA.primaryInletTemperatureC'))))
    expect(Number(runtime.readVariable(valueOf('sgA.heatTransferMw')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('sgA.steamFlowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('turbine.electricMw')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('condenser.steamFlowKgPerS')))).toBeGreaterThan(0)
  })

  test('loss of feedwater trends steam generator inventory downward', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    runtime.tick(1_000)
    const before = Number(runtime.readVariable(valueOf('sgA.levelPercent')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('mainFeedwaterPumpA.running'), value: false })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('mainFeedwaterPumpB.running'), value: false })
    for (let index = 0; index < 120; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('sgA.levelPercent')))).toBeLessThan(before)
    expect(Number(runtime.readVariable(valueOf('sgA.secondaryInventoryKg')))).toBeLessThan(56_000 * before / 100)
  })

  test('reactor coolant pump trip collapses primary link flow and heat transfer', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 50; index += 1) runtime.tick(100)
    const flowingHeatTransfer = Number(runtime.readVariable(valueOf('sgA.heatTransferMw')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('rcpA.running'), value: false })
    for (let index = 0; index < 20; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS')))).toBe(0)
    expect(Number(runtime.readVariable(valueOf('sgA.heatTransferMw')))).toBeLessThan(flowingHeatTransfer)
    expect(Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.flowKgPerS')))).toBe(0)
  })

  test('turbine load demand changes steam use and electrical output', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 50; index += 1) runtime.tick(100)
    const loadedOutput = Number(runtime.readVariable(valueOf('turbine.electricMw')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('turbine.loadFraction'), value: 0.4 })
    for (let index = 0; index < 50; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('turbine.electricMw')))).toBeLessThan(loadedOutput)
    expect(Number(runtime.readVariable(valueOf('turbine.steamFlowKgPerS')))).toBeCloseTo(420, 6)
  })

  test('behavior contexts reject writes outside declared outputs', () => {
    const system = compiledSystem()
    const table = createProcessPlantVariableTable(system, initialComponentValueFor)
    const component = system.graph.components.find(candidate => candidate.id === 'core')
    if (!component) throw new Error('expected core component')
    const context = createBehaviorContext({
      behaviorId: 'test-behavior',
      phase: 'updateControlLogic',
      dtSeconds: 0.1,
      table,
      writablePaths: new Set([componentVariablePath(component, 'reactivityPcm')]),
    })

    expect(() => context.write(componentVariablePath(component, 'powerMw'), 10)).toThrow('cannot write undeclared variable')
  })

  test('behavior definitions declare read and write surfaces for auditability', () => {
    const behaviorIds = new Set<string>()
    for (const behavior of [...componentBehaviorDefinitions, ...processLinkBehaviorDefinitions]) {
      expect(behavior.reads.length).toBeGreaterThan(0)
      expect(behavior.writes.length).toBeGreaterThan(0)
      expect(behaviorIds.has(behavior.id)).toBe(false)
      behaviorIds.add(behavior.id)
    }
  })

  test('behavior contexts reject non-finite numeric writes before they corrupt runtime state', () => {
    const system = compiledSystem()
    const table = createProcessPlantVariableTable(system, initialComponentValueFor)
    const component = system.graph.components.find(candidate => candidate.id === 'core')
    if (!component) throw new Error('expected core component')
    const context = createBehaviorContext({
      behaviorId: 'test-behavior',
      phase: 'updateControlLogic',
      dtSeconds: 0.1,
      table,
      writablePaths: new Set([componentVariablePath(component, 'reactivityPcm')]),
    })

    expect(() => context.write(componentVariablePath(component, 'reactivityPcm'), Number.NaN)).toThrow('non-finite value')
  })

  test('runtime rejects physically invalid writable process values before they enter the solver', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    expect(() => runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('sg-a-steam-to-msiv-a.valve.positionFraction'),
      value: 1.2,
    })).toThrow('fraction value must be between 0 and 1')
    expect(() => runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('mainFeedwaterPumpA.speedFraction'),
      value: -1,
    })).toThrow('fraction value must be between 0 and 1')
  })
})
