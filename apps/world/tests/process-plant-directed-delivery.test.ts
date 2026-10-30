import { describe, expect, test } from 'bun:test'
import { component, connect, plantGraph, compilePlantGraph, processPlantComponentRegistry, compileResolvedProcessPlant, createProcessPlantRuntime, processLinkVariableDescriptorSchema, compileProcessPlant, createPwrReferencePlantDefinition, type PlantGraphSpec, type VariablePath } from '../src/packs/process-plant/index.ts'
import { processPlantModelDigest, processPlantSourceDigest } from '../src/packs/process-plant/model-identity.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()
const path = (value: string): VariablePath => value as VariablePath
const pipe = (id: string, from: string, to: string, service = 'water') => {
  const variables = [
    processLinkVariableDescriptorSchema.parse({ path: 'flowKgPerS', label: 'Flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s', initialValue: 0 }),
    processLinkVariableDescriptorSchema.parse({ path: 'temperatureC', label: 'Temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC', initialValue: 25 }),
    processLinkVariableDescriptorSchema.parse({ path: 'pressureMPa', label: 'Pressure', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa', initialValue: 1 }),
    processLinkVariableDescriptorSchema.parse({ path: 'soluteConcentrationPpm', label: 'Solute', kind: 'state', discipline: 'chemical', writable: false, publish: 'telemetry', quantity: 'concentration', unit: 'ppm', initialValue: 0 }),
  ]
  return { ...connect(id, from, to, { connectionKind: 'fluidFlow', service, nominalFluid: 'water', designPhase: 'liquid', solverModel: 'incompressibleLiquid', variables }), connectionKind: 'fluidFlow' as const, variables }
}
const tank = (id: string, temperature: number, solute: number, capacity: number, inventory = 1_000_000, initialInventoryFraction = 1) => component(id, 'processTank', id, {
  nominalInventoryKg: inventory, initialInventoryFraction, initialTemperatureC: temperature, initialSoluteConcentrationPpm: solute, makeupFlowKgPerS: 0, maxOutletFlowKgPerS: capacity, thermalModel: 'inventoryBalance',
})
const pump = (id: string, flow: number) => component(id, 'centrifugalPump', id, { nominalFlowKgPerS: flow, nominalHeadPa: 800_000, initialRunning: true })
const valve = (id: string, initialPositionFraction: number) => component(id, 'processValve', id, { valveMode: 'isolation', initialPositionFraction, strokeOpenTimeS: 1, strokeCloseTimeS: 1 })
const header = (id: string) => component(id, 'processHeader', id, { distributionMode: 'directedDelivery', initialTemperatureC: 25 })
const compile = (graph: PlantGraphSpec) => compileResolvedProcessPlant({ id: 'directed-test', modelRef: 'test.model', operatingPointRef: 'test.point', automationRef: 'test.automation', graph, automationForGraph: () => ({ operatingModes: [], annunciatorSystems: [], firstOutGroups: [], safetyFunctions: [], rules: [] }) })
const runtimeFor = (graph: PlantGraphSpec) => createProcessPlantRuntime({ system: compile(graph) })
const number = (runtime: ReturnType<typeof runtimeFor>, value: string) => Number(runtime.readVariable(path(value)))
const write = (runtime: ReturnType<typeof runtimeFor>, value: string, setting: number | boolean) => runtime.writeCommand({ type: 'setVariable', path: path(value), value: setting })
const advance = (runtime: ReturnType<typeof runtimeFor>, seconds: number) => { for (let step = 0; step < seconds * 10; step++) runtime.tick(100) }
const selectedSources = (coldCapacity = 200, hotCapacity = 100, inventory = 1_000_000) => plantGraph({ id: 'source-selection', title: 'Finite source selection', fixedStepMs: 100,
  components: [tank('cold', 20, 2200, coldCapacity, inventory), tank('hot', 80, 1200, hotCapacity, inventory), valve('coldIso', 1), valve('hotIso', 0), header('mix'), pump('delivery', 100), tank('receiver', 20, 0, 0, 1_000_000, 0.5)],
  connections: [pipe('coldSource', 'cold.outlet', 'coldIso.inlet', 'fresh'), pipe('coldSelected', 'coldIso.outlet', 'mix.inletA', 'fresh'), pipe('hotSource', 'hot.outlet', 'hotIso.inlet', 'recirculation'), pipe('hotSelected', 'hotIso.outlet', 'mix.inletB', 'recirculation'), pipe('suction', 'mix.outletA', 'delivery.inlet', 'injection'), pipe('receipt', 'delivery.outlet', 'receiver.inlet', 'injection')],
})

describe('explicit directed finite liquid delivery', () => {
  test('make-before-break source overlap conserves every arrival and mixes actual material across functional service labels', () => {
    const runtime = runtimeFor(selectedSources())
    expect(number(runtime, 'coldSource.flowKgPerS')).toBe(100)
    expect(number(runtime, 'hotSource.flowKgPerS')).toBe(0)
    write(runtime, 'hotIso.positionFraction', 1); advance(runtime, 2)
    for (let step = 0; step < 30; step++) {
      const before = ['cold', 'hot', 'receiver'].map(id => number(runtime, `${id}.inventoryKg`))
      runtime.tick(100)
      const cold = number(runtime, 'coldSource.flowKgPerS'), hot = number(runtime, 'hotSource.flowKgPerS'), received = number(runtime, 'receipt.flowKgPerS')
      expect(cold + hot).toBeCloseTo(100, 10)
      expect(cold + hot).toBeCloseTo(received, 10)
      expect(before[0]! - number(runtime, 'cold.inventoryKg')).toBeCloseTo(cold * 0.1, 6)
      expect(before[1]! - number(runtime, 'hot.inventoryKg')).toBeCloseTo(hot * 0.1, 6)
      expect(number(runtime, 'receiver.inventoryKg') - before[2]!).toBeCloseTo(received * 0.1, 6)
      expect(number(runtime, 'mix.flowBalanceResidualKgPerS')).toBeCloseTo(0, 10)
    }
    advance(runtime, 180)
    const cold = number(runtime, 'coldSource.flowKgPerS'), hot = number(runtime, 'hotSource.flowKgPerS')
    expect(number(runtime, 'suction.temperatureC')).toBeCloseTo((cold * 20 + hot * 80) / (cold + hot), 3)
    expect(number(runtime, 'suction.soluteConcentrationPpm')).toBeCloseTo((cold * 2200 + hot * 1200) / (cold + hot), 2)
    write(runtime, 'coldIso.positionFraction', 0); advance(runtime, 2)
    expect(number(runtime, 'coldSource.flowKgPerS')).toBe(0)
    expect(number(runtime, 'hotSource.flowKgPerS')).toBe(100)
    expect(number(runtime, 'receipt.flowKgPerS')).toBe(100)
  })

  test('wrong-order isolation and a failed new source starve a running pump; restoring actual opening restores delivery', () => {
    const runtime = runtimeFor(selectedSources())
    write(runtime, 'hotIso.positionFailureActive', true); write(runtime, 'hotIso.failedPositionFraction', 0); write(runtime, 'hotIso.positionFraction', 1)
    write(runtime, 'coldIso.positionFraction', 0); advance(runtime, 2)
    const before = number(runtime, 'cold.inventoryKg') + number(runtime, 'hot.inventoryKg')
    expect(runtime.readVariable(path('delivery.runningState'))).toBe(true)
    expect(number(runtime, 'hotIso.effectivePositionFraction')).toBe(0)
    expect(number(runtime, 'suction.flowKgPerS')).toBe(0)
    expect(number(runtime, 'receipt.flowKgPerS')).toBe(0)
    expect(number(runtime, 'delivery.flowKgPerS')).toBe(0)
    expect(number(runtime, 'delivery.demandMw')).toBe(0)
    advance(runtime, 2)
    expect(number(runtime, 'cold.inventoryKg') + number(runtime, 'hot.inventoryKg')).toBe(before)
    write(runtime, 'hotIso.positionFailureActive', false); advance(runtime, 2)
    expect(number(runtime, 'hotIso.effectivePositionFraction')).toBe(1)
    expect(number(runtime, 'receipt.flowKgPerS')).toBe(100)
    expect(number(runtime, 'delivery.flowKgPerS')).toBe(100)
  })

  test('small inventories are spent once and cannot be recreated by serial pump capacity or a split', () => {
    const base = selectedSources(200, 100, 5)
    const graph = { ...base, components: [...base.components, header('split'), pump('booster', 40), tank('otherReceiver', 20, 0, 0, 1_000_000, 0.5)], connections: base.connections.filter(link => String(link.id) !== 'receipt').concat([
      pipe('toSplit', 'delivery.outlet', 'split.inletA'), pipe('direct', 'split.outletA', 'receiver.inlet'), pipe('boosterSuction', 'split.outletB', 'booster.inlet'), pipe('boosted', 'booster.outlet', 'otherReceiver.inlet'),
    ]) }
    const runtime = runtimeFor(graph)
    const before = number(runtime, 'receiver.inventoryKg') + number(runtime, 'otherReceiver.inventoryKg')
    runtime.tick(100)
    expect(number(runtime, 'cold.inventoryKg')).toBe(0)
    expect(number(runtime, 'hot.inventoryKg')).toBe(5)
    expect(number(runtime, 'direct.flowKgPerS') + number(runtime, 'boosterSuction.flowKgPerS')).toBeCloseTo(number(runtime, 'toSplit.flowKgPerS'), 10)
    expect(number(runtime, 'boosterSuction.flowKgPerS')).toBe(number(runtime, 'boosted.flowKgPerS'))
    expect(number(runtime, 'receiver.inventoryKg') + number(runtime, 'otherReceiver.inventoryKg') - before).toBeCloseTo(5, 8)
    runtime.tick(100)
    expect(number(runtime, 'direct.flowKgPerS')).toBe(0)
    expect(number(runtime, 'boosted.flowKgPerS')).toBe(0)
  })

  test('a selected source includes unrelated consumers across services and never overspends its shared inventory budget', () => {
    const base = selectedSources(50, 100)
    const graph = { ...base, components: [...base.components, pump('otherConsumer', 80), tank('otherReceiver', 20, 0, 0, 1_000_000, 0.5)], connections: [...base.connections,
      pipe('otherSuction', 'cold.outlet', 'otherConsumer.inlet', 'spray'), pipe('otherReceipt', 'otherConsumer.outlet', 'otherReceiver.inlet', 'spray'),
    ] }
    const runtime = runtimeFor(graph)
    write(runtime, 'hotIso.positionFraction', 1); advance(runtime, 2)
    for (let step = 0; step < 10; step++) {
      const before = number(runtime, 'cold.inventoryKg')
      runtime.tick(100)
      const first = number(runtime, 'coldSource.flowKgPerS'), other = number(runtime, 'otherSuction.flowKgPerS')
      expect(first + other).toBeCloseTo(50, 10)
      expect(before - number(runtime, 'cold.inventoryKg')).toBeCloseTo((first + other) * 0.1, 6)
      expect(number(runtime, 'receipt.flowKgPerS')).toBeGreaterThan(first)
      expect(number(runtime, 'receipt.flowKgPerS')).toBeLessThanOrEqual(100)
      expect(number(runtime, 'hotSource.flowKgPerS')).toBeLessThanOrEqual(100)
      expect(number(runtime, 'otherConsumer.flowKgPerS')).toBeCloseTo(other, 10)
    }
    // This bounded proportional allocation is conservative, not a max-flow
    // optimizer that redispatches spare alternatives after source contention.
    expect(number(runtime, 'hotSource.flowKgPerS')).toBeLessThan(100)
  })

  test('two declared outlet ports of one finite inventory still share exactly one mass budget', () => {
    const base = selectedSources(50, 100)
    const graph = { ...base, components: [...base.components, pump('otherConsumer', 80), tank('otherReceiver', 20, 0, 0, 1_000_000, 0.5)], connections: [...base.connections,
      pipe('otherSuction', 'cold.otherOutlet', 'otherConsumer.inlet', 'spray'), pipe('otherReceipt', 'otherConsumer.outlet', 'otherReceiver.inlet', 'spray'),
    ] }
    // Test-only library extension: the normal processTank currently declares
    // one outlet. Compile a second real port rather than bypass port validation.
    const registry = new Map(processPlantComponentRegistry), kind = graph.components[0]!.kind, definition = registry.get(kind)!
    registry.set(kind, { ...definition, ports: { ...definition.ports, otherOutlet: { ...definition.ports.outlet! } } })
    const compiled = compilePlantGraph(graph, registry)
    const system = { ...compile(base), sourceGraph: graph, graph: compiled, modelDigest: processPlantModelDigest(processPlantSourceDigest(graph), compiled) }
    const runtime = createProcessPlantRuntime({ system }), before = number(runtime, 'cold.inventoryKg')
    runtime.tick(100)
    expect(number(runtime, 'coldSource.flowKgPerS')).toBeGreaterThan(0)
    expect(number(runtime, 'otherSuction.flowKgPerS')).toBeGreaterThan(0)
    expect(number(runtime, 'coldSource.flowKgPerS') + number(runtime, 'otherSuction.flowKgPerS')).toBeCloseTo(50, 10)
    expect(before - number(runtime, 'cold.inventoryKg')).toBeCloseTo(5, 8)
  })

  test('a real inventory closes a circulating path; an unrepresented passive cycle is rejected', () => {
    const graph = plantGraph({ id: 'loop', title: 'Finite loop', fixedStepMs: 100, components: [tank('inventory', 25, 0, 100), pump('circulator', 10), header('manifold')], connections: [pipe('suction', 'inventory.outlet', 'circulator.inlet'), pipe('discharge', 'circulator.outlet', 'manifold.inletA'), pipe('return', 'manifold.outletA', 'inventory.inlet')] })
    const circulated = { ...graph, components: graph.components.map(value => value.id === 'inventory' ? tank('inventory', 25, 0, 10, 100) : value) }
    const runtime = runtimeFor(circulated); advance(runtime, 10)
    expect(number(runtime, 'inventory.inventoryKg')).toBe(100)
    expect(number(runtime, 'return.flowKgPerS')).toBe(10)
    const cyclic = { ...selectedSources(), connections: [...selectedSources().connections, pipe('unsupportedCycle', 'mix.outletB', 'mix.inletC')] }
    expect(() => compile(cyclic)).toThrow('cycle without an explicit fluid inventory')
    const leaky = selectedSources()
    const unsupported = { ...leaky, connections: leaky.connections.map(link => String(link.id) === 'suction' ? { ...link, variables: [...link.variables, processLinkVariableDescriptorSchema.parse({ path: 'leak.areaFraction', label: 'Unrepresented leak', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', quantity: 'ratio', unit: 'fraction', initialValue: 0 })] } : link) }
    expect(() => compile(unsupported)).toThrow('unrepresented leak branch')
  })

  test('restore retains an in-progress physical transfer exactly and resumes the same trajectory', () => {
    const graph = selectedSources(), system = compile(graph), runtime = createProcessPlantRuntime({ system })
    write(runtime, 'hotIso.positionFraction', 1); advance(runtime, 0.5)
    const checkpoint = JSON.parse(JSON.stringify(runtime.checkpoint()))
    const restored = createProcessPlantRuntime({ system, restoredCheckpoint: checkpoint })
    expect(restored.checkpoint()).toEqual(checkpoint)
    for (const current of [runtime, restored]) { write(current, 'coldIso.positionFraction', 0); advance(current, 4) }
    expect(restored.snapshot()).toEqual(runtime.snapshot())
  })
})

test('actual PWR serial supply reaches high-head suction above low-head cutoff while direct low-head delivery stays zero', () => {
  const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'high-pressure-piggyback', loopCount: 4, parameterOverrides: {
    containment: { initialSumpInventoryKg: 100000, initialSumpTemperatureC: 90, initialSumpSoluteConcentrationPpm: 1500 },
    rhrPumpA: { initialRunning: true }, safetyInjectionPumpA: { initialRunning: true },
    rhrRwstSuctionValveA: { initialPositionFraction: 0 }, rhrSumpSuctionValveA: { initialPositionFraction: 1 }, rhrInjectionValveA: { initialPositionFraction: 1 },
    siPiggybackValveA: { initialPositionFraction: 1 }, siRwstSuctionValveA: { initialPositionFraction: 0 },
  } }))
  const runtime = createProcessPlantRuntime({ system })
  expect(number(runtime, 'pressurizer.pressureMPa')).toBeGreaterThan(0.9)
  const supplied = number(runtime, 'containment-sump-to-rhr-sump-suction-valve-a.flowKgPerS')
  expect(supplied).toBeGreaterThan(0)
  expect(number(runtime, 'rhr-injection-valve-a-to-cold-leg-a.flowKgPerS')).toBe(0)
  for (const id of ['rhr-pump-a-to-heat-exchanger', 'rhr-discharge-header-a-to-si-piggyback-valve', 'si-suction-header-a-to-pump', 'safety-injection-pump-a-to-header']) expect(number(runtime, `${id}.flowKgPerS`)).toBeCloseTo(supplied, 10)
  expect(number(runtime, 'rhrPumpA.flowKgPerS')).toBeCloseTo(supplied, 10)
  expect(number(runtime, 'safetyInjectionPumpA.flowKgPerS')).toBeCloseTo(supplied, 10)
  const before = number(runtime, 'containment.sumpInventoryKg'); runtime.tick(100)
  expect(before - number(runtime, 'containment.sumpInventoryKg')).toBeCloseTo(number(runtime, 'containment.sumpOutflowKgPerS') * 0.1, 6)
})

test('finite sump tracer retains actual primary and spray solute, rejects fabricated liquid input, and closes withdrawal balances', () => {
  const graph = plantGraph({ id: 'finite-sump-tracer', title: 'Finite sump material', fixedStepMs: 100,
    components: [tank('primaryRelease', 150, 1500, 10), tank('spraySource', 25, 2200, 5), pump('releasePump', 10), pump('sprayPump', 5),
      component('sump', 'containmentVolume', 'Finite sump', { freeVolumeM3: 50000, initialTemperatureC: 35, initialSumpInventoryKg: 1000, initialSumpTemperatureC: 60, initialSumpSoluteConcentrationPpm: 500, maxSumpOutflowKgPerS: 20 }),
      pump('withdrawal', 20), header('delivery'), tank('receiver', 25, 0, 0, 10000, 0.1)],
    connections: [pipe('primarySuction', 'primaryRelease.outlet', 'releasePump.inlet'), pipe('released', 'releasePump.outlet', 'sump.massEnergyIn'), pipe('spraySuction', 'spraySource.outlet', 'sprayPump.inlet'), pipe('sprayed', 'sprayPump.outlet', 'sump.sprayIn'), pipe('sumpSuction', 'sump.sumpOut', 'withdrawal.inlet'), pipe('sumpDischarge', 'withdrawal.outlet', 'delivery.inletA'), pipe('received', 'delivery.outletA', 'receiver.inlet')],
  })
  const runtime = runtimeFor(graph)
  for (let step = 0; step < 20; step++) {
    const mass = number(runtime, 'sump.sumpInventoryKg'), solute = number(runtime, 'sump.sumpSoluteConcentrationPpm')
    const incoming = number(runtime, 'released.flowKgPerS') * number(runtime, 'released.soluteConcentrationPpm') + number(runtime, 'sprayed.flowKgPerS') * number(runtime, 'sprayed.soluteConcentrationPpm')
    runtime.tick(100)
    const removed = number(runtime, 'sump.sumpOutflowKgPerS') * solute
    expect(number(runtime, 'sump.sumpInventoryKg') * number(runtime, 'sump.sumpSoluteConcentrationPpm') - mass * solute).toBeCloseTo((incoming - removed) * 0.1, 6)
    expect(number(runtime, 'sumpSuction.flowKgPerS')).toBe(number(runtime, 'received.flowKgPerS'))
  }
  const broken = { ...graph, connections: graph.connections.map(link => String(link.id) === 'released' ? { ...link, variables: link.variables.filter(variable => String(variable.path) !== 'soluteConcentrationPpm') } : link) }
  const missing = runtimeFor(broken)
  expect(() => missing.tick(100)).toThrow('requires an actual dissolved-solute reading')
})

test('actual serial pumps bootstrap from zero delivery in either component order and stop above the high-head curve', () => {
  const base = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'zero-supply-bootstrap', loopCount: 4, parameterOverrides: {
    containment: { initialSumpInventoryKg: 100000, initialSumpTemperatureC: 90, initialSumpSoluteConcentrationPpm: 1500 },
    rhrRwstSuctionValveA: { initialPositionFraction: 0 }, rhrSumpSuctionValveA: { initialPositionFraction: 1 }, rhrInjectionValveA: { initialPositionFraction: 1 },
    siPiggybackValveA: { initialPositionFraction: 1 }, siRwstSuctionValveA: { initialPositionFraction: 0 },
  } }))
  for (const reverse of [false, true]) {
    const system = reverse ? compileResolvedProcessPlant({ id: base.id, modelRef: base.modelRef, operatingPointRef: base.operatingPointRef, automationRef: base.automationRef, graph: { ...base.sourceGraph, components: [...base.sourceGraph.components].reverse() }, automationForGraph: () => base.automation }) : base
    const runtime = createProcessPlantRuntime({ system })
    expect(number(runtime, 'rhrPumpA.flowKgPerS')).toBe(0)
    expect(number(runtime, 'safetyInjectionPumpA.flowKgPerS')).toBe(0)
    write(runtime, 'rhrPumpA.running', true); write(runtime, 'safetyInjectionPumpA.running', true); advance(runtime, 1)
    const supplied = number(runtime, 'rhr-discharge-header-a-to-si-piggyback-valve.flowKgPerS')
    expect(supplied).toBeGreaterThan(0)
    expect(number(runtime, 'rhrPumpA.flowKgPerS')).toBeCloseTo(supplied, 10)
    expect(number(runtime, 'safetyInjectionPumpA.flowKgPerS')).toBeCloseTo(supplied, 10)
    write(runtime, 'rhrSumpSuctionValveA.positionFraction', 0); advance(runtime, 10)
    expect(number(runtime, 'rhrPumpA.flowKgPerS')).toBe(0)
    expect(number(runtime, 'safetyInjectionPumpA.flowKgPerS')).toBe(0)
    write(runtime, 'rhrSumpSuctionValveA.positionFraction', 1); advance(runtime, 10)
    expect(number(runtime, 'safetyInjectionPumpA.flowKgPerS')).toBeGreaterThan(0)
  }
  const blocked = compileResolvedProcessPlant({ id: base.id, modelRef: base.modelRef, operatingPointRef: base.operatingPointRef, automationRef: base.automationRef, graph: base.sourceGraph, valueOverrides: { 'pressurizer.pressureMPa': 20, 'rhrPumpA.running': true, 'safetyInjectionPumpA.running': true }, automationForGraph: () => base.automation })
  const runtime = createProcessPlantRuntime({ system: blocked })
  expect(number(runtime, 'rhrPumpA.flowKgPerS')).toBe(0)
  expect(number(runtime, 'safetyInjectionPumpA.flowKgPerS')).toBe(0)
  expect(number(runtime, 'containment-sump-to-rhr-sump-suction-valve-a.flowKgPerS')).toBe(0)
})
