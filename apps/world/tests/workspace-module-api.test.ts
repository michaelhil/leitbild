import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import {
  createWorldWorkspaceRuntimeRegistry,
  type WorldWorkspaceRuntimeRegistry,
} from '../src/core/workspaces/runtime-registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioCatalog, testScenarioAuthoring } from './helpers.ts'
import { scenarioTemplates } from '../src/scenarios/index.ts'

const registries: WorldWorkspaceRuntimeRegistry[] = []
const temporaryDirectories: string[] = []

const createRegistry = async (): Promise<WorldWorkspaceRuntimeRegistry> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-module-api-'))
  temporaryDirectories.push(dataDir)
  const registry = createWorldWorkspaceRuntimeRegistry({
    dataDir,
    moduleState: createWorldModuleState({ dataDir }),
    scenarioCatalog: createTestScenarioCatalog(),
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

  test('discovers Pack authoring and saves the editable Draft with its compiled revision', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)
    const access = accessContextSchema.parse({
      workspaceId,
      requestId: newRequestId(),
      actor: { kind: 'human', id: 'scenario-author' },
    })
    const describeId = capabilityIdSchema.parse('world.scenario-authoring.describe')
    const described = await call<{ result: { features: Array<{ id: string; itemTypes: unknown[] }> } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${describeId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: describeId, input: {}, access }),
      },
    )
    expect(described.body?.result.features.find(feature => feature.id === 'ambulance')?.itemTypes.length).toBeGreaterThan(0)
    expect(described.body?.result.features.find(feature => feature.id === 'process-plant')?.itemTypes.length).toBeGreaterThan(0)

    const source = scenarioTemplates.find(template => template.draft.id === 'oslo-ambulance')!.draft
    const draft = { ...source, id: 'custom-authoring-test', title: 'Custom authoring test' }
    const createId = capabilityIdSchema.parse('world.scenario.create')
    const created = await call<{ result: { definition: { id: string; revisionId: string } } }>(
      registry,
      `/internal/workspaces/${workspaceId}/capabilities/${createId}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: createId, input: { draft }, access }),
      },
    )
    expect(created.status).toBe(201)
    expect(created.body?.result.definition.id).toBe(draft.id)
    const revision = await registry.getLoaded(workspaceId)!.simulationRuns.currentScenario(draft.id)
    expect(revision?.draft.title).toBe(draft.title)
    expect(revision?.definition.initialObjects.length).toBeGreaterThan(0)
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
    const definitions = await call(registry, `/internal/workspaces/${workspaceId}/definitions`)
    const parsedDefinitions = moduleDefinitionCollectionSchema.parse(definitions.body)
    const scenario = parsedDefinitions.definitions[0]!
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
    expect(parsedScenarioInspection.sections.map(section => section.id)).toContain('authored-draft')
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
    expect(String(run?.inspectionCapabilityId)).toBe('world.simulation-run.inspect')

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
    expect(parsedRunInspection.sections.map(section => section.id)).toContain('available-operations')

    const contextCapabilityId = capabilityIdSchema.parse('world.simulation-run.context')
    const context = await call<{ result: { briefing: { title: string }; operationalObjects: unknown[]; affordances: unknown } }>(
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
    expect(context.body?.result.briefing.title).toBeTruthy()
    expect(Array.isArray(context.body?.result.operationalObjects)).toBe(true)
    expect(JSON.stringify(context.body)).not.toContain('timeline')

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
    ).resources.some(resource => resource.ref.id === run!.ref.id)).toBe(true)

    const deleteRunCapabilityId = capabilityIdSchema.parse('world.simulation-run.delete')
    const simulationRunId = registry.getLoaded(workspaceId)!.simulationRuns.list()[0]!.id
    const releaseViewer = registry.getLoaded(workspaceId)!.simulationRuns.acquireLease(simulationRunId, 'realtime')
    const blockedDelete = await call<{ error: { code: string } }>(
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
    expect(blockedDelete.status).toBe(409)
    expect(blockedDelete.body?.error.code).toBe('simulation_run_has_viewers')
    releaseViewer()
    expect((await call(registry, `/internal/workspaces/${workspaceId}/capabilities/${deleteRunCapabilityId}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        capabilityId: deleteRunCapabilityId,
        resource: run!.ref,
        input: {},
        access,
      }),
    })).status).toBe(200)
    expect(moduleResourceCollectionSchema.parse(
      (await call(registry, `/internal/workspaces/${workspaceId}/resources`)).body,
    ).resources.some(resource => resource.ref.id === run!.ref.id)).toBe(false)
  })
})
