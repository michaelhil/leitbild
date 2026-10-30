import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createProcessPlantRuntime, createPwrReferencePlantDefinition, type VariablePath } from '../src/packs/process-plant/index.ts'
import { initialComponentValueFor } from '../src/packs/process-plant/runtime/component-initial-values.ts'
import { primaryLiquidBoundaryCoolingMw } from '../src/packs/process-plant/runtime/primary-liquid-cooling.ts'
import { createProcessPlantVariableTable } from '../src/packs/process-plant/runtime/variable-table.ts'
import { liquidEnthalpyKjPerKg } from '../src/packs/process-plant/runtime/water-properties.ts'

const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:cooling-transport', loopCount: 4 }))
const core = system.graph.components.find(component => component.kind === 'reactorCore')!
const path = (value: string): VariablePath => value as VariablePath
const fixture = () => {
  const table = createProcessPlantVariableTable(system, initialComponentValueFor)
  for (const link of system.graph.links) if (table.has(path(`${link.id}.flowKgPerS`))) table.write(path(`${link.id}.flowKgPerS`), 0)
  table.write(path('core.coolantOutletTemperatureC'), 200)
  const feed = (id: string, flow: number, temperature: number) => {
    table.write(path(`${id}.flowKgPerS`), flow)
    table.write(path(`${id}.temperatureC`), temperature)
  }
  return { table, feed, cooling: () => primaryLiquidBoundaryCoolingMw(system, core, table, 2) }
}

describe('primary cooling transport diagnostics', () => {
  test('an algebraic exchanger reading alone cannot credit any core cooling or duplicate downstream transfer', () => {
    const { table, cooling } = fixture()
    for (const id of ['rhrHeatExchangerA', 'rhrHeatExchangerB', 'componentCoolingHeatExchangerA', 'componentCoolingHeatExchangerB']) table.write(path(`${id}.heatTransferMw`), 100)
    expect(cooling()).toBe(0)
  })

  test('balanced liquid withdrawal and return count exactly the transported enthalpy difference', () => {
    const { feed, cooling } = fixture()
    // Two physical boundary crossings; intervening piping/HX state is not counted again.
    const letdown = system.graph.links.find(link => link.service === 'letdown' && system.graph.components[link.fromComponentIndex]?.kind === 'reactorVessel')!
    feed(String(letdown.id), 50, 180)
    feed('charging-pump-to-cold-leg-a', 50, 40)
    expect(cooling()).toBeCloseTo(50 * (liquidEnthalpyKjPerKg(180, 2) - liquidEnthalpyKjPerKg(40, 2)) / 1000, 10)
  })

  test('external hot liquid has a signed warming effect, while colder makeup contributes its actual delivered cooling', () => {
    const { feed, cooling } = fixture()
    feed('safety-injection-header-to-cold-leg-a', 10, 230)
    expect(cooling()).toBeLessThan(0)
    feed('safety-injection-header-to-cold-leg-a', 10, 80)
    expect(cooling()).toBeCloseTo(10 * (liquidEnthalpyKjPerKg(200, 2) - liquidEnthalpyKjPerKg(80, 2)) / 1000, 10)
    feed('safety-injection-header-to-cold-leg-a', 0, 80)
    expect(cooling()).toBe(0)
  })

  test('fresh paused and progressed diagnostics retain signed load and its positive part as distinct from recovery proof', () => {
    const runtime = createProcessPlantRuntime({ system })
    for (const ms of [0, 1000]) {
      if (ms > 0) runtime.tick(ms)
      const read = (value: string) => Number(runtime.readVariable(path(value)))
      const input = read('core.totalThermalPowerMw') + read('core.pumpHeatMw')
      const sg = ['A', 'B', 'C', 'D'].reduce((sum, loop) => sum + read(`sg${loop}.heatTransferMw`), 0)
      const net = read('core.primaryNetHeatLoadMw')
      expect(net).toBeCloseTo(input - sg - read('core.primaryLiquidBoundaryCoolingMw'), 5)
      expect(read('core.coreHeatRemovalDeficitMw')).toBeCloseTo(Math.max(0, net), 10)
      const diagnostics = runtime.pwrTransientDiagnostics().core
      expect(diagnostics.netHeatLoadMw).toBe(net)
      expect(diagnostics.liquidBoundaryCoolingMw).toBe(read('core.primaryLiquidBoundaryCoolingMw'))
      expect(system.graph.signalBindingByPath.get(path('core.primaryNetHeatLoadMw'))!.simulatorOnly).toBe(true)
    }
  })
})
