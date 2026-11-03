import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentsPerspectiveRoomAdmissionSchema, moduleRegistrationSchema, moduleIdSchema, perspectiveAdmissionSchema,
  perspectiveAssistantSetupResultSchema, workspaceIdSchema, workspaceResourceReferenceSchema,
  type PerspectiveRuntimeBinding, type WorkspaceResourceReference,
} from '@leitbild/contracts'
import { createWorldApplicationAssembly } from '../../../apps/world/src/app-assembly.ts'
import { handleWorldModuleApi } from '../../../apps/world/src/core/api/workspace-module-api.ts'
import { createWorldModuleState } from '../../../apps/world/src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../../../apps/world/src/core/workspaces/runtime-registry.ts'
import { createScenarioRuntimeResolver } from '../../../apps/world/src/core/scenarios/runtime-resolver.ts'
import { scenarioAuthoringCatalogFor } from '../../../apps/world/src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../../../apps/world/src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../../../apps/world/src/core/scenarios/definition.ts'
import { createDirectRoutingAdapter } from '../../../apps/world/src/routing/direct-adapter.ts'
import border from '../../../apps/world/src/scenarios/halden-border-human-red.scenario.json'
import { handleAgentsModuleApi } from '../../../apps/agents/src/api/workspace-module-api.ts'
import { createAgentsModuleState } from '../../../apps/agents/src/core/workspaces/module-state.ts'
import { createWorkspaceRuntimeRegistry } from '../../../apps/agents/src/core/workspaces/runtime-registry.ts'
import { createDeploymentRuntime } from '../../../apps/agents/src/core/deployment-runtime.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig } from '../../../apps/agents/src/api/__fixtures__/stub-gateway.ts'
import { asAIAgent } from '../../../apps/agents/src/agents/shared.ts'
import { createPassTool } from '../../../apps/agents/src/tools/built-in/agent-tools.ts'
import type { ChatRequest } from '../../../apps/agents/src/core/types/llm.ts'
import { agentConfigurationRevision } from '../../../apps/agents/src/agents/configuration.ts'
import { createWorkspaceHost } from '../../../apps/leitbild/src/host.ts'
import { createModuleGateway } from '../../../apps/leitbild/src/module-gateway.ts'
import { createWorkspaceHostServer } from '../../../apps/leitbild/src/server.ts'
import { createWorkspaceStore } from '../../../apps/leitbild/src/store.ts'

test('real Host, World and Agents establish three separate pictures and exclude an ordinary fourth Agent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perspective-combined-')), previousHome = process.env.LEITBILD_HOME
  process.env.LEITBILD_HOME = join(directory, 'agents')
  // Activation selects an existing dedicated Workspace, never every Workspace
  // a server may create later. Provision both real core Modules below.
  const store = createWorkspaceStore(':memory:')
  const workspace = store.create({ name: 'Private exercise fixture', moduleIds: [moduleIdSchema.parse('world'), moduleIdSchema.parse('agents')] })
  const workspaceId = workspace.id
  const pilot = { enabled: true, workspaceIds: [workspaceId] }
  let hostUrl = ''
  const ownerInvoke = async (workspaceId: string, operation: string, resource: WorkspaceResourceReference, input: unknown = {}) => {
    const response = await fetch(`${hostUrl}/internal/workspaces/${workspaceId}/capabilities/${operation}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resource, input,
        actor: { kind: 'system', id: 'world' }, perspectiveOrigin: { kind: 'owner', moduleId: 'world' } }),
    })
    const body = await response.json() as { result?: unknown; error?: unknown }
    if (!response.ok) throw new Error(`Peer owner ${operation}: ${JSON.stringify(body.error)}`)
    return body.result
  }
  const routing = createDirectRoutingAdapter(), assembly = createWorldApplicationAssembly({ routing })
  const world = createWorldWorkspaceRuntimeRegistry({ dataDir: join(directory, 'world'), moduleState: createWorldModuleState({ dataDir: join(directory, 'world') }),
    runtimeAdapters: assembly.runtimeAdapters, workspaceCapabilities: assembly.packs.flatMap(pack => pack.workspaceCapabilities ?? []),
    scenarioDefinitions: [], scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    perspectivePilot: { ...pilot,
      readAgentsAdmission: async (binding: PerspectiveRuntimeBinding) => agentsPerspectiveRoomAdmissionSchema.parse(await ownerInvoke(binding.room.workspaceId, 'agents.perspective-room.read', binding.room)),
      revokeAgentsAdmission: async (binding, reason) => {
        const read = async () => agentsPerspectiveRoomAdmissionSchema.parse(await ownerInvoke(binding.room.workspaceId, 'agents.perspective-room.read', binding.room))
        const current = await read()
        if (current.status === 'revoked') return current
        try { return agentsPerspectiveRoomAdmissionSchema.parse(await ownerInvoke(binding.room.workspaceId, 'agents.perspective-room.revoke', binding.room, { expectedRevision: current.revision, reason })) }
        catch (error) { const latest = await read(); if (latest.status === 'revoked') return latest; throw error }
      },
    },
  })
  const worldServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => await handleWorldModuleApi(request, new URL(request.url), world) ?? new Response('Not found', { status: 404 }) })
  const modelRequests: ChatRequest[] = []
  const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup({ ...makeStubGateway(),
    stream: async function* (request) {
      modelRequests.push(structuredClone(request))
      yield { delta: 'Scoped fixture response.', done: false }
      yield { delta: '', done: true, tokensUsed: { prompt: 10, completion: 4 } }
    },
  }) })
  deployment.sharedToolRegistry.register(createPassTool())
  const agentsState = createAgentsModuleState()
  let agents!: ReturnType<typeof createWorkspaceRuntimeRegistry>
  const agentsServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => await handleAgentsModuleApi(request, new URL(request.url), { registry: agents, state: agentsState }) ?? new Response('Not found', { status: 404 }) })
  const host = createWorkspaceHost({ store, modules: createModuleGateway({ registrations: [
    moduleRegistrationSchema.parse({ moduleId: 'world', internalBaseUrl: worldServer.url.origin, manifestPath: '/.well-known/workspace-module' }),
    moduleRegistrationSchema.parse({ moduleId: 'agents', internalBaseUrl: agentsServer.url.origin, manifestPath: '/.well-known/workspace-module' }),
  ] }) })
  const hostServer = createWorkspaceHostServer({ host, bindHost: '127.0.0.1', port: 0, perspectivePilot: pilot })
  hostUrl = hostServer.url.origin
  agents = createWorkspaceRuntimeRegistry({ deployment, moduleState: agentsState, workspaceHostUrl: hostUrl, perspectivePilot: pilot, idleMs: 1_000_000 })
  try {
    for (const [moduleId, url] of [['world', worldServer.url.origin], ['agents', agentsServer.url.origin]] as const) {
      expect((await fetch(`${url}/internal/workspaces/${workspaceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) })).status).toBe(201)
      store.setModuleState(workspaceId, { moduleId: moduleIdSchema.parse(moduleId), status: 'ready', updatedAt: new Date().toISOString() })
    }
    expect((await fetch(`${hostUrl}/api/workspaces/${workspaceId}`)).status).toBe(200)
    const registry = (await world.getOrLoad(workspaceId)).simulationRuns, runtime = await agents.getOrLoad(workspaceId)
    const source = scenarioDefinitionSchema.parse(border)
    await registry.createScenario(source)
    const run = await registry.create({ scenarioId: source.id }); await run.setClock({ paused: true })
    const runRef = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id })
    const template = asAIAgent(await runtime.spawnAIAgent({ name: 'Public reusable template', model: 'stub:mock-model', tools: ['workspace_explore', 'workspace_call'], persona: 'Inspect the current permitted picture.' }))!
    const participant = await runtime.spawnHumanAgent({ name: 'Fixture participant' }, () => {})
    const invoke = async (operation: string, resource: WorkspaceResourceReference, input: unknown = {}, actor = { kind: 'human', id: 'person-fixture' }) => {
      const response = await fetch(`${hostUrl}/api/workspaces/${workspaceId}/capabilities/${operation}/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resource, input, actor }) })
      return { status: response.status, body: await response.json() as { result?: unknown; error?: { code: string } } }
    }
    const pictures = []
    for (const roleIds of [['group:ems', 'group:blue-recce'], ['group:red-recce', 'group:red-armour'], ['controller']]) {
      const requestId = crypto.randomUUID()
      const prepared = await invoke('world.perspective.prepare', runRef, { roleIds, requestId })
      expect(prepared.status).toBe(200)
      const pending = perspectiveAdmissionSchema.parse(prepared.body.result)
      const response = await fetch(`${hostUrl}/api/workspaces/${workspaceId}/perspective-assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ perspective: pending.resource, templateId: template.id, templateRevision: agentConfigurationRevision(template.getConfig()), requestId }) })
      const result: unknown = await response.json()
      expect(response.status, JSON.stringify(result)).toBe(200)
      const admitted = perspectiveAssistantSetupResultSchema.parse(result)
      const origin = runtime.perspectiveRooms!.executionOrigin(admitted.roomAdmission.room.id, admitted.roomAdmission.actualAgentId, 'actual-fixture-turn')
      const context = { callerId: admitted.roomAdmission.actualAgentId, callerName: 'Scoped fixture', roomId: admitted.roomAdmission.room.id, executionTurnId: 'actual-fixture-turn', perspectiveOrigin: origin }
      const discovery = await runtime.toolRegistry.get('workspace_explore')!.execute({ view: 'scope' }, context)
      expect(discovery.success).toBe(true)
      expect(JSON.stringify(discovery)).toContain(pending.resource.id)
      expect(JSON.stringify(discovery)).not.toContain(run.id)
      const objects = await runtime.toolRegistry.get('workspace_call')!.execute({ calls: [{ key: 'picture', operationId: 'world.perspective.objects.list', input: { limit: 100 } }] }, context)
      expect(objects.success, JSON.stringify(objects)).toBe(true)
      const canonical = await invoke('world.simulation-run.read', runRef, {}, { kind: 'ai', id: admitted.roomAdmission.actualAgentId })
      expect(canonical.status).toBe(403)
      expect(canonical.body.error?.code).toBe('ai_role_run_unsupported')
      pictures.push({ admitted, context, objects })
    }
    expect(new Set(pictures.map(picture => picture.admitted.roomAdmission.actualAgentId)).size).toBe(3)
    expect(new Set(pictures.map(picture => picture.admitted.roomAdmission.room.id)).size).toBe(3)
    expect(JSON.stringify(pictures[0]!.objects)).toContain('unit:blue-recce-1')
    expect(JSON.stringify(pictures[0]!.objects)).not.toContain('unit:red-recce-1')
    expect(JSON.stringify(pictures[1]!.objects)).toContain('unit:red-recce-1')
    expect(JSON.stringify(pictures[1]!.objects)).not.toContain('unit:blue-recce-1')
    expect(JSON.stringify(pictures[2]!.objects)).toContain('unit:blue-recce-1')
    expect(JSON.stringify(pictures[2]!.objects)).toContain('unit:red-recce-1')
    const catalog = await (await fetch(`${hostUrl}/api/workspaces/${workspaceId}/resources`)).text()
    for (const picture of pictures) { expect(catalog).not.toContain(picture.admitted.roomAdmission.room.id); expect(catalog).not.toContain(picture.admitted.roomAdmission.actualAgentId) }
    const privateRead = await invoke('agents.room.inspect', pictures[0]!.admitted.roomAdmission.room, {}, { kind: 'ai', id: template.id })
    expect(privateRead.status).toBe(403)
    for (const [index, picture] of pictures.entries()) {
      const room = runtime.rooms.getRoom(picture.admitted.roomAdmission.room.id)!
      room.post({ senderId: participant.id, content: `PRIVATE_PICTURE_${index}: give a concise situation report.`, type: 'chat' })
    }
    const until = Date.now() + 5_000
    while (pictures.some(picture => !runtime.rooms.getRoom(picture.admitted.roomAdmission.room.id)!.getRetainedMessages().some(message => message.senderId === picture.admitted.roomAdmission.actualAgentId)) && Date.now() < until) await Bun.sleep(10)
    expect(modelRequests).toHaveLength(3)
    for (const [index, picture] of pictures.entries()) {
      const request = modelRequests.find(request => JSON.stringify(request.messages).includes(`PRIVATE_PICTURE_${index}`))
      expect(request).toBeDefined()
      for (const other of [0, 1, 2].filter(other => other !== index)) {
        expect(JSON.stringify(request)).not.toContain(`PRIVATE_PICTURE_${other}`)
        expect(JSON.stringify(request)).not.toContain(pictures[other]!.admitted.roomAdmission.room.id)
        expect(JSON.stringify(request)).not.toContain(pictures[other]!.admitted.roomAdmission.actualAgentId)
      }
      const messages = runtime.rooms.getRoom(picture.admitted.roomAdmission.room.id)!.getRetainedMessages()
      expect(messages.some(message => message.senderId === picture.admitted.roomAdmission.actualAgentId && message.content.includes('Scoped fixture response.'))).toBe(true)
    }
    expect(JSON.stringify(modelRequests.find(request => JSON.stringify(request.messages).includes('PRIVATE_PICTURE_0')))).not.toContain('unit:red-recce-1')
    const list = await runtime.toolRegistry.get('list_rooms')!.execute({}, { callerId: template.id, callerName: template.name })
    expect(list.data).toEqual([])
    const target = pictures[0]!
    const revoked = await invoke('world.perspective.revoke', target.admitted.admission.resource, { expectedRevision: target.admitted.admission.revision, roleIds: ['group:ems', 'group:blue-recce'], reason: 'Fixture role changed' })
    expect(revoked.status).toBe(200)
    const after = await runtime.toolRegistry.get('workspace_explore')!.execute({ view: 'scope' }, target.context)
    expect(after.success).toBe(false)
    expect(JSON.stringify(after)).not.toContain('PRIVATE_')
  } finally {
    const outcomes = await Promise.allSettled([agents.shutdown(), world.shutdown()])
    hostServer.stop(true); agentsServer.stop(true); worldServer.stop(true); store.close(); deployment.providerSetup.dispose()
    if (previousHome === undefined) delete process.env.LEITBILD_HOME; else process.env.LEITBILD_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
  }
}, 30_000)
