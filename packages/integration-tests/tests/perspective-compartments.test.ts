import { expect, test } from 'bun:test'
import { mkdtemp, rm, access } from 'node:fs/promises'
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

for (const mode of ['settlement', 'settlement-save-failed', 'host-closed', 'world-closed', 'agents-withdrawal', 'open-control'] as const) test(`real three-owner compartments, no cross-access and ${mode} lifecycle`, async () => {
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
  const worldConfig: Parameters<typeof createWorldWorkspaceRuntimeRegistry>[0] = { dataDir: join(directory, 'world'), moduleState: createWorldModuleState({ dataDir: join(directory, 'world') }),
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
  }
  let world = createWorldWorkspaceRuntimeRegistry(worldConfig)
  let worldServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => await handleWorldModuleApi(request, new URL(request.url), world) ?? new Response('Not found', { status: 404 }) })
  const modelRequests: ChatRequest[] = []
  const lateEntered = Promise.withResolvers<void>(), lateRelease = Promise.withResolvers<void>()
  let lateSignal: AbortSignal | undefined
  let lateAgent: ReturnType<typeof asAIAgent>
  let restoreFlush: (() => void) | undefined
  const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup({ ...makeStubGateway(),
    stream: async function* (request, signal) {
      modelRequests.push(structuredClone(request))
      if (JSON.stringify(request.messages).includes('NEXT_MODEL_POLICY_CASE') && !request.messages.some(message => message.role === 'tool')) {
        lateSignal = signal; lateEntered.resolve(); await lateRelease.promise
        // Current-conversation evidence only: no World tool or new World
        // content is necessary to trigger the next paid model decision.
        yield { delta: '', done: true, toolCalls: [{ id: 'localRead123', function: { name: 'conversation_read', arguments: {} } }], tokensUsed: { prompt: 11, completion: 2 } }
        return
      }
      if (JSON.stringify(request.messages).includes('LATE_PRIVATE_DISPOSAL')) {
        lateSignal = signal; lateEntered.resolve()
        await lateRelease.promise // Deliberately ignore cancellation until actual completion.
        yield { delta: 'Late private disposal response.', done: false }
        yield { delta: '', done: true, tokensUsed: { prompt: 17, completion: 9 }, billing: { generationId: 'local-disposal-fixture', costUsd: 0.125 } }
        return
      }
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
  let hostServer = createWorkspaceHostServer({ host, bindHost: '127.0.0.1', port: 0, perspectivePilot: pilot })
  hostUrl = hostServer.url.origin
  agents = createWorkspaceRuntimeRegistry({ deployment, moduleState: agentsState, workspaceHostUrl: hostUrl, perspectivePilot: pilot, idleMs: 1_000_000, drainMs: 5 })
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

    const retained = pictures[1]!.admitted.roomAdmission, privateRoom = runtime.rooms.getRoom(retained.room.id)!
    const actual = asAIAgent(runtime.team.getAgent(retained.actualAgentId)!)!
    lateAgent = actual
    if (!mode.startsWith('settlement')) {
      privateRoom.post({ senderId: participant.id, content: 'NEXT_MODEL_POLICY_CASE', type: 'chat' })
      await lateEntered.promise
      const localVerification = () => fetch(`${hostUrl}/internal/workspaces/${workspaceId}/capabilities/world.perspective.read/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resource: retained.perspective, input: {}, actor: { kind: 'system', id: 'agents' }, perspectiveOrigin: { kind: 'owner', moduleId: 'agents' } }),
      })
      if (mode === 'host-closed') {
        const port = hostServer.port!; await hostServer.stop(true)
        hostServer = createWorkspaceHostServer({ host, bindHost: '127.0.0.1', port, perspectivePilot: { ...pilot, enabled: false } })
        expect((await localVerification()).status).toBe(404)
      } else if (mode === 'world-closed') {
        const port = worldServer.port!; await worldServer.stop(true); await world.shutdown()
        world = createWorldWorkspaceRuntimeRegistry({ ...worldConfig, perspectivePilot: { ...worldConfig.perspectivePilot!, enabled: false } })
        worldServer = Bun.serve({ hostname: '127.0.0.1', port, fetch: async request => await handleWorldModuleApi(request, new URL(request.url), world) ?? new Response('Not found', { status: 404 }) })
        const reading = await localVerification()
        expect(reading.status).toBe(200)
        expect(perspectiveAdmissionSchema.parse((await reading.json() as { result: unknown }).result).runtimeAvailability?.status).toBe('unavailable')
      } else if (mode === 'agents-withdrawal') {
        await expect(agents.shutdown()).rejects.toMatchObject({ code: 'perspective_calls_unsettled' })
        expect(lateSignal?.aborted).toBe(true)
      }
      lateRelease.resolve()
      await actual.whenSettled(2_000)
      expect(modelRequests).toHaveLength(mode === 'open-control' ? 5 : 4)
      const replies = privateRoom.getRetainedMessages().filter(message => message.senderId === retained.actualAgentId)
      expect(replies).toHaveLength(mode === 'open-control' ? 2 : 1)
      return
    }
    privateRoom.post({ senderId: participant.id, content: 'LATE_PRIVATE_DISPOSAL', type: 'chat' })
    await lateEntered.promise
    privateRoom.post({ senderId: participant.id, content: 'Queued work must never dispatch during removal', type: 'chat' })
    actual.cancelGeneration() // Apparent idle while the old epoch still owns a real provider Promise.
    await actual.whenIdle()
    expect(actual.hasInFlightTurns()).toBe(true)
    const oldTurn = runtime.executionStore.listTurns(privateRoom.profile.id)[0]!
    if (mode === 'settlement-save-failed') {
      const saver = agents.autoSaverFor(workspaceId)!, original = saver.flush
      Object.assign(saver, { flush: async () => { throw new Error('Injected private snapshot save failure') } })
      restoreFlush = () => Object.assign(saver, { flush: original })
    }
    const incomplete = await fetch(`${hostUrl}/api/workspaces/${workspaceId}`, { method: 'DELETE' })
    expect(incomplete.status).toBe(502)
    expect((await incomplete.json() as { error: { code: string } }).error.code).toBe('workspace_delete_incomplete')
    expect(await agentsState.has(workspaceId)).toBe(true)
    expect(runtime.executionStore.getTurn(privateRoom.profile.id, oldTurn.id)?.status).toBe('interrupted')
    expect(runtime.executionStore.modelEvidence(privateRoom.profile.id, oldTurn.id).models[0]?.status).toBe('running')
    expect(lateSignal?.aborted).toBe(true)
    restoreFlush?.(); restoreFlush = undefined
    expect(() => actual.requestTurn!(privateRoom.profile.id, { instruction: 'No new turn after removal starts', inReplyTo: [], requireView: false, cause: { kind: 'display-request', name: 'Fixture' } })).toThrow('immutable')
    lateRelease.resolve()
    await actual.whenSettled(2_000)
    expect(actual.hasInFlightTurns()).toBe(false)
    expect(runtime.executionStore.getModelCall(privateRoom.profile.id, oldTurn.id, 'model_1')?.response?.metrics.costUsd).toBe(0.125)
    expect(privateRoom.getRetainedMessages().some(message => message.content.includes('Late private disposal response.'))).toBe(false)
    expect(modelRequests).toHaveLength(4) // The queued prompt and requested turn never dispatched.
    const removed = await fetch(`${hostUrl}/api/workspaces/${workspaceId}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)
    expect((await fetch(`${hostUrl}/api/workspaces/${workspaceId}`)).status).toBe(404)
    expect(await agentsState.has(workspaceId)).toBe(false)
    expect(await access(join(directory, 'agents', 'workspaces', workspaceId, 'agents')).then(() => true, () => false)).toBe(false)
  } finally {
    restoreFlush?.()
    lateRelease.resolve()
    await lateAgent?.whenSettled(2_000)
    const outcomes = await Promise.allSettled([agents.shutdown(), world.shutdown()])
    hostServer.stop(true); agentsServer.stop(true); worldServer.stop(true); store.close(); deployment.providerSetup.dispose()
    if (previousHome === undefined) delete process.env.LEITBILD_HOME; else process.env.LEITBILD_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
  }
}, 30_000)
