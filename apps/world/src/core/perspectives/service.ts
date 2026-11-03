import {
  agentsPerspectiveRoomAdmissionSchema, perspectiveRuntimeBindingSchema,
  type AccessContext, type AgentsPerspectiveRoomAdmission, type PerspectiveAdmission,
  type PerspectiveRuntimeBinding, type WorkspaceResourceReference,
  perspectivePilotPolicySchema, type PerspectivePilotPolicy,
} from '@leitbild/contracts'
import type { Actor } from '../simulation-runs/actors.ts'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../simulation-runs/runtime.ts'
import { resolveRunPerspective, assertHoldsRole } from '../simulation-runs/role-gates.ts'
import { actorIdSchema, type SimulationRunId } from '../model/ids.ts'
import { perspectiveFailure, type StoredPerspective } from './model.ts'
import { perspectiveRoleDigest, type PerspectiveStore } from './store.ts'
import { mapWithConcurrency, workspaceFanOutLimit } from '../storage/bounded-fan-out.ts'

/** Supplying this explicit owner dependency is construction/test admission, not product activation. */
export interface WorldPerspectivePilotConfig extends PerspectivePilotPolicy {
  readonly readAgentsAdmission: (binding: PerspectiveRuntimeBinding) => Promise<AgentsPerspectiveRoomAdmission>
  /** A revoked response confirms closed admission and requested cooperative cancellation,
   * never that an uncooperative provider stopped or prior effects rolled back. */
  readonly revokeAgentsAdmission: (binding: PerspectiveRuntimeBinding, reason: string) => Promise<AgentsPerspectiveRoomAdmission>
}
export interface AdmittedPerspective {
  readonly record: StoredPerspective
  readonly runtime: SimulationRunRuntime
  /** World-stamped held role/class, retaining the actual Agent attribution for read-only adapters. */
  readonly actor: Actor
  readonly access: AccessContext
  readonly current: () => boolean
  readonly assertFresh: () => Promise<void>
}
type RunPort = Pick<SimulationRunRegistry, 'workspaceId' | 'load' | 'runRoles' | 'acquireLease' | 'presentation'>
const bindingKey = (binding: PerspectiveRuntimeBinding): string => JSON.stringify([
  binding.perspective, binding.admissionGeneration, binding.room, binding.actualAgentId,
  binding.runtimeGeneration, binding.templateId, binding.templateRevision,
])
const sameBinding = (a: PerspectiveRuntimeBinding, b: PerspectiveRuntimeBinding): boolean => bindingKey(a) === bindingKey(b)

export const createWorldPerspectiveService = (config: { store: PerspectiveStore; runs: RunPort; pilot: WorldPerspectivePilotConfig }) => {
  const pilot = perspectivePilotPolicySchema.parse({ enabled: config.pilot.enabled, workspaceIds: config.pilot.workspaceIds })
  const enabled = (): boolean => pilot.enabled && pilot.workspaceIds.includes(config.runs.workspaceId)
  const requireEnabled = (): void => { if (!enabled()) throw perspectiveFailure('perspective_pilot_disabled', 'Perspective admission is closed for this Workspace', 404) }
  const known = new Map<string, StoredPerspective>()
  const invalidated = new Set<string>()
  const remember = (record: StoredPerspective): StoredPerspective => { known.set(record.admission.resource.id, record); return record }
  const requireOwner = (access: AccessContext, allowed: ReadonlyArray<'host' | 'world' | 'agents'>): void => {
    const origin = access.perspectiveOrigin
    if (origin?.kind !== 'owner' || !allowed.includes(origin.moduleId)) throw perspectiveFailure('perspective_owner_required', 'This exact admission port requires an internal owner relationship')
  }
  const rolesOf = async (runId: SimulationRunId, roleIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
    const declaration = await config.runs.runRoles(runId)
    if (declaration === null) throw perspectiveFailure('perspective_role_run_required', 'The restricted pilot requires a Run that declares human roles', 422)
    const perspective = resolveRunPerspective(declaration, roleIds)
    assertHoldsRole(perspective)
    if (perspective.kind !== 'roles') throw perspectiveFailure('perspective_roles_required', 'Select the held human role set', 400)
    return perspective.roleIds
  }
  const requireHuman = async (record: StoredPerspective, access: AccessContext, roleIds?: ReadonlyArray<string>): Promise<void> => {
    if (access.actor.kind !== 'human' || access.perspectiveOrigin?.kind === 'execution' || roleIds === undefined) throw perspectiveFailure('perspective_holder_required', 'This management operation requires the current human screen role set')
    if (perspectiveRoleDigest(roleIds) !== record.admission.roleSetDigest) throw perspectiveFailure('perspective_role_changed', 'The screen no longer holds this Perspective; prepare a fresh admission')
  }
  const verifyPeer = async (binding: PerspectiveRuntimeBinding, statuses: ReadonlyArray<AgentsPerspectiveRoomAdmission['status']>): Promise<void> => {
    const peer = agentsPerspectiveRoomAdmissionSchema.parse(await config.pilot.readAgentsAdmission(binding))
    if (!statuses.includes(peer.status) || peer.runtimeAvailability?.status !== 'available' || !sameBinding(peer, binding)) throw perspectiveFailure('perspective_runtime_unavailable', 'The exact scoped Agents runtime is unavailable; prepare a fresh admission', 409)
  }
  const fresh = async (record: StoredPerspective, peer = true): Promise<StoredPerspective> => {
    requireEnabled()
    const latest = remember(await config.store.read(record.admission.resource.id))
    await config.store.assertCurrent(latest)
    if (latest.admission.status !== 'active' || latest.admission.revision !== record.admission.revision || latest.admission.binding === undefined
      || record.admission.binding === undefined || !sameBinding(latest.admission.binding, record.admission.binding)) throw perspectiveFailure('perspective_admission_changed', 'The Perspective admission is no longer current', 409)
    if (peer) {
      try { await verifyPeer(latest.admission.binding, ['bound']) }
      catch (error) {
        // World revocation during the owner read remains authoritative even
        // when the peer's cancellation completes before its reply returns.
        await fresh(latest, false)
        throw error
      }
      return fresh(latest, false)
    }
    return latest
  }
  const actorOf = async (record: StoredPerspective, access: AccessContext): Promise<Actor> => {
    const declaration = await config.runs.runRoles(record.runId)
    const perspective = resolveRunPerspective(declaration, record.roleIds)
    if (perspective.kind !== 'roles') throw perspectiveFailure('perspective_roles_unavailable', 'The admitted role set is unavailable', 409)
    const actualId = record.admission.binding?.actualAgentId
    return {
      id: actorIdSchema.parse(actualId === undefined ? `actor:perspective:${record.admission.resource.id}` : `actor:ai:${actualId}`),
      label: actualId === undefined ? 'Perspective holder' : `Scoped Agent ${actualId}`,
      ...(access.actor.displayName === undefined ? {} : { displayName: access.actor.displayName }),
      role: perspective.roleClass, roleIds: perspective.roleIds, readOnlyAgent: true,
    }
  }
  const withRecord = async <T>(record: StoredPerspective, access: AccessContext, work: (context: AdmittedPerspective) => Promise<T>): Promise<T> => {
    await fresh(record)
    const release = config.runs.acquireLease(record.runId, 'api')
    try {
      const runtime = await config.runs.load(record.runId), actor = await actorOf(record, access)
      await fresh(record)
      const visibility = () => {
        const policy = runtime.inspectionPolicy(actor)
        return JSON.stringify([runtime.snapshot().scenario?.agentRestrictions.revision,
          runtime.snapshot().objects.filter(object => policy.canInspect(object.id)).map(object => object.id).sort()])
      }
      const visibleBefore = visibility()
      const current = () => !invalidated.has(record.admission.resource.id)
        && known.get(record.admission.resource.id)?.admission.status === 'active'
        && known.get(record.admission.resource.id)?.admission.revision === record.admission.revision
      const result = await work({ record, runtime, actor, access, current, assertFresh: async () => { await fresh(record) } })
      await fresh(record)
      if (visibility() !== visibleBefore) throw perspectiveFailure('perspective_inspection_changed', 'The permitted inspection picture changed during this read; acquire a new result', 409)
      return result
    } finally { release() }
  }
  const clearRecord = (record: StoredPerspective): void => {
    invalidated.add(record.admission.resource.id)
    config.runs.presentation.clear(record.admission.resource)
  }
  const notifyPeer = async (record: StoredPerspective, reason: string): Promise<void> => {
    const binding = record.admission.binding
    if (binding === undefined) return
    try {
      const peer = agentsPerspectiveRoomAdmissionSchema.parse(await config.pilot.revokeAgentsAdmission(binding, reason))
      if (peer.status !== 'revoked' || !sameBinding(peer, binding)) throw new Error('The exact peer admission did not confirm revocation')
    } catch {
      throw perspectiveFailure('perspective_peer_revocation_unconfirmed', 'World ended this admission, but the Agents cancellation request was not confirmed; read back the exact admission before retrying', 503,
        { resource: record.admission.resource, acceptedWorldRevision: record.admission.revision })
    }
  }
  return {
    enabled,
    prepare: async (runId: SimulationRunId, input: { roleIds: ReadonlyArray<string>; requestId: string }, access: AccessContext): Promise<PerspectiveAdmission> => {
      requireEnabled()
      if (access.actor.kind !== 'human' || access.perspectiveOrigin?.kind === 'execution') throw perspectiveFailure('perspective_prepare_for_people', 'Only the human screen prepares a held-role Perspective')
      const roleIds = await rolesOf(runId, input.roleIds)
      const record = remember(await config.store.prepare({ runId, roleIds, requestId: input.requestId }))
      return config.store.admission(record)
    },
    read: async (id: string, access: AccessContext, roleIds?: ReadonlyArray<string>): Promise<PerspectiveAdmission> => {
      // Guard before lookup: ordinary unscoped Agent calls cannot use this as a private Room directory.
      if (access.perspectiveOrigin?.kind === 'owner') requireOwner(access, ['host', 'agents'])
      else if (access.actor.kind !== 'human' || roleIds === undefined) throw perspectiveFailure('perspective_holder_required', 'This admission is not a public Resource directory')
      const record = remember(await config.store.read(id))
      if (access.perspectiveOrigin?.kind !== 'owner') await requireHuman(record, access, roleIds)
      const admission = await config.store.admission(record)
      if (access.perspectiveOrigin?.kind === 'owner' || admission.status !== 'active' || admission.binding === undefined) return { ...admission,
        runtimeAvailability: { status: enabled() && admission.status !== 'revoked' ? 'available' : 'unavailable' } }
      try {
        await fresh(record)
        return { ...admission, runtimeAvailability: { status: 'available' } }
      } catch {
        return { ...await config.store.admission(record), runtimeAvailability: { status: 'unavailable', reason: 'The current scoped runtime relationship could not be established; start fresh rather than rebinding it' } }
      }
    },
    bind: async (id: string, input: { expectedRevision: number; binding: PerspectiveRuntimeBinding }, access: AccessContext): Promise<PerspectiveAdmission> => {
      requireEnabled()
      requireOwner(access, ['host'])
      const record = remember(await config.store.read(id)), binding = perspectiveRuntimeBindingSchema.parse(input.binding)
      await config.store.assertCurrent(record)
      if (record.admission.status !== 'pending' || record.admission.revision !== input.expectedRevision) throw perspectiveFailure('perspective_revision_conflict', 'Read the pending admission before binding it', 409)
      if (binding.perspective.workspaceId !== config.runs.workspaceId || binding.perspective.id !== id || binding.admissionGeneration !== record.admission.admissionGeneration) throw perspectiveFailure('perspective_binding_mismatch', 'The binding names another Perspective admission', 409)
      // Cross-Module verification is deliberately outside the record's write serialization.
      await verifyPeer(binding, ['prepared', 'bound'])
      const next = remember(await config.store.change(id, input.expectedRevision, current => ({ ...current,
        admission: { ...current.admission, status: 'active', revision: current.admission.revision + 1, binding, updatedAt: new Date().toISOString() } })))
      return config.store.admission(next)
    },
    revoke: async (id: string, input: { expectedRevision: number; reason: string; roleIds?: ReadonlyArray<string> }, access: AccessContext): Promise<PerspectiveAdmission> => {
      if (access.perspectiveOrigin?.kind === 'owner') requireOwner(access, ['host', 'agents'])
      else if (access.actor.kind !== 'human' || input.roleIds === undefined) throw perspectiveFailure('perspective_holder_required', 'This operation requires the held human perspective')
      const record = remember(await config.store.read(id))
      if (access.perspectiveOrigin?.kind !== 'owner') await requireHuman(record, access, input.roleIds)
      if (record.admission.revision !== input.expectedRevision) throw perspectiveFailure('perspective_revision_conflict', 'Read the admission before retrying', 409)
      const effective = await config.store.admission(record)
      if (effective.status === 'revoked') {
        clearRecord(record)
        await notifyPeer(record, input.reason)
        return effective
      }
      const next = remember(await config.store.change(id, input.expectedRevision, current => ({ ...current,
        admission: { ...current.admission, status: 'revoked', revision: current.admission.revision + 1, revokedReason: input.reason, updatedAt: new Date().toISOString() } })))
      clearRecord(next)
      // The World CAS/save is finished. No cross-owner call holds its write lock.
      await notifyPeer(next, input.reason)
      return next.admission
    },
    withExecution: async <T>(id: string, access: AccessContext, work: (context: AdmittedPerspective) => Promise<T>): Promise<T> => {
      const origin = access.perspectiveOrigin
      if (origin?.kind !== 'execution' || access.actor.kind !== 'ai' || access.actor.id !== origin.actualAgentId || origin.perspectiveId !== id) throw perspectiveFailure('perspective_execution_required', 'This read requires its actual scoped Room execution')
      const record = remember(await config.store.read(id)), binding = record.admission.binding
      if (binding === undefined || binding.admissionGeneration !== origin.admissionGeneration || binding.room.id !== origin.roomId || binding.actualAgentId !== origin.actualAgentId || binding.runtimeGeneration !== origin.runtimeGeneration) throw perspectiveFailure('perspective_binding_mismatch', 'This execution does not belong to the admitted Room/runtime')
      return withRecord(record, access, work)
    },
    withHuman: async <T>(id: string, roleIds: ReadonlyArray<string>, access: AccessContext, work: (context: AdmittedPerspective) => Promise<T>): Promise<T> => {
      if (access.actor.kind !== 'human') throw perspectiveFailure('perspective_holder_required', 'Only a human screen owns a browser receiver')
      const record = remember(await config.store.read(id))
      await requireHuman(record, access, roleIds)
      return withRecord(record, access, work)
    },
    withOwner: async <T>(id: string, access: AccessContext, work: (context: AdmittedPerspective) => Promise<T>): Promise<T> => {
      requireOwner(access, ['host'])
      const record = remember(await config.store.read(id))
      return withRecord(record, access, work)
    },
    invalidateRun: async (runId: SimulationRunId): Promise<void> => {
      await config.store.rotateRun(runId)
      for (const record of known.values()) if (record.runId === runId) clearRecord(record)
    },
    clearRunPresentation: (runId: SimulationRunId): void => {
      for (const record of known.values()) if (record.runId === runId) config.runs.presentation.clear(record.admission.resource)
    },
    notifyRunPeers: async (runId: SimulationRunId, reason: string): Promise<void> => {
      // Reset/delete call this only after releasing their Run lifecycle locks.
      // Cold persisted bindings matter even if this process has not read them.
      let records: ReadonlyArray<StoredPerspective>
      try { records = await config.store.listForRun(runId) }
      catch {
        console.warn(JSON.stringify({ event: 'world.perspective.peer-revocation-unconfirmed', runId, worldAdmissionEnded: true, reason: 'Stored binding lookup could not be established; inspect owned Perspective admissions' }))
        return
      }
      await mapWithConcurrency(records, workspaceFanOutLimit, async record => {
        // A fresh admission may have been prepared after the lifecycle lock
        // released. Only ended incarnations/admissions belong to this notice.
        if ((await config.store.admission(record)).status !== 'revoked') return
        clearRecord(remember(record))
        try { await notifyPeer(record, reason) }
        catch {
          // The existing World process owner log retains this operational warning;
          // public Run/reset results never enumerate another compartment's binding.
          console.warn(JSON.stringify({ event: 'world.perspective.peer-revocation-unconfirmed', resource: record.admission.resource, acceptedWorldRevision: record.admission.revision, worldAdmissionEnded: true, reason: 'Agents cooperative cancellation request was not confirmed' }))
        }
      })
    },
  }
}
export type WorldPerspectiveService = ReturnType<typeof createWorldPerspectiveService>
