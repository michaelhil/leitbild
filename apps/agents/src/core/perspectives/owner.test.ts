import { expect, test } from 'bun:test'
import { newWorkspaceId, perspectiveAdmissionSchema, worldPerspectiveReferenceSchema, type PerspectiveAdmission } from '@leitbild/contracts'
import { createAgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import { createDeploymentRuntime } from '../deployment-runtime.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig } from '../../api/__fixtures__/stub-gateway.ts'
import { createPassTool } from '../../tools/built-in/agent-tools.ts'
import { agentConfigurationRevision } from '../../agents/configuration.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { bindingOf, toolWitness } from './owner.ts'
import { createRuntimeAccessView } from '../workspaces/runtime-access.ts'
import { createWSManager } from '../../api/ws-handler.ts'
import { serializeModuleSnapshots, saveWorkspaceModuleSnapshots, loadWorkspaceModuleSnapshots } from '../storage/module-snapshots.ts'
import type { WorkspaceModulePaths } from '../paths.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fixture = async (enabled = true, persist: () => Promise<void> = async () => {}) => {
  const workspaceId = newWorkspaceId()
  const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(makeStubGateway()) })
  deployment.sharedToolRegistry.register(createPassTool())
  const worlds = new Map<string, PerspectiveAdmission>()
  let readWorld: (id: string) => Promise<PerspectiveAdmission> = async id => structuredClone(worlds.get(id)!)
  const runtime = createAgentsWorkspaceRuntime({ deployment, workspaceId, workspaceHostUrl: 'http://127.0.0.1:1',
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
  return { runtime, template, human, worlds, workspaceId, input, prepare, bind,
    setRead: (read: typeof readWorld) => { readWorld = read },
    close: async () => { for (const agent of runtime.team.listByKind('ai')) { const ai = asAIAgent(agent)!; ai.close(); ai.cancelGeneration() }; await runtime.comparisons.close(); runtime.executionStore.close(); deployment.providerSetup.dispose() },
  }
}

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
    const agentsRoot = join(root, 'agents'), roomsRoot = join(agentsRoot, 'rooms')
    const paths: WorkspaceModulePaths = { root,
      rooms: { root: roomsRoot, marker: join(roomsRoot, 'workspace.json'), snapshot: join(roomsRoot, 'snapshot.json'), logs: join(roomsRoot, 'logs'), documents: join(roomsRoot, 'documents') },
      agents: { root: agentsRoot, marker: join(agentsRoot, 'workspace.json'), snapshot: join(agentsRoot, 'snapshot.json'), inspections: join(agentsRoot, 'generation-inspections.json'), executions: join(agentsRoot, 'executions.sqlite'), people: join(agentsRoot, 'people.sqlite'), memory: join(agentsRoot, 'memory'), vectors: join(agentsRoot, 'vectors.jsonl') },
    }
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
