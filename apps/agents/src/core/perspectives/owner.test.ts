import { expect, test } from 'bun:test'
import { accessContextSchema, newRequestId, newWorkspaceId, perspectiveAdmissionSchema, worldPerspectiveReferenceSchema, type PerspectiveAdmission } from '@leitbild/contracts'
import { createAgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import { createDeploymentRuntime } from '../deployment-runtime.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig } from '../../api/__fixtures__/stub-gateway.ts'
import { createPassTool } from '../../tools/built-in/agent-tools.ts'
import { agentConfigurationRevision } from '../../agents/configuration.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { bindingOf, toolWitness } from './owner.ts'
import { createRuntimeAccessView } from '../workspaces/runtime-access.ts'
import { createWSManager } from '../../api/ws-handler.ts'
import { serializeModuleSnapshots, saveWorkspaceModuleSnapshots, loadWorkspaceModuleSnapshots, createModuleAutoSaver, restoreWorkspaceModuleSnapshots } from '../storage/module-snapshots.ts'
import type { WorkspaceModulePaths } from '../paths.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ProviderGateway } from '../../llm/provider-gateway.ts'
import type { ChatRequest } from '../types/llm.ts'
import { wireWorkspaceRuntimeEvents } from '../../api/wire-workspace-runtime-events.ts'
import { wireAgentTracking } from '../../api/agent-tracking.ts'
import { handleAPI, type RouteDeps } from '../../api/http-routes.ts'
import { createExecutionStore } from '../executions/store.ts'

const fixture = async (enabled = true, persist: () => Promise<void> = async () => {}, options: { gateway?: ProviderGateway; hostBaseUrl?: string; executionsFile?: string } = {}) => {
  const workspaceId = newWorkspaceId()
  const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(options.gateway ?? makeStubGateway()) })
  deployment.sharedToolRegistry.register(createPassTool())
  const worlds = new Map<string, PerspectiveAdmission>()
  let readWorld: (id: string) => Promise<PerspectiveAdmission> = async id => structuredClone(worlds.get(id)!)
  const runtime = createAgentsWorkspaceRuntime({ deployment, workspaceId, workspaceHostUrl: options.hostBaseUrl ?? 'http://127.0.0.1:1',
    ...(options.executionsFile === undefined ? {} : { executionsFile: options.executionsFile }),
    perspectivePilot: { enabled }, persistConfiguration: persist,
    perspectiveWorldRead: async reference => readWorld(reference.id),
  })
  const template = asAIAgent(await runtime.spawnAIAgent({ name: 'Public template', model: 'stub:mock-model', persona: 'Read the current permitted view.', tools: [] }))!
  const human = await runtime.spawnHumanAgent({ name: 'Public human' }, () => {})
  const input = (id = crypto.randomUUID()) => {
    const reference = worldPerspectiveReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.perspective', id })
    const world = perspectiveAdmissionSchema.parse({ resource: reference, status: 'pending', revision: 0,
      admissionGeneration: crypto.randomUUID(), runIncarnation: crypto.randomUUID(), roleSetDigest: '0'.repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    worlds.set(id, world)
    return { perspective: reference, admissionGeneration: world.admissionGeneration, templateId: template.id,
      templateRevision: agentConfigurationRevision(template.getConfig()), requestId: crypto.randomUUID() }
  }
  const prepare = async () => runtime.perspectiveRooms!.prepare(input())
  const bind = async () => {
    const prepared = await prepare()
    worlds.set(prepared.perspective.id, perspectiveAdmissionSchema.parse({ ...worlds.get(prepared.perspective.id), status: 'active', revision: 1, binding: bindingOf(prepared) }))
    return runtime.perspectiveRooms!.bind(prepared.room.id, prepared.revision)
  }
  return { runtime, deployment, template, human, worlds, workspaceId, input, prepare, bind,
    setRead: (read: typeof readWorld) => { readWorld = read },
    close: async () => { for (const agent of runtime.team.listByKind('ai')) { const ai = asAIAgent(agent)!; ai.close(); ai.cancelGeneration() }; await runtime.comparisons.close(); runtime.executionStore.close(); deployment.providerSetup.dispose() },
  }
}

const eventually = async (description: string, predicate: () => boolean): Promise<void> => {
  const deadline = performance.now() + 2_000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await Bun.sleep(5)
  }
}

const callHTTP = async (f: Awaited<ReturnType<typeof fixture>>, method: string, path: string, token?: string, body?: unknown) => {
  const request = new Request(`http://local${path}`, { method,
    headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { 'X-Leitbild-Perspective-View': token }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  // These routes do not use deployment catalog mutation ports.
  const deps: RouteDeps = { broadcastAllWorkspaces: () => {}, broadcastToWorkspace: () => {}, subscribeAgentState: () => {},
    packManager: {} as RouteDeps['packManager'], roomDefinitions: {} as RouteDeps['roomDefinitions'] }
  return (await handleAPI(request, path, f.runtime, f.workspaceId, accessContextSchema.parse({ workspaceId: f.workspaceId,
    requestId: newRequestId(), actor: { kind: 'human', id: f.human.id } }), deps))!
}

const pathsFor = (root: string): WorkspaceModulePaths => {
  const agentsRoot = join(root, 'agents'), roomsRoot = join(agentsRoot, 'rooms')
  return { root,
    rooms: { root: roomsRoot, marker: join(roomsRoot, 'workspace.json'), snapshot: join(roomsRoot, 'snapshot.json'), logs: join(roomsRoot, 'logs'), documents: join(roomsRoot, 'documents') },
    agents: { root: agentsRoot, marker: join(agentsRoot, 'workspace.json'), snapshot: join(agentsRoot, 'snapshot.json'), inspections: join(agentsRoot, 'generation-inspections.json'), executions: join(agentsRoot, 'executions.sqlite'), people: join(agentsRoot, 'people.sqlite'), memory: join(agentsRoot, 'memory'), vectors: join(agentsRoot, 'vectors.jsonl') },
  }
}

test('private owner preparation uses the installed production spawn tracking wrapper exactly once', async () => {
  const f = await fixture()
  try {
    const attached: string[] = [], subscribed: string[] = []
    wireAgentTracking(f.runtime, f.workspaceId, {
      attach: id => { attached.push(id) }, detach: () => {},
      subscribeAgentState: agent => { subscribed.push(agent.id) }, unsubscribeAgentState: () => {},
    })
    const prepared = await f.prepare()
    expect(attached).toEqual([prepared.actualAgentId])
    expect(subscribed).toEqual([prepared.actualAgentId])
    expect(f.runtime.team.getAgent(prepared.actualAgentId)?.id).toBe(prepared.actualAgentId)
  } finally { await f.close() }
})

test('Perspective construction is default-off and rejects unsafe template selection before creating a Room', async () => {
  const disabled = await fixture(false)
  try {
    await expect(disabled.prepare()).rejects.toMatchObject({ code: 'perspective_pilot_disabled' })
    expect(disabled.runtime.rooms.listAllRooms()).toHaveLength(0)
  } finally { await disabled.close() }
  const ready = await fixture()
  try {
    ready.runtime.toolRegistry.register({ name: 'shared-writer', description: 'Unclassified shared writer', parameters: {}, execute: async () => ({ success: true }) })
    ready.template.updateTools!(['shared-writer'])
    await expect(ready.prepare()).rejects.toMatchObject({ code: 'perspective_tool_not_admitted' })
    expect(ready.runtime.rooms.listAllRooms()).toHaveLength(0)
  } finally { await ready.close() }
})

test('a scheduled public template is refused before construction rather than silently changing its policy', async () => {
  const f = await fixture()
  try {
    const publicRoom = f.runtime.rooms.createRoom({ name: 'Public schedule', createdBy: f.human.id })
    f.template.addTrigger!({ id: 'scheduled', name: 'Schedule', prompt: 'Report', mode: 'execute', intervalSec: 60, enabled: true, roomId: publicRoom.profile.id })
    await expect(f.prepare()).rejects.toMatchObject({ code: 'perspective_template_triggers_unsupported' })
    expect(f.runtime.rooms.listAllRooms()).toHaveLength(1)
    expect(f.template.getTriggers!()).toHaveLength(1)
  } finally { await f.close() }
})

test('preparation publishes an empty, immutable, separately identified Room and runtime before either owner admits execution', async () => {
  const f = await fixture()
  try {
    const published: unknown[] = []
    f.runtime.setOnRoomCreated(profile => published.push(structuredClone(profile.perspective)))
    const blue = await f.prepare(), red = await f.prepare()
    expect(published).toHaveLength(2)
    expect(published.every(Boolean)).toBe(true)
    expect(blue.status).toBe('prepared')
    expect(red.actualAgentId).not.toBe(blue.actualAgentId)
    expect(red.runtimeGeneration).not.toBe(blue.runtimeGeneration)
    const room = f.runtime.rooms.getRoom(blue.room.id)!, agent = asAIAgent(f.runtime.team.getAgent(blue.actualAgentId)!)!
    expect(room.getRetainedMessages()).toHaveLength(0)
    expect(room.paused).toBe(true)
    expect(room.getParticipantIds()).toEqual([agent.id])
    expect(agent.getHistory!(red.room.id)).toEqual([])
    await expect(agent.join(f.runtime.rooms.getRoom(red.room.id)!)).rejects.toMatchObject({ code: 'perspective_runtime_room_mismatch' })
    expect(() => agent.updatePersona('Store BLUE_PRIVATE in a shared template')).toThrow('immutable')
    expect(f.template.getPersona()).toBe('Read the current permitted view.')
    await expect(f.runtime.perspectiveRooms!.assertLive(room.profile.id)).rejects.toMatchObject({ code: 'perspective_room_not_bound' })
    await expect(f.runtime.perspectiveRooms!.bind(room.profile.id, 0)).rejects.toMatchObject({ code: 'perspective_world_not_bound' })
    expect(() => room.setScope({ kind: 'workspace' }, 0)).toThrow('immutable')
  } finally { await f.close() }
})

test('ordinary tools, Room/Agent readers and snapshots omit private compartments while an exact document view sees only its own Room', async () => {
  const f = await fixture()
  try {
    const blue = await f.bind(), red = await f.bind()
    const room = f.runtime.rooms.getRoom(blue.room.id)!
    room.setPaused(true)
    const message = room.post({ senderId: f.human.id, senderName: f.human.name, content: 'BLUE_PRIVATE_CANARY', type: 'chat' })
    expect(message.perspective?.runtimeGeneration).toBe(blue.runtimeGeneration)
    const ordinary = createRuntimeAccessView(f.runtime)
    expect(ordinary.rooms.listAllRooms()).toEqual([])
    expect(ordinary.team.listAgents().map(agent => agent.id)).toEqual([f.template.id, f.human.id])
    expect(ordinary.rooms.getRoom(blue.room.id)).toBeUndefined()
    expect(ordinary.team.getAgent(blue.actualAgentId)).toBeUndefined()
    const roomsTool = await f.runtime.toolRegistry.get('list_rooms')!.execute({}, { callerId: f.template.id, callerName: f.template.name })
    expect(roomsTool.data).toEqual([])
    const agentsTool = await f.runtime.toolRegistry.get('list_agents')!.execute({}, { callerId: f.template.id, callerName: f.template.name })
    expect(JSON.stringify(agentsTool)).not.toContain(blue.actualAgentId)
    expect(JSON.stringify(agentsTool)).not.toContain('Perspective Assistant')
    const lease = await f.runtime.perspectiveRooms!.viewOpen(blue.room.id, blue.revision, crypto.randomUUID())
    const manager = createWSManager({ getRuntime: () => f.runtime })
    manager.sessions.set('ordinary', { workspaceId: f.workspaceId, sessionToken: 'ordinary', lastActivity: 1 })
    manager.sessions.set('private', { workspaceId: f.workspaceId, sessionToken: 'private', focusedRoomId: blue.room.id, perspectiveViewToken: lease.token, lastActivity: 1 })
    expect(JSON.stringify(manager.buildSnapshot(f.workspaceId, 'ordinary'))).not.toContain(blue.room.id)
    const snapshot = manager.buildSnapshot(f.workspaceId, 'private')!
    expect(snapshot.rooms.map(profile => profile.id)).toEqual([blue.room.id])
    expect(JSON.stringify(snapshot)).not.toContain(red.room.id)
    const output = { ordinary: [] as string[], private: [] as string[] }
    for (const key of ['ordinary', 'private'] as const) manager.wsConnections.set(key, { send: data => output[key].push(data), close: () => {}, getBufferedAmount: () => 0 })
    manager.broadcastToRoom(f.workspaceId, blue.room.id, { type: 'message', message })
    manager.broadcastToRoom(f.workspaceId, blue.room.id, { type: 'agent_activity', agentId: blue.actualAgentId, agentName: 'Scoped', roomId: blue.room.id, event: { traceId: 'turn', kind: 'chunk', delta: 'UNCOMMITTED_PRIVATE' } })
    expect(output.ordinary).toEqual([])
    expect(output.private).toHaveLength(1)
    expect(output.private[0]).toContain('BLUE_PRIVATE_CANARY')
    expect(JSON.stringify(output)).not.toContain('UNCOMMITTED_PRIVATE')
    await expect(f.runtime.addAgentToRoom(f.template.id, blue.room.id)).rejects.toMatchObject({ code: 'perspective_membership_immutable' })
  } finally { await f.close() }
})

test('real human authors persist without joining private execution membership; unknown/other-AI senders are refused', async () => {
  const f = await fixture(), root = await mkdtemp(join(tmpdir(), 'perspective-snapshot-'))
  try {
    const admission = await f.bind(), room = f.runtime.rooms.getRoom(admission.room.id)!
    room.setPaused(true)
    const message = room.post({ senderId: f.human.id, senderName: f.human.name, type: 'chat', content: 'HUMAN_SCOPED_DRAFT' })
    expect(room.getParticipantIds()).toEqual([admission.actualAgentId])
    expect(() => room.post({ senderId: f.template.id, type: 'chat', content: 'Impersonating an extra runtime' })).toThrow('existing public human')
    expect(() => room.post({ senderId: 'unknown-person', type: 'chat', content: 'Unadmitted author' })).toThrow('existing public human')
    const snapshots = serializeModuleSnapshots(f.runtime)
    const paths = pathsFor(root)
    await saveWorkspaceModuleSnapshots(snapshots, paths)
    const saved = await loadWorkspaceModuleSnapshots(paths)
    const persisted = saved.rooms!.rooms.find(candidate => candidate.profile.id === room.profile.id)!
    expect(persisted.members).toEqual([admission.actualAgentId])
    expect(persisted.messages).toEqual([message])
    expect(saved.rooms!.humanActors.find(actor => actor.id === f.human.id)?.name).toBe(f.human.name)
  } finally { await f.close(); await rm(root, { recursive: true, force: true }) }
})

test('exact view renewals survive an owner await, while local revoke and replacement never rebind an admitted read', async () => {
  const f = await fixture()
  try {
    const admission = await f.bind(), owner = f.runtime.perspectiveRooms!, document = crypto.randomUUID()
    const lease = await owner.viewOpen(admission.room.id, admission.revision, document)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let suspended = true
    f.setRead(async id => { if (suspended) { entered.resolve(); await release.promise }; return structuredClone(f.worlds.get(id)!) })
    const pending = owner.viewAuthorize(lease.token)
    await entered.promise
    suspended = false
    const renewed = await owner.viewOpen(admission.room.id, admission.revision, document)
    expect(renewed.token).toBe(lease.token)
    release.resolve()
    expect((await pending).documentId).toBe(document)
    const other = await owner.viewOpen(admission.room.id, admission.revision, crypto.randomUUID())
    expect(other.token).not.toBe(lease.token)
    const revoked = await owner.revoke(admission.room.id, admission.revision, 'Role changed')
    expect(revoked.status).toBe('revoked')
    await expect(owner.viewAuthorize(lease.token)).rejects.toMatchObject({ code: 'perspective_view_unavailable' })
    expect(owner.viewLocal(other.token)).toBeUndefined()
    await expect(owner.bind(admission.room.id, revoked.revision)).rejects.toMatchObject({ code: 'perspective_room_not_prepared' })
    expect(await owner.revoke(admission.room.id, revoked.revision, 'Repeat')).toEqual(revoked)
  } finally { await f.close() }
})

test('uncertain preparation retains real identity; keyed retry flushes the same accepted empty compartment', async () => {
  let failSave = true
  const f = await fixture(true, async () => { if (failSave) throw new Error('fixture disk failure') })
  try {
    const input = f.input()
    await expect(f.runtime.perspectiveRooms!.prepare(input)).rejects.toMatchObject({ code: 'perspective_preparation_outcome_unknown' })
    const accepted = f.runtime.rooms.listAllRooms()[0]!
    expect(accepted.perspective?.requestId).toBe(input.requestId)
    expect(f.runtime.rooms.getRoom(accepted.id)!.getRetainedMessages()).toHaveLength(0)
    failSave = false
    const retry = await f.runtime.perspectiveRooms!.prepare(input)
    expect(String(retry.room.id)).toBe(accepted.id)
    expect(f.runtime.rooms.listAllRooms()).toHaveLength(1)
    expect(f.runtime.team.listByKind('ai')).toHaveLength(2)
  } finally { await f.close() }
})

test('a new closure with identical source text retires live authority, and uploaded tools cannot self-certify', async () => {
  const f = await fixture()
  try {
    const admitted = await f.bind()
    const previous = toolWitness(f.runtime.toolRegistry, 'pass')
    f.runtime.toolRegistry.register(createPassTool())
    expect(toolWitness(f.runtime.toolRegistry, 'pass')).toBe(previous)
    await expect(f.runtime.perspectiveRooms!.assertLive(admitted.room.id)).rejects.toMatchObject({ code: 'perspective_tool_changed' })
    const replacement = { ...createPassTool(), name: 'uploaded-isolated-tool' }
    f.runtime.toolRegistry.registerWithSource(replacement, { kind: 'skill-bundled', skill: 'author-upload', path: '/fixture/tools/tool.ts' })
    f.template.updateTools!([replacement.name])
    await expect(f.prepare()).rejects.toMatchObject({ code: 'perspective_tool_not_admitted' })
  } finally { await f.close() }
})

test('revoke completes while bind verifies its peer; stale continuation cannot reactivate the runtime', async () => {
  const f = await fixture()
  try {
    const prepared = await f.prepare(), owner = f.runtime.perspectiveRooms!
    f.worlds.set(prepared.perspective.id, perspectiveAdmissionSchema.parse({ ...f.worlds.get(prepared.perspective.id), status: 'active', revision: 1, binding: bindingOf(prepared) }))
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    f.setRead(async id => { entered.resolve(); await release.promise; return structuredClone(f.worlds.get(id)!) })
    const binding = owner.bind(prepared.room.id, prepared.revision)
    await entered.promise
    const revoked = await owner.revoke(prepared.room.id, prepared.revision, 'Role changed while bind awaited World')
    expect(revoked.status).toBe('revoked')
    release.resolve()
    await expect(binding).rejects.toMatchObject({ code: 'perspective_room_revision_conflict' })
    expect(owner.read(prepared.room.id)).toEqual(revoked)
    expect(owner.isLocallyReady(prepared.room.id)).toBe(false)
  } finally { await f.close() }
})

for (const peerStop of [true, false]) test(`World revoke ${peerStop ? 'with' : 'without'} peer cancellation retains late provider cost without WS content or an answer`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'perspective-late-provider-'))
  const previousHome = process.env.LEITBILD_HOME
  process.env.LEITBILD_HOME = root
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let providerSignal: AbortSignal | undefined
  const requests: ChatRequest[] = [], contextOrigins: unknown[] = []
  const gateway: ProviderGateway = { ...makeStubGateway(),
    modelInfo: async model => ({ id: model, provider: 'stub', contextMax: 128_000, source: 'fixture' }),
    stream: async function* (request, signal) {
      requests.push(request); providerSignal = signal
      yield { delta: 'PRIVATE_STREAM_CANARY', done: false }
      entered.resolve()
      // An admitted provider may ignore abort and report its actual cost later.
      await release.promise
      yield { delta: '_LATE_PRIVATE_CANARY', done: false }
      yield { delta: '', done: true, tokensUsed: { prompt: 17, completion: 9 }, billing: { generationId: 'fixture-late-generation', costUsd: 0.125 } }
    },
  }
  const host = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const body = await request.json() as { perspectiveOrigin: unknown }
    contextOrigins.push(body.perspectiveOrigin)
    return Response.json({ result: { context: { text: 'PRIVATE_WORLD_CONTEXT_CANARY', at: new Date().toISOString(), clock: 'simulation' } } })
  } })
  let saver: ReturnType<typeof createModuleAutoSaver> | undefined
  const f = await fixture(true, async () => { await saver!.flush() }, { gateway, hostBaseUrl: host.url.origin, executionsFile: join(root, 'executions.sqlite') })
  saver = createModuleAutoSaver(f.runtime, pathsFor(root), 10_000)
  const manager = createWSManager({ getRuntime: () => f.runtime })
  const attached: string[] = [], output = { ordinary: [] as string[], private: [] as string[] }
  wireAgentTracking(f.runtime, f.workspaceId, { attach: id => { attached.push(id) }, detach: () => {},
    subscribeAgentState: manager.subscribeAgentState, unsubscribeAgentState: manager.unsubscribeAgentState })
  const unwire = wireWorkspaceRuntimeEvents(f.runtime, manager, saver, f.workspaceId)
  try {
    const admission = await f.bind(), room = f.runtime.rooms.getRoom(admission.room.id)!
    const lease = await f.runtime.perspectiveRooms!.viewOpen(admission.room.id, admission.revision, crypto.randomUUID())
    for (const key of ['ordinary', 'private'] as const) {
      manager.sessions.set(key, { workspaceId: f.workspaceId, sessionToken: key, lastActivity: 1,
        ...(key === 'ordinary' ? {} : { focusedRoomId: room.profile.id, perspectiveViewToken: lease.token }) })
      manager.wsConnections.set(key, { send: value => output[key].push(value), close: () => {}, getBufferedAmount: () => 0 })
    }
    const posted = await callHTTP(f, 'POST', '/messages', lease.token, { senderId: f.human.id, content: 'PRIVATE_HUMAN_CANARY', target: { rooms: [room.profile.id] } })
    expect(posted.status).toBe(201)
    await entered.promise
    expect(attached).toEqual([admission.actualAgentId])
    expect(output.private.some(value => value.includes('agent_state') && value.includes('generating'))).toBe(true)
    expect(JSON.stringify(contextOrigins)).toContain(admission.actualAgentId)
    expect(JSON.stringify(requests)).toContain('PRIVATE_WORLD_CONTEXT_CANARY')
    expect(f.runtime.executionStore.listTurns(room.profile.id)).toHaveLength(1)
    const originalTurn = f.runtime.executionStore.listTurns(room.profile.id)[0]!
    expect(JSON.stringify(contextOrigins)).toContain(originalTurn.id)

    f.worlds.set(admission.perspective.id, perspectiveAdmissionSchema.parse({ ...f.worlds.get(admission.perspective.id), status: 'revoked', revision: 2, revokedReason: 'Role ended' }))
    if (peerStop) await f.runtime.perspectiveRooms!.revoke(room.profile.id, admission.revision, 'World owner revoked')
    expect(providerSignal?.aborted).toBe(peerStop)
    release.resolve()
    await eventually('late provider billing capture', () => f.runtime.executionStore.modelEvidence(room.profile.id, originalTurn.id).models[0]?.metrics?.costUsd === 0.125)
    await Bun.sleep(10) // Allow the completed evaluator to attempt publication.
    expect(room.getRetainedMessages().filter(message => message.senderId === admission.actualAgentId)).toEqual([])
    expect(f.runtime.executionStore.getTurn(room.profile.id, originalTurn.id)?.status).toBe('interrupted')
    expect((await callHTTP(f, 'GET', `/rooms/${room.profile.id}`, lease.token)).status).toBe(403)
    const evidence = f.runtime.executionStore.getModelCall(room.profile.id, originalTurn.id, 'model_1')!
    expect(evidence.response?.metrics).toMatchObject({ costUsd: 0.125, generationId: 'fixture-late-generation', promptTokens: 17, completionTokens: 9 })
    expect(evidence.response?.content).toContain('_LATE_PRIVATE_CANARY')
    const reopened = createExecutionStore(join(root, 'executions.sqlite'))
    try {
      expect(reopened.getTurn(room.profile.id, originalTurn.id)?.status).toBe('interrupted')
      expect(reopened.getModelCall(room.profile.id, originalTurn.id, 'model_1')?.response?.metrics.costUsd).toBe(0.125)
    } finally { reopened.close() }
    const replacement = await f.bind()
    expect(replacement.actualAgentId).not.toBe(admission.actualAgentId)
    expect(f.runtime.executionStore.listTurns(replacement.room.id)).toEqual([])
    expect(f.runtime.rooms.getRoom(replacement.room.id)!.getRetainedMessages()).toEqual([])
    expect(JSON.stringify(output)).not.toContain('PRIVATE_STREAM_CANARY')
    expect(JSON.stringify(output)).not.toContain('_LATE_PRIVATE_CANARY')
    expect(JSON.stringify(output.ordinary)).not.toContain('PRIVATE_HUMAN_CANARY')
    expect((await callHTTP(f, 'GET', `/rooms/${room.profile.id}/executions/${originalTurn.id}`)).status).toBe(404)
    await saver.flush()
    expect((await loadWorkspaceModuleSnapshots(pathsFor(root))).rooms!.rooms.find(item => item.profile.id === room.profile.id)!.profile.perspective!.admission.status).toBe('revoked')
  } finally {
    release.resolve(); unwire()
    for (const agent of f.runtime.team.listByKind('ai')) manager.unsubscribeAgentState(agent.id)
    await saver.dispose(); await f.close(); await host.stop(true)
    if (previousHome === undefined) delete process.env.LEITBILD_HOME; else process.env.LEITBILD_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)

test('restored private data stays fenced and the old runtime generation cannot resume or reopen a view', async () => {
  const f = await fixture()
  let restored: ReturnType<typeof createAgentsWorkspaceRuntime> | undefined
  const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup() })
  deployment.sharedToolRegistry.register(createPassTool())
  try {
    const admission = await f.bind(), room = f.runtime.rooms.getRoom(admission.room.id)!
    room.setPaused(true)
    room.post({ senderId: f.human.id, type: 'chat', content: 'RESTORED_PRIVATE_CANARY' })
    const lease = await f.runtime.perspectiveRooms!.viewOpen(room.profile.id, admission.revision, crypto.randomUUID())
    restored = createAgentsWorkspaceRuntime({ deployment, workspaceId: f.workspaceId, workspaceHostUrl: 'http://127.0.0.1:1',
      perspectivePilot: { enabled: true }, perspectiveWorldRead: async reference => structuredClone(f.worlds.get(reference.id)!) })
    await restoreWorkspaceModuleSnapshots(restored, serializeModuleSnapshots(f.runtime))
    expect(restored.perspectiveRooms!.isLocallyReady(room.profile.id)).toBe(false)
    expect(restored.perspectiveRooms!.invalidateRestored()).toBe(true)
    expect(restored.perspectiveRooms!.read(room.profile.id).status).toBe('revoked')
    expect(restored.rooms.getRoom(room.profile.id)!.getRetainedMessages()[0]?.content).toBe('RESTORED_PRIVATE_CANARY')
    expect(createRuntimeAccessView(restored).rooms.listAllRooms()).toEqual([])
    expect(createRuntimeAccessView(restored).team.getAgent(admission.actualAgentId)).toBeUndefined()
    await expect(restored.perspectiveRooms!.viewAuthorize(lease.token)).rejects.toMatchObject({ code: 'perspective_view_unavailable' })
    await expect(restored.perspectiveRooms!.viewOpen(room.profile.id, admission.revision + 1, crypto.randomUUID())).rejects.toMatchObject({ code: 'perspective_room_not_bound' })
    expect(restored.rooms.getRoom(room.profile.id)!.paused).toBe(true)
    expect(restored.executionStore.listTurns(room.profile.id)).toEqual([])
  } finally {
    if (restored !== undefined) {
      for (const agent of restored.team.listByKind('ai')) { asAIAgent(agent)!.close(); asAIAgent(agent)!.cancelGeneration() }
      await restored.comparisons.close(); restored.executionStore.close()
    }
    deployment.providerSetup.dispose(); await f.close()
  }
})
