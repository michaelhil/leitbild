import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { experienceDescriptorSchema, moduleRegistrationSchema, workspaceIdSchema } from '@samsinn-leitbild/platform-contracts'
import { createServer as createMicroworldServer } from '../../../apps/leitbild/src/core/api/server.ts'
import { createMicroworldModuleState } from '../../../apps/leitbild/src/core/workspaces/module-state.ts'
import { microworldWorkspacePaths } from '../../../apps/leitbild/src/core/workspaces/paths.ts'
import { createMicroworldWorkspaceRuntimeRegistry } from '../../../apps/leitbild/src/core/workspaces/runtime-registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioCatalog } from '../../../apps/leitbild/tests/helpers.ts'
import { handleSamsinnModuleApi } from '../../../apps/samsinn/src/api/workspace-module-api.ts'
import { asAIAgent } from '../../../apps/samsinn/src/agents/shared.ts'
import { createDeploymentRuntime } from '../../../apps/samsinn/src/core/deployment-runtime.ts'
import { createSamsinnModuleState } from '../../../apps/samsinn/src/core/workspaces/module-state.ts'
import {
  createWorkspaceRuntimeRegistry as createSamsinnWorkspaceRuntimeRegistry,
  type WorkspaceRuntimeRegistry as SamsinnWorkspaceRuntimeRegistry,
} from '../../../apps/samsinn/src/core/workspaces/runtime-registry.ts'
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

    const registry = createMicroworldWorkspaceRuntimeRegistry({
      dataDir,
      moduleState: createMicroworldModuleState({ dataDir }),
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
        entryModuleId: 'microworld',
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
    expect((await registry.list()).map(item => String(item.workspaceId))).toEqual([workspace.id])

    const entry = await fetch(`${baseUrl}/workspaces/${workspace.id}/experiences/leitbild`, { redirect: 'manual' })
    expect(entry.status).toBe(303)
    expect(entry.headers.get('location')).toBe(`http://127.0.0.1:${microworldServer.port}/workspaces/${workspace.id}`)

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
    const modulePaths = microworldWorkspacePaths(dataDir, workspaceIdSchema.parse(workspace.id))
    expect(Bun.file(join(modulePaths.simulationRuns, runId, 'manifest.json')).exists()).resolves.toBe(false)
  })

  test('composes real Microworld, Collaboration, and Agents Modules without stored Resource bindings', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'workspace-combined-microworld-'))
    const uiDir = await mkdtemp(join(tmpdir(), 'workspace-combined-ui-'))
    const samsinnHome = await mkdtemp(join(tmpdir(), 'workspace-combined-samsinn-'))
    const originalSamsinnHome = process.env.SAMSINN_HOME
    const originalProvider = process.env.PROVIDER
    const originalSeed = process.env.SAMSINN_SEED_WORKSPACE
    process.env.SAMSINN_HOME = samsinnHome
    process.env.PROVIDER = 'ollama'
    process.env.SAMSINN_SEED_WORKSPACE = '0'

    let samsinnRegistry: SamsinnWorkspaceRuntimeRegistry | undefined
    cleanup.push(async () => {
      await samsinnRegistry?.shutdown()
      if (originalSamsinnHome === undefined) delete process.env.SAMSINN_HOME
      else process.env.SAMSINN_HOME = originalSamsinnHome
      if (originalProvider === undefined) delete process.env.PROVIDER
      else process.env.PROVIDER = originalProvider
      if (originalSeed === undefined) delete process.env.SAMSINN_SEED_WORKSPACE
      else process.env.SAMSINN_SEED_WORKSPACE = originalSeed
      await rm(samsinnHome, { recursive: true, force: true })
    })
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }))
    cleanup.push(() => rm(uiDir, { recursive: true, force: true }))

    const microworldRegistry = createMicroworldWorkspaceRuntimeRegistry({
      dataDir,
      moduleState: createMicroworldModuleState({ dataDir }),
      scenarioCatalog: createTestScenarioCatalog(),
      runtimeAdapters: createTestPackRuntimeAdapters(),
    })
    const microworldServer = createMicroworldServer({
      workspaces: microworldRegistry,
      bindHost: '127.0.0.1',
      port: 0,
      uiDistPath: uiDir,
      mapArtifacts: { rootDir: join(dataDir, 'maps') },
    })
    cleanup.push(() => microworldServer.stop())

    const samsinnState = createSamsinnModuleState()
    const samsinnServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (!samsinnRegistry) return Response.json({ error: { code: 'runtime_unavailable' } }, { status: 503 })
        const url = new URL(request.url)
        return await handleSamsinnModuleApi(request, url, { state: samsinnState, registry: samsinnRegistry })
          ?? new Response('Not found', { status: 404 })
      },
    })
    cleanup.push(() => samsinnServer.stop(true))

    const store = createWorkspaceStore(':memory:')
    cleanup.push(() => store.close())
    const host = createWorkspaceHost({
      store,
      modules: createModuleGateway({
        registrations: [
          moduleRegistrationSchema.parse({
            moduleId: 'microworld',
            baseUrl: `http://127.0.0.1:${microworldServer.port}`,
            manifestPath: '/.well-known/workspace-module',
          }),
          moduleRegistrationSchema.parse({
            moduleId: 'collaboration',
            baseUrl: `http://127.0.0.1:${samsinnServer.port}`,
            manifestPath: '/.well-known/workspace-module/collaboration',
          }),
          moduleRegistrationSchema.parse({
            moduleId: 'agents',
            baseUrl: `http://127.0.0.1:${samsinnServer.port}`,
            manifestPath: '/.well-known/workspace-module/agents',
          }),
        ],
      }),
      experiences: [
        experienceDescriptorSchema.parse({
          id: 'leitbild',
          title: 'Leitbild',
          requiredModules: ['microworld'],
          entryModuleId: 'microworld',
        }),
        experienceDescriptorSchema.parse({
          id: 'samsinn',
          title: 'Samsinn',
          requiredModules: ['collaboration', 'agents'],
          entryModuleId: 'collaboration',
        }),
      ],
    })
    const hostServer = createWorkspaceHostServer({ host, bindHost: '127.0.0.1', port: 0 })
    cleanup.push(() => hostServer.stop(true))
    const baseUrl = `http://127.0.0.1:${hostServer.port}`

    samsinnRegistry = createSamsinnWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime(),
      moduleState: samsinnState,
      workspaceHostUrl: baseUrl,
      idleMs: 1_000_000,
    })

    const createdResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Combined Lab', experienceIds: ['leitbild', 'samsinn'] }),
    })
    expect(createdResponse.status).toBe(201)
    const workspace = (await createdResponse.json() as {
      workspace: { id: string; modules: Array<{ moduleId: string; status: string }> }
    }).workspace
    expect(workspace.modules.map(module => [module.moduleId, module.status])).toEqual([
      ['agents', 'ready'],
      ['collaboration', 'ready'],
      ['microworld', 'ready'],
    ])

    const createRunResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/capabilities/microworld.simulation-run.create/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      },
    )
    expect(createRunResponse.status).toBe(200)
    const runId = (await createRunResponse.json() as { result: { id: string } }).result.id

    const createAgentResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/capabilities/agents.agent.create/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: {
            name: 'Microworld Observer',
            model: 'test-model',
            persona: 'Inspect available Workspace Resources when asked.',
            toolGrants: [{ capabilityId: 'microworld.simulation-run.read' }],
          },
          actor: { kind: 'human', id: 'operator', displayName: 'Operator' },
        }),
      },
    )
    expect(createAgentResponse.status).toBe(200)
    const agentId = (await createAgentResponse.json() as { result: { id: string } }).result.id
    const runtime = await samsinnRegistry.getOrLoad(workspaceIdSchema.parse(workspace.id))
    const agent = runtime.team.getAgent(agentId)
    const aiAgent = agent ? asAIAgent(agent) : undefined
    expect(aiAgent).toBeDefined()
    expect(JSON.stringify(aiAgent?.getConfig() ?? {})).not.toContain(runId)

    const context = { callerId: agentId, callerName: 'Microworld Observer' }
    const discover = runtime.toolRegistry.get('workspace_resources')
    const invoke = runtime.toolRegistry.get('workspace_invoke')
    expect(discover).toBeDefined()
    expect(invoke).toBeDefined()
    const discovered = await discover!.execute(
      { capabilityId: 'microworld.simulation-run.read' },
      context,
    )
    expect(discovered.success).toBe(true)
    const currentRun = (discovered.data as {
      resources: Array<{ ref: { moduleId: string; type: string; id: string } }>
    }).resources[0]!
    expect(currentRun.ref.id).toBe(runId)

    const read = await invoke!.execute({
      capabilityId: 'microworld.simulation-run.read',
      resource: currentRun.ref,
      input: {},
    }, context)
    expect(read.success).toBe(true)
    expect((read.data as { id: string }).id).toBe(runId)

    expect((await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await microworldRegistry.list()).toEqual([])
    expect(await samsinnState.enabled(workspaceIdSchema.parse(workspace.id))).toEqual(new Set())
  })
})
