import { describe, expect, test } from 'bun:test'
import { component, connect, plantGraph, compileResolvedProcessPlant, createProcessPlantRuntime, processLinkVariableDescriptorSchema, compileProcessPlant, createPwrReferencePlantDefinition, createProcessPlantProtectionRunner, type PlantGraphSpec, type VariablePath } from '../src/packs/process-plant/index.ts'
import { guardPlantTests } from './plant-hang-guard.ts'
import { mixedLiquidTemperatureStep } from '../src/packs/process-plant/runtime/thermal-inventory.ts'

guardPlantTests()

const path = (value: string): VariablePath => value as VariablePath
const fluid = (temperature: number, pressure = 1, solute = 0) => [
  processLinkVariableDescriptorSchema.parse({ path: 'flowKgPerS', label: 'Flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s', initialValue: 0 }),
  processLinkVariableDescriptorSchema.parse({ path: 'temperatureC', label: 'Temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC', initialValue: temperature }),
  processLinkVariableDescriptorSchema.parse({ path: 'pressureMPa', label: 'Pressure', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa', initialValue: pressure }),
  processLinkVariableDescriptorSchema.parse({ path: 'soluteConcentrationPpm', label: 'Solute', kind: 'state', discipline: 'chemical', writable: false, publish: 'telemetry', quantity: 'concentration', unit: 'ppm', initialValue: solute }),
]
const pipe = (id: string, from: string, to: string, service: string, temperature: number, pressure = 1, solute = 0) => connect(id, from, to, {
  connectionKind: 'fluidFlow', service, nominalFluid: 'water', designPhase: 'liquid', solverModel: 'incompressibleLiquid', variables: fluid(temperature, pressure, solute),
})
const tank = (id: string, temperature: number, maxFlow: number, inventory = 100_000, solute = 0) => component(id, 'processTank', id, {
  nominalInventoryKg: inventory, initialInventoryFraction: 1, initialTemperatureC: temperature, makeupFlowKgPerS: 0, maxOutletFlowKgPerS: maxFlow, initialSoluteConcentrationPpm: solute,
})
const pump = (id: string, flow: number, running = true) => component(id, 'centrifugalPump', id, { nominalFlowKgPerS: flow, nominalHeadPa: 800_000, initialRunning: running })
const runtimeFor = (graph: PlantGraphSpec) => createProcessPlantRuntime({ system: compileResolvedProcessPlant({
  id: 'thermal-test', modelRef: 'test.model', operatingPointRef: 'test.operating-point', automationRef: 'test.automation', graph,
  automationForGraph: () => ({ operatingModes: [], annunciatorSystems: [], firstOutGroups: [], safetyFunctions: [], rules: [] }),
}) })
const number = (runtime: ReturnType<typeof runtimeFor>, value: string) => Number(runtime.readVariable(path(value)))
const run = (runtime: ReturnType<typeof runtimeFor>, seconds: number) => { for (let t = 0; t < seconds * 10; t++) runtime.tick(100) }
const hxGraph = (hotTemperature = 180, coldTemperature = 30, closedColdLoop = false) => plantGraph({
  id: 'thermal-chain', title: 'Thermal chain', fixedStepMs: 100,
  components: [tank('hotTank', hotTemperature, 80, 100_000, 1000),
    closedColdLoop
      ? component('coldTank', 'processTank', 'Finite CCW inventory', { nominalInventoryKg: 5000, initialInventoryFraction: 0.9, initialTemperatureC: coldTemperature, makeupFlowKgPerS: 0, maxOutletFlowKgPerS: 50, thermalModel: 'inventoryBalance' })
      : tank('coldTank', coldTemperature, 50),
    pump('hotPump', 80), pump('coldPump', 50),
    component('hx', 'heatExchanger', 'Exchanger', { uaMwPerC: 0.8, hotSideDesignFlowKgPerS: 80, coldSideDesignFlowKgPerS: 50, initialHotTemperatureC: hotTemperature, initialColdTemperatureC: coldTemperature }),
    component('hotReturn', 'processHeader', 'Hot return', {}), component('coldReturn', 'processHeader', 'Cold return', {}),
  ],
  // Deliberately identical service names on physically separate HX circuits.
  connections: [pipe('hotSuction', 'hotTank.outlet', 'hotPump.inlet', 'waterLoop', hotTemperature, 2, 1000),
    pipe('hotIn', 'hotPump.outlet', 'hx.hotIn', 'waterLoop', hotTemperature, 2, 1000),
    pipe('hotOut', 'hx.hotOut', 'hotReturn.inletA', 'waterLoop', hotTemperature, 2, 1000),
    pipe('coldSuction', 'coldTank.outlet', 'coldPump.inlet', 'waterLoop', coldTemperature, 1, 0),
    pipe('coldIn', 'coldPump.outlet', 'hx.coldIn', 'waterLoop', coldTemperature, 1, 0),
    pipe('coldOut', 'hx.coldOut', closedColdLoop ? 'coldTank.inlet' : 'coldReturn.inletA', 'waterLoop', coldTemperature, 1, 0)],
})

describe('RHR physical prerequisites', () => {
  test('each exchanger instant conserves both-side heat at unequal flow, separates circuit mass/chemistry/pressure', () => {
    const runtime = runtimeFor(hxGraph())
    for (let i = 0; i < 100; i++) {
      runtime.tick(100)
      const hot = number(runtime, 'hx.hotSideFlowKgPerS') * 0.00418 * (number(runtime, 'hx.hotInletTemperatureC') - number(runtime, 'hx.hotOutletTemperatureC'))
      const cold = number(runtime, 'hx.coldSideFlowKgPerS') * 0.00418 * (number(runtime, 'hx.coldOutletTemperatureC') - number(runtime, 'hx.coldInletTemperatureC'))
      expect(hot).toBeCloseTo(cold, 10)
      expect(hot).toBeCloseTo(number(runtime, 'hx.heatTransferMw'), 10)
      expect(number(runtime, 'hx.heatBalanceResidualMw')).toBeCloseTo(0, 10)
      expect(number(runtime, 'hotOut.flowKgPerS')).toBeCloseTo(80, 10)
      expect(number(runtime, 'coldOut.flowKgPerS')).toBeCloseTo(50, 10)
    }
    expect(number(runtime, 'hotOut.pressureMPa')).toBeCloseTo(2, 8)
    expect(number(runtime, 'coldOut.pressureMPa')).toBeCloseTo(1, 8)
    expect(number(runtime, 'hotOut.soluteConcentrationPpm')).toBeGreaterThan(900)
    expect(number(runtime, 'coldOut.soluteConcentrationPpm')).toBe(0)
  })

  test('counterflow transfer uses both finite stream heat capacities, including the equal-capacity limit', () => {
    const equal = hxGraph()
    const changed = { ...equal, components: equal.components.map(component => {
      if (String(component.id) === 'hx') return { ...component, parameters: { ...component.parameters as Record<string, unknown>, uaMwPerC: 0.209 } }
      if (String(component.id) === 'hotTank') return { ...component, parameters: { ...component.parameters as Record<string, unknown>, maxOutletFlowKgPerS: 50 } }
      if (String(component.id) === 'hotPump') return { ...component, parameters: { ...component.parameters as Record<string, unknown>, nominalFlowKgPerS: 50 } }
      return component
    }) }
    const equalRuntime = runtimeFor(changed)
    run(equalRuntime, 1)
    // NTU=1 and Cr=1: epsilon=1/2, not the infinite-receiver 1-exp(-1).
    expect(number(equalRuntime, 'hx.effectivenessFraction')).toBeCloseTo(0.5, 12)
    expect(number(equalRuntime, 'hx.heatTransferMw')).toBeCloseTo(15.675, 10)
    const unequal = { ...changed, components: changed.components.map(component => {
      if (String(component.id) === 'hotTank') return { ...component, parameters: { ...component.parameters as Record<string, unknown>, maxOutletFlowKgPerS: 100 } }
      if (String(component.id) === 'hotPump') return { ...component, parameters: { ...component.parameters as Record<string, unknown>, nominalFlowKgPerS: 100 } }
      return component
    }) }
    const unequalRuntime = runtimeFor(unequal)
    run(unequalRuntime, 1)
    // Tabulated counterflow NTU=1, Cr=0.5.
    expect(number(unequalRuntime, 'hx.effectivenessFraction')).toBeCloseTo(0.5647334016064162, 12)
    expect(number(unequalRuntime, 'hx.heatBalanceResidualMw')).toBeCloseTo(0, 10)
  })

  test('isolation travel reaches physical stroke endpoints, supports reversal, and leaves analog lag unchanged', () => {
    const graph = (mode: 'isolation' | 'control') => plantGraph({ id: `stroke-${mode}`, title: 'Actuator travel', fixedStepMs: 100,
      components: [tank('source', 30, 10), component('valve', 'processValve', 'Valve', { valveMode: mode, initialPositionFraction: 0, strokeOpenTimeS: 4, strokeCloseTimeS: 2 }), component('sink', 'processHeader', 'Sink', {})],
      connections: [pipe('inlet', 'source.outlet', 'valve.inlet', 'water', 30), pipe('outlet', 'valve.outlet', 'sink.inletA', 'water', 30)],
    })
    const runtime = runtimeFor(graph('isolation'))
    runtime.writeCommand({ type: 'setVariable', path: path('valve.positionFraction'), value: 1 })
    run(runtime, 1)
    expect(number(runtime, 'valve.effectivePositionFraction')).toBeCloseTo(0.25, 10)
    run(runtime, 1)
    expect(number(runtime, 'valve.effectivePositionFraction')).toBeCloseTo(0.5, 10)
    runtime.writeCommand({ type: 'setVariable', path: path('valve.positionFraction'), value: 0 })
    run(runtime, 0.5)
    expect(number(runtime, 'valve.effectivePositionFraction')).toBeCloseTo(0.25, 10)
    run(runtime, 0.5)
    expect(number(runtime, 'valve.effectivePositionFraction')).toBeCloseTo(0, 12)
    // IEEE rounding may leave an ulp at the exact sampled travel time; the
    // following physical solver step reaches the endpoint without a cutoff.
    runtime.tick(100)
    expect(number(runtime, 'valve.effectivePositionFraction')).toBe(0)
    run(runtime, 1)
    expect(number(runtime, 'outlet.flowKgPerS')).toBe(0)
    runtime.writeCommand({ type: 'setVariable', path: path('valve.positionFraction'), value: 1 })
    run(runtime, 4)
    expect(number(runtime, 'valve.effectivePositionFraction')).toBe(1)
    const analog = runtimeFor(graph('control'))
    analog.writeCommand({ type: 'setVariable', path: path('valve.positionFraction'), value: 1 })
    run(analog, 1)
    expect(number(analog, 'valve.effectivePositionFraction')).toBeCloseTo(1 - (1 - 0.1 / 4) ** 10, 10)
  })

  test('a service discontinuity on an exchanger side is rejected instead of silently starving its circuit', () => {
    const graph = hxGraph()
    const malformed = { ...graph, connections: graph.connections.map(link => String(link.id) === 'coldOut' ? { ...link, service: 'wrongCircuit' as typeof link.service } : link) }
    expect(() => runtimeFor(malformed)).toThrow('cold circuit requires one named fluid service')
  })

  test('a stopped cooling pump removes transfer immediately without lagged artificial cooling', () => {
    const runtime = runtimeFor(hxGraph())
    run(runtime, 10)
    expect(number(runtime, 'hx.heatTransferMw')).toBeGreaterThan(0)
    runtime.writeCommand({ type: 'setVariable', path: path('coldPump.running'), value: false })
    runtime.tick(100)
    expect(number(runtime, 'hx.coldSideFlowKgPerS')).toBe(0)
    expect(number(runtime, 'hx.heatTransferMw')).toBe(0)
    expect(number(runtime, 'hx.hotOutletTemperatureC')).toBe(number(runtime, 'hx.hotInletTemperatureC'))
    expect(number(runtime, 'hx.heatBalanceResidualMw')).toBe(0)
  })

  test('heat reverses for reversed inlet temperatures while circuit labels stay fixed', () => {
    const runtime = runtimeFor(hxGraph(30, 180))
    run(runtime, 2)
    expect(number(runtime, 'hx.heatTransferMw')).toBeLessThan(0)
    expect(number(runtime, 'hx.hotOutletTemperatureC')).toBeGreaterThan(number(runtime, 'hx.hotInletTemperatureC'))
    expect(number(runtime, 'hx.coldOutletTemperatureC')).toBeLessThan(number(runtime, 'hx.coldInletTemperatureC'))
    expect(number(runtime, 'hx.heatBalanceResidualMw')).toBeCloseTo(0, 10)
  })

  test('finite CCW stores heat, holds its temperature without flow, and restores exactly from checkpoint', () => {
    const graph = hxGraph(180, 30, true)
    const runtime = runtimeFor(graph)
    run(runtime, 120)
    const warmed = number(runtime, 'coldTank.temperatureC')
    expect(warmed).toBeGreaterThan(40)
    expect(number(runtime, 'coldTank.inventoryKg')).toBeCloseTo(4500, 8)
    runtime.writeCommand({ type: 'setVariable', path: path('coldPump.running'), value: false })
    run(runtime, 5)
    const held = number(runtime, 'coldTank.temperatureC')
    run(runtime, 120)
    expect(number(runtime, 'coldTank.temperatureC')).toBe(held)
    expect(number(runtime, 'hx.heatTransferMw')).toBe(0)
    const restored = createProcessPlantRuntime({ system: compileResolvedProcessPlant({ id: 'thermal-test', modelRef: 'test.model', operatingPointRef: 'test.operating-point', automationRef: 'test.automation', graph, automationForGraph: () => ({ operatingModes: [], annunciatorSystems: [], firstOutGroups: [], safetyFunctions: [], rules: [] }) }), restoredCheckpoint: runtime.checkpoint() })
    runtime.writeCommand({ type: 'setVariable', path: path('coldPump.running'), value: true })
    restored.writeCommand({ type: 'setVariable', path: path('coldPump.running'), value: true })
    run(runtime, 10); run(restored, 10)
    expect(restored.snapshot()).toEqual(runtime.snapshot())
    expect(number(runtime, 'coldTank.temperatureC')).toBeGreaterThan(held)
  })

  test('sump retains finite inventory and liquid temperature when idle, and shares its capacity once between trains', () => {
    const graph = plantGraph({ id: 'sump-draw', title: 'Finite sump draw', fixedStepMs: 100,
      components: [tank('source', 25, 0), component('containment', 'containmentVolume', 'Containment', {
        freeVolumeM3: 70000, initialTemperatureC: 35, initialSumpInventoryKg: 50000, initialSumpTemperatureC: 120, maxSumpOutflowKgPerS: 80,
      }), pump('pumpA', 60, false), pump('pumpB', 60, false), component('returns', 'processHeader', 'Return', {})],
      connections: [pipe('idleIn', 'source.outlet', 'containment.massEnergyIn', 'release', 25), pipe('sumpA', 'containment.sumpOut', 'pumpA.inlet', 'recirc', 120), pipe('sumpB', 'containment.sumpOut', 'pumpB.inlet', 'recirc', 120), pipe('returnA', 'pumpA.outlet', 'returns.inletA', 'recirc', 120), pipe('returnB', 'pumpB.outlet', 'returns.inletB', 'recirc', 120)],
    })
    const runtime = runtimeFor(graph)
    run(runtime, 30)
    expect(number(runtime, 'containment.sumpInventoryKg')).toBe(50000)
    expect(number(runtime, 'containment.sumpTemperatureC')).toBe(120)
    expect(number(runtime, 'containment.sumpOutflowKgPerS')).toBe(0)
    runtime.writeCommand({ type: 'setVariable', path: path('pumpA.running'), value: true })
    runtime.writeCommand({ type: 'setVariable', path: path('pumpB.running'), value: true })
    run(runtime, 10)
    expect(number(runtime, 'sumpA.flowKgPerS')).toBeCloseTo(40, 10)
    expect(number(runtime, 'sumpB.flowKgPerS')).toBeCloseTo(40, 10)
    expect(number(runtime, 'containment.sumpOutflowKgPerS')).toBeCloseTo(80, 10)
    expect(number(runtime, 'containment.sumpInventoryKg')).toBeCloseTo(49200, 8)
    expect(number(runtime, 'containment.sumpTemperatureC')).toBe(120)
    expect(number(runtime, 'sumpA.temperatureC')).toBeCloseTo(120, 10)
  })

  test('one stored-water outlet shares its actual mass budget across large CW and small SW services', () => {
    const sourceGraph = (capacity: number, inventory: number) => plantGraph({ id: 'shared-source', title: 'Shared CW and SW source', fixedStepMs: 100,
      components: [tank('source', 18, capacity, inventory), pump('cw', 43000), pump('swA', 450), pump('swB', 450), component('return', 'processHeader', 'Return', {})],
      connections: [pipe('sourceCW', 'source.outlet', 'cw.inlet', 'coolingWater', 18), pipe('sourceSWA', 'source.outlet', 'swA.inlet', 'serviceWater', 18), pipe('sourceSWB', 'source.outlet', 'swB.inlet', 'serviceWater', 18), pipe('returnCW', 'cw.outlet', 'return.inletA', 'coolingWater', 18), pipe('returnSWA', 'swA.outlet', 'return.inletB', 'serviceWater', 18), pipe('returnSWB', 'swB.outlet', 'return.inletC', 'serviceWater', 18)],
    })
    const full = runtimeFor(sourceGraph(50000, 100000))
    full.tick(100)
    expect(number(full, 'sourceCW.flowKgPerS')).toBe(43000)
    expect(number(full, 'sourceSWA.flowKgPerS')).toBe(450)
    expect(number(full, 'sourceSWB.flowKgPerS')).toBe(450)
    expect(number(full, 'source.inventoryKg')).toBe(95610)
    const limited = runtimeFor(sourceGraph(1000, 100000))
    limited.tick(100)
    expect(number(limited, 'sourceCW.flowKgPerS')).toBeCloseTo(1000 * 43000 / 43900, 10)
    expect(number(limited, 'sourceSWA.flowKgPerS')).toBeCloseTo(1000 * 450 / 43900, 10)
    expect(number(limited, 'sourceSWB.flowKgPerS')).toBeCloseTo(1000 * 450 / 43900, 10)
    expect(number(limited, 'source.inventoryKg')).toBe(99900)
    const depleted = runtimeFor(sourceGraph(50000, 10))
    depleted.tick(100)
    const total = ['sourceCW', 'sourceSWA', 'sourceSWB'].reduce((sum, id) => sum + number(depleted, `${id}.flowKgPerS`), 0)
    expect(total).toBeCloseTo(100, 10)
    expect(number(depleted, 'source.inventoryKg')).toBeCloseTo(0, 10)
    depleted.tick(100)
    expect(number(depleted, 'sourceCW.flowKgPerS')).toBe(0)
    expect(number(depleted, 'sourceSWA.flowKgPerS')).toBe(0)
    expect(number(depleted, 'sourceSWB.flowKgPerS')).toBe(0)
  })

  test('finite liquid mixing closes its sensible energy and preserves no-flow/withdrawal temperature', () => {
    const after = mixedLiquidTemperatureStep({ inventoryKg: 1000, temperatureC: 120, inflowKgPerS: 20, inflowThermalRateKgCPerS: 20 * 30, outflowKgPerS: 10, dtSeconds: 1 })
    expect(after * 1010 + 10 * 120).toBeCloseTo(1000 * 120 + 20 * 30, 9)
    expect(mixedLiquidTemperatureStep({ inventoryKg: 1000, temperatureC: 120, inflowKgPerS: 0, inflowThermalRateKgCPerS: 0, outflowKgPerS: 10, dtSeconds: 1 })).toBe(120)
  })
})


const operatingChain = () => {
  const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'rhr-current-model', loopCount: 4 }))
  const runtime = createProcessPlantRuntime({ system })
  const protection = createProcessPlantProtectionRunner({ system, protection: system.automation })
  for (let seconds = 0; seconds < 300; seconds++) {
    if (seconds === 10) runtime.writeCommand({ type: 'setVariable', path: path('rcp-a-to-core.leak.areaFraction'), value: 0.5 })
    if (seconds === 120) {
      runtime.writeCommand({ type: 'setVariable', path: path('rhrPumpA.running'), value: true })
      runtime.writeCommand({ type: 'setVariable', path: path('rhrPumpB.running'), value: true })
      runtime.writeCommand({ type: 'setVariable', path: path('rhrIsolationValve.positionFraction'), value: 1 })
    }
    runtime.tick(1000)
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-rhr-physics' as never, sourceRuntimeId: 'process-plant.local' })
  }
  return { system, checkpoint: runtime.checkpoint() }
}
let chain: ReturnType<typeof operatingChain> | undefined
const restoredChain = () => {
  chain ??= operatingChain()
  return createProcessPlantRuntime({ system: chain.system, restoredCheckpoint: chain.checkpoint })
}

describe('current PWR RHR cooling chain', () => {
  test('a fresh paused full-power model already shows real receiving flows and no fictional unloaded cooling pulse', () => {
    for (const loopCount of [2, 4, 6]) {
      const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: `rhr-paused-${loopCount}`, loopCount }))
      const runtime = createProcessPlantRuntime({ system })
      expect(runtime.elapsedMs()).toBe(0)
      const sourceTemperature = number(runtime, 'ultimateHeatSink.temperatureC')
      for (const train of ['A', 'B']) {
        expect(number(runtime, `componentCoolingTank${train}.temperatureC`)).toBe(sourceTemperature)
        expect(number(runtime, `rhrHeatExchanger${train}.hotSideFlowKgPerS`)).toBe(0)
        expect(number(runtime, `rhrHeatExchanger${train}.coldSideFlowKgPerS`)).toBe(350)
        expect(number(runtime, `rhrHeatExchanger${train}.coolingAvailabilityFraction`)).toBe(1)
        expect(number(runtime, `rhrHeatExchanger${train}.heatTransferMw`)).toBe(0)
        const exchanger = `componentCoolingHeatExchanger${train}`
        expect(number(runtime, `${exchanger}.hotSideFlowKgPerS`)).toBe(350)
        expect(number(runtime, `${exchanger}.coldSideFlowKgPerS`)).toBe(450)
        expect(number(runtime, `${exchanger}.hotOutletTemperatureC`)).toBe(sourceTemperature)
        expect(number(runtime, `${exchanger}.coldOutletTemperatureC`)).toBe(sourceTemperature)
        expect(number(runtime, `${exchanger}.heatTransferMw`)).toBe(0)
        expect(number(runtime, `${exchanger}.effectivenessFraction`)).toBeGreaterThan(0)
      }
      const before = runtime.checkpoint()
      const restored = createProcessPlantRuntime({ system, restoredCheckpoint: before })
      expect(restored.checkpoint()).toEqual(before)
      runtime.tick(1000)
      for (const train of ['A', 'B']) {
        expect(number(runtime, `componentCoolingTank${train}.temperatureC`)).toBe(sourceTemperature)
        expect(number(runtime, `componentCoolingHeatExchanger${train}.heatTransferMw`)).toBe(0)
      }
    }
  })

  test('actual LOCA source cools through both physical exchangers while finite closed CCW inventory remains conserved', () => {
    const runtime = restoredChain()
    expect(number(runtime, 'pressurizer.pressureMPa')).toBeLessThan(0.9)
    for (const train of ['A', 'B']) {
      expect(number(runtime, `rhrHeatExchanger${train}.hotSideFlowKgPerS`)).toBeGreaterThan(0)
      expect(number(runtime, `rhrHeatExchanger${train}.coldSideFlowKgPerS`)).toBeCloseTo(350, 8)
      expect(number(runtime, `componentCoolingHeatExchanger${train}.coldSideFlowKgPerS`)).toBeGreaterThan(0)
      expect(number(runtime, `componentCoolingHeatExchanger${train}.coldSideFlowKgPerS`)).toBeLessThanOrEqual(450)
      expect(number(runtime, `rhrHeatExchanger${train}.heatTransferMw`)).toBeGreaterThan(0)
      expect(number(runtime, `componentCoolingHeatExchanger${train}.heatTransferMw`)).toBeGreaterThan(0)
      expect(number(runtime, `rhrHeatExchanger${train}.hotOutletTemperatureC`)).toBeLessThan(number(runtime, `rhrHeatExchanger${train}.hotInletTemperatureC`))
      expect(number(runtime, `componentCoolingTank${train}.inventoryKg`)).toBeCloseTo(28500, 7)
      expect(number(runtime, `rhrHeatExchanger${train}.heatBalanceResidualMw`)).toBeCloseTo(0, 8)
      expect(number(runtime, `componentCoolingHeatExchanger${train}.heatBalanceResidualMw`)).toBeCloseTo(0, 8)
    }
    expect(number(runtime, 'containment.sumpTemperatureC')).toBeGreaterThan(number(runtime, 'containment.temperatureC'))
    expect(number(runtime, 'rhr-isolation-valve-to-cold-leg-a.flowKgPerS')).toBeGreaterThan(0)
  })

  test('loss of one SW feeder removes its driven heat-rejection path and warms finite CCW, without defeating the other train', () => {
    const runtime = restoredChain()
    runtime.writeCommand({ type: 'setVariable', path: path('serviceWaterPumpBreakerA.closed'), value: false })
    // Pump mechanics run before the electrical solve; the next step observes
    // contacts solved open in the preceding step.
    runtime.tick(200)
    expect(runtime.readVariable(path('serviceWaterPumpA.runningState'))).toBe(false)
    run(runtime, 180)
    expect(number(runtime, 'componentCoolingHeatExchangerA.coldSideFlowKgPerS')).toBeLessThan(1e-8)
    expect(number(runtime, 'componentCoolingHeatExchangerA.heatTransferMw')).toBeLessThan(1e-8)
    expect(number(runtime, 'componentCoolingTankA.temperatureC')).toBeGreaterThan(number(runtime, 'componentCoolingTankB.temperatureC'))
    expect(number(runtime, 'rhrHeatExchangerA.heatTransferMw')).toBeLessThan(number(runtime, 'rhrHeatExchangerB.heatTransferMw'))
    expect(number(runtime, 'componentCoolingHeatExchangerB.heatTransferMw')).toBeGreaterThan(0)
    expect(number(runtime, 'componentCoolingTankA.inventoryKg')).toBeCloseTo(28500, 7)
  })

  test('closing the return isolation stops actual sump draw and hot-side transfer on both trains', () => {
    const runtime = restoredChain()
    runtime.writeCommand({ type: 'setVariable', path: path('rhrIsolationValve.positionFraction'), value: 0 })
    run(runtime, 12)
    expect(number(runtime, 'rhrIsolationValve.effectivePositionFraction')).toBe(0)
    expect(number(runtime, 'rhr-isolation-valve-to-cold-leg-a.flowKgPerS')).toBe(0)
    expect(number(runtime, 'containment.sumpOutflowKgPerS')).toBe(0)
    expect(number(runtime, 'rhrHeatExchangerA.hotSideFlowKgPerS')).toBe(0)
    expect(number(runtime, 'rhrHeatExchangerB.hotSideFlowKgPerS')).toBe(0)
    expect(number(runtime, 'rhrHeatExchangerA.heatTransferMw')).toBe(0)
  })

  test('a complete current-model checkpoint preserves every state and the continued thermal trajectory', () => {
    const original = restoredChain()
    const restored = createProcessPlantRuntime({ system: chain!.system, restoredCheckpoint: original.checkpoint() })
    expect(restored.checkpoint().values).toHaveLength(chain!.system.graph.variables.length)
    expect(restored.snapshot()).toEqual(original.snapshot())
    original.writeCommand({ type: 'setVariable', path: path('serviceWaterPumpBreakerA.closed'), value: false })
    restored.writeCommand({ type: 'setVariable', path: path('serviceWaterPumpBreakerA.closed'), value: false })
    run(original, 60); run(restored, 60)
    expect(restored.snapshot()).toEqual(original.snapshot())
  })

  test('the actual shutoff head refuses RHR delivery at full primary pressure even with pump and return commands on', () => {
    const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'rhr-head-test', loopCount: 4 }))
    const runtime = createProcessPlantRuntime({ system })
    runtime.writeCommand({ type: 'setVariable', path: path('rhrPumpA.running'), value: true })
    runtime.writeCommand({ type: 'setVariable', path: path('rhrPumpB.running'), value: true })
    runtime.writeCommand({ type: 'setVariable', path: path('rhrIsolationValve.positionFraction'), value: 1 })
    run(runtime, 30)
    expect(number(runtime, 'pressurizer.pressureMPa')).toBeGreaterThan(0.9)
    expect(number(runtime, 'rhrPumpA.flowKgPerS')).toBe(0)
    expect(number(runtime, 'rhrPumpB.flowKgPerS')).toBe(0)
    expect(number(runtime, 'rhr-isolation-valve-to-cold-leg-a.flowKgPerS')).toBe(0)
  })
})
