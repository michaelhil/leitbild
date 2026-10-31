import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import type { ActorId, IsoTimestamp, SimulationRunId } from '../src/core/model/index.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { processPlantRuntimeStateSchema } from '../src/packs/process-plant/sim/runtime-state.ts'
import { unpackFixtureRun } from './run-restore/fixture-runs.ts'
import { guardPlantTests, PLANT_HANG_GUARD_MS } from './plant-hang-guard.ts'
import { workspaceIdSchema } from '@leitbild/contracts'
import { createLocalScenarioLibrary, scenarioRevisionIdSchema } from '../src/core/scenarios/library.ts'
import { simulationRunManifestSchema } from '../src/core/simulation-runs/manifest.ts'
import { worldWorkspacePaths } from '../src/core/workspaces/paths.ts'

guardPlantTests()

// T03: retain the exact historical artifacts, including the old PWR model's explicit refusal after the owner-authorized
// controller/model-identity change. Current PWR state is created, persisted and restored through the real registry;
// no old digest or variable slots are rewritten. The unrelated historical Einsatz Run still restores unchanged.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const viewer: Actor = { id: 'actor:human:restore-viewer' as ActorId, label: 'Restore viewer', role: 'operator' }
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const registryFor = (dataDir: string, workspaceId: WorkspaceId): SimulationRunRegistry => createSimulationRunRegistry({
    dataDir,
    workspaceId,
    scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
    runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
  })

const restore = async (name: string) => {
  const { dataDir, runDir, meta } = await unpackFixtureRun(name)
  const registry = registryFor(dataDir, meta.workspaceId as WorkspaceId)
  cleanups.push(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  const saved = {
    snapshot: await Bun.file(join(runDir, 'snapshot.json')).json(),
    execution: await Bun.file(join(runDir, 'execution.json')).json(),
    events: (await Bun.file(join(runDir, 'events.jsonl')).text()).split('\n').filter(line => line.trim()).map(line => JSON.parse(line)),
  }
  const run = await registry.load(meta.runId as SimulationRunId)
  return { run, runDir, meta, saved }
}

// Each object's identity, lifecycle and status as the Run shows it: what a restored Run must give back unchanged.
const states = (objects: ReadonlyArray<any>) => objects.map(object => `${object.id} ${object.lifecycle} ${object.operational?.status ?? '-'}`).sort()

const query = async (run: Awaited<ReturnType<typeof restore>>['run'], capabilityId: string, input: Record<string, unknown>): Promise<any> => {
  const outcome = await run.invokeCapability(viewer, { capabilityId, input })
  if (outcome.kind !== 'query') throw new Error(`${capabilityId} is not a query`)
  return outcome.result
}

describe('T03: saved Runs restore', () => {
  test('today\'s bundled seed advances the head while retaining the exact historical Scenario dependency', async () => {
    const { dataDir, runDir, meta } = await unpackFixtureRun('halden-loop')
    try {
      const workspaceId = workspaceIdSchema.parse(meta.workspaceId)
      const library = createLocalScenarioLibrary({ workspaceId, rootDir: worldWorkspacePaths(dataDir, workspaceId).scenarios })
      const manifest = simulationRunManifestSchema.parse(await Bun.file(join(runDir, 'manifest.json')).json())
      const requiredId = scenarioRevisionIdSchema.parse(manifest.scenario.revisionId)
      const historical = await library.getRevision(requiredId)
      expect(historical?.digest).toBe(manifest.scenario.digest)
      expect((await library.currentRevision(meta.scenarioId))?.id).toBe(requiredId)
      await library.seed(builtinScenarioDefinitions)
      const current = await library.currentRevision(meta.scenarioId)
      expect(current?.id).not.toBe(requiredId)
      expect(current?.document.packs.some(pack => pack.id === 'physical-layout')).toBe(true)
      expect(await library.getRevision(requiredId)).toEqual(historical)
      expect(historical?.document.packs.some(pack => pack.id === 'physical-layout')).toBe(false)
    } finally { await rm(dataDir, { recursive: true, force: true }) }
  })

  test('the retained historical PWR checkpoint refuses a different model without reinterpreting its slots', async () => {
    const { dataDir, runDir, meta } = await unpackFixtureRun('halden-loop')
    const registry = registryFor(dataDir, meta.workspaceId as WorkspaceId)
    cleanups.push(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
    const path = join(runDir, 'runtimes', 'process-plant.local.json')
    const before = await Bun.file(path).text()
    const historical = processPlantRuntimeStateSchema.parse(JSON.parse(before).state)
    expect(meta.commit).toBe('37e4431bb')
    expect(new Set(historical.plants.map(plant => plant.runtime.modelDigest))).toEqual(new Set(['47b82339adddd913ef20d24294ae9c595b104d1c10148bcfb5943bc30aeaf3ea']))
    await expect(registry.load(meta.runId as SimulationRunId)).rejects.toThrow('restored process plant model 47b82339adddd913ef20d24294ae9c595b104d1c10148bcfb5943bc30aeaf3ea does not match Plant model')
    expect(await Bun.file(path).text()).toBe(before)
  })

  test('a fresh four-unit Halden loss restores its actual saved clock, journal, objects and controller selections', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-restore-current-pwr-'))
    const workspaceId = newWorkspaceId()
    let registry = registryFor(dataDir, workspaceId)
    let release = (): void => {}
    cleanups.push(async () => { release(); await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
    const fresh = await registry.create({ scenarioId: 'halden-offsite-power-restoration' })
    // The direct test client holds the same API lease as an active product request, so idle-close cannot interrupt it.
    release = registry.acquireLease(fresh.id, 'api')
    await registry.setExecution(fresh.id, { playback: 'paused' })
    const selections = [
      { plantId: 'plant:halden-2', tagId: 'TURB-BYP-AUTO', value: false },
      { plantId: 'plant:halden-2', tagId: 'TURB-BYP-SP', value: 7.4 },
      { plantId: 'plant:halden-3', tagId: 'MFW-A-CTRL-AUTO', value: false },
      { plantId: 'plant:halden-3', tagId: 'MFW-A-CTRL-SP', value: 60 },
    ]
    const commands: string[] = []
    for (const input of selections) {
      const result = await fresh.invokeCapability(viewer, { capabilityId: 'world.process-plant.control.write', input })
      if (result.kind !== 'command' || !result.result.ok) throw new Error(`Current controller selection refused: ${JSON.stringify(result)}`)
      commands.push(result.result.commandId)
    }
    await registry.advanceExecution(fresh.id, { minutes: 3, onComplete: 'pause' })
    while ((await registry.executionStatus(fresh.id)).acceleration?.status === 'running') await new Promise<void>(resolve => setImmediate(resolve))
    expect(await registry.setExecution(fresh.id, { playback: 'paused' })).toMatchObject({ playback: 'paused', acceleration: { status: 'completed' } })
    const runId = fresh.id
    const runDir = join(worldWorkspacePaths(dataDir, workspaceId).simulationRuns, runId)
    const before = { objects: structuredClone(fresh.snapshot().objects), events: structuredClone(fresh.events()) }
    release()
    await registry.shutdown()
    const saved = {
      snapshot: await Bun.file(join(runDir, 'snapshot.json')).json(),
      execution: await Bun.file(join(runDir, 'execution.json')).json(),
      events: (await Bun.file(join(runDir, 'events.jsonl')).text()).split('\n').filter(line => line.trim()).map(line => JSON.parse(line)),
    }
    const stored = await Bun.file(join(runDir, 'runtimes', 'process-plant.local.json')).json()
    expect(stored).toMatchObject({ schemaVersion: 1, runtimeId: 'process-plant.local' })
    const persisted = processPlantRuntimeStateSchema.parse(stored.state)
    expect(persisted.plants.map(plant => plant.plantId)).toEqual(['plant:halden-1', 'plant:halden-2', 'plant:halden-3', 'plant:halden-4'])
    expect(saved.snapshot.snapshot.objects).toEqual(before.objects)
    for (const commandId of commands) expect(saved.events.some(event => event.type === 'command.result' && event.result.commandId === commandId && event.result.ok)).toBe(true)
    registry = registryFor(dataDir, workspaceId)
    const run = await registry.load(runId)
    release = registry.acquireLease(runId, 'api')
    const snapshot = run.snapshot()
    expect(states(snapshot.objects)).toEqual(states(saved.snapshot.snapshot.objects))
    expect(snapshot.objects.filter(object => object.packId === 'process-plant')).toHaveLength(4)
    expect(snapshot.clock!.currentTime).toBe(saved.execution.execution.currentSimulationTime)
    expect(run.events().length).toBeGreaterThanOrEqual(saved.events.length)
    expect(snapshot.objects).toEqual(before.objects)
    const priorEventIds = new Set(before.events.map(event => event.id))
    expect(run.events().filter(event => priorEventIds.has(event.id))).toEqual([...before.events])
    for (const { plantId, tagId, value } of selections) {
      const read = await query(run, 'world.process-plant.signals.read', { plantId, signals: [{ tagId }] })
      expect(read.signals[0].variable.value).toBe(value)
    }
    // The restored Plants still read the loss: every unit off its grid, its diesels running.
    for (const plantId of ['plant:halden-1', 'plant:halden-2', 'plant:halden-3', 'plant:halden-4']) {
      const read = await query(run, 'world.process-plant.signals.read', { plantId, signals: [{ tagId: 'GRID-AVAIL' }, { tagId: 'EDG-A-RUN' }] })
      expect(read.signals.map((entry: { variable: { value: unknown } }) => entry.variable.value)).toEqual([false, true])
    }
    // And they run on: a restored Run plays.
    const at = Date.parse(snapshot.clock!.currentTime)
    await registry.advanceExecution(runId, { minutes: 2 / 60, onComplete: 'pause' })
    while ((await registry.executionStatus(runId)).acceleration?.status === 'running') await new Promise<void>(resolve => setImmediate(resolve))
    expect(await registry.setExecution(runId, { playback: 'paused' })).toMatchObject({ playback: 'paused', acceleration: { status: 'completed' } })
    expect(Date.parse(run.snapshot().clock!.currentTime)).toBeGreaterThanOrEqual(at + 2_000)
  }, PLANT_HANG_GUARD_MS)

  test('the Einsatz supply Run restores its objects, clock and journal', async () => {
    const { run, saved } = await restore('einsatz-supply-run')
    const snapshot = run.snapshot()
    expect(states(snapshot.objects)).toEqual(states(saved.snapshot.snapshot.objects))
    expect(snapshot.objects.some(object => object.packId === 'einsatz')).toBe(true)
    expect(snapshot.clock!.currentTime).toBe(saved.execution.execution.currentSimulationTime)
    expect(run.events().length).toBeGreaterThanOrEqual(saved.events.length)
    expect(saved.events.some((event: Record<string, unknown>) => 'simulationTime' in event)).toBe(false)
    const at = Date.parse(snapshot.clock!.currentTime)
    await run.runMaximumPace(new Date(at + 2_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
    expect(Date.parse(run.snapshot().clock!.currentTime)).toBeGreaterThanOrEqual(at + 2_000)
  })
})
