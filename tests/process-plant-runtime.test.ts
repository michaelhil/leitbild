import { describe, expect, test } from 'bun:test'
import {
  componentVariablePath,
  compileProcessPlantExecutionPlan,
  compileProcessPlantSystem,
  createBehaviorContext,
  createProcessPlantMultiSystemTestbed,
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
    expect(Number(snapshot.variables.find(variable => variable.path === valueOf('pressurizer.levelPercent'))?.value)).toBeCloseTo(55, 6)
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
      'core.fuelTemperatureC',
      'core.decayHeatMw',
      'core.coolantInletTemperatureC',
      'core.coolantOutletTemperatureC',
      'core.heatToCoolantMw',
      'pressurizer.pressureMPa',
      'pressurizer.levelPercent',
      'pressurizer.reliefFlowKgPerS',
      'sgA.levelPercent',
      'sgA.pressureMPa',
      'sgA.heatTransferMw',
      'sgA.primaryInletTemperatureC',
      'sgA.primaryOutletTemperatureC',
      'sgA.tubeMetalTemperatureC',
      'sgA.secondaryTemperatureC',
      'sgA.steamFlowKgPerS',
      'sgA.boilingRateKgPerS',
      'sgA.feedwaterFlowKgPerS',
      'sgA.steamQualityFraction',
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

  test('multi-system testbed runs independent systems with isolated scheduled faults and telemetry', () => {
    const multiSystem = createProcessPlantMultiSystemTestbed([
      {
        system: compileProcessPlantSystem({
          id: 'unit-1',
          pack: 'process-plant',
          componentLibrary: 'process-plant',
          graph: pressurizedWaterReactorPlantSpec,
        }),
        telemetry: {
          sampleIntervalMs: 1_000,
          variables: [valueOf('rcpA.running'), valueOf('turbine.electricMw')],
        },
        schedule: { actions: [] },
      },
      {
        system: compileProcessPlantSystem({
          id: 'unit-2',
          pack: 'process-plant',
          componentLibrary: 'process-plant',
          graph: pressurizedWaterReactorPlantSpec,
        }),
        telemetry: {
          sampleIntervalMs: 1_000,
          variables: [valueOf('rcpA.running'), valueOf('turbine.electricMw')],
        },
        schedule: {
          actions: [{
            id: 'unit-2-rcp-a-trip',
            atMs: 2_000,
            type: 'tripComponent',
            componentId: 'rcpA' as never,
          }],
        },
      },
    ])

    const snapshots = multiSystem.runFor(5_000, 1_000)
    const bySystem = new Map(snapshots.map(snapshot => [snapshot.systemId, snapshot]))
    const unit1 = bySystem.get('unit-1')
    const unit2 = bySystem.get('unit-2')
    if (!unit1 || !unit2) throw new Error('expected both process plant unit snapshots')
    expect(unit1.runtime.variables.find(variable => variable.path === valueOf('rcpA.running'))?.value).toBe(true)
    expect(unit2.runtime.variables.find(variable => variable.path === valueOf('rcpA.running'))?.value).toBe(false)
    expect(unit1.telemetry?.find(series => series.path === valueOf('turbine.electricMw'))?.systemId).toBe('unit-1')
    expect(unit1.telemetry?.find(series => series.path === valueOf('turbine.electricMw'))?.points.length).toBe(6)
    expect(unit1.telemetry?.find(series => series.path === valueOf('turbine.electricMw'))?.points.at(-1)).toMatchObject({
      quantity: 'power',
      unit: 'MW',
      source: 'runtime',
    })
    expect(unit2.telemetry?.find(series => series.path === valueOf('rcpA.running'))?.points.at(-1)?.value).toBe(false)
  })

  test('per-system initialState is applied without mutating shared graphRef runtime state', () => {
    const unitA = compileProcessPlantSystem({
      id: 'unit-a',
      pack: 'process-plant',
      componentLibrary: 'process-plant',
      graph: pressurizedWaterReactorPlantSpec,
      initialState: {
        'core.rodInsertionFraction': 0.75,
        'sgA.secondaryInventoryKg': 48_000,
      },
    })
    const unitB = compileProcessPlantSystem({
      id: 'unit-b',
      pack: 'process-plant',
      componentLibrary: 'process-plant',
      graph: pressurizedWaterReactorPlantSpec,
    })
    const runtimeA = createProcessPlantRuntime({ system: unitA })
    const runtimeB = createProcessPlantRuntime({ system: unitB })

    expect(runtimeA.readVariable(valueOf('core.rodInsertionFraction'))).toBe(0.75)
    expect(runtimeA.readVariable(valueOf('sgA.secondaryInventoryKg'))).toBe(48_000)
    expect(runtimeB.readVariable(valueOf('core.rodInsertionFraction'))).not.toBe(0.75)
    expect(runtimeB.readVariable(valueOf('sgA.secondaryInventoryKg'))).not.toBe(48_000)
  })

  test('per-system restore preserves each unit independently', () => {
    const unitA = compiledSystem()
    const unitB = compileProcessPlantSystem({
      id: 'plant-b',
      pack: 'process-plant',
      componentLibrary: 'process-plant',
      graph: pressurizedWaterReactorPlantSpec,
    })
    const runtimeA = createProcessPlantRuntime({ system: unitA })
    const runtimeB = createProcessPlantRuntime({ system: unitB })
    runtimeA.writeCommand({ type: 'setVariable', path: valueOf('rcpA.running'), value: false })
    runtimeA.tick(1_000)
    runtimeB.tick(1_000)

    const restoredA = createProcessPlantRuntime({ system: unitA, restoredSnapshot: runtimeA.snapshot() })
    const restoredB = createProcessPlantRuntime({ system: unitB, restoredSnapshot: runtimeB.snapshot() })

    expect(restoredA.readVariable(valueOf('rcpA.running'))).toBe(false)
    expect(restoredB.readVariable(valueOf('rcpA.running'))).toBe(true)
    expect(restoredA.snapshot().elapsedMs).toBe(restoredB.snapshot().elapsedMs)
  })

  test('runtime snapshots carry graph identity and reject mismatched graph restores', () => {
    const system = compiledSystem()
    const runtime = createProcessPlantRuntime({ system })
    runtime.tick(1_000)
    const snapshot = runtime.snapshot()

    expect(snapshot.graphSpecId).toBe(String(system.graph.specId))
    expect(snapshot.variablePaths).toEqual(system.graph.variables.map(variable => variable.path))
    expect(() => createProcessPlantRuntime({
      system,
      restoredSnapshot: {
        ...snapshot,
        graphSpecId: 'process-plant.other-graph.v1',
      },
    })).toThrow('does not match system graph')
    expect(() => createProcessPlantRuntime({
      system,
      restoredSnapshot: {
        ...snapshot,
        variablePaths: snapshot.variablePaths.slice(1),
      },
    })).toThrow('variable path count')
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
    expect(Number(runtime.readVariable(valueOf('sgA.tubeMetalTemperatureC'))))
      .toBeGreaterThan(Number(runtime.readVariable(valueOf('sgA.secondaryTemperatureC'))))
    expect(Number(runtime.readVariable(valueOf('sgA.heatTransferMw')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('sgA.steamFlowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('sgA.boilingRateKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('sgA.feedwaterFlowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('sgA.steamQualityFraction')))).toBeGreaterThan(0.75)
    expect(Number(runtime.readVariable(valueOf('turbine.electricMw')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('condenser.steamFlowKgPerS')))).toBeGreaterThan(0)
  })

  test('reactor trip leaves decay heat while fission power falls', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 50; index += 1) runtime.tick(100)
    const initialFissionPower = Number(runtime.readVariable(valueOf('core.powerMw')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('core.rodInsertionFraction'), value: 1 })
    for (let index = 0; index < 150; index += 1) runtime.tick(100)

    const trippedFissionPower = Number(runtime.readVariable(valueOf('core.powerMw')))
    const decayHeat = Number(runtime.readVariable(valueOf('core.decayHeatMw')))
    const heatToCoolant = Number(runtime.readVariable(valueOf('core.heatToCoolantMw')))
    expect(trippedFissionPower).toBeLessThan(initialFissionPower)
    expect(decayHeat).toBeGreaterThan(0)
    expect(heatToCoolant).toBeGreaterThan(trippedFissionPower)
  })

  test('pressurizer heaters and relief valve change pressure through component behavior', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 20; index += 1) runtime.tick(100)
    const initialPressure = Number(runtime.readVariable(valueOf('pressurizer.pressureMPa')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('pressurizer.heaterPowerMw'), value: 20 })
    for (let index = 0; index < 120; index += 1) runtime.tick(100)
    const heatedPressure = Number(runtime.readVariable(valueOf('pressurizer.pressureMPa')))
    expect(heatedPressure).toBeGreaterThan(initialPressure)

    runtime.writeCommand({ type: 'setVariable', path: valueOf('pressurizer.heaterPowerMw'), value: 0 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('pressurizer.reliefValvePositionFraction'), value: 1 })
    for (let index = 0; index < 120; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('pressurizer.reliefFlowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('pressurizer.pressureMPa')))).toBeLessThan(heatedPressure)
    expect(Number(runtime.readVariable(valueOf('pressurizer-relief-to-tank.flowKgPerS')))).toBeGreaterThan(0)
  })

  test('loss of feedwater trends steam generator inventory downward', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    runtime.tick(1_000)
    const before = Number(runtime.readVariable(valueOf('sgA.levelPercent')))
    const initialFeedwaterFlow = Number(runtime.readVariable(valueOf('sgA.feedwaterFlowKgPerS')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('mainFeedwaterPumpA.running'), value: false })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('mainFeedwaterPumpB.running'), value: false })
    runtime.tick(100)
    expect(Number(runtime.readVariable(valueOf('mainFeedwaterPumpA.flowKgPerS')))).toBeGreaterThan(0)
    for (let index = 0; index < 120; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('sgA.levelPercent')))).toBeLessThan(before)
    expect(Number(runtime.readVariable(valueOf('sgA.secondaryInventoryKg')))).toBeLessThan(56_000 * before / 100)
    expect(Number(runtime.readVariable(valueOf('sgA.feedwaterFlowKgPerS')))).toBeLessThan(initialFeedwaterFlow)
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

  test('compiled execution plan validates behavior write declarations before runtime ticks', () => {
    const plan = compileProcessPlantExecutionPlan(compiledSystem())

    expect(plan.invocationCount).toBeGreaterThan(0)
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
