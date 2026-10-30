import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createProcessPlantRuntime, createPwrReferencePlantDefinition, createProcessPlantProtectionRunner, type VariablePath } from '../src/packs/process-plant/index.ts'
import { closedPrimaryCircuitDemandOpen, directedFluidDeliveryFlow, prepareDirectedFluidDelivery } from '../src/packs/process-plant/runtime/directed-fluid-delivery.ts'
import type { ProcessPlantBehaviorContext } from '../src/packs/process-plant/runtime/behavior-contract.ts'
import { shutdownCoolingWithdrawalLinks } from '../src/packs/process-plant/runtime/shutdown-cooling.ts'
import { valveBehaviorDefinitions } from '../src/packs/process-plant/runtime/behaviors/junction/valve-behaviors.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()
const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'test:sdc-delivery' }))

// Controlled solver frames isolate the capacity/mass allocation mechanism.
// They are not a cold operating point, procedure qualification or evidence of
// a full-power cooldown. Dynamic trajectories are tested separately.
const frame = (overrides: Record<string, number | boolean> = {}) => {
  const runtime = createProcessPlantRuntime({ system })
  const values = new Map<string, number | boolean>(runtime.snapshot().variables.map(row => [row.path, row.value]))
  for (const variable of system.graph.variables) if (String(variable.path).endsWith('.pressureMPa')) values.set(String(variable.path), 1.5)
  for (const train of ['A', 'B']) {
    for (const barrier of [1, 2]) values.set(`rhrShutdownSuctionValve${train}${barrier}.effectivePositionFraction`, 1)
    values.set(`rhrRwstSuctionValve${train}.effectivePositionFraction`, 0)
    values.set(`rhrSumpSuctionValve${train}.effectivePositionFraction`, 0)
    values.set(`siPiggybackValve${train}.effectivePositionFraction`, 0)
    values.set(`rhrInjectionValve${train}.effectivePositionFraction`, 1)
    values.set(`rhrPump${train}.flowKgPerS`, 520)
    values.set(`rhrPump${train}.runningState`, true)
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!values.has(key)) throw Error(`Unknown solver frame override ${key}`)
    values.set(key, value)
  }
  const read = (path: VariablePath) => {
    const value = values.get(path)
    if (value === undefined) throw Error(`Unknown test solver input ${path}`)
    return value
  }
  const context: ProcessPlantBehaviorContext = {
    phase: 'solveFluidFlowLinks', dtSeconds: .1, has: path => values.has(path), read,
    readNumber: path => { const value = read(path); if (typeof value !== 'number') throw Error(`Not numeric ${path}`); return value },
    readBoolean: path => { const value = read(path); if (typeof value !== 'boolean') throw Error(`Not Boolean ${path}`); return value },
    readOptionalNumber: (path, fallback) => values.has(path) ? Number(read(path)) : fallback,
    write: (path, value) => values.set(path, value),
  }
  prepareDirectedFluidDelivery(system, context, .1)
  const flow = (id: string) => {
    const link = system.graph.links.find(row => String(row.id) === id)
    if (!link) throw Error(`Unknown graph link ${id}`)
    const value = directedFluidDeliveryFlow(system, link, context)
    if (value === null) throw Error(`Not a directed circuit ${id}`)
    return value
  }
  return { context, flow }
}

describe('finite closed-primary RHR delivery', () => {
  test('closed return circulates above low-head injection shutoff without inventing external supply', () => {
    const { flow } = frame()
    for (const train of ['a', 'b']) {
      const drawn = flow(`rcs-to-rhr-shutdown-suction-${train}`)
      expect(drawn).toBeGreaterThan(400)
      expect(flow(`rhr-shutdown-suction-${train}-inner-to-outer`)).toBeCloseTo(drawn, 10)
      expect(flow(`rhr-shutdown-suction-${train}-to-header`)).toBeCloseTo(drawn, 10)
      expect(flow(`rhr-injection-valve-${train}-to-cold-leg-${train}`)).toBeCloseTo(drawn, 10)
      expect(flow(`rwst-to-rhr-rwst-suction-valve-${train}`)).toBe(0)
      expect(flow(`containment-sump-to-rhr-sump-suction-valve-${train}`)).toBe(0)
    }
    expect(shutdownCoolingWithdrawalLinks(system).map(link => String(link.id))).toEqual(['rcs-to-rhr-shutdown-suction-a', 'rcs-to-rhr-shutdown-suction-b'])
  })

  test('either series barrier or the return valve stops that train, independently', () => {
    for (const blocked of ['rhrShutdownSuctionValveA1', 'rhrShutdownSuctionValveA2', 'rhrInjectionValveA']) {
      const { flow, context } = frame({ [`${blocked}.effectivePositionFraction`]: 0 })
      expect(flow('rcs-to-rhr-shutdown-suction-a')).toBe(0)
      expect(flow('rhr-injection-valve-a-to-cold-leg-a')).toBe(0)
      expect(flow('rcs-to-rhr-shutdown-suction-b')).toBeGreaterThan(400)
      const pump = system.graph.components.find(component => String(component.id) === 'rhrPumpA')!
      expect(closedPrimaryCircuitDemandOpen(system, pump, context)).toBe(false)
    }
  })

  test('the two suction branches spend one finite liquid stock, excluding stored steam', () => {
    const { flow } = frame({ 'vessel.primaryCoolantInventoryKg': 20, 'vessel.loopSteamMassKg': 10 })
    const total = flow('rcs-to-rhr-shutdown-suction-a') + flow('rcs-to-rhr-shutdown-suction-b')
    expect(total).toBeCloseTo(100, 10)
    expect(flow('rhr-injection-valve-a-to-cold-leg-a') + flow('rhr-injection-valve-b-to-cold-leg-b')).toBeCloseTo(total, 10)
    const empty = frame({ 'vessel.primaryCoolantInventoryKg': 10, 'vessel.loopSteamMassKg': 10 })
    expect(empty.flow('rcs-to-rhr-shutdown-suction-a')).toBe(0)
    expect(empty.flow('rcs-to-rhr-shutdown-suction-b')).toBe(0)
  })

  test('an open external source cannot borrow RCS closed-loop pressure head', () => {
    const { flow } = frame({
      'vessel.primaryCoolantInventoryKg': 20, 'vessel.loopSteamMassKg': 10,
      'rhrRwstSuctionValveA.effectivePositionFraction': 1, 'rhrRwstSuctionValveB.effectivePositionFraction': 1,
    })
    expect(flow('rcs-to-rhr-shutdown-suction-a') + flow('rcs-to-rhr-shutdown-suction-b')).toBeCloseTo(100, 10)
    expect(flow('rwst-to-rhr-rwst-suction-valve-a')).toBe(0)
    expect(flow('rwst-to-rhr-rwst-suction-valve-b')).toBe(0)
    expect(flow('rhr-injection-valve-a-to-cold-leg-a') + flow('rhr-injection-valve-b-to-cold-leg-b')).toBeCloseTo(100, 10)
  })

  test('closed RCS suction leaves the existing high-pressure injection restriction intact', () => {
    const { flow } = frame({
      'rhrShutdownSuctionValveA1.effectivePositionFraction': 0, 'rhrShutdownSuctionValveB1.effectivePositionFraction': 0,
      'rhrRwstSuctionValveA.effectivePositionFraction': 1, 'rhrRwstSuctionValveB.effectivePositionFraction': 1,
    })
    expect(flow('rcs-to-rhr-shutdown-suction-a')).toBe(0)
    expect(flow('rcs-to-rhr-shutdown-suction-b')).toBe(0)
    expect(flow('rhr-injection-valve-a-to-cold-leg-a')).toBe(0)
    expect(flow('rhr-injection-valve-b-to-cold-leg-b')).toBe(0)
  })

  test('actual high-temperature/full-pressure protection holds both finite barriers despite open demands', () => {
    const runtime = createProcessPlantRuntime({ system })
    const protection = createProcessPlantProtectionRunner({ system, protection: system.automation })
    protection.evaluate({ runtime, elapsedMs: 0, simulationRunId: 'run:sdc-barriers' as never, sourceRuntimeId: 'process-plant.local' })
    for (const train of ['A', 'B']) for (const barrier of [1, 2]) runtime.writeCommand({ type: 'setVariable', path: `rhrShutdownSuctionValve${train}${barrier}.positionFraction` as VariablePath, value: 1 })
    for (let second = 0; second < 10; second++) {
      runtime.tick(1000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run:sdc-barriers' as never, sourceRuntimeId: 'process-plant.local' })
    }
    for (const train of ['A', 'B']) {
      for (const barrier of [1, 2]) {
        expect(runtime.readVariable(`rhrShutdownSuctionValve${train}${barrier}.positionFraction` as VariablePath)).toBe(1)
        expect(runtime.readVariable(`rhrShutdownSuctionValve${train}${barrier}.isolationSignal` as VariablePath)).toBe(true)
        expect(runtime.readVariable(`rhrShutdownSuctionValve${train}${barrier}.effectivePositionFraction` as VariablePath)).toBe(0)
      }
      expect(runtime.readVariable(`rcs-to-rhr-shutdown-suction-${train.toLowerCase()}.flowKgPerS` as VariablePath)).toBe(0)
    }
  })

  test('a source barrier needs its real train motor supply to travel and holds its position on loss of power', () => {
    const valve = system.graph.components.find(component => String(component.id) === 'rhrShutdownSuctionValveA1')!
    const actuator = valveBehaviorDefinitions.find(behavior => behavior.id === 'processValve-effective-position')!
    const { context } = frame({ 'rhrShutdownSuctionValveA1.positionFraction': 1, 'rhrShutdownSuctionValveA1.effectivePositionFraction': .5,
      'safetyBusA.energized': false, 'safetyBusA.voltageFraction': 0 })
    actuator.update({ system, component: valve, context })
    expect(context.readNumber('rhrShutdownSuctionValveA1.effectivePositionFraction' as VariablePath)).toBe(.5)
    expect(context.readBoolean('rhrShutdownSuctionValveA1.motorPowerAvailable' as VariablePath)).toBe(false)
    context.write('rhrShutdownSuctionValveA1.isolationSignal' as VariablePath, true)
    actuator.update({ system, component: valve, context })
    // An out-of-envelope interlock is an electrical close demand, not magic
    // mechanical motion from a de-energized motor.
    expect(context.readNumber('rhrShutdownSuctionValveA1.effectivePositionFraction' as VariablePath)).toBe(.5)
    context.write('safetyBusA.energized' as VariablePath, true)
    context.write('safetyBusA.voltageFraction' as VariablePath, 1)
    actuator.update({ system, component: valve, context })
    expect(context.readBoolean('rhrShutdownSuctionValveA1.motorPowerAvailable' as VariablePath)).toBe(true)
    expect(context.readNumber('rhrShutdownSuctionValveA1.effectivePositionFraction' as VariablePath)).toBeCloseTo(.5 - .1 / 8, 12)
    context.write('rhrShutdownSuctionValveA1.isolationSignal' as VariablePath, false)
    actuator.update({ system, component: valve, context })
    expect(context.readNumber('rhrShutdownSuctionValveA1.effectivePositionFraction' as VariablePath)).toBeCloseTo(.5, 12)
  })
})
