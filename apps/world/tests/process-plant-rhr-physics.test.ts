import { describe, expect, test } from 'bun:test'
import { component, connect, plantGraph, compileResolvedProcessPlant, createProcessPlantRuntime, processLinkVariableDescriptorSchema, type PlantGraphSpec, type VariablePath } from '../src/packs/process-plant/index.ts'
import { mixedLiquidTemperatureStep } from '../src/packs/process-plant/runtime/thermal-inventory.ts'

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

  test('finite liquid mixing closes its sensible energy and preserves no-flow/withdrawal temperature', () => {
    const after = mixedLiquidTemperatureStep({ inventoryKg: 1000, temperatureC: 120, inflowKgPerS: 20, inflowThermalRateKgCPerS: 20 * 30, outflowKgPerS: 10, dtSeconds: 1 })
    expect(after * 1010 + 10 * 120).toBeCloseTo(1000 * 120 + 20 * 30, 9)
    expect(mixedLiquidTemperatureStep({ inventoryKg: 1000, temperatureC: 120, inflowKgPerS: 0, inflowThermalRateKgCPerS: 0, outflowKgPerS: 10, dtSeconds: 1 })).toBe(120)
  })
})
