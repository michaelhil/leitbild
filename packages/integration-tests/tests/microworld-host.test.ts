import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { experienceDescriptorSchema, moduleRegistrationSchema } from '@samsinn-leitbild/platform-contracts'
import { createServer as createMicroworldServer } from '../../../apps/leitbild/src/core/api/server.ts'
import { createLocalWorkspaceDirectory } from '../../../apps/leitbild/src/core/workspaces/directory.ts'
import { createLeitbildWorkspaceRuntimeRegistry } from '../../../apps/leitbild/src/core/workspaces/runtime-registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioCatalog } from '../../../apps/leitbild/tests/helpers.ts'
import { createWorkspaceHost } from '../../../apps/workspace-host/src/host.ts'
import { createModuleGateway } from '../../../apps/workspace-host/src/module-gateway.ts'
import { createWorkspaceHostServer } from '../../../apps/workspace-host/src/server.ts'
import { createWorkspaceStore } from '../../../apps/workspace-host/src/store.ts'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation()
})

describe('Workspace Host with the real Microworld Module', () => {
  test('provisions, discovers, invokes, and destructively removes Module-owned state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'workspace-microworld-integration-'))
    const uiDir = await mkdtemp(join(tmpdir(), 'workspace-microworld-ui-'))
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }))
    cleanup.push(() => rm(uiDir, { recursive: true, force: true }))

    const registry = createLeitbildWorkspaceRuntimeRegistry({
      dataDir,
      workspaceDirectory: createLocalWorkspaceDirectory({ path: join(dataDir, 'workspace-directory.json') }),
      scenarioCatalog: createTestScenarioCatalog(),
      runtimeAdapters: createTestPackRuntimeAdapters(),
    })
    const microworldServer = createMicroworldServer({
      workspaces: registry,
      bindHost: '127.0.0.1',
      port: 0,
      uiDistPath: uiDir,
      mapArtifacts: { rootDir: join(dataDir, 'maps') },
    })
    cleanup.push(() => microworldServer.stop())

    const store = createWorkspaceStore(':memory:')
    cleanup.push(() => store.close())
    const host = createWorkspaceHost({
      store,
      modules: createModuleGateway({
        registrations: [moduleRegistrationSchema.parse({
          moduleId: 'microworld',
          baseUrl: `http://127.0.0.1:${microworldServer.port}`,
          manifestPath: '/.well-known/workspace-module',
        })],
      }),
      experiences: [experienceDescriptorSchema.parse({
        id: 'leitbild',
        title: 'Leitbild',
        requiredModules: ['microworld'],
      })],
    })
    const hostServer = createWorkspaceHostServer({ host, bindHost: '127.0.0.1', port: 0 })
    cleanup.push(() => hostServer.stop(true))
    const baseUrl = `http://127.0.0.1:${hostServer.port}`

    const createdResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: null, experienceIds: ['leitbild'] }),
    })
    expect(createdResponse.status).toBe(201)
    const workspace = (await createdResponse.json() as {
      workspace: { id: string; modules: Array<{ status: string }> }
    }).workspace
    expect(workspace.modules).toEqual([expect.objectContaining({ status: 'ready' })])
    expect((await registry.list()).map(item => String(item.id))).toEqual([workspace.id])

    const capabilities = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/capabilities`)
      .then(response => response.json()) as { capabilities: Array<{ id: string }> }
    expect(capabilities.capabilities.map(item => item.id)).toContain('microworld.simulation-run.create')

    const createRun = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/capabilities/microworld.simulation-run.create/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      },
    )
    expect(createRun.status).toBe(200)
    const runId = (await createRun.json() as { result: { id: string } }).result.id

    const resources = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/resources`)
      .then(response => response.json()) as { resources: Array<{ ref: { type: string; id: string } }> }
    const run = resources.resources.find(resource => resource.ref.type === 'microworld.simulation-run')
    expect(run?.ref.id).toBe(runId)

    const readRun = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/capabilities/microworld.simulation-run.read/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resource: { workspaceId: workspace.id, moduleId: 'microworld', type: 'microworld.simulation-run', id: runId },
          input: {},
        }),
      },
    )
    expect((await readRun.json() as { result: { id: string } }).result.id).toBe(runId)

    expect((await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await registry.list()).toEqual([])
    expect(Bun.file(join(dataDir, 'workspaces', workspace.id, 'leitbild', 'simulation-runs', runId, 'manifest.json')).exists()).resolves.toBe(false)
  })
})
