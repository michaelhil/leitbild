import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  accessContextSchema,
  capabilityIdSchema,
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
import { createTestPackRuntimeAdapters, createTestScenarioCatalog } from './helpers.ts'

const registries: WorldWorkspaceRuntimeRegistry[] = []
const temporaryDirectories: string[] = []

const createRegistry = async (): Promise<WorldWorkspaceRuntimeRegistry> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-module-api-'))
  temporaryDirectories.push(dataDir)
  const registry = createWorldWorkspaceRuntimeRegistry({
    dataDir,
    moduleState: createWorldModuleState({ dataDir }),
    scenarioCatalog: createTestScenarioCatalog(),
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

  test('discovers Scenario Definitions, starts an exact revision, and exposes agent-safe Run context', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    await provision(registry, workspaceId)

    const capabilities = await call(registry, `/internal/workspaces/${workspaceId}/capabilities`)
    expect(moduleCapabilityCollectionSchema.safeParse(capabilities.body).success).toBe(true)
    expect((capabilities.body as { capabilities: Array<{ id: string }> }).capabilities.map(item => item.id)).toContain(
      'world.scenario.start',
    )
    const definitions = await call(registry, `/internal/workspaces/${workspaceId}/definitions`)
    const parsedDefinitions = moduleDefinitionCollectionSchema.parse(definitions.body)
    const scenario = parsedDefinitions.definitions[0]!

    const access = accessContextSchema.parse({
      workspaceId,
      requestId: newRequestId(),
      actor: { kind: 'ai', id: 'operator' },
    })
    const createCapabilityId = capabilityIdSchema.parse('world.scenario.start')
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

    const resources = await call(registry, `/internal/workspaces/${workspaceId}/resources`)
    expect(moduleResourceCollectionSchema.safeParse(resources.body).success).toBe(true)
    const run = (resources.body as { resources: Array<{ ref: { type: string; id: string } }> }).resources
      .find(resource => resource.ref.type === 'world.simulation-run')
    expect(run?.ref.id).toBe(created.body?.result.id)

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
  })
})
