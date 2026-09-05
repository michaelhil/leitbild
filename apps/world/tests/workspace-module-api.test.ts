import {
  accessContextSchema,
  capabilityIdSchema,
  inspectionViewSchema,
  moduleCapabilityCollectionSchema,
  moduleDefinitionCollectionSchema,
  moduleResourceCollectionSchema,
  newRequestId,
  newWorkspaceId,
  workspaceModuleManifestSchema,
  type WorkspaceId,
} from '@leitbild/contracts'
import { afterEach,describe,expect,test } from 'bun:test'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import {
  createWorldWorkspaceRuntimeRegistry,
  type WorldWorkspaceRuntimeRegistry,
} from '../src/core/workspaces/runtime-registry.ts'
import { testScenarioDefinitions } from './fixtures/scenarios.ts'
import { createTestPackRuntimeAdapters,createTestScenarioRuntimeResolver,testScenarioAuthoring } from './helpers.ts'

const registries: WorldWorkspaceRuntimeRegistry[] = []
const temporaryDirectories: string[] = []

const createRegistry = async (): Promise<WorldWorkspaceRuntimeRegistry> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-module-api-'))
  temporaryDirectories.push(dataDir)
  const registry = createWorldWorkspaceRuntimeRegistry({
    dataDir,
    moduleState: createWorldModuleState({ dataDir }),
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
    ...testScenarioAuthoring(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
  })
  registries.push(registry)
  return registry
}

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.shutdown()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const call = async <T>(
  registry: WorldWorkspaceRuntimeRegistry,
  path: string,
  init?: RequestInit,
): Promise<{ readonly status: number; readonly body: T | null }> => {
  const request = new Request(`http://world.test${path}`, init)
  const response = await handleWorldModuleApi(request, new URL(request.url), registry)
  if (!response) throw new Error(`Module route did not handle ${init?.method ?? 'GET'} ${path}`)
  return { status: response.status, body: response.status === 204 ? null : await response.json() as T }
}

const provision = async (registry: WorldWorkspaceRuntimeRegistry, workspaceId: WorkspaceId) =>
  await call(registry, `/internal/workspaces/${workspaceId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  })

describe('World Module API', () => {
  test('exposes independent playback and pace through one discoverable capability', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const runs = registry.getLoaded(workspaceId)!.simulationRuns
    const run = await runs.create({ scenarioId: 'test-response' })
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'human', id: 'operator' } })
    const resource = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }
    const invoke = async (capabilityId: string, input: unknown) => await call<{ result: {
      playback: 'playing' | 'paused'; pace: 'realtime' | 'maximum'; maximumPace: { available: boolean }
    } }>(registry, `/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, capabilityId, resource, input, access }),
    })

    expect((await invoke('world.simulation-run.execution.read', {})).body?.result)
      .toMatchObject({ playback: 'playing', pace: 'realtime', maximumPace: { available: true } })
    expect((await invoke('world.simulation-run.execution.set', { playback: 'paused' })).body?.result)
      .toMatchObject({ playback: 'paused', pace: 'realtime' })
    expect((await invoke('world.simulation-run.execution.set', { pace: 'maximum' })).body?.result)
      .toMatchObject({ playback: 'paused', pace: 'maximum' })
    expect((await invoke('world.simulation-run.execution.set', { playback: 'playing' })).body?.result)
      .toMatchObject({ playback: 'playing', pace: 'maximum' })
    expect((await invoke('world.simulation-run.execution.set', { playback: 'paused' })).body?.result)
      .toMatchObject({ playback: 'paused', pace: 'maximum' })
    expect((await invoke('world.simulation-run.execution.set', { pace: 'realtime' })).body?.result)
      .toMatchObject({ playback: 'paused', pace: 'realtime' })
  })

  test('lists execution summaries without loading idle Simulation Runs', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const runs = registry.getLoaded(workspaceId)!.simulationRuns
    const run = await runs.create({ scenarioId: 'test-response' })
    await runs.close(run.id)
    expect(runs.get(run.id)).toBeUndefined()

    const resources = moduleResourceCollectionSchema.parse(
      (await call(registry, `/internal/workspaces/${workspaceId}/resources`)).body,
    )

    expect(resources.resources.find(resource => resource.ref.type === 'world.simulation-run' && String(resource.ref.id) === String(run.id))?.summary)
      .toContainEqual(expect.objectContaining({ label: 'Status', value: 'Running' }))
    expect(runs.get(run.id)).toBeUndefined()
  })

  test('Agent history queries preserve simulation time and pagination through the capability boundary', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const runs = registry.getLoaded(workspaceId)!.simulationRuns
    const source = structuredClone(testScenarioDefinitions.find(item => item.id === 'halden-power-complex')!)
    await runs.createScenario({ ...source, id: 'history-api', world: { ...source.world, startsAt: '2026-01-01T00:00:00.000Z' } })
    const run = await runs.create({ scenarioId: 'history-api' })
    for (let attempt = 0; attempt < 30 && (run.recordingStatus()?.sampleCount ?? 0) < 100; attempt++) await Bun.sleep(100)
    expect(run.recordingStatus()!.sampleCount).toBeGreaterThan(0)
    await run.setClock({ paused: true })
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'ai', id: 'history-reader' } })
    const seriesCapabilityId = 'world.simulation-run.history-series.list'
    const seriesCatalog = await call<{ result: { series: Array<{ runtimeId: string; id: string }> } }>(registry,
      `/internal/workspaces/${workspaceId}/capabilities/${seriesCapabilityId}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: seriesCapabilityId, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }, input: {}, access }),
      })
    const selectedSeries = seriesCatalog.body!.result.series[0]!
    expect(selectedSeries).toBeDefined()
    const capabilityId = 'world.simulation-run.history-samples.read'
    const read = (input: unknown) => call<{ result: { samples: Array<{ sequence: number; runtimeId?: string; seriesId?: string }>; windowSummary: { sampleCount: number; firstSample: { sequence: number } | null }; nextBeforeSequence: number | null } }>(registry,
      `/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }, input, access }),
      })
    const series = { runtimeId: selectedSeries.runtimeId, seriesId: selectedSeries.id }
    const missing = await read({ runtimeId: selectedSeries.runtimeId, seriesId: 'series:not-real', limit: 1 })
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ error: {
      code: 'historian_series_not_found',
      details: { nextOperation: seriesCapabilityId },
    } })
    const first = await read({ ...series, timeAxis: 'simulation', to: '2026-01-02T00:00:00Z', limit: 2 })
    expect(first.body!.result.samples.length).toBeGreaterThan(0)
    expect(first.body!.result.windowSummary.sampleCount).toBeGreaterThan(0)
    expect(first.body!.result.windowSummary.firstSample).not.toBeNull()
    expect(first.body!.result.samples.every(sample => sample.runtimeId === undefined && sample.seriesId === undefined)).toBe(true)
    const cursor = first.body!.result.nextBeforeSequence
    if (cursor !== null) {
      const second = await read({ ...series, timeAxis: 'simulation', to: '2026-01-02T00:00:00Z', beforeSequence: cursor, limit: 2 })
      expect(second.body!.result.samples.every(sample => sample.sequence < cursor)).toBe(true)
    }
    const observed = await read({ ...series, timeAxis: 'observed', to: '2026-01-02T00:00:00Z', limit: 2 })
    expect(observed.body!.result.samples).toEqual([])
    expect(runs.leaseSummary(run.id).leasesByKind.api).toBe(0)
  })
  test('container admission is bounded without evicting active definition owners', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'world-container-cap-'))
    temporaryDirectories.push(dataDir)
    const moduleState = createWorldModuleState({ dataDir })
    const registry = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState, maxLoadedWorkspaces: 1,
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters() })
    registries.push(registry)
    const a = newWorkspaceId(), b = newWorkspaceId()
    await moduleState.provision(a); await moduleState.provision(b)
    const first = await registry.getOrLoad(a)
    const run = await first.simulationRuns.create({ scenarioId: 'test-response' })
    await expect(registry.getOrLoad(b)).rejects.toThrow('capacity')
    expect(registry.getLoaded(a)).toBe(first)
    await first.simulationRuns.close(run.id)
    expect((await registry.getOrLoad(b)).workspaceId).toBe(b)
    expect(registry.getLoaded(a)).toBeUndefined()
  })
  test('publishes the strict Module manifest', async () => {
    const registry = await createRegistry()
    const response = await call(registry, '/.well-known/workspace-module')
    expect(response.status).toBe(200)
    expect(workspaceModuleManifestSchema.safeParse(response.body).success).toBe(true)
  })

  test('provisions and removes one Host-owned Workspace idempotently', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    expect((await provision(registry, workspaceId)).status).toBe(201)
    expect((await provision(registry, workspaceId)).status).toBe(200)
    expect((await registry.list()).map(workspace => workspace.workspaceId)).toEqual([workspaceId])

    expect((await call(registry, `/internal/workspaces/${workspaceId}`, { method: 'DELETE' })).status).toBe(204)
    expect(await registry.list()).toEqual([])
  })

  test('discovers Pack authoring and saves an editable Scenario Definition', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const access = accessContextSchema.parse({
      workspaceId,
      requestId: newRequestId(),
      actor: { kind: 'human', id: 'scenario-author' },
    })
    const describeId = capabilityIdSchema.parse('world.scenario-authoring.describe')
    const described = await call<{ result: { detail: string; packs: Array<{ id: string; itemTypes: unknown[]; runtimes: unknown[]; configSchema?: unknown }>; commands: Array<{ packId: string }> } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${describeId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: describeId, input: {}, access }),
      },
    )
    expect(described.body?.result.packs.find(pack => pack.id === 'ambulance')?.itemTypes.length).toBeGreaterThan(0)
    expect(described.body?.result.packs.find(pack => pack.id === 'process-plant')?.itemTypes.length).toBeGreaterThan(0)
    expect(described.body?.result.packs.map(pack => pack.id).sort()).toEqual(['ambulance', 'drone', 'electric-grid', 'process-plant', 'weather'])
    expect(described.body?.result.detail).toBe('catalog')
    expect(described.body?.result.packs.find(pack => pack.id === 'process-plant')?.configSchema).toBeUndefined()

    const focused = await call<{ result: { packs: Array<{ id: string }>; commands: Array<{ packId: string }> } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${describeId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: describeId, input: { packIds: ['ambulance', 'weather'], detail: 'authoring' }, access }),
      },
    )
    expect(focused.status).toBe(200)
    expect(focused.body?.result.packs.map(pack => pack.id)).toEqual(['ambulance', 'weather'])
    expect(focused.body?.result.commands.every(command => ['ambulance', 'weather'].includes(command.packId))).toBe(true)
    expect((focused.body?.result.packs[0] as { configSchema?: unknown } | undefined)?.configSchema).toBeTruthy()

    const unknownPack = await call<{ error: { code: string } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${describeId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: describeId, input: { packIds: ['missing-pack'] }, access }),
      },
    )
    expect(unknownPack.status).toBe(400)
    expect(unknownPack.body?.error.code).toBe('scenario_authoring_pack_not_found')

    const previewSource = testScenarioDefinitions.find(source => source.id === 'halden-power-complex')!
    const previewId = capabilityIdSchema.parse('world.scenario.preview')
    const previewed = await call<{ result: { objectives: string[]; view: { center: [number, number]; zoom: number; layers: string[] }; assets: Array<{ id: string; electricalPorts: Array<{ role: string }> }>; connections: unknown[]; timeline: { cueCount: number; lastCueAtSeconds: number | null; cues: unknown[] } } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${previewId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: previewId, input: { source: previewSource }, access }),
      },
    )
    expect(previewed.status).toBe(200)
    expect(previewed.body?.result.assets.filter(asset => asset.electricalPorts.length > 0)).toHaveLength(5)
    const electricalRoles = previewed.body?.result.assets.flatMap(asset => asset.electricalPorts.map(port => port.role)) ?? []
    expect(electricalRoles.filter(role => role === 'system')).toHaveLength(4)
    expect(electricalRoles.filter(role => role === 'network')).toHaveLength(4)
    expect(previewed.body?.result.connections).toHaveLength(4)
    expect(previewed.body?.result.view.center).toHaveLength(2)
    expect(previewed.body?.result.timeline).toEqual({ cueCount: 0, lastCueAtSeconds: null, cues: [] })

    const source = testScenarioDefinitions.find(source => source.id === 'test-response')!
    const definition = { ...source, id: 'custom-authoring-test', title: 'Custom authoring test' }
    const createId = capabilityIdSchema.parse('world.scenario.create')
    const created = await call<{ result: { definition: { id: string; revisionId: string }; uiPath: string } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${createId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: createId, input: { source: definition }, access }),
      },
    )
    expect(created.status).toBe(201)
    expect(created.body?.result.definition.id).toBe(definition.id)
    expect(created.body?.result.uiPath).toContain(`definition=${definition.id}`)
    const runs = registry.getLoaded(workspaceId)!.simulationRuns
    const revision = await runs.currentScenario(definition.id)
    expect(revision?.document.title).toBe(definition.title)
    expect((await runs.compileScenarioRevision(revision!)).initialObjects.length).toBeGreaterThan(0)

    const updateId = capabilityIdSchema.parse('world.scenario.update')
    const updatedTitle = 'Updated authoring test'
    const updated = await call<{ result: { definition: { id: string; revisionId: string }; title: string } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${updateId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: updateId,
          definition: {
            workspaceId,
            moduleId: 'world',
            type: 'world.scenario',
            id: definition.id,
            revisionId: revision!.id,
          },
          input: { source: { ...definition, title: updatedTitle } },
          access,
        }),
      },
    )
    expect(updated.status).toBe(200)
    expect(updated.body?.result.title).toBe(updatedTitle)
    expect(updated.body?.result.definition.revisionId).not.toBe(revision!.id)
    const readId = capabilityIdSchema.parse('world.scenario.read')
    const read = await call<{ result: { source: { title: string }; definition: { revisionId: string } } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${readId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: readId,
          definition: {
            workspaceId,
            moduleId: 'world',
            type: 'world.scenario',
            id: definition.id,
            revisionId: updated.body!.result.definition.revisionId,
          },
          input: {},
          access,
        }),
      },
    )
    expect(read.status).toBe(200)
    expect(read.body?.result.source.title).toBe(updatedTitle)
    expect(read.body?.result.definition.revisionId).toBe(updated.body?.result.definition.revisionId)
    const updatedDescriptor = moduleDefinitionCollectionSchema.parse(
      (await call(registry, `/internal/workspaces/${workspaceId}/definitions`)).body,
    ).definitions.find(candidate => candidate.ref.id === definition.id)!
    expect(updatedDescriptor.title).toBe(updatedTitle)
    expect(updatedDescriptor.uiPath).toContain(`definition=${definition.id}`)
  })

  test('discovers Scenario Definitions, starts an exact revision, and exposes agent-safe Run context', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)

    const capabilities = await call(registry, `/internal/workspaces/${workspaceId}/capabilities`)
    expect(moduleCapabilityCollectionSchema.safeParse(capabilities.body).success).toBe(true)
    expect((capabilities.body as { capabilities: Array<{ id: string }> }).capabilities.map(item => item.id)).toContain(
      'world.scenario.start',
    )
    expect((capabilities.body as { capabilities: Array<{ id: string }> }).capabilities.map(item => item.id)).toContain(
      'world.simulation-run.delete',
    )
    expect((capabilities.body as { capabilities: Array<{ id: string }> }).capabilities.map(item => item.id)).toContain(
      'world.object.delete',
    )
    const definitions = await call(registry, `/internal/workspaces/${workspaceId}/definitions`)
    const parsedDefinitions = moduleDefinitionCollectionSchema.parse(definitions.body)
    const scenario = parsedDefinitions.definitions.find(definition => definition.ref.id === 'test-response')!
    expect(String(scenario.inspectionCapabilityId)).toBe('world.scenario.inspect')

    const access = accessContextSchema.parse({
      workspaceId,
      requestId: newRequestId(),
      actor: { kind: 'ai', id: 'operator' },
    })
    const createCapabilityId = capabilityIdSchema.parse('world.scenario.start')
    const inspectScenarioCapabilityId = capabilityIdSchema.parse('world.scenario.inspect')
    const scenarioInspection = await call<{ result: unknown }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${inspectScenarioCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: inspectScenarioCapabilityId,
          definition: { ...scenario.ref, revisionId: scenario.currentRevisionId },
          input: {},
          access,
        }),
      },
    )
    const parsedScenarioInspection = inspectionViewSchema.parse(scenarioInspection.body?.result)
    expect(parsedScenarioInspection.sections.map(section => section.id)).toContain('authored-definition')
    expect(parsedScenarioInspection.sections.map(section => section.id)).toContain('assets')
    expect(parsedScenarioInspection.sections.map(section => section.id)).toContain('timeline')

    const created = await call<{ result: { id: string }; createdResources: Array<{ id: string }> }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${createCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: createCapabilityId,
          definition: { ...scenario.ref, revisionId: scenario.currentRevisionId },
          input: {},
          access,
        }),
      },
    )
    expect(created.status).toBe(201)

    const resources = moduleResourceCollectionSchema.parse(
      (await call(registry, `/internal/workspaces/${workspaceId}/resources`)).body,
    )
    const run = resources.resources
      .find(resource => resource.ref.type === 'world.simulation-run')
    expect(String(run?.ref.id)).toBe(created.body!.result.id)
    expect(run?.title).toBe(scenario.title)
    expect(run?.summary.find(item => item.key === 'started-at')?.kind).toBe('timestamp')
    expect(run?.summary.find(item => item.key === 'viewer-count')).toMatchObject({ kind: 'count', value: 0 })
    expect(run?.summary.find(item => item.key === 'status')).toMatchObject({ kind: 'status', value: 'Running' })
    const family = resources.resources.find(resource => resource.ref.type === 'world.run-family' && resource.ref.id === run?.ref.id)
    expect(family?.links).toContainEqual(expect.objectContaining({ rel: 'contains', ref: run?.ref }))
    expect(run?.links).toContainEqual(expect.objectContaining({ rel: 'member-of', ref: family?.ref }))
    expect(String(run?.inspectionCapabilityId)).toBe('world.simulation-run.inspect')
    expect(String(run?.renameCapabilityId)).toBe('world.simulation-run.rename')
    const renameCapabilityId = capabilityIdSchema.parse('world.simulation-run.rename')
    const renameRequest = {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, capabilityId: renameCapabilityId, resource: run!.ref,
        input: { name: 'Training shift', expectedTitle: run!.title }, access }),
    }
    const renamed = await call<{ result: { title: string } }>(registry,
      `/internal/workspaces/${workspaceId}/capabilities/${renameCapabilityId}/invoke`, renameRequest)
    expect(renamed.status).toBe(200)
    expect(renamed.body?.result.title).toBe('Training shift')
    expect((await call(registry, `/internal/workspaces/${workspaceId}/capabilities/${renameCapabilityId}/invoke`, renameRequest)).status).toBe(409)

    const inspectRunCapabilityId = capabilityIdSchema.parse('world.simulation-run.inspect')
    const runInspection = await call<{ result: unknown }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${inspectRunCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: inspectRunCapabilityId,
          resource: run!.ref,
          input: {},
          access,
        }),
      },
    )
    const parsedRunInspection = inspectionViewSchema.parse(runInspection.body?.result)
    expect(parsedRunInspection.sections.map(section => section.id)).toContain('live-assets')
    expect(parsedRunInspection.sections.map(section => section.id)).not.toContain('available-capabilities')

    const contextCapabilityId = capabilityIdSchema.parse('world.simulation-run.context')
    const context = await call<{ result: { briefing: { title: string }; objects: { total: number; returned: number; selection: string; items: Array<{ id: string }> }; affordances: unknown } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${contextCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: contextCapabilityId,
          resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run!.ref.id },
          input: {},
          access,
        }),
      },
    )
    expect(context.body?.result.briefing.title).toBe('Training shift')
    expect(Array.isArray(context.body?.result.objects.items)).toBe(true)
    expect(context.body?.result.objects.selection).toBe('one-per-pack-kind')
    expect(context.body?.result.objects.total).toBeGreaterThanOrEqual(context.body?.result.objects.returned ?? 0)
    expect(JSON.stringify(context.body)).not.toContain('timeline')

    const searchObjectsCapabilityId = capabilityIdSchema.parse('world.simulation-run.objects.search')
    const searchedObjects = await call<{ result: { total: number; objects: Array<{ id: string; packId: string }> } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${searchObjectsCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: searchObjectsCapabilityId,
          resource: run!.ref,
          input: { packId: 'ambulance', limit: 2 },
          access,
        }),
      },
    )
    expect(searchedObjects.status).toBe(200)
    expect(searchedObjects.body?.result.objects.length).toBeLessThanOrEqual(2)
    expect(searchedObjects.body?.result.objects.every(object => object.packId === 'ambulance')).toBe(true)

    const packCapabilityId = capabilityIdSchema.parse('world.ambulance.dispatch-state')
    const publishedCapabilities = moduleCapabilityCollectionSchema.parse(capabilities.body)
    const contextDescriptor = publishedCapabilities.capabilities.find(capability => capability.id === contextCapabilityId)
    expect(contextDescriptor?.outputSchema).toMatchObject({
      type: 'object',
      properties: {
        subject: { type: 'object' },
        briefing: { type: 'object' },
        situation: { type: 'object' },
        objects: { type: 'object' },
        affordances: { type: 'object' },
      },
    })
    const packCapability = publishedCapabilities.capabilities.find(capability => capability.id === packCapabilityId)
    expect(packCapability).toMatchObject({ kind: 'query', scope: { kind: 'resource', resourceType: 'world.simulation-run' } })
    expect(packCapability?.outputSchema).toMatchObject({
      type: 'object',
      properties: {
        units: { type: 'array' },
        incidents: { type: 'array' },
        patients: { type: 'array' },
        careSites: { type: 'array' },
      },
    })
    const dispatchState = await call<{ result: { units: unknown[]; incidents: unknown[]; patients: unknown[]; careSites: unknown[] } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${packCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: packCapabilityId,
          resource: run!.ref,
          input: {},
          access,
        }),
      },
    )
    expect(dispatchState.status).toBe(200)
    expect(dispatchState.body?.result.units.length).toBeGreaterThan(0)

    const deleteObjectCapabilityId = capabilityIdSchema.parse('world.object.delete')
    const deletedObject = await call<{ result: { ok: boolean } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${deleteObjectCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: deleteObjectCapabilityId,
          resource: run!.ref,
          input: { objectId: context.body!.result.objects.items[0]!.id },
          access,
        }),
      },
    )
    expect(deletedObject.status).toBe(200)
    expect(deletedObject.body?.result.ok).toBe(true)

    const changesCapabilityId = capabilityIdSchema.parse('world.simulation-run.changes')
    const changes = await call<{ result: { currentSequence: number; events: unknown[]; hasMore: boolean } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${changesCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: changesCapabilityId,
          resource: run!.ref,
          input: { afterSequence: 0, limit: 2 },
          access,
        }),
      },
    )
    expect(changes.status).toBe(200)
    expect(changes.body?.result.events.length).toBeLessThanOrEqual(2)
    expect(changes.body?.result.currentSequence).toBeGreaterThanOrEqual(changes.body?.result.events.length ?? 0)

    const readCapabilityId = capabilityIdSchema.parse('world.simulation-run.read')
    const read = await call<{ result: { id: string } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${readCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: readCapabilityId,
          resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run!.ref.id },
          input: {},
          access,
        }),
      },
    )
    expect(read.body?.result.id).toBe(created.body?.result.id)

    const deleteCapabilityId = capabilityIdSchema.parse('world.scenario.delete')
    expect((await call(registry, `/internal/workspaces/${workspaceId}/capabilities/${deleteCapabilityId}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        capabilityId: deleteCapabilityId,
        definition: { ...scenario.ref, revisionId: scenario.currentRevisionId },
        input: {},
        access,
      }),
    })).status).toBe(200)
    expect(moduleDefinitionCollectionSchema.parse(
      (await call(registry, `/internal/workspaces/${workspaceId}/definitions`)).body,
    ).definitions.some(definition => definition.ref.id === scenario.ref.id)).toBe(false)
    expect(moduleResourceCollectionSchema.parse(
      (await call(registry, `/internal/workspaces/${workspaceId}/resources`)).body,
    ).resources.some(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === run!.ref.id)).toBe(true)

    const deleteRunCapabilityId = capabilityIdSchema.parse('world.simulation-run.delete')
    const simulationRunId = registry.getLoaded(workspaceId)!.simulationRuns.list()[0]!.id
    const releaseViewer = registry.getLoaded(workspaceId)!.simulationRuns.acquireLease(simulationRunId, 'realtime')
    const deleted = await call<{ result: { deleted: boolean } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${deleteRunCapabilityId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          capabilityId: deleteRunCapabilityId,
          resource: run!.ref,
          input: {},
          access,
        }),
      },
    )
    expect(deleted.status).toBe(200)
    expect(deleted.body?.result.deleted).toBe(true)
    releaseViewer()
    expect(moduleResourceCollectionSchema.parse(
      (await call(registry, `/internal/workspaces/${workspaceId}/resources`)).body,
    ).resources.some(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === run!.ref.id)).toBe(false)
  })
})
