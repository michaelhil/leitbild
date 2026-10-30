import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createProcessPlantRuntime, createPwrReferencePlantDefinition, type VariablePath } from '../src/packs/process-plant/index.ts'
import { processLinkFlowSourceFor } from '../src/packs/process-plant/runtime/links/link-flow-source-strategy.ts'
import { steamGeneratorBehaviorDefinitions } from '../src/packs/process-plant/runtime/behaviors/steam-generator-behaviors.ts'
import type { ProcessPlantBehaviorContext } from '../src/packs/process-plant/runtime/behavior-contract.ts'
import { guardPlantTests } from './plant-hang-guard.ts'
import { steamGeneratorDomeState } from '../src/packs/process-plant/runtime/steam-generator-dome.ts'
import { steamGeneratorOperatingLevel } from '../src/packs/process-plant/steam-generator-operating-level.ts'

guardPlantTests()
const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'test:secondary-cooldown' }))
const frame = (overrides: Record<string, number | boolean>, dtSeconds = .1) => {
  const runtime = createProcessPlantRuntime({ system })
  const values = new Map<string, number | boolean>(runtime.snapshot().variables.map(row => [row.path, row.value]))
  for (const [path, value] of Object.entries(overrides)) {
    if (!values.has(path)) throw Error(`Unknown frame override ${path}`)
    values.set(path, value)
  }
  const read = (path: VariablePath) => { const value = values.get(path); if (value === undefined) throw Error(`Unknown frame ${path}`); return value }
  const context: ProcessPlantBehaviorContext = {
    phase: 'updateComponentState', dtSeconds, has: path => values.has(path), read,
    readNumber: path => { const value = read(path); if (typeof value !== 'number') throw Error(`Not numeric ${path}`); return value },
    readBoolean: path => { const value = read(path); if (typeof value !== 'boolean') throw Error(`Not Boolean ${path}`); return value },
    readOptionalNumber: (path, fallback) => values.has(path) ? Number(read(path)) : fallback,
    write: (path, value) => values.set(path, value),
  }
  return { context, value: (path: string) => Number(read(path as VariablePath)) }
}

describe('secondary cooldown physical boundaries', () => {
  test('dome calibration reproduces the authored full-power pressure and responds to actual vapor mass', () => {
    const sg = system.graph.components.find(component => String(component.id) === 'sgA')!
    const parameters = sg.parameters as Record<string, number>
    const nominal = { liquidInventoryKg: parameters.nominalSecondaryInventoryKg! * steamGeneratorOperatingLevel(sg.parameters as Record<string, unknown>).collapsed / 100,
      liquidTemperatureC: parameters.initialSecondaryTemperatureC!, steamMassKg: parameters.nominalSteamMassKg!, pressureMPa: parameters.nominalPressureMPa! }
    const atPower = steamGeneratorDomeState(sg, nominal)
    expect(atPower.pressureMPa).toBeCloseTo(nominal.pressureMPa, 8)
    expect(steamGeneratorDomeState(sg, { ...nominal, steamMassKg: nominal.steamMassKg / 10 }).pressureMPa).toBeLessThan(1)
    expect(steamGeneratorDomeState(sg, { ...nominal, steamMassKg: nominal.steamMassKg * 1.2 }).pressureMPa).toBeGreaterThan(nominal.pressureMPa)
    const filled = steamGeneratorDomeState(sg, { ...nominal, liquidInventoryKg: nominal.liquidInventoryKg * 1.2 })
    expect(filled.steamSpaceVolumeM3).toBeLessThan(atPower.steamSpaceVolumeM3)
    expect(filled.pressureMPa).toBeGreaterThan(atPower.pressureMPa)
  })

  test('a known saturated-vapor density gives the independent steam-table pressure', () => {
    const sg = system.graph.components.find(component => String(component.id) === 'sgA')!
    const emptyLiquid = { liquidInventoryKg: 0, liquidTemperatureC: 100, steamMassKg: 1, pressureMPa: 1 }
    const volume = steamGeneratorDomeState(sg, emptyLiquid).steamSpaceVolumeM3
    // IF97 saturated steam at 1 MPa: specific volume 0.1943489 m3/kg.
    const atOneMPa = steamGeneratorDomeState(sg, { ...emptyLiquid, steamMassKg: volume / .1943489 })
    expect(atOneMPa.pressureMPa).toBeCloseTo(1, 5)
  })

  test('all simultaneous steam outlets share one finite dome stock, including turbine-driven AFW', () => {
    const sg = system.graph.components.find(component => String(component.id) === 'sgB')!
    const outlets = system.graph.links.filter(link => link.fromComponentIndex === sg.index && link.service === 'mainSteam')
    expect(outlets.length).toBeGreaterThan(2)
    const make = (stock: number) => frame({ 'sgB.steamMassKg': stock,
      'steamGeneratorReliefValveB.effectivePositionFraction': 1, 'auxFeedwaterPumpTurbine.running': true,
      'auxFeedwaterTurbineSteamValveB.effectivePositionFraction': 1 })
    const full = make(100_000), sparse = make(.1), empty = make(0)
    const demands = outlets.map(link => processLinkFlowSourceFor({ system, link, context: full.context }).flowKgPerS)
    const delivered = outlets.map(link => processLinkFlowSourceFor({ system, link, context: sparse.context }).flowKgPerS)
    const requested = demands.reduce((sum, flow) => sum + flow, 0)
    expect(demands.filter(flow => flow > 0).length).toBeGreaterThan(2)
    expect(delivered.reduce((sum, flow) => sum + flow, 0)).toBeCloseTo(1, 12)
    for (let index = 0; index < outlets.length; index++) {
      expect(delivered[index]!).toBeCloseTo(demands[index]! / requested, 12)
      expect(processLinkFlowSourceFor({ system, link: outlets[index]!, context: empty.context }).flowKgPerS).toBe(0)
    }
  })

  test('an open condenser dump draws real stored steam even when current boiling is zero', () => {
    const sg = system.graph.components.find(component => String(component.id) === 'sgA')!
    const outlet = system.graph.links.find(link => link.fromComponentIndex === sg.index && String(link.fromPortName) === 'steamOutlet')!
    const frameFor = (opening: number, stock: number) => frame({ 'sgA.steamMassKg': stock, 'sgA.steamFlowKgPerS': 0,
      'turbine.loadFraction': 0, 'turbine.steamDemandKgPerS': 0, 'turbineStopValve.effectivePositionFraction': 0,
      'turbineBypassValve.effectivePositionFraction': opening })
    const open = frameFor(1, 1000), closed = frameFor(0, 1000), empty = frameFor(1, 0)
    expect(processLinkFlowSourceFor({ system, link: outlet, context: open.context }).flowKgPerS).toBeGreaterThan(100)
    expect(processLinkFlowSourceFor({ system, link: outlet, context: closed.context }).flowKgPerS).toBe(0)
    expect(processLinkFlowSourceFor({ system, link: outlet, context: empty.context }).flowKgPerS).toBe(0)
  })

  test('cold primary and secondary cool toward actual enthalpy/saturation temperatures, not hot-operation floors', () => {
    const sg = system.graph.components.find(component => String(component.id) === 'sgA')!
    const updates = frame({
      'rcs-hot-leg-a.temperatureC': 150, 'rcs-hot-leg-a.pressureMPa': 1.5,
      'sgA.primaryInletTemperatureC': 150, 'sgA.primaryOutletTemperatureC': 160,
      'sgA.tubeMetalTemperatureC': 140, 'sgA.secondaryTemperatureC': 140,
      'sgA.pressureMPa': .2, 'sgA.heatTransferMw': 100,
    }, 1)
    steamGeneratorBehaviorDefinitions.find(behavior => behavior.id === 'steam-generator-inventory-pressure-state')!.update({ system, component: sg, context: updates.context })
    expect(updates.value('sgA.primaryOutletTemperatureC')).toBeLessThan(160)
    expect(updates.value('sgA.secondaryTemperatureC')).toBeLessThan(140)
    expect(updates.value('sgA.primaryOutletTemperatureC')).toBeGreaterThan(updates.value('sgA.secondaryTemperatureC'))
  })

  test('depressurizing steam stock can fall below the old 15 percent floor with an exact finite mass balance', () => {
    const sg = system.graph.components.find(component => String(component.id) === 'sgA')!
    const outletValues = Object.fromEntries(system.graph.links.filter(link => link.fromComponentIndex === sg.index && link.service === 'mainSteam').map(link => [`${link.id}.flowKgPerS`, 2]))
    const updates = frame({ ...outletValues, 'sgA.steamMassKg': 1000, 'sgA.boilingRateKgPerS': 1, 'sgA.pressureMPa': .5 }, 1)
    steamGeneratorBehaviorDefinitions.find(behavior => behavior.id === 'steam-generator-inventory-pressure-state')!.update({ system, component: sg, context: updates.context })
    expect(updates.value('sgA.steamMassKg')).toBeLessThan(1000)
    expect(updates.value('sgA.steamMassBalanceResidualKg')).toBeCloseTo(0, 12)
    expect(updates.value('sgA.pressureTargetMPa')).toBeLessThan(1)
  })

  test('finite liquid limits real boiling and a dry generator cannot remain an unlimited heat sink', () => {
    const sg = system.graph.components.find(component => String(component.id) === 'sgA')!
    for (const liquid of [0, .1]) {
      const updates = frame({ 'sgA.secondaryInventoryKg': liquid,
        'sgA.collapsedLevelPercent': 0, 'sgA.swellLevelPercent': 0 }, 1)
      steamGeneratorBehaviorDefinitions.find(behavior => behavior.id === 'steam-generator-heat-transfer')!.update({ system, component: sg, context: updates.context })
      expect(updates.value('sgA.boilingRateKgPerS')).toBeLessThanOrEqual(liquid)
      if (liquid === 0) {
        expect(updates.value('sgA.heatTransferMw')).toBe(0)
        expect(updates.value('sgA.steamFlowKgPerS')).toBe(0)
      }
    }
  })
})
