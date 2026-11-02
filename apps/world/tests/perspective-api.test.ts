import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accessContextSchema, agentsPerspectiveRoomAdmissionSchema, newWorkspaceId, newRequestId,
  perspectiveAdmissionSchema, perspectiveDiscoverySchema, perspectivePresentationVerificationSchema,
  workspaceResourceReferenceSchema, type AgentsPerspectiveRoomAdmission, type PerspectiveAdmission,
  type PerspectiveOrigin, type PerspectiveRuntimeBinding, type WorkspaceResourceReference,
} from '@leitbild/contracts'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import border from '../src/scenarios/halden-border-human-red.scenario.json'

// The published Agents owner port is an explicit contract double in this World-only test.
const setup = async (enabled = true) => {
  const directory = await mkdtemp(join(tmpdir(), 'world-perspective-api-')), workspaceId = newWorkspaceId()
  const routing = createDirectRoutingAdapter(), assembly = createWorldApplicationAssembly({ routing })
  const peers = new Map<string, AgentsPerspectiveRoomAdmission>()
  let beforePeerRead: (() => Promise<void>) | undefined
  const workspaces = createWorldWorkspaceRuntimeRegistry({ dataDir: directory, moduleState: createWorldModuleState({ dataDir: directory }),
    runtimeAdapters: assembly.runtimeAdapters, workspaceCapabilities: assembly.packs.flatMap(pack => pack.workspaceCapabilities ?? []),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), scenarioDefinitions: [],
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }), scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
    ...(enabled ? { perspectivePilot: { enabled: true as const, readAgentsAdmission: async (binding: PerspectiveRuntimeBinding) => {
      const wait = beforePeerRead; beforePeerRead = undefined; await wait?.()
      const peer = peers.get(binding.room.id)
      if (!peer) throw Error('The actual scoped runtime is unavailable')
      return structuredClone(peer)
    } } } : {}),
  })
  await workspaces.provision(workspaceId)
  const registry = (await workspaces.getOrLoad(workspaceId)).simulationRuns
  const source = scenarioDefinitionSchema.parse(border)
  await registry.createScenario(source)
  const run = await registry.create({ scenarioId: source.id }); await run.setClock({ paused: true })
  const runRef = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id })
  const invoke = async (capabilityId: string, resource: WorkspaceResourceReference, input: unknown, actor: 'human' | 'ai' = 'human', origin?: PerspectiveOrigin) => {
    const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: actor, id: origin?.kind === 'execution' ? origin.actualAgentId : 'test-human' }, ...(origin === undefined ? {} : { perspectiveOrigin: origin }) })
    const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, capabilityId, resource, input, access }) })
    const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
    if (!response) throw Error('World did not handle its own operation')
    return { status: response.status, body: await response.json() as { result?: unknown; error?: { code: string; message: string } } }
  }
  const owner = { kind: 'owner', moduleId: 'host' } as const
  const prepare = async (roleIds: string[]) => {
    const result = await invoke('world.perspective.prepare', runRef, { roleIds, requestId: crypto.randomUUID() })
    expect(result.status).toBe(200)
    return perspectiveAdmissionSchema.parse(result.body.result)
  }
  const bind = async (pending: PerspectiveAdmission, bound = true) => {
    const binding = {
      perspective: pending.resource, admissionGeneration: pending.admissionGeneration,
      room: workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'agents', type: 'agents.room', id: `private-${crypto.randomUUID()}` }),
      actualAgentId: `actual-${crypto.randomUUID()}`, runtimeGeneration: crypto.randomUUID(), templateId: 'safe-template', templateRevision: 'safe-revision',
    }
    const now = new Date().toISOString()
    peers.set(binding.room.id, agentsPerspectiveRoomAdmissionSchema.parse({ ...binding, status: 'prepared', revision: 0, createdAt: now, updatedAt: now }))
    const result = await invoke('world.perspective.bind', pending.resource, { expectedRevision: 0, binding }, 'human', owner)
    expect(result.status).toBe(200)
    if (bound) peers.set(binding.room.id, { ...peers.get(binding.room.id)!, status: 'bound', revision: 1 })
    const admission = perspectiveAdmissionSchema.parse(result.body.result)
    const origin: PerspectiveOrigin = { kind: 'execution', roomId: binding.room.id, actualAgentId: binding.actualAgentId, runtimeGeneration: binding.runtimeGeneration, turnId: 'actual-turn', perspectiveId: pending.resource.id, admissionGeneration: pending.admissionGeneration }
    return { admission, binding, origin }
  }
  const get = async (suffix: string) => {
    const request = new Request(`http://world.test/internal/workspaces/${workspaceId}/${suffix}`)
    const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
    return await response!.json() as Record<string, unknown>
  }
  return { invoke, get, prepare, bind, owner, registry, run, runRef, peers,
    waitOnPeer: (wait: () => Promise<void>) => { beforePeerRead = wait },
    close: async () => { await workspaces.shutdown(); await rm(directory, { recursive: true, force: true }) },
  }
}

test('disabled pilot advertises no adapters, while canonical role-Run AI stays refused', async () => {
  const fixture = await setup(false)
  try {
    expect(JSON.stringify(await fixture.get('capabilities'))).not.toContain('world.perspective.')
    expect((await fixture.invoke('world.perspective.prepare', fixture.runRef, { roleIds: ['group:blue-recce'], requestId: crypto.randomUUID() })).status).toBe(404)
    expect((await fixture.invoke('world.simulation-run.inspect', fixture.runRef, {}, 'ai')).status).toBe(403)
  } finally { await fixture.close() }
})

test('published private admissions require both owners and preserve Blue, Red and controller read pictures', async () => {
  const fixture = await setup()
  try {
    const pending = await fixture.prepare(['group:blue-recce'])
    expect((await fixture.invoke('world.perspective.context.read', pending.resource, {}, 'ai')).status).toBe(403)
    expect((await fixture.invoke('world.perspective.read', pending.resource, {}, 'ai')).status).toBe(403)
    expect((await fixture.invoke('world.perspective.read', pending.resource, { roleIds: ['group:red-recce'] })).status).toBe(403)
    expect(JSON.stringify(await fixture.get('resources'))).not.toContain(pending.resource.id)
    const blue = await fixture.bind(pending, false)
    expect((await fixture.invoke('world.perspective.context.read', pending.resource, {}, 'ai', blue.origin)).status).toBe(409)
    fixture.peers.set(blue.binding.room.id, { ...fixture.peers.get(blue.binding.room.id)!, status: 'bound', revision: 1 })
    const red = await fixture.bind(await fixture.prepare(['group:red-recce']))
    const controller = await fixture.bind(await fixture.prepare(['controller']))
    const blueList = await fixture.invoke('world.perspective.objects.list', pending.resource, { limit: 100 }, 'ai', blue.origin)
    expect(blueList.status).toBe(200)
    expect(JSON.stringify(blueList.body)).toContain('unit:blue-recce-1')
    expect(JSON.stringify(blueList.body)).not.toContain('unit:red-recce-1')
    expect(JSON.stringify(blueList.body)).not.toContain(fixture.run.id)
    const redList = await fixture.invoke('world.perspective.objects.list', red.admission.resource, { limit: 100 }, 'ai', red.origin)
    expect(redList.status).toBe(200)
    expect(JSON.stringify(redList.body)).toContain('unit:red-recce-1')
    expect(JSON.stringify(redList.body)).not.toContain('unit:blue-recce-1')
    const all = await fixture.invoke('world.perspective.objects.list', controller.admission.resource, { limit: 100 }, 'ai', controller.origin)
    expect(JSON.stringify(all.body)).toContain('unit:blue-recce-1')
    expect(JSON.stringify(all.body)).toContain('unit:red-recce-1')
    const discovery = await fixture.invoke('world.perspective.discovery.read', pending.resource, {}, 'ai', blue.origin)
    expect(discovery.status).toBe(200)
    const discovered = perspectiveDiscoverySchema.parse(discovery.body.result)
    expect(discovered.resource.ref).toEqual(pending.resource)
    expect(discovered.resource.links).toEqual([])
    expect(discovered.capabilities.every(capability => capability.scope.kind === 'resource' && capability.scope.resourceType === 'world.perspective')).toBe(true)
    expect(discovered.capabilities.some(capability => capability.id === 'world.perspective.bind')).toBe(false)
    expect(JSON.stringify(discovery.body)).not.toContain(fixture.run.id)
    expect((await fixture.invoke('world.perspective.objects.read', pending.resource, { objectId: 'unit:red-recce-1' }, 'ai', blue.origin)).status).toBe(403)
    expect((await fixture.invoke('world.perspective.objects.read', pending.resource, { objectId: 'unit:not-present' }, 'ai', blue.origin)).status).toBe(403)
    expect((await fixture.invoke('world.perspective.context.read', red.admission.resource, {}, 'ai', blue.origin)).status).toBe(403)
    expect((await fixture.invoke('world.perspective.context.read', pending.resource, {}, 'ai', { ...blue.origin, kind: 'execution', runtimeGeneration: crypto.randomUUID() })).status).toBe(403)
    expect((await fixture.invoke('world.simulation-run.inspect', fixture.runRef, {}, 'ai', blue.origin)).status).toBe(403)
  } finally { await fixture.close() }
})

test('Perspective receivers use exact held-role leases and no prompt-draft route', async () => {
  const fixture = await setup()
  try {
    const blue = await fixture.bind(await fixture.prepare(['group:blue-recce']))
    const registered = await fixture.invoke('world.perspective.presentation.register', blue.admission.resource, { clientId: 'human-document', documentId: 'document-1', roleIds: ['group:blue-recce'] })
    expect(registered.status).toBe(200)
    const recipient = registered.body.result
    const verified = await fixture.invoke('world.perspective.presentation.verify', blue.admission.resource, { recipient }, 'human', fixture.owner)
    expect(verified.status).toBe(200)
    expect(perspectivePresentationVerificationSchema.parse(verified.body.result).binding).toEqual(blue.binding)
    expect((await fixture.invoke('world.perspective.presentation.verify', blue.admission.resource, { recipient })).status).toBe(403)
    expect((await fixture.invoke('world.perspective.presentation.poll', blue.admission.resource, { recipient, roleIds: ['group:red-recce'] })).status).toBe(403)
    const target = { subject: blue.admission.resource, type: 'world.object', id: 'unit:blue-recce-1' }
    const suggested = await fixture.invoke('world.perspective.presentation.request', blue.admission.resource, { recipient, requestId: 'attention-one', target, action: { kind: 'highlight' }, purpose: 'Inspect your current unit' }, 'ai', blue.origin)
    expect(suggested.status).toBe(200)
    const polled = await fixture.invoke('world.perspective.presentation.poll', blue.admission.resource, { recipient, roleIds: ['group:blue-recce'] })
    expect(JSON.stringify(polled.body)).toContain(blue.binding.actualAgentId)
    expect(JSON.stringify(polled.body)).toContain('actual-turn')
    expect((await fixture.invoke('world.perspective.presentation.request', blue.admission.resource, { recipient, requestId: 'forbidden-draft', target, action: { kind: 'draft', text: 'Bypass composer scope' }, purpose: 'Unsupported action' }, 'ai', blue.origin)).status).toBe(400)
    const targets = await fixture.invoke('world.perspective.presentation.targets', blue.admission.resource, {}, 'ai', blue.origin)
    expect(JSON.stringify(targets.body)).not.toContain('world.composer')
    expect(JSON.stringify(targets.body)).not.toContain('"draft"')
    const revoked = await fixture.invoke('world.perspective.revoke', blue.admission.resource, { expectedRevision: 1, reason: 'Changed the screen role', roleIds: ['group:blue-recce'] })
    expect(revoked.status).toBe(200)
    expect((await fixture.invoke('world.perspective.presentation.poll', blue.admission.resource, { recipient, roleIds: ['group:blue-recce'] })).status).toBe(403)
    expect((await fixture.invoke('world.perspective.context.read', blue.admission.resource, {}, 'ai', blue.origin)).status).toBe(403)
  } finally { await fixture.close() }
})

test('revocation during suspended peer verification cannot return data or hold the World write lock', async () => {
  const fixture = await setup()
  try {
    const blue = await fixture.bind(await fixture.prepare(['group:blue-recce']))
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    fixture.waitOnPeer(async () => { entered(); await gate })
    const pending = fixture.invoke('world.perspective.context.read', blue.admission.resource, {}, 'ai', blue.origin)
    await waiting
    const revoked = await fixture.invoke('world.perspective.revoke', blue.admission.resource, { expectedRevision: 1, reason: 'Revoked during owner verification' }, 'human', fixture.owner)
    expect(revoked.status).toBe(200)
    release()
    const result = await pending
    expect(result.status).toBe(403)
    expect(JSON.stringify(result.body)).not.toContain('unit:blue-recce-1')
    const stored = await fixture.invoke('world.perspective.read', blue.admission.resource, { roleIds: ['group:blue-recce'] })
    expect(perspectiveAdmissionSchema.parse(stored.body.result)).toMatchObject({ status: 'revoked', revision: 2 })
  } finally { await fixture.close() }
})

test('binding verification races cannot reactivate a revoked pending admission', async () => {
  const fixture = await setup()
  try {
    const pending = await fixture.prepare(['group:blue-recce'])
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    fixture.waitOnPeer(async () => { entered(); await gate })
    // The helper expects success, so observe the raw Host-equivalent bind here.
    const binding = { perspective: pending.resource, admissionGeneration: pending.admissionGeneration,
      room: workspaceResourceReferenceSchema.parse({ workspaceId: pending.resource.workspaceId, moduleId: 'agents', type: 'agents.room', id: 'pending-private-room' }),
      actualAgentId: 'pending-actual-agent', runtimeGeneration: crypto.randomUUID(), templateId: 'safe-template', templateRevision: 'safe-revision' }
    const at = new Date().toISOString()
    fixture.peers.set(binding.room.id, agentsPerspectiveRoomAdmissionSchema.parse({ ...binding, status: 'prepared', revision: 0, createdAt: at, updatedAt: at }))
    const bindingCall = fixture.invoke('world.perspective.bind', pending.resource, { expectedRevision: 0, binding }, 'human', fixture.owner)
    await waiting
    const revoked = await fixture.invoke('world.perspective.revoke', pending.resource, { expectedRevision: 0, reason: 'Cancelled setup after changing the screen', roleIds: ['group:blue-recce'] })
    expect(revoked.status).toBe(200)
    release()
    expect((await bindingCall).status).toBe(409)
    const read = await fixture.invoke('world.perspective.read', pending.resource, { roleIds: ['group:blue-recce'] })
    expect(perspectiveAdmissionSchema.parse(read.body.result)).toMatchObject({ status: 'revoked', revision: 1 })
  } finally { await fixture.close() }
})

test('runtime retirement is explicit derived unavailability; reset ends old incarnations without reviving them', async () => {
  const fixture = await setup()
  try {
    const blue = await fixture.bind(await fixture.prepare(['group:blue-recce']))
    fixture.peers.set(blue.binding.room.id, { ...fixture.peers.get(blue.binding.room.id)!, status: 'revoked', revision: 2 })
    const unavailable = await fixture.invoke('world.perspective.read', blue.admission.resource, { roleIds: ['group:blue-recce'] })
    expect(perspectiveAdmissionSchema.parse(unavailable.body.result)).toMatchObject({ status: 'active', revision: 1, runtimeAvailability: { status: 'unavailable' } })
    const owner = await fixture.invoke('world.perspective.read', blue.admission.resource, {}, 'human', fixture.owner)
    expect(perspectiveAdmissionSchema.parse(owner.body.result)).toMatchObject({ status: 'active', revision: 1 })
    expect(perspectiveAdmissionSchema.parse(owner.body.result).runtimeAvailability).toBeUndefined()
    expect((await fixture.invoke('world.perspective.context.read', blue.admission.resource, {}, 'ai', blue.origin)).status).toBe(409)
    await fixture.registry.reset(fixture.run.id)
    const ended = await fixture.invoke('world.perspective.read', blue.admission.resource, { roleIds: ['group:blue-recce'] })
    expect(perspectiveAdmissionSchema.parse(ended.body.result)).toMatchObject({ status: 'revoked', revokedReason: 'The owning Run incarnation has ended' })
    expect((await fixture.invoke('world.perspective.context.read', blue.admission.resource, {}, 'ai', blue.origin)).status).toBe(403)
    const fresh = await fixture.prepare(['group:blue-recce'])
    expect(fresh.runIncarnation).not.toBe(blue.admission.runIncarnation)
    expect(fresh.admissionGeneration).not.toBe(blue.admission.admissionGeneration)
    expect(fresh.resource).not.toEqual(blue.admission.resource)
  } finally { await fixture.close() }
})
