import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  moduleCapabilityCollectionSchema,
  moduleResourceCollectionSchema,
  newWorkspaceId,
  workspaceModuleManifestSchema,
  workspaceResourceReferenceSchema,
  type WorkspaceId,
} from '@leitbild/contracts'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createAgentsModuleState, type AgentsModuleState } from '../core/workspaces/module-state.ts'
import { createWorkspaceRuntimeRegistry, type WorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import { agentsModuleManifest, handleAgentsModuleApi } from './workspace-module-api.ts'

let home = ''
let originalHome: string | undefined
let originalProvider: string | undefined
let originalSeed: string | undefined
let state: AgentsModuleState
let registry: WorkspaceRuntimeRegistry

beforeEach(async () => {
  originalHome = process.env.LEITBILD_HOME
  originalProvider = process.env.PROVIDER
  originalSeed = process.env.LEITBILD_SEED_WORKSPACE
  home = await mkdtemp(join(tmpdir(), 'leitbild-module-api-'))
  process.env.LEITBILD_HOME = home
  process.env.PROVIDER = 'ollama'
  process.env.LEITBILD_SEED_WORKSPACE = '0'
  state = createAgentsModuleState()
  registry = createWorkspaceRuntimeRegistry({ deployment: createDeploymentRuntime(), moduleState: state, idleMs: 1_000_000 })
})

afterEach(async () => {
  await registry.shutdown()
  if (originalHome === undefined) delete process.env.LEITBILD_HOME
  else process.env.LEITBILD_HOME = originalHome
  if (originalProvider === undefined) delete process.env.PROVIDER
  else process.env.PROVIDER = originalProvider
  if (originalSeed === undefined) delete process.env.LEITBILD_SEED_WORKSPACE
  else process.env.LEITBILD_SEED_WORKSPACE = originalSeed
  await rm(home, { recursive: true, force: true })
})

const request = async (method: string, path: string, body?: unknown): Promise<Response> => {
  const url = new URL(path, 'http://leitbild.test')
  const response = await handleAgentsModuleApi(new Request(url.href, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }), url, { state, registry })
  if (!response) throw new Error(`Module API did not handle ${method} ${path}`)
  return response
}

const invokeBody = (workspaceId: WorkspaceId, capabilityId: string, input: unknown, resource?: {
  readonly type: string
  readonly id: string
}) => ({
  workspaceId,
  capabilityId,
  ...(resource === undefined ? {} : {
    resource: workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'agents', ...resource }),
  }),
  input,
  access: {
    workspaceId,
    requestId: crypto.randomUUID(),
    actor: { kind: 'ai' as const, id: 'agent:operator', displayName: 'Operator' },
    client: { id: 'workspace-host', kind: 'service' as const },
  },
})

describe('Agents Workspace Module API', () => {
  test('publishes one strict Agents manifest', async () => {
    const body = await (await request('GET', '/.well-known/workspace-module')).json()
    expect(workspaceModuleManifestSchema.parse(body)).toEqual(agentsModuleManifest)
  })

  test('provisions and discovers Rooms and Agent Profiles through one Module', async () => {
    const workspaceId = newWorkspaceId()
    expect((await request('PUT', `/internal/workspaces/${workspaceId}`, { workspaceId })).status).toBe(201)

    const capabilities = moduleCapabilityCollectionSchema.parse(
      await (await request('GET', `/internal/workspaces/${workspaceId}/capabilities`)).json(),
    )
    expect(capabilities.capabilities.every(capability => capability.id.startsWith('agents.'))).toBe(true)
    expect(capabilities.capabilities.map(capability => String(capability.id))).toContain('agents.room.create')
    expect(capabilities.capabilities.map(capability => String(capability.id))).toContain('agents.agent.create')
    expect(capabilities.capabilities.map(capability => String(capability.id))).toContain('agents.demo.apply')
    expect(capabilities.capabilities.map(capability => String(capability.id))).toContain('agents.prompt-deck.run-entry')

    expect((await request('POST', `/internal/workspaces/${workspaceId}/capabilities/agents.room.create/invoke`,
      invokeBody(workspaceId, 'agents.room.create', { name: 'Operations' }))).status).toBe(201)
    const createAgent = await request('POST', `/internal/workspaces/${workspaceId}/capabilities/agents.agent.create/invoke`,
      invokeBody(workspaceId, 'agents.agent.create', {
        name: 'Analyst', model: 'test-model', persona: 'Analyse.',
        toolGrants: [{ capabilityId: 'world.simulation-run.read' }],
      }))
    expect(createAgent.status).toBe(201)
    const agentId = (await createAgent.json() as { result: { id: string } }).result.id

    const resources = moduleResourceCollectionSchema.parse(
      await (await request('GET', `/internal/workspaces/${workspaceId}/resources`)).json(),
    )
    expect(resources.resources.map(resource => resource.title)).toEqual(['Operations', 'Analyst'])
    expect(resources.resources.map(resource => String(resource.ref.type))).toEqual(['agents.room', 'agents.agent'])

    const agentProfile = await request(
      'POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.agent.read/invoke`,
      invokeBody(workspaceId, 'agents.agent.read', {}, { type: 'agents.agent', id: agentId }),
    )
    expect((await agentProfile.json() as {
      result: { config: { toolGrants: Array<{ capabilityId: string }> } }
    }).result.config.toolGrants).toEqual([{ capabilityId: 'world.simulation-run.read' }])
  })

  test('removing Agents removes the complete Module', async () => {
    const workspaceId = newWorkspaceId()
    await request('PUT', `/internal/workspaces/${workspaceId}`, { workspaceId })
    expect((await request('DELETE', `/internal/workspaces/${workspaceId}`)).status).toBe(204)
    expect((await request('GET', `/internal/workspaces/${workspaceId}/resources`)).status).toBe(404)
  })
})
