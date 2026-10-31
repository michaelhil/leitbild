import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type CompiledProcessPlant,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { valvePositionController } from '../src/packs/process-plant/graph/valve-controller.ts'
import { parameterNumber } from '../src/packs/process-plant/runtime/component-helpers.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// The condensate side of the four-loop reference PWR: the condensate pumps
// take the hotwell's water to the feedwater tank through the tank's level
// control valve (COND-LCV-POS), which throttles them as the tank fills, and
// the hotwell rejects what rises above 60 % to the condensate storage tank.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:hotwell', loopCount: 4 }))
const hotwellLow = 'alarm:condenser-hotwell-level-low:hotwell-level-low'

const started = (system: CompiledProcessPlant = plant) => {
  const runtime = createProcessPlantRuntime({ system })
  const protection = createProcessPlantProtectionRunner({ system, protection: system.automation })
  const read = (path: string): number => Number(runtime.readVariable(path as VariablePath))
  const tag = (tagId: string): number => Number(runtime.readVariable(resolveProcessPlantSignalBinding(system.graph, { tagId: tagId as never }).path))
  const alarmed = (): ReadonlyArray<string> => protection.snapshot().alarms.filter(lifecycle => lifecycle.active).map(lifecycle => lifecycle.id)
  const evaluate = (): void => {
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-hotwell' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
  }
  const run = (seconds: number, each?: () => void): void => {
    for (let second = 0; second < seconds; second += 1) {
      runtime.tick(1_000)
      evaluate()
      each?.()
    }
  }
  const act = (actionId: string): void => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters: {}, graph: system.graph })) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  }
  return { runtime, read, tag, alarmed, evaluate, run, act }
}

describe('hotwell and feedwater tank level control', () => {
  test('the full-power hotwell starts balanced and conserves its actual production and draw as thermal stocks settle', () => {
    const plantRun = started()
    const { read, tag, runtime, evaluate } = plantRun
    const condenser = plant.graph.components.find(component => component.kind === 'condenserSink')!
    const reject = plant.graph.components.find(component => component.id === 'hotwellRejectValve')!
    const rejectController = valvePositionController(reject)!
    const lowLevel = plant.automation.rules.find(rule => rule.id === 'condenser-hotwell-level-low')!.condition
    if (lowLevel.type !== 'comparison' || typeof lowLevel.value !== 'number') throw Error('Expected the authored hotwell low-level comparison')
    const outlets = plant.graph.links.filter(link => link.fromComponentIndex === condenser.index && link.service === 'condensate')
    const outletFlow = () => outlets.reduce((sum, link) => sum + read(`${link.id}.flowKgPerS`), 0)
    const initialMass = read('condenser.condensateInventoryKg')
    const initialFeedwaterMass = read('feedwaterTank.inventoryKg')
    // The initial operating datum remains exact. It is not a promise of a
    // frozen coupled thermal state: the core also receives finite CVCS flow,
    // and the SG metal and steam inventories follow their actual heat input.
    expect(tag('HOTWELL-LVL')).toBeCloseTo(55, 10)
    expect(tag('FW-TANK-LVL')).toBeCloseTo(82, 10)
    expect(outletFlow()).toBeCloseTo(read('condenser.condensateProductionKgPerS'), 8)
    const stepMs = plant.graph.timestep.fixedStepMs
    const dt = stepMs / 1_000
    let integratedMassChange = 0
    let previousMass = initialMass
    let lowAlarm = false
    for (let elapsed = 0; elapsed < 120_000; elapsed += stepMs) {
      runtime.tick(stepMs)
      // Preserve the fixture's original one-second I&C cadence while reading
      // the material balance at every actual numerical solver step.
      if (runtime.elapsedMs() % 1_000 === 0) evaluate()
      const massChange = (read('condenser.condensateProductionKgPerS') - outletFlow()) * dt
      const mass = read('condenser.condensateInventoryKg')
      expect(mass - previousMass).toBeCloseTo(massChange, 8)
      integratedMassChange += massChange
      previousMass = mass
      expect(tag('HOTWELL-LVL')).toBeGreaterThan(lowLevel.value)
      expect(tag('HOTWELL-LVL')).toBeLessThan(rejectController.setpoint)
      lowAlarm ||= plantRun.alarmed().includes(hotwellLow)
    }
    expect(read('condenser.condensateInventoryKg') - initialMass).toBeCloseTo(integratedMassChange, 7)
    expect(tag('HOTWELL-LVL')).toBeCloseTo(100 * read('condenser.condensateInventoryKg') / parameterNumber(condenser, 'nominalCondensateInventoryKg'), 10)
    expect(tag('COND-LCV-POS')).toBeCloseTo(1, 6)
    expect(tag('HOTWELL-REJECT-POS')).toBe(0)
    expect(read('feedwaterTank.inventoryKg')).toBe(initialFeedwaterMass)
    expect(tag('FW-TANK-LVL')).toBeCloseTo(82, 10)
    expect(lowAlarm).toBe(false)
  })

  test('after a turbine trip the level control valve shuts the condensate off, and the hotwell holds without alarm', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('turbine-trip')
    let lowest = 100
    let alarmed = false
    const at = new Map<number, number>()
    let second = 0
    plantRun.run(600, () => {
      second += 1
      lowest = Math.min(lowest, plantRun.tag('HOTWELL-LVL'))
      alarmed ||= plantRun.alarmed().includes(hotwellLow)
      if ([120, 300, 600].includes(second)) at.set(second, plantRun.tag('HOTWELL-LVL'))
    })
    // The feedwater pumps stopped, the tank fills to about 84 %, where its valve has shut.
    expect(plantRun.tag('COND-LCV-POS')).toBeCloseTo(0, 6)
    expect(plantRun.tag('FW-TANK-LVL')).toBeGreaterThan(83)
    expect(plantRun.tag('FW-TANK-LVL')).toBeLessThan(85)
    expect(plantRun.read('condenser-to-condensate-pump-a.flowKgPerS') + plantRun.read('condenser-to-condensate-pump-b.flowKgPerS')).toBeCloseTo(0, 6)
    // The hotwell dips while the valve closes, then holds, and its low alarm never comes in.
    expect(alarmed).toBe(false)
    expect(lowest).toBeGreaterThan(40)
    for (const level of at.values()) {
      expect(level).toBeGreaterThan(40)
      expect(level).toBeLessThan(60)
    }
  })

  test('after a loss of main feedwater the hotwell rejects to the condensate storage tank what it takes in above 60 %', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act('loss-main-feedwater')
    let rejected = 0
    plantRun.run(600, () => { rejected += plantRun.tag('HOTWELL-REJECT-FLOW') })
    expect(rejected).toBeGreaterThan(500)
    expect(plantRun.tag('HOTWELL-LVL')).toBeGreaterThan(60)
    expect(plantRun.tag('HOTWELL-LVL')).toBeLessThan(62)
    expect(plantRun.alarmed()).not.toContain(hotwellLow)
  })
})
