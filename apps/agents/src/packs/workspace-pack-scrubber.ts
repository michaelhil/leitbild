import type { WorkspaceId } from '@leitbild/contracts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import type { WorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import { appendRoomsPendingScrub } from '../core/storage/module-snapshots.ts'
import { workspaceModulePaths } from '../core/paths.ts'

export type ScrubbedRoomPackSet = {
  readonly roomId: string
  readonly activePacks: ReadonlyArray<string>
}

/** Removes an uninstalled Pack from live Rooms and queues the mutation for unloaded Workspaces. */
export const createWorkspacePackScrubber = (deps: {
  readonly registry: WorkspaceRuntimeRegistry
  readonly broadcastToWorkspace: (workspaceId: WorkspaceId, message: WSOutbound) => void
}): ((packId: string) => Promise<ReadonlyArray<ScrubbedRoomPackSet>>) => async packId => {
  const scrubbedRooms: ScrubbedRoomPackSet[] = []
  const dirtyWorkspaces = new Set<WorkspaceId>()

  for (const meta of deps.registry.list()) {
    const runtime = deps.registry.tryGetLive(meta.id)
    if (!runtime) continue
    for (const profile of runtime.rooms.listAllRooms()) {
      const room = runtime.rooms.getRoom(profile.id)
      if (!room) continue
      const before = room.getActivePacks()
      if (!before.includes(packId)) continue
      const activePacks = before.filter(candidate => candidate !== packId)
      room.setActivePacks(activePacks)
      scrubbedRooms.push({ roomId: profile.id, activePacks })
      dirtyWorkspaces.add(meta.id)
      deps.broadcastToWorkspace(meta.id, {
        type: 'pack_activation_changed',
        roomId: profile.id,
        activePacks,
      })
    }
  }

  await Promise.all([...dirtyWorkspaces].map(async workspaceId => {
    const saver = deps.registry.autoSaverFor(workspaceId)
    if (!saver) throw new Error(`Missing autosaver for live Workspace ${workspaceId}`)
    await saver.flush()
  }))

  const scheduledAt = new Date().toISOString()
  await Promise.all((await deps.registry.listOnDisk()).map(async meta => {
    if (deps.registry.tryGetLive(meta.id)) return
    const result = await appendRoomsPendingScrub(
      workspaceModulePaths(meta.id).rooms.snapshot,
      { packId, scheduledAt },
    )
    if (!result.applied && result.reason !== 'no snapshot file' && result.reason !== 'already queued') {
      throw new Error(`Could not queue Pack scrub for Workspace ${meta.id}: ${result.reason ?? 'unknown reason'}`)
    }
  }))

  return scrubbedRooms
}
