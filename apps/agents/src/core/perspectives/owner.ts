import { createHash } from 'node:crypto'
import {
  agentsPerspectiveRoomPrepareInputSchema, agentsPerspectiveRoomAdmissionSchema, perspectiveRuntimeBindingSchema,
  perspectiveViewLeaseSchema,
  type AgentsPerspectiveRoomAdmission, type PerspectiveAdmission, type PerspectiveOrigin,
  type PerspectiveRuntimeBinding, type WorldPerspectiveReference, type WorkspaceId,
  type PerspectiveViewLease,
} from '@leitbild/contracts'
import type { AIAgent, AIAgentConfig, Team } from '../types/agent.ts'
import type { Room } from '../types/room.ts'
import type { RoomDirectory } from '../rooms/directory.ts'
import type { ToolRegistry, ToolRegistryEntry } from '../types/tool.ts'
import type { PerspectiveRoomState } from '../types/perspective-room.ts'
import type { SkillStore } from '../../skills/loader.ts'
import { createSerialiseChain } from '../serialise-chain.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { agentConfigurationRevision } from '../../agents/configuration.ts'
import { effectiveAgentToolSelection } from '../../agents/spawn.ts'
import { isPerspectiveScope } from '../rooms/perspective-scope.ts'

const fail = (code: string, message: string, details?: unknown): never => {
  throw Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) })
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const toolWitness = (registry: ToolRegistry, name: string): string | undefined => {
  const entry = registry.getEntry(name)
  return entry === undefined ? undefined : hash({ name, access: entry.tool.compartmentAccess, parameters: entry.tool.parameters,
    execute: entry.tool.execute.toString(), source: { kind: entry.source.kind, pack: entry.source.pack, skill: entry.source.skill } })
}
export const skillWitness = (store: SkillStore, name: string): string | undefined => {
  const skill = store.get(name)
  return skill === undefined ? undefined : hash({ name, body: skill.body, description: skill.description, tools: skill.tools, allowedToolNames: skill.allowedToolNames, pack: skill.pack })
}
export const bindingOf = (admission: AgentsPerspectiveRoomAdmission): PerspectiveRuntimeBinding => perspectiveRuntimeBindingSchema.parse({
  perspective: admission.perspective, admissionGeneration: admission.admissionGeneration, room: admission.room,
  actualAgentId: admission.actualAgentId, runtimeGeneration: admission.runtimeGeneration,
  templateId: admission.templateId, templateRevision: admission.templateRevision,
})
const sameBinding = (left: PerspectiveRuntimeBinding, right: PerspectiveRuntimeBinding): boolean => JSON.stringify(left) === JSON.stringify(right)

export interface PerspectiveRoomsDeps {
  readonly workspaceId: WorkspaceId
  readonly enabled: () => boolean
  readonly rooms: RoomDirectory
  readonly team: Team
  readonly tools: ToolRegistry
  readonly skills: SkillStore
  readonly workspacePrompt: () => string
  readonly responseFormat: () => string
  readonly createRoom: (scope: WorldPerspectiveReference, initialize: (room: Room) => void) => Promise<Room>
  readonly spawn: (config: AIAgentConfig, actualAgentId: string) => Promise<AIAgent>
  readonly readWorld: (reference: WorldPerspectiveReference, signal?: AbortSignal) => Promise<PerspectiveAdmission>
  readonly persist: () => Promise<void>
  readonly changed: () => void
}

/** One specific admission owner, not a general grant service. Room scope is
 * immutable; World remains the authority for the perspective and its Run.
 */
export const createPerspectiveRooms = (deps: PerspectiveRoomsDeps) => {
  const serial = createSerialiseChain()
  const live = new Set<string>()
  const admittedTools = new Map<string, ReadonlyMap<string, ToolRegistryEntry>>()
  // Pilot delivery leases are subordinate to owner authority. Sixteen active
  // documents per Room bounds abandoned iframe resources while allowing the
  // three-perspective exercise and concurrent recovery windows. Never evict a
  // live reader to admit another; expired entries are reclaimed on access.
  const views = new Map<string, { lease: PerspectiveViewLease; binding: PerspectiveRuntimeBinding }>()
  const viewLeaseMs = 30_000
  const requireEnabled = () => { if (!deps.enabled()) fail('perspective_pilot_disabled', 'Perspective AI construction is installed but runtime activation is disabled') }
  const requireRoom = (roomId: string): Room => {
    const room = deps.rooms.getRoom(roomId)
    return room?.profile.perspective === undefined ? fail('perspective_room_unavailable', 'Perspective Room is unavailable') : room
  }
  const stateOf = (roomId: string): PerspectiveRoomState => requireRoom(roomId).profile.perspective!
  const read = (roomId: string): AgentsPerspectiveRoomAdmission => structuredClone(stateOf(roomId).admission)
  const save = async (room: Room) => {
    deps.changed()
    try { await deps.persist() }
    catch { fail('perspective_room_outcome_unknown', 'Perspective Room state changed but durable save is unconfirmed; read the accepted Room identity before retrying', { room: room.profile.perspective!.admission.room }) }
  }
  const current = (roomId: string, expected?: number): { room: Room; state: PerspectiveRoomState } => {
    const room = requireRoom(roomId), state = room.profile.perspective!
    if (expected !== undefined && expected !== state.admission.revision) fail('perspective_room_revision_conflict', 'Perspective Room admission changed')
    return { room, state }
  }
  const invalidate = (room: Room, reason: string) => {
    const state = room.profile.perspective!
    live.delete(state.admission.runtimeGeneration)
    admittedTools.delete(state.admission.runtimeGeneration)
    for (const [token, view] of views) if (view.binding.room.id === room.profile.id) views.delete(token)
    room.setPaused(true)
    const ai = deps.team.getAgent(state.admission.actualAgentId)
    if (ai !== undefined) { const runtime = asAIAgent(ai); runtime?.close(); runtime?.cancelGeneration() }
    if (state.admission.status !== 'revoked') room.setPerspectiveState({ ...state, admission: { ...state.admission,
      status: 'revoked', revision: state.admission.revision + 1, updatedAt: new Date().toISOString(), revokedReason: reason } }, state.admission.revision)
  }
  const assertLocal = (roomId: string): AgentsPerspectiveRoomAdmission => {
    requireEnabled()
    const state = stateOf(roomId), admission = state.admission
    if (admission.status !== 'bound' || !live.has(admission.runtimeGeneration)) fail('perspective_room_not_bound', 'This Perspective runtime is pending, revoked or belongs to an earlier process; prepare a fresh compartment')
    const runtime = deps.team.getAgent(admission.actualAgentId)
    if (runtime === undefined || !requireRoom(roomId).hasMember(admission.actualAgentId)) fail('perspective_runtime_unavailable', 'The admitted Agent runtime is unavailable')
    for (const witness of state.tools) if (deps.tools.getEntry(witness.name) !== admittedTools.get(admission.runtimeGeneration)?.get(witness.name)
      || toolWitness(deps.tools, witness.name) !== witness.digest) fail('perspective_tool_changed', 'An admitted tool was retired or replaced; prepare a fresh compartment')
    for (const witness of state.skills) if (skillWitness(deps.skills, witness.name) !== witness.digest) fail('perspective_skill_changed', 'An admitted Skill was retired or changed; prepare a fresh compartment')
    return admission
  }
  const assertLive = async (roomId: string, signal?: AbortSignal): Promise<AgentsPerspectiveRoomAdmission> => {
    signal?.throwIfAborted()
    const admitted = structuredClone(assertLocal(roomId))
    const world = await deps.readWorld(admitted.perspective, signal)
    signal?.throwIfAborted()
    const latest = assertLocal(roomId)
    if (!sameBinding(bindingOf(admitted), bindingOf(latest))) fail('perspective_binding_changed', 'The captured runtime binding is no longer current')
    if (world.status !== 'active' || world.binding === undefined || !sameBinding(bindingOf(admitted), world.binding)) {
      const room = requireRoom(roomId)
      invalidate(room, 'World perspective authority was revoked or replaced')
      await save(room)
      return fail('perspective_authority_revoked', 'World no longer admits this Perspective runtime')
    }
    return admitted
  }
  return {
    read,
    isPrivateRoom: (roomId: string) => { const room = deps.rooms.getRoom(roomId); return room !== undefined && isPerspectiveScope(room.profile.scope) },
    isPrivateAgent: (agentId: string) => {
      const agent = deps.team.getAgent(agentId), ownerRoomId = agent === undefined ? undefined : asAIAgent(agent)?.getConfig().ownerRoomId
      const room = ownerRoomId === undefined ? undefined : deps.rooms.getRoom(ownerRoomId)
      return room !== undefined && isPerspectiveScope(room.profile.scope)
    },
    isLocallyReady: (roomId: string): boolean => { try { assertLocal(roomId); return true } catch { return false } },
    assertLive,
    viewOpen: async (roomId: string, expectedRevision: number, documentId: string): Promise<PerspectiveViewLease> => {
      const admitted = await assertLive(roomId)
      current(roomId, expectedRevision)
      const now = Date.now()
      for (const [token, view] of views) if (Date.parse(view.lease.expiresAt) <= now) views.delete(token)
      const existing = [...views.values()].find(view => view.binding.room.id === roomId && view.lease.documentId === documentId)
      if (existing === undefined && [...views.values()].filter(view => view.binding.room.id === roomId).length >= 16) fail('perspective_view_capacity', 'This Room already has the pilot limit of active view documents; close an old view or wait for its lease to expire')
      const lease = perspectiveViewLeaseSchema.parse({ token: existing?.lease.token ?? crypto.randomUUID(), room: admitted.room,
        perspective: admitted.perspective, documentId, expiresAt: new Date(now + viewLeaseMs).toISOString() })
      views.set(lease.token, { lease, binding: bindingOf(admitted) })
      return structuredClone(lease)
    },
    viewClose: (token: string, documentId: string): void => {
      const existing = views.get(token)
      if (existing?.lease.documentId === documentId) views.delete(token)
    },
    viewLocal: (token: string): PerspectiveViewLease | undefined => {
      const view = views.get(token)
      if (view === undefined) return undefined
      if (Date.parse(view.lease.expiresAt) <= Date.now()) { views.delete(token); return undefined }
      try { const admission = assertLocal(view.binding.room.id); return sameBinding(bindingOf(admission), view.binding) ? structuredClone(view.lease) : undefined }
      catch { return undefined } // A locked local admission grants no transport access.
    },
    viewAuthorize: async (token: string): Promise<PerspectiveViewLease> => {
      const view = views.get(token)
      if (view === undefined || Date.parse(view.lease.expiresAt) <= Date.now()) { views.delete(token); return fail('perspective_view_unavailable', 'This Perspective document view has expired or was closed') }
      const admitted = await assertLive(view.binding.room.id)
      const latest = views.get(token)
      if (latest === undefined || latest.lease.documentId !== view.lease.documentId || Date.parse(latest.lease.expiresAt) <= Date.now()
        || !sameBinding(latest.binding, view.binding) || !sameBinding(bindingOf(admitted), view.binding)) return fail('perspective_view_unavailable', 'This exact Perspective document view is no longer current')
      return structuredClone(latest.lease)
    },
    executionOrigin: (roomId: string, actualAgentId: string, turnId: string): Extract<PerspectiveOrigin, { kind: 'execution' }> => {
      const admission = assertLocal(roomId)
      if (admission.actualAgentId !== actualAgentId) fail('perspective_runtime_mismatch', 'Only the actual admitted Agent may execute in this compartment')
      return { kind: 'execution', roomId: admission.room.id, actualAgentId, runtimeGeneration: admission.runtimeGeneration,
        turnId, perspectiveId: admission.perspective.id, admissionGeneration: admission.admissionGeneration }
    },
    prepare: (raw: unknown) => serial.run(async (): Promise<AgentsPerspectiveRoomAdmission> => {
      requireEnabled()
      const input = agentsPerspectiveRoomPrepareInputSchema.parse(raw)
      if (input.perspective.workspaceId !== deps.workspaceId) fail('perspective_workspace_mismatch', 'Perspective belongs to another Workspace')
      const existing = deps.rooms.listAllRooms().find(profile => profile.perspective?.requestId === input.requestId)
      if (existing !== undefined) {
        const admission = existing.perspective!.admission
        if (admission.perspective.id !== input.perspective.id || admission.admissionGeneration !== input.admissionGeneration
          || admission.templateId !== input.templateId || admission.templateRevision !== input.templateRevision) fail('perspective_preparation_conflict', 'Preparation identity is already used for different input')
        await save(requireRoom(existing.id))
        return read(existing.id)
      }
      const world = await deps.readWorld(input.perspective)
      if (world.status !== 'pending' || world.admissionGeneration !== input.admissionGeneration || JSON.stringify(world.resource) !== JSON.stringify(input.perspective)) fail('perspective_not_pending', 'World Perspective is not the requested pending admission')
      const template = deps.team.getAgent(input.templateId), ai = template === undefined ? undefined : asAIAgent(template)
      if (ai === undefined) return fail('perspective_template_unavailable', 'Choose an existing public AI Agent template')
      const config = structuredClone(ai.getConfig())
      if ((config.triggers?.length ?? 0) > 0) fail('perspective_template_triggers_unsupported', 'The pilot cannot copy scheduled triggers; choose a public template with no triggers')
      const owner = config.ownerRoomId === undefined ? undefined : deps.rooms.getRoom(config.ownerRoomId)
      if (owner !== undefined && isPerspectiveScope(owner.profile.scope)) fail('perspective_template_private', 'A private runtime cannot become another perspective template')
      if (agentConfigurationRevision(config) !== input.templateRevision) fail('perspective_template_revision_conflict', 'Agent template changed; inspect its canonical configuration revision')
      const selectedEntries = new Map<string, ToolRegistryEntry>()
      const tools = effectiveAgentToolSelection(config).concat('pass').filter((name, index, all) => all.indexOf(name) === index).map(name => {
        const entry = deps.tools.getEntry(name), digest = toolWitness(deps.tools, name)
        if (entry?.source.kind !== 'built-in' || entry.tool.compartmentAccess === undefined || digest === undefined) return fail('perspective_tool_not_admitted', `Selected tool ${name} has no trusted built-in owner compartment declaration`)
        selectedEntries.set(name, entry)
        return { name, digest }
      })
      const skills = (config.skills ?? []).map(name => {
        const skill = deps.skills.get(name), digest = skillWitness(deps.skills, name)
        if (skill === undefined || digest === undefined) return fail('perspective_skill_unavailable', 'A selected Skill is unavailable')
        if (skill.pack !== undefined) fail('perspective_skill_pack_unavailable', 'The first pilot supports explicit built-in/authored Skill snapshots; Pack activation needs its own admitted selection')
        return { name, digest, description: skill.description, body: skill.body, allowedToolNames: [...skill.allowedToolNames] }
      })
      const actualAgentId = crypto.randomUUID(), at = new Date().toISOString()
      const room = await deps.createRoom(input.perspective, prepared => {
        const admission = agentsPerspectiveRoomAdmissionSchema.parse({ perspective: input.perspective, admissionGeneration: input.admissionGeneration,
          room: { workspaceId: deps.workspaceId, moduleId: 'agents', type: 'agents.room', id: prepared.profile.id },
          actualAgentId, runtimeGeneration: crypto.randomUUID(), templateId: input.templateId, templateRevision: input.templateRevision,
          status: 'prepared', revision: 0, createdAt: at, updatedAt: at })
        prepared.setPerspectiveState({ requestId: input.requestId, admission, tools, skills, workspacePrompt: deps.workspacePrompt(), responseFormat: deps.responseFormat() })
        prepared.setPaused(true)
      })
      const admission = room.profile.perspective!.admission
      // Register the generation before constructing its runtime. Prepared is
      // still non-callable; no join/chat message is created during bootstrap.
      live.add(admission.runtimeGeneration)
      admittedTools.set(admission.runtimeGeneration, selectedEntries)
      let runtimePrepared = false
      try {
        const runtime = await deps.spawn({ ...config, name: `Perspective Assistant ${actualAgentId.slice(0, 8)}`, ownerRoomId: room.profile.id,
          tools: tools.map(tool => tool.name), triggers: [] }, actualAgentId)
        room.addMember(runtime.id)
        await runtime.join(room)
        runtimePrepared = true
        await save(room)
      } catch (error) {
        // The Room/runtime may already be accepted; retain its identity rather
        // than deleting evidence or claiming the preparation rolled back.
        if (!runtimePrepared) invalidate(room, 'Preparation failed before a complete runtime was admitted')
        fail('perspective_preparation_outcome_unknown', 'Perspective preparation did not finish; read the accepted Room before retrying', { room: admission.room, cause: error instanceof Error && 'code' in error ? error.code : 'preparation_failed' })
      }
      return read(room.profile.id)
    }),
    bind: (roomId: string, expectedRevision: number) => serial.run(async () => {
      requireEnabled()
      const { room, state } = current(roomId, expectedRevision)
      if (state.admission.status !== 'prepared' || !live.has(state.admission.runtimeGeneration)) fail('perspective_room_not_prepared', 'Only the prepared live runtime can be bound')
      const world = await deps.readWorld(state.admission.perspective)
      current(roomId, expectedRevision)
      if (world.status !== 'active' || world.binding === undefined || !sameBinding(bindingOf(state.admission), world.binding)) fail('perspective_world_not_bound', 'World has not activated this exact Room/runtime binding')
      room.setPerspectiveState({ ...state, admission: { ...state.admission, status: 'bound', revision: expectedRevision + 1, updatedAt: new Date().toISOString() } }, expectedRevision)
      room.setPaused(false)
      await save(room)
      return read(roomId)
    }),
    revoke: (roomId: string, expectedRevision: number, reason: string) => serial.run(async () => {
      const { room, state } = current(roomId, expectedRevision)
      if (state.admission.status !== 'revoked') invalidate(room, reason)
      await save(room)
      return read(roomId)
    }),
    /** An explicit process lifecycle transition, never a snapshot migration. */
    invalidateRestored: (): boolean => {
      let changed = false
      for (const profile of deps.rooms.listAllRooms()) {
        const state = profile.perspective
        if (state !== undefined && state.admission.status !== 'revoked' && !live.has(state.admission.runtimeGeneration)) {
          invalidate(requireRoom(profile.id), 'Runtime restarted; create a fresh compartment. Retained evidence remains private.')
          changed = true
        }
      }
      return changed
    },
  }
}
export type PerspectiveRooms = ReturnType<typeof createPerspectiveRooms>
