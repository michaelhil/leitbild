import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { moduleBindingSchema, newWorkspaceId, type WorkspaceId } from '@samsinn-leitbild/platform-contracts'
import { handleWorkspaceApi } from '../src/core/api/workspace-routes.ts'
import { createLocalWorkspaceDirectory } from '../src/core/workspaces/directory.ts'
import {
  createLeitbildWorkspaceRuntimeRegistry,
  type LeitbildWorkspaceRuntimeRegistry,
} from '../src/core/workspaces/runtime-registry.ts'
import { createServer } from '../src/core/api/server.ts'
import { createTestPackRuntimeAdapters, createTestScenarioCatalog } from './helpers.ts'

const registries: LeitbildWorkspaceRuntimeRegistry[] = []

const createRegistry = async (): Promise<LeitbildWorkspaceRuntimeRegistry> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-workspace-api-'))
  const registry = createLeitbildWorkspaceRuntimeRegistry({
    dataDir,
    workspaceDirectory: createLocalWorkspaceDirectory({
      path: join(dataDir, 'workspace-directory.json'),
      defaultDisplayName: 'Default Workspace',
    }),
    scenarioCatalog: createTestScenarioCatalog(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
  })
  registries.push(registry)
  return registry
}

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.shutdown()
})

const callWorkspaceRoute = async <T>(
  registry: LeitbildWorkspaceRuntimeRegistry,
  path: string,
  init?: RequestInit,
): Promise<{ readonly status: number; readonly body: T }> => {
  const request = new Request(`http://leitbild.test${path}`, init)
  const response = await handleWorkspaceApi(request, new URL(request.url), registry)
  if (!response) throw new Error(`Workspace route did not handle ${init?.method ?? 'GET'} ${path}`)
  return { status: response.status, body: await response.json() as T }
}

describe('Workspace API', () => {
  test('lists the standalone default and provisions generated Workspaces', async () => {
    const registry = await createRegistry()
    const initial = await callWorkspaceRoute<{
      readonly defaultWorkspaceId: WorkspaceId
      readonly workspaces: ReadonlyArray<{ readonly id: WorkspaceId; readonly displayName: string }>
    }>(registry, '/api/workspaces')
    expect(initial.status).toBe(200)
    expect(initial.body.workspaces).toEqual([
      expect.objectContaining({ id: initial.body.defaultWorkspaceId, displayName: 'Default Workspace' }),
    ])

    const created = await callWorkspaceRoute<{
      readonly workspace: { readonly id: WorkspaceId; readonly displayName: string }
    }>(registry, '/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Exercise Alpha' }),
    })
    expect(created.status).toBe(201)
    expect(created.body.workspace.displayName).toBe('Exercise Alpha')
    expect(created.body.workspace.id).not.toBe(initial.body.defaultWorkspaceId)
  })

  test('supports idempotent suite provisioning with a canonical supplied id', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    const provision = (): Promise<{ readonly status: number; readonly body: { readonly workspace: { readonly id: WorkspaceId } } }> =>
      callWorkspaceRoute(registry, `/api/workspaces/${workspaceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Combined Workspace' }),
      })
    const first = await provision()
    const second = await provision()
    expect(first.status).toBe(201)
    expect(first.body.workspace.id).toBe(workspaceId)
    expect(second.status).toBe(200)
    expect(second.body.workspace.id).toBe(workspaceId)

    const conflict = await callWorkspaceRoute<{ readonly error: { readonly code: string } }>(
      registry,
      `/api/workspaces/${workspaceId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Different Name' }),
      },
    )
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe('workspace_conflict')
  })

  test('stores suite-owned Module Bindings on the Workspace', async () => {
    const registry = await createRegistry()
    const workspaceId = newWorkspaceId()
    const modules = [moduleBindingSchema.parse({
      moduleId: 'samsinn',
      baseUrl: 'https://samsinn.test',
      discoveryUrl: 'https://samsinn.test/.well-known/samsinn',
    })]
    const response = await callWorkspaceRoute<{
      readonly workspace: { readonly modules: typeof modules }
    }>(registry, `/api/workspaces/${workspaceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Bound Workspace', modules }),
    })
    expect(response.status).toBe(201)
    expect(response.body.workspace.modules).toEqual(modules)
  })

  test('rejects malformed ids and unknown Workspace resources visibly', async () => {
    const registry = await createRegistry()
    const invalid = await callWorkspaceRoute<{ readonly error: { readonly code: string } }>(
      registry,
      '/api/workspaces/not-a-uuid',
    )
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('invalid_request')

    const missing = await callWorkspaceRoute<{ readonly error: { readonly code: string } }>(
      registry,
      `/api/workspaces/${newWorkspaceId()}`,
    )
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('workspace_not_found')
  })
})

describe('Workspace-scoped server API', () => {
  test('isolates Run collections and removes the unscoped API', async () => {
    const registry = await createRegistry()
    const first = await registry.provision({ displayName: 'First' })
    const second = await registry.provision({ displayName: 'Second' })
    const uiDistPath = await mkdtemp(join(tmpdir(), 'leitbild-empty-ui-'))
    const server = createServer({ workspaces: registry, bindHost: '127.0.0.1', port: 0, uiDistPath })
    const base = `http://127.0.0.1:${server.port}`
    try {
      const createRun = async (workspaceId: WorkspaceId): Promise<SimulationRunResponse> => {
        const response = await fetch(`${base}/api/workspaces/${workspaceId}/simulation-runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        expect(response.status).toBe(201)
        return await response.json() as SimulationRunResponse
      }
      interface SimulationRunResponse { readonly id: string }
      const firstRun = await createRun(first.workspace.id)
      const secondRun = await createRun(second.workspace.id)

      const firstList = await fetch(`${base}/api/workspaces/${first.workspace.id}/simulation-runs`)
        .then(response => response.json()) as { readonly simulationRuns: ReadonlyArray<{ readonly id: string }> }
      const secondList = await fetch(`${base}/api/workspaces/${second.workspace.id}/simulation-runs`)
        .then(response => response.json()) as { readonly simulationRuns: ReadonlyArray<{ readonly id: string }> }
      expect(firstList.simulationRuns.map(run => run.id)).toEqual([firstRun.id])
      expect(secondList.simulationRuns.map(run => run.id)).toEqual([secondRun.id])

      const crossWorkspace = await fetch(
        `${base}/api/workspaces/${second.workspace.id}/simulation-runs/${firstRun.id}`,
      )
      expect(crossWorkspace.status).toBe(404)
      expect((await fetch(`${base}/api/simulation-runs`)).status).toBe(404)

      const capabilities = await fetch(`${base}/api/workspaces/${first.workspace.id}/capabilities`)
      expect(capabilities.status).toBe(200)
      expect((await capabilities.json() as { capabilities: unknown[] }).capabilities).toEqual([])
    } finally {
      server.stop()
    }
  })
})
