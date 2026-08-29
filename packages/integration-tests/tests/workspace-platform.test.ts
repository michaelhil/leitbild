import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { moduleRegistrationSchema, workspaceIdSchema } from '@leitbild/contracts'
import { createServer as createWorldServer } from '../../../apps/world/src/core/api/server.ts'
import { createWorldModuleState } from '../../../apps/world/src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../../../apps/world/src/core/workspaces/runtime-registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioCatalog } from '../../../apps/world/tests/helpers.ts'
import { handleCollabAgentsModuleApi } from '../../../apps/collab-agents/src/api/workspace-module-api.ts'
import { asAIAgent } from '../../../apps/collab-agents/src/agents/shared.ts'
import { createDeploymentRuntime } from '../../../apps/collab-agents/src/core/deployment-runtime.ts'
import { createCollabAgentsModuleState } from '../../../apps/collab-agents/src/core/workspaces/module-state.ts'
import {
  createWorkspaceRuntimeRegistry as createCollabAgentsWorkspaceRuntimeRegistry,
  type WorkspaceRuntimeRegistry as CollabAgentsWorkspaceRuntimeRegistry,
} from '../../../apps/collab-agents/src/core/workspaces/runtime-registry.ts'
import { createWorkspaceHost } from '../../../apps/leitbild/src/host.ts'
import { createModuleGateway } from '../../../apps/leitbild/src/module-gateway.ts'
import { createWorkspaceHostServer } from '../../../apps/leitbild/src/server.ts'
import { createWorkspaceStore } from '../../../apps/leitbild/src/store.ts'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation()
})

describe('Workspace Host with the real World Module', () => {
  test('provisions real World, Collab, and Agents Modules without stored Resource bindings', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'workspace-combined-world-'))
    const uiDir = await mkdtemp(join(tmpdir(), 'workspace-combined-ui-'))
    const leitbildHome = await mkdtemp(join(tmpdir(), 'workspace-combined-leitbild-'))
    const originalLeitbildHome = process.env.LEITBILD_HOME
    const originalProvider = process.env.PROVIDER
    const originalSeed = process.env.LEITBILD_SEED_WORKSPACE
    process.env.LEITBILD_HOME = leitbildHome
    process.env.PROVIDER = 'ollama'
    process.env.LEITBILD_SEED_WORKSPACE = '0'

    let leitbildRegistry: CollabAgentsWorkspaceRuntimeRegistry | undefined
    cleanup.push(async () => {
      await leitbildRegistry?.shutdown()
      if (originalLeitbildHome === undefined) delete process.env.LEITBILD_HOME
      else process.env.LEITBILD_HOME = originalLeitbildHome
      if (originalProvider === undefined) delete process.env.PROVIDER
      else process.env.PROVIDER = originalProvider
      if (originalSeed === undefined) delete process.env.LEITBILD_SEED_WORKSPACE
      else process.env.LEITBILD_SEED_WORKSPACE = originalSeed
      await rm(leitbildHome, { recursive: true, force: true })
    })
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }))
    cleanup.push(() => rm(uiDir, { recursive: true, force: true }))

    const worldRegistry = createWorldWorkspaceRuntimeRegistry({
      dataDir,
      moduleState: createWorldModuleState({ dataDir }),
      scenarioCatalog: createTestScenarioCatalog(),
      runtimeAdapters: createTestPackRuntimeAdapters(),
    })
    const worldServer = createWorldServer({
      workspaces: worldRegistry,
      bindHost: '127.0.0.1',
      port: 0,
      uiDistPath: uiDir,
      mapArtifacts: { rootDir: join(dataDir, 'maps') },
    })
    cleanup.push(() => worldServer.stop())

    const leitbildState = createCollabAgentsModuleState()
    const leitbildServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (!leitbildRegistry) return Response.json({ error: { code: 'runtime_unavailable' } }, { status: 503 })
        const url = new URL(request.url)
        return await handleCollabAgentsModuleApi(request, url, { state: leitbildState, registry: leitbildRegistry })
          ?? new Response('Not found', { status: 404 })
      },
    })
    cleanup.push(() => leitbildServer.stop(true))

    const store = createWorkspaceStore(':memory:')
    cleanup.push(() => store.close())
    const host = createWorkspaceHost({
      store,
      modules: createModuleGateway({
        registrations: [
          moduleRegistrationSchema.parse({
            moduleId: 'world',
            internalBaseUrl: `http://127.0.0.1:${worldServer.port}`,
            manifestPath: '/.well-known/workspace-module',
          }),
          moduleRegistrationSchema.parse({
            moduleId: 'collab',
            internalBaseUrl: `http://127.0.0.1:${leitbildServer.port}`,
            manifestPath: '/.well-known/workspace-module/collab',
          }),
          moduleRegistrationSchema.parse({
            moduleId: 'agents',
            internalBaseUrl: `http://127.0.0.1:${leitbildServer.port}`,
            manifestPath: '/.well-known/workspace-module/agents',
          }),
        ],
      }),
    })
    const hostServer = createWorkspaceHostServer({ host, bindHost: '127.0.0.1', port: 0 })
    cleanup.push(() => hostServer.stop(true))
    const baseUrl = `http://127.0.0.1:${hostServer.port}`

    leitbildRegistry = createCollabAgentsWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime(),
      moduleState: leitbildState,
      workspaceHostUrl: baseUrl,
      idleMs: 1_000_000,
    })

    const createdResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Combined Lab' }),
    })
    expect(createdResponse.status).toBe(201)
    const workspace = (await createdResponse.json() as {
      workspace: { id: string; modules: Array<{ moduleId: string; status: string }> }
    }).workspace
    expect(workspace.modules.map(module => [module.moduleId, module.status])).toEqual([
      ['agents', 'ready'],
      ['collab', 'ready'],
      ['world', 'ready'],
    ])

    const createRunResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/capabilities/world.simulation-run.create/invoke`,
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
            name: 'World Observer',
            model: 'test-model',
            persona: 'Inspect available Workspace Resources when asked.',
            toolGrants: [{ capabilityId: 'world.simulation-run.read' }],
          },
          actor: { kind: 'human', id: 'operator', displayName: 'Operator' },
        }),
      },
    )
    expect(createAgentResponse.status).toBe(200)
    const agentId = (await createAgentResponse.json() as { result: { id: string } }).result.id
    const runtime = await leitbildRegistry.getOrLoad(workspaceIdSchema.parse(workspace.id))
    const agent = runtime.team.getAgent(agentId)
    const aiAgent = agent ? asAIAgent(agent) : undefined
    expect(aiAgent).toBeDefined()
    expect(JSON.stringify(aiAgent?.getConfig() ?? {})).not.toContain(runId)

    const context = { callerId: agentId, callerName: 'World Observer' }
    const discover = runtime.toolRegistry.get('workspace_resources')
    const invoke = runtime.toolRegistry.get('workspace_invoke')
    expect(discover).toBeDefined()
    expect(invoke).toBeDefined()
    const discovered = await discover!.execute(
      { capabilityId: 'world.simulation-run.read' },
      context,
    )
    expect(discovered.success).toBe(true)
    const currentRun = (discovered.data as {
      resources: Array<{ ref: { moduleId: string; type: string; id: string } }>
    }).resources[0]!
    expect(currentRun.ref.id).toBe(runId)

    const read = await invoke!.execute({
      capabilityId: 'world.simulation-run.read',
      resource: currentRun.ref,
      input: {},
    }, context)
    expect(read.success).toBe(true)
    expect((read.data as { id: string }).id).toBe(runId)

    expect((await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await worldRegistry.list()).toEqual([])
    expect(await leitbildState.enabled(workspaceIdSchema.parse(workspace.id))).toEqual(new Set())
  })
})
