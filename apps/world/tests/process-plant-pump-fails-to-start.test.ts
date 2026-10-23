import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { displayRunOf } from '../src/core/api/display-capabilities.ts'
import type { ActorId, IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { composeDefault } from '../src/features/displays/compose/compose.ts'
import type { VignetteSection } from '../src/features/displays/compose/model.ts'
import { compileVignette, sampleVignette } from '../src/features/displays/compose/view.ts'
import {
  answerProcessPlantQuery,
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  isInjectedFault,
  processPlantActionCatalog,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantProtectionRunner } from '../src/packs/process-plant/runtime/index.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { flowDrawing } from '../src/ui/embed/vignette/flow-symbols.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// The needle of plan v5 §5.2: a motor-driven auxiliary feedwater pump that fails to start. The instructor sets it by
// an action on a copy; the fault is a knob no person or AI agent reads (D-88), and shows only through what the Plant
// does: commanded to run with its safety bus live, the pump stays stopped and the I&C raises "MD AFW A fails to start"
// on it, a new alarm, expected after nothing. A pump that starts as it should raises none.

const PLANT_ID = 'plant:fails-to-start'
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: PLANT_ID, loopCount: 4 }))
const RULE = { A: 'motor-driven-afw-pump-a-fails-to-start', B: 'motor-driven-afw-pump-b-fails-to-start' } as const

const started = () => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const run = (seconds: number): void => {
    for (let second = 0; second < seconds; second += 1) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-fails-to-start' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
  }
  const act = (actionId: string): void => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters: {}, graph: plant.graph })) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  }
  const active = (): ReadonlyArray<string> => protection.snapshot().alarms.filter(alarm => alarm.active).map(alarm => alarm.ruleId)
  const read = (path: string) => runtime.readVariableSnapshot(path as never).value
  return { runtime, protection, run, act, active, read }
}

describe('the instructor fails a motor-driven AFW pump to start', () => {
  test('an action per pump, in the catalog, writing the fault on the pump its I&C tags AFW-PUMP-A (and B)', () => {
    const catalog = processPlantActionCatalog().map(action => action.id)
    expect(catalog).toEqual(expect.arrayContaining([RULE.A, RULE.B]))
    const written = (actionId: string) => commandsForProcessPlantAction({ actionId, parameters: {}, graph: plant.graph }).map(command => [String(command.path), command.value])
    expect([written(RULE.A), written(RULE.B)]).toEqual([[['auxFeedwaterPumpMotor.startFailureActive', true]], [['auxFeedwaterPumpMotorB.startFailureActive', true]]])
    // Every pump has the knob; none of them is set until the instructor sets it.
    const knobs = plant.graph.signalBindings.filter(binding => String(binding.path).endsWith('.startFailureActive'))
    expect(knobs.length).toBe(plant.graph.components.filter(component => component.kind === 'centrifugalPump').length)
    expect(started().read('auxFeedwaterPumpMotor.startFailureActive')).toBe(false)
  })

  test('the fault is a knob no person or AI agent reads (D-88): not declared, not found, refused; the instructor\'s action still sets it', () => {
    const knob = plant.graph.signalBindingByPath.get('auxFeedwaterPumpMotor.startFailureActive' as never)!
    expect(isInjectedFault(knob)).toBe(true)
    expect(plantDeclaration(PLANT_ID as ObjectId, plant, null).observables.some(observable => observable.ref.endsWith('.startFailureActive'))).toBe(false)
    const runtime = createProcessPlantRuntime({ system: plant })
    const system: ProcessPlantRuntimeInstance = { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), performance: createProcessPlantRuntimePerformance() }
    const ask = (capabilityId: string, input: unknown): unknown => answerProcessPlantQuery({ request: { capabilityId, input }, plants: new Map([[PLANT_ID, system]]), objects: new Map(), simulationTime: '2026-10-23T10:00:00.000Z' as IsoTimestamp, recordedSeriesIds: new Set() })
    const found = (text: string) => (ask('world.process-plant.signals.search', { plantId: PLANT_ID, limit: 500, text }) as { readonly signals: ReadonlyArray<{ readonly signal: { readonly path: string } }> }).signals.map(entry => entry.signal.path)
    for (const text of ['fails to start', 'start', 'MD AFW A', 'auxiliary feedwater pump']) expect(found(text).filter(path => path.endsWith('.startFailureActive'))).toEqual([])
    expect(() => ask('world.process-plant.signals.read', { plantId: PLANT_ID, signals: [{ path: 'auxFeedwaterPumpMotor.startFailureActive' }] })).toThrow('is a fault the scenario injects')
    expect(() => ask('world.process-plant.variables.read', { plantId: PLANT_ID, paths: ['auxFeedwaterPumpMotor.startFailureActive'] })).toThrow('is a fault the scenario injects')
  })
})

describe('MD AFW A fails to start: the pump stays stopped and the I&C says so; a pump that starts says nothing', () => {
  test('on a loss of offsite power with the fault set: A commanded, its bus live, not running, "fails to start" on it; B starts', () => {
    const plantRun = started()
    plantRun.run(5)
    plantRun.act(RULE.A)
    plantRun.run(5)
    expect(plantRun.active()).not.toContain(RULE.A)
    plantRun.act('loss-offsite-power')
    let raisedAt: number | null = null
    for (let second = 0; second < 180 && raisedAt === null; second += 1) {
      plantRun.run(1)
      if (plantRun.active().includes(RULE.A)) raisedAt = second
    }
    expect(raisedAt).not.toBeNull()
    expect([plantRun.read('auxFeedwaterPumpMotor.running'), plantRun.read('auxFeedwaterPumpMotor.runningState'), plantRun.read('safetyBusA.energized')]).toEqual([true, false, true])
    expect([plantRun.read('auxFeedwaterPumpMotorB.runningState')]).toEqual([true])
    plantRun.run(60)
    expect(plantRun.active()).toContain(RULE.A)
    expect(plantRun.active()).not.toContain(RULE.B)
    const alarm = plantRun.protection.snapshot().alarms.find(entry => entry.ruleId === RULE.A)!
    // On the pump, in the feedwater system, an alarm of its own: expected after nothing, first out of nothing.
    expect(alarm).toMatchObject({ title: 'MD AFW A fails to start', severity: 'warning', firstOut: false, annunciator: { system: 'feedwater', equipmentId: 'auxFeedwaterPumpMotor', group: 'auxiliary-feedwater', priority: 'high', role: 'symptom' } })
    expect(alarm.annunciator?.expectedAfter).toBeUndefined()
  })

  test('no alarm where the pumps start as they should: at power, on a loss of offsite power (their buses dead until the diesels pick them up), on a loss of main feedwater', () => {
    for (const upset of [null, 'loss-offsite-power', 'loss-main-feedwater'] as const) {
      const plantRun = started()
      plantRun.run(10)
      if (upset !== null) plantRun.act(upset)
      const seen = new Set<string>()
      for (let second = 0; second < 300; second += 1) {
        plantRun.run(1)
        for (const id of plantRun.active()) seen.add(id)
      }
      expect([...seen].filter(id => id === RULE.A || id === RULE.B), String(upset)).toEqual([])
      if (upset !== null) expect([plantRun.read('auxFeedwaterPumpMotor.runningState'), plantRun.read('auxFeedwaterPumpMotorB.runningState')], upset).toEqual([true, true])
    }
  })
})

// The needle as the evaluation sets it (needle.ts --inject=action:motor-driven-afw-pump-a-fails-to-start): a copy of
// Run C (the featured Halden offsite-power demo at power, its switchyard busbar fault two minutes in), the fault set by
// the instructor's action as a person, played through the loss of offsite power.
describe('the needle in the haystack (plan v5 §5.2) on a Run like C', () => {
  const routing = createDirectRoutingAdapter()
  const assembly = createWorldApplicationAssembly({ routing })
  const person = { id: 'actor:human:needle' as ActorId, label: 'Instructor', role: 'operator' as const }
  const plantId = 'plant:halden-1'
  let registry: SimulationRunRegistry
  let dataDir: string
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'leitbild-needle-'))
    registry = createSimulationRunRegistry({
      dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
      compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
      scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
      scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), idleRuntimeCloseTimer: () => () => {},
    })
  })
  afterAll(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

  const played = async (needle: boolean) => {
    const runtime = await registry.create({ scenarioId: 'halden-offsite-power-restoration' })
    await runtime.setClock({ paused: true })
    const start = Math.floor(Date.parse(runtime.snapshot().clock!.currentTime) / 60_000) * 60_000
    const play = (seconds: number) => runtime.runMaximumPace(new Date(start + seconds * 1_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
    // Run C: 1.5 min in, at power; the busbar fault at 2 min.
    await play(90)
    if (needle) {
      const outcome = await runtime.invokeCapability(person, { capabilityId: 'world.process-plant.action.invoke', input: { plantId, actionId: RULE.A, parameters: {} } })
      if (outcome.kind === 'command' && !outcome.result.ok) throw new Error(JSON.stringify(outcome.result))
    }
    await play(240)
    return displayRunOf(registry, runtime, person, new Set())
  }

  test('MD AFW A framed in its drawing by a new alarm on it, not expected after the reactor trip; without the fault, none', async () => {
    const run = await played(true)
    const object = run.objects.find(entry => entry.id === plantId)!
    const alert = object.alerts.find(entry => entry.subject !== undefined && 'element' in entry.subject && entry.subject.element === 'auxFeedwaterPumpMotor')
    expect(alert).toMatchObject({ id: `alarm:${RULE.A}:fails-to-start`, message: 'MD AFW A fails to start', priority: 'warning' })
    // Its own default draws it around it; the sample's alerts frame it at the alarm's priority, as a new alarm.
    const outcome = await composeDefault(run, `${plantId}#auxFeedwaterPumpMotor`)
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
    const view = await compileVignette(run, outcome.state)
    const sample = await sampleVignette(run, outcome.state)
    const row = sample.alerts.find(entry => entry.alert.id === alert!.id)!
    expect(row.priority).not.toBeNull()
    expect(row.expected).toBeUndefined()
    const topology = view.sections.find((section): section is Extract<VignetteSection, { kind: 'topology' }> => section.kind === 'topology')!
    const drawn = flowDrawing(topology, sample.observations, sample.alerts, false).texts.find(text => text.id === 'auxFeedwaterPumpMotor')!
    // STOP, then the command it does not follow (W1.3), in the frame its alarm draws.
    expect(drawn.lines.map(line => line.text)).toEqual(['MD AFW A', 'STOP', 'CMD RUN'])
    expect(drawn.tone).not.toBeNull()
    expect(drawn.outline).toBeNull()
    // The same Run without the fault: the pump runs, nothing is raised on it.
    const control = await played(false)
    expect(control.objects.find(entry => entry.id === plantId)!.alerts.filter(entry => entry.subject !== undefined && 'element' in entry.subject && entry.subject.element === 'auxFeedwaterPumpMotor')).toEqual([])
  }, 300_000)
})
