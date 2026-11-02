import { accessContextSchema, newRequestId, newWorkspaceId } from '@leitbild/contracts'
import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { dronePackConfigSchema } from '../src/packs/drone/config.ts'
import { deepCopy, setValueAtPath } from '../src/ui/scenario-builder-model.ts'
import { allPackAuthoringExample } from './fixtures/all-pack-authoring.ts'

test('all eight owner selections survive discovered schema, preview, published start/read, live changes, revision edits and restore', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-all-pack-authoring-')), workspaceId = newWorkspaceId(), routing = createDirectRoutingAdapter()
  const assembly = createWorldApplicationAssembly({ routing })
  let connections = 0
  const workspaces = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }),
    runtimeAdapters: assembly.runtimeAdapters.map(adapter => ({ ...adapter, connect: async config => { connections++; return adapter.connect(config) } })),
    workspaceCapabilities: assembly.packs.flatMap(pack => pack.workspaceCapabilities ?? []),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), scenarioDefinitions: [],
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }), scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
  })
  const invoke = async (capabilityId: string, input: unknown, actor: 'ai' | 'human', target?: { definition?: unknown; resource?: unknown }) => {
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: actor, id: `example-${actor}` } })
    const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, capabilityId, input, access, ...target }) })
    const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
    if (!response) throw Error('Module did not handle example lifecycle')
    return { status: response.status, body: await response.json() as any }
  }
  try {
    await workspaces.provision(workspaceId)
    const registry = (await workspaces.getOrLoad(workspaceId)).simulationRuns, source = deepCopy(allPackAuthoringExample())
    const droneIndex = source.packs.findIndex(pack => pack.id === 'drone')
    setValueAtPath(source, ['packs', droneIndex, 'items', 0, 'headingDeg'], 12)
    expect(source.packs[droneIndex]!.config).toEqual({ stepIntervalMs: 25, projectionIntervalMs: 750, motionFrameIntervalMs: 100 })
    expect(new Set(source.packs.map(pack => pack.id))).toEqual(new Set(assembly.packs.map(pack => pack.descriptor.id)))
    for (const selection of source.packs) {
      const owner = assembly.packs.find(pack => pack.descriptor.id === selection.id)!
      owner.scenarioConfigSchema.parse(selection.config)
      for (const item of selection.items) owner.scenario!.itemSchemas[item.type]!.parse({ ...item, pack: selection.id })
      for (const actor of ['human', 'ai'] as const) {
        const discovered = await invoke('world.scenario-authoring.describe', { detail: 'authoring', packIds: [selection.id] }, actor)
        expect(discovered.status).toBe(200)
        expect(discovered.body.result.packs[0].configSchema).toHaveProperty('type', 'object')
      }
    }
    for (const [packId, change, reason] of [
      ['ambulance', (selection: any) => { selection.items.find((item: any) => item.type === 'patient').incidentId = 'missing-incident' }, 'missing-incident'],
      ['drone', (selection: any) => { selection.items[0].modelId = 'unknown-model' }, 'unknown drone vehicle model'],
      ['weather', (selection: any) => { selection.items[0].atmosphere.precipitation = { type: 'none', intensityMmPerHour: 1 } }, 'No precipitation'],
      ['situation-monitor', (selection: any) => { selection.config.sources.push(structuredClone(selection.config.sources[0])) }, 'unique'],
      ['einsatz', (selection: any) => { selection.items.find((item: any) => item.type === 'unit').unitType = 'unknown-type' }, 'unknown_unit_type'],
      ['process-plant', (selection: any) => { selection.items[0].model.ref = 'unknown-model' }, 'unknown process plant model'],
      ['electric-grid', (selection: any) => { selection.items[0].model.ref = 'unknown-model' }, 'unknown Grid Model'],
      ['physical-layout', (selection: any) => { selection.items[0].design.digest = '0'.repeat(64) }, 'mismatched physical Design'],
    ] as const) {
      const invalid = structuredClone(source)
      change(invalid.packs.find(selection => selection.id === packId))
      const rejected = await invoke('world.scenario.preview', { source: invalid }, 'ai')
      expect(rejected.status).toBe(400)
      expect(JSON.stringify(rejected.body)).toContain(reason)
    }
    for (const actor of ['human', 'ai'] as const) {
      const preview = await invoke('world.scenario.preview', { source }, actor)
      expect(preview.status).toBe(200)
      expect(preview.body.result.initialInventory.length).toBeGreaterThan(0)
    }
    expect(connections).toBe(0)
    const revision = await registry.createScenario(source)
    const definition = { workspaceId, moduleId: 'world', type: 'world.scenario', id: source.id, revisionId: revision.id }
    for (const actor of ['human', 'ai'] as const) {
      const read = await invoke('world.scenario.read', {}, actor, { definition })
      expect(read.status).toBe(200)
      expect(read.body.result.source.packs).toEqual(source.packs) // Advanced JSON fields do not pass through specialized forms.
    }
    const started = await invoke('world.scenario.start', {}, 'ai', { definition })
    expect(started.status).toBe(201)
    const run = await registry.load(started.body.result.id); await run.setClock({ paused: true })
    const resource = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }
    const reads = [
      ['ambulance', 'world.ambulance.dispatch-state', {}], ['drone', 'world.drone.scene', {}],
      ['weather', 'world.weather.describe', {}], ['situation-monitor', 'world.situation-monitor.status', {}],
      ['einsatz', 'world.einsatz.configuration', {}], ['process-plant', 'world.process-plant.plants.list', {}],
      ['electric-grid', 'world.electric-grid.catalog.list', {}], ['physical-layout', 'world.simulation-run.read-object', { objectId: source.packs.find(pack => pack.id === 'physical-layout')!.items[0]!.id }],
    ] as const
    for (const [pack, capabilityId, input] of reads) for (const actor of ['human', 'ai'] as const) {
      expect((await invoke(capabilityId, input, actor, { resource })).status).toBe(200)
      expect(source.packs.some(selection => selection.id === pack)).toBe(true)
    }
    for (const [capabilityId, input] of [
      ['world.ambulance.set-unit-readiness', { unitId: 'example:ambulance', ready: false }],
      ['world.weather.set-enabled', { objectId: 'example:weather', enabled: false }],
      ['world.drone.set-gimbal', { droneId: 'example:drone', yawDeg: 15, pitchDeg: -20 }],
      ['world.situation-monitor.configuration.replace', { expectedRevision: 0, config: { sources: [], areas: [] } }],
      ['world.einsatz.unit.hold', { unitId: 'unit:truck-3' }],
      ['world.process-plant.control.write', { plantId: 'plant:halden-1', tagId: 'MOV-8000A', value: 0 }],
    ] as const) {
      const answer = await invoke(capabilityId, input, 'human', { resource })
      expect(answer.status).toBe(200)
      expect(answer.body.result.ok).toBe(true)
    }
    const branch = (await invoke('world.electric-grid.assets.search', { gridId: 'grid:halden-four-unit', kinds: ['branch'], status: ['closed'], limit: 1 }, 'ai', { resource })).body.result.assets[0]
    expect(branch.id).toEqual(expect.any(String))
    expect((await invoke('world.electric-grid.derate-branch', { gridId: 'grid:halden-four-unit', assetId: branch.id, availability: 0.5 }, 'human', { resource })).body.result.ok).toBe(true)
    // Plant control writes enter its validated write queue and take effect in
    // the next physics step. Read that actual result before testing restore.
    await run.setClock({ paused: false })
    const deadline = performance.now() + 5_000
    let plantValue: unknown
    do {
      plantValue = (await invoke('world.process-plant.signals.read', { plantId: 'plant:halden-1', signals: [{ tagId: 'MOV-8000A' }] }, 'ai', { resource })).body.result.signals[0].variable.value
      if (plantValue === 0) break
      await Bun.sleep(20)
    } while (performance.now() < deadline)
    await run.setClock({ paused: true })
    expect(plantValue).toBe(0)
    const current = await registry.currentScenario(source.id)
    const edited = structuredClone(source), drones = edited.packs.find(pack => pack.id === 'drone')!
    drones.config = { ...dronePackConfigSchema.parse(drones.config), stepIntervalMs: 30 }
    await registry.updateScenario(edited, current!.id)
    expect((await registry.scenarioRevisionForRun(run.id))!.id).toBe(revision.id)
    expect((await registry.compiledScenarioForRun(run.id)).packConfigs.drone).toMatchObject({ stepIntervalMs: 25 })
    expect((await invoke('world.physical-layout.design.describe', { design: source.packs.find(pack => pack.id === 'physical-layout')!.items[0]!.design }, 'ai')).body.result.liveDesignReplacement).toBe(false)
    expect((await invoke('world.process-plant.models.describe', {}, 'ai')).body.result.liveModelReplacement).toBe(false)
    // Restore retains the persisted JSON value. IEEE signed zero in runtime
    // telemetry is encoded as 0 on that boundary, so compare the complete JSON
    // objects rather than requiring a non-persistable -0 distinction.
    const frozen = JSON.stringify(run.snapshot().objects)
    await registry.close(run.id)
    const restored = await registry.load(run.id)
    expect(JSON.parse(JSON.stringify(restored.snapshot().objects))).toEqual(JSON.parse(frozen))
    expect((await invoke('world.situation-monitor.status', {}, 'ai', { resource })).body.result.config.sources).toEqual([])
    expect((await invoke('world.ambulance.object', { objectId: 'example:ambulance' }, 'ai', { resource })).body.result.object.packData.crewReady).toBe(false)
    expect((await invoke('world.simulation-run.read-object', { objectId: 'example:weather' }, 'ai', { resource })).body.result.packData.definition.enabled).toBe(false)
    expect((await invoke('world.electric-grid.asset.get', { gridId: 'grid:halden-four-unit', assetId: branch.id }, 'ai', { resource })).body.result.asset.state.availability).toBe(0.5)
    expect((await invoke('world.simulation-run.read-object', { objectId: 'example:drone' }, 'ai', { resource })).body.result.packData.payload).toMatchObject({ gimbalPitchDeg: -20, gimbalYawDeg: 15 })
    expect((await invoke('world.simulation-run.read-object', { objectId: 'unit:truck-3' }, 'ai', { resource })).body.result.packData.paused).toBe(true)
    expect((await invoke('world.process-plant.signals.read', { plantId: 'plant:halden-1', signals: [{ tagId: 'MOV-8000A' }] }, 'ai', { resource })).body.result.signals[0].variable.value).toBe(0)
  } finally { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
})
