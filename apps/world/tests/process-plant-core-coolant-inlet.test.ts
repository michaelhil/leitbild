import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createPwrReferencePlantDefinition, type VariablePath } from '../src/packs/process-plant/index.ts'
import { componentVariablePath, processLinkVariablePath } from '../src/packs/process-plant/runtime/behavior-contract.ts'
import { initialComponentValueFor } from '../src/packs/process-plant/runtime/component-initial-values.ts'
import { reactorCoreCoolantInlet } from '../src/packs/process-plant/runtime/core-coolant-inlet.ts'
import { createProcessPlantVariableTable } from '../src/packs/process-plant/runtime/variable-table.ts'
import { liquidEnthalpyKjPerKg } from '../src/packs/process-plant/runtime/water-properties.ts'
import { reactorCoreNetInflowKgPerS } from '../src/packs/process-plant/runtime/primary-loop-hydraulics.ts'

const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:core-inlet', loopCount: 4 }))
const core = system.graph.components.find(component => component.kind === 'reactorCore')!
const fixture = () => {
  const table = createProcessPlantVariableTable(system, initialComponentValueFor)
  for (const index of system.graph.incomingLinksByComponent[core.index] ?? []) {
    const link = system.graph.links[index]!
    const path = processLinkVariablePath(link, 'flowKgPerS')
    if (table.has(path)) table.write(path, 0)
  }
  for (const component of system.graph.components) {
    const path = componentVariablePath(component, 'loopReverseFlowKgPerS')
    if (table.has(path)) table.write(path, 0)
  }
  const feed = (id: string, flow: number, temperature: number) => {
    table.write(`${id}.flowKgPerS` as VariablePath, flow)
    table.write(`${id}.temperatureC` as VariablePath, temperature)
  }
  const coldLegs = (system.graph.incomingLinksByComponent[core.index] ?? [])
    .map(index => system.graph.links[index]!).filter(link => link.service === 'primaryCoolant')
  return { table, feed, coldLegs }
}

describe('core coolant heat and mass transport', () => {
  test('charging, accumulators, SI and RHR return all enter the thermal throughput at their actual delivered flow', () => {
    const { table, feed, coldLegs } = fixture()
    feed(String(coldLegs[0]!.id), 100, 300)
    feed('charging-pump-to-cold-leg-a', 10, 200)
    feed('safety-accumulator-a-to-cold-leg-a', 20, 30)
    feed('safety-injection-header-to-cold-leg-a', 30, 60)
    feed('rhr-injection-valve-a-to-cold-leg-a', 40, 90)
    const inlet = reactorCoreCoolantInlet(system, core, table, 10)
    expect(inlet.forwardFlowKgPerS).toBe(200)
    expect(inlet.netFlowKgPerS).toBe(200)
    const energy = 100 * liquidEnthalpyKjPerKg(300, 10) + 10 * liquidEnthalpyKjPerKg(200, 10)
      + 20 * liquidEnthalpyKjPerKg(30, 10) + 30 * liquidEnthalpyKjPerKg(60, 10) + 40 * liquidEnthalpyKjPerKg(90, 10)
    expect(inlet.specificEnthalpyKjPerKg! * inlet.forwardFlowKgPerS).toBeCloseTo(energy, 7)
    // Water enthalpy is nonlinear: averaging inlet temperatures first loses energy.
    expect(Math.abs(inlet.specificEnthalpyKjPerKg! - liquidEnthalpyKjPerKg(190, 10))).toBeGreaterThan(1)
  })

  test('a reverse cold leg removes throughput and never acts as an arriving hot stream', () => {
    const { table, feed, coldLegs } = fixture()
    const forward = coldLegs[0]!
    const reversed = coldLegs[1]!
    feed(String(forward.id), 100, 100)
    feed(String(reversed.id), 25, 300)
    const pump = system.graph.components[reversed.fromComponentIndex]!
    table.write(componentVariablePath(pump, 'loopReverseFlowKgPerS'), 25)
    feed('rhr-injection-valve-a-to-cold-leg-a', 50, 50)
    const inlet = reactorCoreCoolantInlet(system, core, table, 2)
    expect(inlet.forwardFlowKgPerS).toBe(150)
    expect(inlet.reverseFlowKgPerS).toBe(25)
    expect(inlet.netFlowKgPerS).toBe(125)
    expect(inlet.specificEnthalpyKjPerKg).toBeCloseTo((100 * liquidEnthalpyKjPerKg(100, 2) + 50 * liquidEnthalpyKjPerKg(50, 2)) / 150, 9)
  })

  test('zero delivery carries no inlet energy and a changed live flow is not cached as topology', () => {
    const { table, feed } = fixture()
    expect(reactorCoreCoolantInlet(system, core, table, 1)).toEqual({ forwardFlowKgPerS: 0, reverseFlowKgPerS: 0, netFlowKgPerS: 0, specificEnthalpyKjPerKg: null })
    feed('rhr-injection-valve-a-to-cold-leg-a', 30, 80)
    expect(reactorCoreCoolantInlet(system, core, table, 1).netFlowKgPerS).toBe(30)
    feed('rhr-injection-valve-a-to-cold-leg-a', 0, 80)
    expect(reactorCoreCoolantInlet(system, core, table, 1).specificEnthalpyKjPerKg).toBeNull()
  })

  test('the loop-only indication preserves reverse direction under its signed net-flow contract', () => {
    const { table, feed, coldLegs } = fixture()
    const reversed = coldLegs[0]!
    feed(String(reversed.id), 25, 100)
    table.write(componentVariablePath(system.graph.components[reversed.fromComponentIndex]!, 'loopReverseFlowKgPerS'), 25)
    const net = reactorCoreNetInflowKgPerS(system, core, table)
    expect(net).toBe(-25)
    const indication = componentVariablePath(core, 'primaryLoopNetFlowKgPerS')
    table.write(indication, net)
    expect(table.snapshotVariable(indication)).toMatchObject({ value: -25, quantity: 'flowRateDelta', unit: 'kg/s' })
    expect(table.has(componentVariablePath(core, 'averageHotLegFlowKgPerS'))).toBe(false)
  })
})
