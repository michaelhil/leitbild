import { describe, expect, test } from 'bun:test'
import { component, connect, plantGraph, compileResolvedProcessPlant, compileProcessPlant, createPwrReferencePlantDefinition, createProcessPlantRuntime, type PlantGraphSpec, type VariablePath } from '../src/packs/process-plant/index.ts'
import { dcSupplyStep } from '../src/packs/process-plant/runtime/dc-supply.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()
const path = (value: string) => value as VariablePath
const runtimeFor = (graph: PlantGraphSpec) => createProcessPlantRuntime({ system: compileResolvedProcessPlant({ id: 'dc-test', modelRef: 'test.model', operatingPointRef: 'test.point', automationRef: 'test.automation', graph,
  automationForGraph: () => ({ operatingModes: [], annunciatorSystems: [], firstOutGroups: [], safetyFunctions: [], rules: [] }),
}) })
const graph = (powerLossBehavior: 'hold' | 'close' = 'hold', initialCharge = 1) => plantGraph({ id: 'dc-fixture', title: 'Finite DC support', fixedStepMs: 100,
  components: [
    component('grid', 'electricalGridSource', 'AC source', { nominalPowerMw: 4 }),
    component('battery', 'battery', 'Battery and integrated charger', { nominalPowerMw: 1, dischargeTimeS: 10, initialStateOfChargeFraction: initialCharge,
      charger: { nominalPowerMw: 1.5, efficiencyFraction: .9, chargeEfficiencyFraction: .8 } }),
    component('inverter', 'inverter', 'Inverter', { nominalPowerMw: 1, efficiencyFraction: .8 }),
    component('essential', 'electricalLoad', 'Essential support', { nominalLoadMw: .4, essential: true }),
    component('discretionary', 'electricalLoad', 'Shed-able support', { nominalLoadMw: .4 }),
    component('valve', 'processValve', 'Powered valve', { initialPositionFraction: 0, valveMode: 'isolation', strokeOpenTimeS: 2, strokeCloseTimeS: 2, powerLossBehavior }),
  ], connections: [
    connect('charger-feed', 'grid.outlet', 'battery.chargerPower', { connectionKind: 'electricalPower' }),
    connect('battery-inverter', 'battery.outlet', 'inverter.dcInlet', { connectionKind: 'electricalPower' }),
    connect('essential-feed', 'inverter.acOutlet', 'essential.power', { connectionKind: 'electricalPower' }),
    connect('discretionary-feed', 'inverter.acOutlet', 'discretionary.power', { connectionKind: 'electricalPower' }),
    connect('motor-feed', 'inverter.acOutlet', 'valve.motorPower', { connectionKind: 'electricalPower' }),
  ],
})
const read = (r: ReturnType<typeof runtimeFor>, p: string) => Number(r.readVariable(path(p)))
const write = (r: ReturnType<typeof runtimeFor>, p: string, value: boolean | number) => r.writeCommand({ type: 'setVariable', path: path(p), value })
const run = (r: ReturnType<typeof runtimeFor>, seconds: number) => { for (let i = 0; i < seconds * 10; i++) r.tick(100) }

describe('finite DC supply and actual support dependencies', () => {
  test('admission rejects unsupported charger wiring and unspecified actuator power-loss behavior', () => {
    const original = graph()
    expect(() => runtimeFor({ ...original, connections: original.connections.filter(link => String(link.id) !== 'charger-feed') })).toThrow('chargerPower supply')
    expect(() => runtimeFor({ ...original, components: original.components.map(c => String(c.id) === 'valve' ? { ...c, parameters: { initialPositionFraction: 0 } } : c) })).toThrow('powerLossBehavior')
    expect(() => runtimeFor({ ...original, connections: original.connections.filter(link => String(link.id) !== 'motor-feed') })).toThrow('powerLossBehavior')
  })
  test('initial reconciliation serves loads from the charger without inventing battery discharge', () => {
    const r = runtimeFor(graph())
    expect(read(r, 'battery.stateOfChargeFraction')).toBe(1)
    expect(read(r, 'battery.loadDemandMw')).toBeCloseTo(1, 12)
    expect(read(r, 'battery.chargerInputMw')).toBeCloseTo(1 / .9, 12)
    expect(read(r, 'battery.dischargePowerMw')).toBe(0)
    expect(read(r, 'essential.servedMw')).toBe(.4)
    expect(r.readVariable(path('valve.motorPowerAvailable'))).toBe(true)
    run(r, 100)
    expect(read(r, 'battery.stateOfChargeFraction')).toBe(1)
  })

  test('actual AC loss debits downstream loads through inverter efficiency; shedding halves energy use', () => {
    const r = runtimeFor(graph())
    write(r, 'grid.available', false)
    run(r, 2)
    expect(read(r, 'battery.storedEnergyMj')).toBeCloseTo(8, 10)
    expect(read(r, 'battery.dischargePowerMw')).toBeCloseTo(1, 12)
    expect(read(r, 'battery.chargerInputMw')).toBe(0)
    write(r, 'discretionary.connected', false)
    run(r, 2)
    expect(read(r, 'battery.storedEnergyMj')).toBeCloseTo(7, 10)
    expect(read(r, 'battery.dischargePowerMw')).toBeCloseTo(.5, 12)
    expect(read(r, 'discretionary.servedMw')).toBe(0)
    expect(read(r, 'essential.servedMw')).toBe(.4)
  })

  test('charger disable uses real battery energy; restoration serves loads and recharges with explicit losses', () => {
    const r = runtimeFor(graph())
    write(r, 'battery.chargerEnabled', false)
    run(r, 2)
    expect(read(r, 'battery.storedEnergyMj')).toBeCloseTo(8, 10)
    write(r, 'battery.chargerEnabled', true)
    const before = read(r, 'battery.storedEnergyMj')
    r.tick(100)
    expect(read(r, 'battery.storedEnergyMj') - before).toBeCloseTo(read(r, 'battery.chargePowerMw') * .1, 12)
    expect(read(r, 'battery.chargerInputMw')).toBeCloseTo(read(r, 'battery.loadDemandMw') + read(r, 'battery.chargePowerMw') + read(r, 'battery.conversionLossMw'), 12)
    expect(read(r, 'battery.dischargePowerMw')).toBe(0)
    run(r, 10)
    expect(read(r, 'battery.stateOfChargeFraction')).toBe(1)
    expect(read(r, 'battery.chargePowerMw')).toBe(0)
  })

  test('exhaustion removes inverter load service and freezes motor demand; protection cannot bypass dead motor power', () => {
    const r = runtimeFor(graph('hold'))
    write(r, 'valve.positionFraction', 1)
    run(r, 2.1)
    expect(read(r, 'valve.effectivePositionFraction')).toBe(1)
    write(r, 'grid.available', false)
    run(r, 10.2)
    expect(read(r, 'battery.storedEnergyMj')).toBe(0)
    expect(r.readVariable(path('valve.motorPowerAvailable'))).toBe(false)
    expect(read(r, 'essential.servedMw')).toBe(0)
    write(r, 'valve.positionFraction', 0)
    write(r, 'valve.isolationSignal', true)
    run(r, 3)
    expect(read(r, 'valve.demandPositionFraction')).toBe(0)
    expect(read(r, 'valve.effectivePositionFraction')).toBe(1)
    write(r, 'grid.available', true)
    run(r, 2.1)
    expect(read(r, 'valve.effectivePositionFraction')).toBe(0)
    expect(r.readVariable(path('valve.motorPowerAvailable'))).toBe(true)
  })

  test('an explicitly spring-return actuator closes on power loss without changing its command', () => {
    const r = runtimeFor(graph('close', .01))
    write(r, 'valve.positionFraction', 1)
    run(r, 2.1)
    write(r, 'grid.available', false)
    run(r, 3)
    expect(read(r, 'valve.positionFraction')).toBe(1)
    expect(read(r, 'valve.effectivePositionFraction')).toBe(0)
  })

  test('finite storage power balance remains conservative at partial depletion and partial recharge steps', () => {
    for (const energy of [0, .03, 4.5, 9.99, 10]) for (const charger of [0, .2, 1.5]) for (const load of [0, .4, 2]) for (const dtSeconds of [.1, 2, 20]) {
      const r = dcSupplyStep({ energyMj: energy, capacityMj: 10, batteryPowerMw: 1, loadMw: load, chargerAvailableMw: charger, chargerEfficiency: .9, chargeEfficiency: .8, dtSeconds })
      expect(r.energyMj).toBeGreaterThanOrEqual(0)
      expect(r.energyMj).toBeLessThanOrEqual(10)
      expect(r.energyMj - energy).toBeCloseTo((r.chargePowerMw - r.dischargePowerMw) * dtSeconds, 10)
      expect(r.chargerInputMw + r.dischargePowerMw).toBeCloseTo(load - r.unservedLoadMw + r.chargePowerMw + r.conversionLossMw, 10)
      expect(r.chargePowerMw * r.dischargePowerMw).toBe(0)
    }
  })

  test('current PWR preserves the total .8 MW support abstraction per train and adds actual charger/selected valve dependencies', () => {
    const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'current-dc' }))
    const r = createProcessPlantRuntime({ system })
    for (const train of ['A', 'B']) {
      expect(read(r, `vitalBattery${train}.stateOfChargeFraction`)).toBe(1)
      expect(read(r, `vitalBattery${train}.chargerInputMw`)).toBeGreaterThan(0)
      expect(read(r, `plantControlsLoad${train}.servedMw`) + read(r, `dcNonessentialLoad${train}.servedMw`)).toBeCloseTo(.8, 12)
    }
    write(r, 'offsiteGrid.available', false)
    write(r, 'offsiteBreakerA.closed', false)
    write(r, 'offsiteBreakerB.closed', false)
    run(r, 1)
    expect(read(r, 'vitalBatteryA.stateOfChargeFraction')).toBeLessThan(1)
    expect(read(r, 'vitalBatteryA.dischargePowerMw')).toBeCloseTo(.8 / .95, 10)
    expect(r.readVariable(path('steamGeneratorReliefValveA.motorPowerAvailable'))).toBe(true)
    write(r, 'dcNonessentialLoadA.connected', false)
    run(r, 1)
    expect(read(r, 'vitalBatteryA.dischargePowerMw')).toBeCloseTo(.4 / .95, 10)
    expect(read(r, 'vitalBatteryB.dischargePowerMw')).toBeCloseTo(.8 / .95, 10)
  })
})
