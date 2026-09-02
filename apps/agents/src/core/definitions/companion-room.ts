import type { WorkspaceResourceReference } from '@leitbild/contracts'
import type { AgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import type { RoomProfile } from '../types/messaging.ts'
import type { RoomDefinitionLibrary } from './room-definition-library.ts'
import { startRoomDefinition } from './room-definition-service.ts'

// Runtime-scoped serialization; the durable identity is the Room's association,
// not this pending-work map or the Definition revision used to create it.
const pending = new WeakMap<AgentsWorkspaceRuntime, Map<string, Promise<RoomProfile>>>()
const keyFor = (ref: WorkspaceResourceReference): string => JSON.stringify([ref.workspaceId, ref.moduleId, ref.type, ref.id])

export const ensureCompanionRoom = async (
  runtime: AgentsWorkspaceRuntime,
  library: RoomDefinitionLibrary,
  definitionId: string,
  revisionId: string,
  resource: WorkspaceResourceReference,
  title: string,
  flush: () => Promise<void>,
): Promise<RoomProfile> => {
  const revision = await library.getRevision(revisionId)
  if (!revision || revision.definitionId !== definitionId || revision.document.companionFor !== resource.type) {
    throw new Error('Capability requires a matching companion Room Definition Revision')
  }
  let requests = pending.get(runtime)
  if (!requests) { requests = new Map(); pending.set(runtime, requests) }
  const key = keyFor(resource)
  const inflight = requests.get(key)
  if (inflight) return inflight
  const work = (async () => {
    const existing = runtime.rooms.listAllRooms().find(room => room.companionOf && keyFor(room.companionOf) === key)
    if (existing) { await flush(); return existing }
    const started = await startRoomDefinition(runtime, library, definitionId, revisionId, { resource, title })
    const room = runtime.rooms.getRoom(started.room.id)
    if (!room) throw new Error('Companion Room disappeared during creation')
    await flush()
    return room.profile
  })()
  requests.set(key, work)
  try { return await work }
  finally { requests.delete(key) }
}
