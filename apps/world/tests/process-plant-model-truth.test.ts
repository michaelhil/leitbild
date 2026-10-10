import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { itemBinding, framingRules } from '../src/packs/process-plant/displays/mimic/bindings.ts'
import { indexSample, itemLook } from '../src/packs/process-plant/displays/mimic/evaluate.ts'

// The reference PWR reports what its equipment does, beside what it is told
// to do: a feedback tag for each command tag, read from the solved state.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:model-truth', loopCount: 4 }))
const graph = plant.graph

const started = () => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const run = (durationMs: number, options: { readonly withIc: boolean } = { withIc: true }) => {
    for (let elapsed = 0; elapsed < durationMs; elapsed += 1_000) {
      runtime.tick(1_000)
      if (options.withIc) protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-model-truth' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
  }
  const act = (actionId: string, parameters: Readonly<Record<string, unknown>> = {}) => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters, graph })) {
      runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
  }
  const tag = (tagId: string) => runtime.readVariable(resolveProcessPlantSignalBinding(graph, { tagId: tagId as never }).path)
  const read = (path: string) => runtime.readVariable(path as VariablePath)
  const activeIds = () => {
    const snapshot = protection.snapshot()
    return [...snapshot.alarms, ...snapshot.trips].filter(lifecycle => lifecycle.active).map(lifecycle => lifecycle.id)
  }
  return { runtime, protection, run, act, tag, read, activeIds }
}

describe('the pressurizer PORV', () => {
  test('a stuck-open PORV reads open on its position feedback while its demand stays shut', () => {
    const plantRun = started()
    plantRun.run(5_000)
    expect(plantRun.tag('PORV-456A-POS')).toBe(0)
    plantRun.act('pressurizer-relief-open', { positionPercent: 100 })
    plantRun.run(10_000)
    expect(plantRun.tag('PORV-456A')).toBe(0)
    expect(plantRun.tag('PORV-456A-POS')).toBe(1)
    expect(Number(plantRun.read('pressurizer.reliefFlowKgPerS'))).toBeGreaterThan(1)

    // The drawn PORV says it is open and that its demand disagrees.
    const pzr = graph.componentIndexById.get('pressurizer' as never)!
    const binding = itemBinding(plant, { kind: 'device', component: pzr, device: 'reliefValve' }, 'position', framingRules(plant))
    const sample = indexSample([binding.state!.state!.path, binding.state!.command!].map(path => ({ path, value: plantRun.read(path), quality: 'good' })))
    expect(itemLook(binding, sample)).toMatchObject({ state: { kind: 'position', fraction: 1 }, notMeasured: false, mismatch: 'CMD SHUT' })
  })

  test('a partly failed PORV reads the opening it fails to', () => {
    const plantRun = started()
    plantRun.act('pressurizer-relief-open', { positionPercent: 35 })
    plantRun.run(3_000)
    expect(Number(plantRun.tag('PORV-456A-POS'))).toBeCloseTo(0.35, 6)
  })
})

describe('breakers', () => {
  const breakerLook = (system: typeof plant, id: string, read: (path: string) => unknown) => {
    const binding = itemBinding(system, { kind: 'component', component: system.graph.componentIndexById.get(id as never)! }, 'position', framingRules(system))
    const paths = [binding.state!.state!.path, binding.state!.command!]
    return itemLook(binding, indexSample(paths.map(path => ({ path, value: read(path), quality: 'good' }))))
  }

  test('a breaker opened by its command reads open', () => {
    const plantRun = started()
    plantRun.run(2_000, { withIc: false })
    expect(plantRun.tag('BRK-OFFSITE-A-POS')).toBe(true)
    expect(breakerLook(plant, 'offsiteBreakerA', plantRun.read)).toMatchObject({ state: { kind: 'closed' }, mismatch: null, words: 'closed' })
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'offsiteBreakerA.closed' as VariablePath, value: false })
    plantRun.run(1_000, { withIc: false })
    expect(plantRun.tag('BRK-OFFSITE-A-CLOSED')).toBe(false)
    expect(plantRun.tag('BRK-OFFSITE-A-POS')).toBe(false)
    expect(plantRun.read('offsiteBreakerA.energized')).toBe(false)
    expect(breakerLook(plant, 'offsiteBreakerA', plantRun.read)).toMatchObject({ state: { kind: 'open' }, mismatch: null, words: 'open' })
  })

  test('a tripped breaker reads open while its close command stays', () => {
    const plantRun = started()
    plantRun.run(2_000, { withIc: false })
    // A protective relay latches the trip; the close command is left as it was.
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'offsiteBreakerA.tripped' as VariablePath, value: true })
    plantRun.run(1_000, { withIc: false })
    expect(plantRun.tag('BRK-OFFSITE-A-CLOSED')).toBe(true)
    expect(plantRun.tag('BRK-OFFSITE-A-POS')).toBe(false)
    expect(plantRun.tag('BRK-OFFSITE-B-POS')).toBe(true)
    expect(plantRun.read('offsiteBreakerA.energized')).toBe(false)
    expect(breakerLook(plant, 'offsiteBreakerA', plantRun.read)).toMatchObject({ state: { kind: 'open' }, mismatch: 'CMD CLOSE', words: 'open; commanded close disagrees' })
  })

  test('a reactor trip opens both reactor trip breakers, read from their position feedback', () => {
    const tripped = compileProcessPlant(createPwrReferencePlantDefinition({
      id: 'plant:reactor-trip',
      valueOverrides: { 'pressurizer.pressureMPa': 10 },
    }))
    const runtime = createProcessPlantRuntime({ system: tripped })
    const protection = createProcessPlantProtectionRunner({ system: tripped, protection: tripped.automation })
    for (let elapsed = 0; elapsed < 5_000; elapsed += 1_000) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-model-truth' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
    const tag = (tagId: string) => runtime.readVariable(resolveProcessPlantSignalBinding(tripped.graph, { tagId: tagId as never }).path)
    expect(tag('TRIP-BKR-A-POS')).toBe(false)
    expect(tag('TRIP-BKR-B-POS')).toBe(false)
    // The turbine follows the reactor trip, as the breakers' position reads it.
    expect(Number(runtime.readVariable('turbineStopValve.positionFraction' as VariablePath))).toBe(0)
  })
})

describe('pumps', () => {
  const pumps = graph.components.filter(component => component.kind === 'centrifugalPump').map(component => String(component.id))

  test('under loss of offsite power every pump reads not running while its run command stays', () => {
    const plantRun = started()
    plantRun.run(2_000, { withIc: false })
    const commanded = pumps.filter(id => plantRun.read(`${id}.running`) === true)
    expect(commanded).toEqual(expect.arrayContaining(['rcpA', 'rcpB', 'rcpC', 'rcpD', 'mainFeedwaterPumpA', 'mainFeedwaterPumpB', 'chargingPump']))
    for (const id of pumps) expect(plantRun.read(`${id}.runningState`), id).toBe(plantRun.read(`${id}.running`))

    // Without the I&C no diesel starts, so the safety buses stay dead.
    plantRun.act('loss-offsite-power')
    plantRun.run(3_000, { withIc: false })
    expect(plantRun.read('safetyBusA.energized')).toBe(false)
    expect(plantRun.read('safetyBusB.energized')).toBe(false)
    for (const id of commanded) {
      expect(plantRun.read(`${id}.running`), id).toBe(true)
      expect(plantRun.read(`${id}.runningState`), id).toBe(false)
    }
    for (const loop of ['A', 'B', 'C', 'D']) {
      expect(plantRun.tag(`RCP-${loop}-RUN`)).toBe(true)
      expect(plantRun.tag(`RCP-${loop}-RUNNING`)).toBe(false)
    }
  })

  test('a reactor coolant pump that loses its power alarms as not running, though its run command stands', () => {
    const plantRun = started()
    plantRun.run(2_000)
    plantRun.act('loss-offsite-power')
    plantRun.run(3_000)
    expect(plantRun.tag('RCP-A-RUN')).toBe(true)
    expect(plantRun.activeIds()).toEqual(expect.arrayContaining(['alarm:rcp-a-trip:not-running', 'alarm:rcp-b-trip:not-running', 'alarm:main-feedwater-pump-trip:main-feedwater-pump-unavailable']))
  })
})
