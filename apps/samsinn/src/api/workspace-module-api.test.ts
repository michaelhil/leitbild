import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  moduleCapabilityCollectionSchema,
  moduleResourceCollectionSchema,
  newWorkspaceId,
  workspaceResourceReferenceSchema,
  workspaceModuleManifestSchema,
  type WorkspaceId,
} from '@samsinn-leitbild/platform-contracts'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createWorkspaceRuntimeRegistry, type WorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import { createSamsinnModuleState, type SamsinnModuleState } from '../core/workspaces/module-state.ts'
import {
  agentsModuleManifest,
  collaborationModuleManifest,
  handleSamsinnModuleApi,
} from './workspace-module-api.ts'

let home = ''
let originalHome: string | undefined
let originalProvider: string | undefined
let originalSeed: string | undefined
let state: SamsinnModuleState
let registry: WorkspaceRuntimeRegistry

beforeEach(async () => {
  originalHome = process.env.SAMSINN_HOME
  originalProvider = process.env.PROVIDER
  originalSeed = process.env.SAMSINN_SEED_WORKSPACE
  home = await mkdtemp(join(tmpdir(), 'samsinn-module-api-'))
  process.env.SAMSINN_HOME = home
  process.env.PROVIDER = 'ollama'
  process.env.SAMSINN_SEED_WORKSPACE = '0'
  state = createSamsinnModuleState()
  registry = createWorkspaceRuntimeRegistry({
    deployment: createDeploymentRuntime(),
    moduleState: state,
    idleMs: 1_000_000,
  })
})

afterEach(async () => {
  await registry.shutdown()
  if (originalHome === undefined) delete process.env.SAMSINN_HOME
  else process.env.SAMSINN_HOME = originalHome
  if (originalProvider === undefined) delete process.env.PROVIDER
  else process.env.PROVIDER = originalProvider
  if (originalSeed === undefined) delete process.env.SAMSINN_SEED_WORKSPACE
  else process.env.SAMSINN_SEED_WORKSPACE = originalSeed
  await rm(home, { recursive: true, force: true })
})

const request = async (method: string, path: string, body?: unknown): Promise<Response> => {
  const url = new URL(path, 'http://samsinn.test')
  const response = await handleSamsinnModuleApi(new Request(url.href, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }), url, { state, registry })
  if (!response) throw new Error(`Module API did not handle ${method} ${path}`)
  return response
}

const invokeBody = (workspaceId: WorkspaceId, capabilityId: string, input: unknown, resource?: {
  readonly moduleId: 'collaboration' | 'agents'
  readonly type: string
  readonly id: string
}) => ({
  workspaceId,
  capabilityId,
  ...(resource === undefined ? {} : {
    resource: workspaceResourceReferenceSchema.parse({ workspaceId, ...resource }),
  }),
  input,
  access: {
    workspaceId,
    requestId: crypto.randomUUID(),
    actor: { kind: 'ai' as const, id: 'agent:operator', displayName: 'Operator' },
    client: { id: 'workspace-host', kind: 'service' as const },
  },
})

describe('Samsinn Workspace Module API', () => {
  test('publishes two strict manifests with independent lifecycle endpoints', async () => {
    expect(workspaceModuleManifestSchema.parse(await (await request('GET', '/.well-known/workspace-module/collaboration')).json())).toEqual(collaborationModuleManifest)
    expect(workspaceModuleManifestSchema.parse(await (await request('GET', '/.well-known/workspace-module/agents')).json())).toEqual(agentsModuleManifest)
    expect(collaborationModuleManifest.endpoints.workspace).not.toBe(agentsModuleManifest.endpoints.workspace)
  })

  test('provisions, discovers, and invokes each Module without cross-owned identifiers', async () => {
    const workspaceId = newWorkspaceId()
    expect((await request('PUT', `/internal/collaboration/workspaces/${workspaceId}`, { workspaceId })).status).toBe(201)
    expect((await request('PUT', `/internal/agents/workspaces/${workspaceId}`, { workspaceId })).status).toBe(201)

    const collaborationCapabilities = moduleCapabilityCollectionSchema.parse(
      await (await request('GET', `/internal/collaboration/workspaces/${workspaceId}/capabilities`)).json(),
    )
    const agentsCapabilities = moduleCapabilityCollectionSchema.parse(
      await (await request('GET', `/internal/agents/workspaces/${workspaceId}/capabilities`)).json(),
    )
    expect(collaborationCapabilities.capabilities.every(capability => capability.id.startsWith('collaboration.'))).toBe(true)
    expect(agentsCapabilities.capabilities.every(capability => capability.id.startsWith('agents.'))).toBe(true)

    expect((await request('POST', `/internal/collaboration/workspaces/${workspaceId}/capabilities/collaboration.room.create/invoke`,
      invokeBody(workspaceId, 'collaboration.room.create', { name: 'Operations' }))).status).toBe(201)
    const createAgent = await request('POST', `/internal/agents/workspaces/${workspaceId}/capabilities/agents.agent.create/invoke`,
      invokeBody(workspaceId, 'agents.agent.create', {
        name: 'Analyst',
        model: 'test-model',
        persona: 'Analyse.',
        toolGrants: [{ capabilityId: 'microworld.simulation-run.read' }],
      }))
    expect(createAgent.status).toBe(201)
    const agentId = (await createAgent.json() as { result: { id: string } }).result.id

    const rooms = moduleResourceCollectionSchema.parse(
      await (await request('GET', `/internal/collaboration/workspaces/${workspaceId}/resources`)).json(),
    )
    const agents = moduleResourceCollectionSchema.parse(
      await (await request('GET', `/internal/agents/workspaces/${workspaceId}/resources`)).json(),
    )
    expect(rooms.resources.map(resource => resource.title)).toEqual(['Operations'])
    expect(agents.resources.map(resource => resource.title)).toEqual(['Analyst'])
    expect(String(rooms.resources[0]?.ref.type)).toBe('collaboration.room')
    expect(String(agents.resources[0]?.ref.type)).toBe('agents.agent')

    const agentProfile = await request(
      'POST',
      `/internal/agents/workspaces/${workspaceId}/capabilities/agents.agent.read/invoke`,
      invokeBody(workspaceId, 'agents.agent.read', {}, {
        moduleId: 'agents',
        type: 'agents.agent',
        id: agentId,
      }),
    )
    expect((await agentProfile.json() as {
      result: { config: { toolGrants: Array<{ capabilityId: string }> } }
    }).result.config.toolGrants).toEqual([{ capabilityId: 'microworld.simulation-run.read' }])
  })

  test('removing Collaboration preserves Agents state and disables only Collaboration', async () => {
    const workspaceId = newWorkspaceId()
    await request('PUT', `/internal/collaboration/workspaces/${workspaceId}`, { workspaceId })
    await request('PUT', `/internal/agents/workspaces/${workspaceId}`, { workspaceId })
    await request('POST', `/internal/agents/workspaces/${workspaceId}/capabilities/agents.agent.create/invoke`,
      invokeBody(workspaceId, 'agents.agent.create', { name: 'Persistent', model: 'test-model', persona: 'Persist.' }))

    expect((await request('DELETE', `/internal/collaboration/workspaces/${workspaceId}`)).status).toBe(204)
    expect((await request('GET', `/internal/collaboration/workspaces/${workspaceId}/resources`)).status).toBe(404)
    const agents = moduleResourceCollectionSchema.parse(
      await (await request('GET', `/internal/agents/workspaces/${workspaceId}/resources`)).json(),
    )
    expect(agents.resources.map(resource => resource.title)).toEqual(['Persistent'])
  })
})
