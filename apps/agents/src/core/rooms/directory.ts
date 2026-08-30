// Workspace-scoped Room collection. Owns Room identity, name uniqueness,
// lookup, restoration, and lifecycle callbacks. Workspace settings and
// bookmarks are separate services.

import type {
  CreateResult,
  OnDeliveryModeChanged,
  OnMessagePosted,
  OnModeAutoSwitched,
  OnRoomCreated,
  OnRoomDeleted,
  OnSummaryConfigChanged,
  OnSummaryUpdated,
  OnTurnChanged,
  Room,
  RoomConfig,
} from '../types/room.ts'
import type { DeliverFn, ResolveAgentName, ResolveTagFn, RoomProfile } from '../types/messaging.ts'
import { ensureUniqueName, validateName } from '../names.ts'
import { createRoom, type RoomCallbacks } from './room.ts'

export interface RoomDirectoryCallbacks {
  readonly deliver?: DeliverFn
  readonly resolveAgentName?: ResolveAgentName
  readonly resolveTag?: ResolveTagFn
  readonly resolveKind?: (id: string) => 'ai' | 'human' | undefined
  readonly onMessagePosted?: OnMessagePosted
  readonly onTurnChanged?: OnTurnChanged
  readonly onDeliveryModeChanged?: OnDeliveryModeChanged
  readonly onRoomCreated?: OnRoomCreated
  readonly onRoomDeleted?: OnRoomDeleted
  readonly onManualModeEntered?: (roomId: string) => void
  readonly onModeAutoSwitched?: OnModeAutoSwitched
  readonly onSummaryConfigChanged?: OnSummaryConfigChanged
  readonly onSummaryUpdated?: OnSummaryUpdated
  readonly onScriptMessage?: OnMessagePosted
}

export interface RoomDirectory {
  readonly createRoom: (config: RoomConfig) => Room
  readonly createRoomSafe: (config: RoomConfig) => CreateResult<Room>
  readonly getRoom: (idOrName: string) => Room | undefined
  readonly getRoomsForAgent: (agentId: string) => ReadonlyArray<Room>
  readonly listAllRooms: () => ReadonlyArray<RoomProfile>
  readonly removeRoom: (id: string) => boolean
  readonly restoreRoom: (profile: RoomProfile) => Room
}

export const createRoomDirectory = (callbacks: RoomDirectoryCallbacks = {}): RoomDirectory => {
  const rooms = new Map<string, Room>()
  const nameIndex = new Map<string, string>()

  const makeRoomCallbacks = (): RoomCallbacks => ({
    deliver: callbacks.deliver,
    resolveAgentName: callbacks.resolveAgentName,
    resolveTag: callbacks.resolveTag,
    resolveKind: callbacks.resolveKind,
    onMessagePosted: callbacks.onMessagePosted,
    onTurnChanged: callbacks.onTurnChanged,
    onDeliveryModeChanged: callbacks.onDeliveryModeChanged,
    onManualModeEntered: callbacks.onManualModeEntered,
    onModeAutoSwitched: callbacks.onModeAutoSwitched,
    onSummaryConfigChanged: callbacks.onSummaryConfigChanged,
    onSummaryUpdated: callbacks.onSummaryUpdated,
    onScriptMessage: callbacks.onScriptMessage,
  })

  const storeRoom = (config: RoomConfig, name: string): Room => {
    validateName(name, 'Room')
    const profile: RoomProfile = {
      id: crypto.randomUUID(),
      name,
      roomPrompt: config.roomPrompt,
      createdBy: config.createdBy,
      createdAt: Date.now(),
      ...(config.sourceDefinition === undefined ? {} : { sourceDefinition: config.sourceDefinition }),
    }
    const room = createRoom(profile, makeRoomCallbacks())
    rooms.set(profile.id, room)
    nameIndex.set(name.toLowerCase(), profile.id)
    callbacks.onRoomCreated?.(profile)
    return room
  }

  const getRoom = (idOrName: string): Room | undefined => {
    const byId = rooms.get(idOrName)
    if (byId) return byId
    const id = nameIndex.get(idOrName.toLowerCase())
    return id ? rooms.get(id) : undefined
  }

  return {
    createRoom: (config) => {
      if (nameIndex.has(config.name.toLowerCase())) throw new Error(`Room name "${config.name}" is already taken`)
      return storeRoom(config, config.name)
    },
    createRoomSafe: (config) => {
      const assignedName = ensureUniqueName(config.name, [...rooms.values()].map(room => room.profile.name))
      return { value: storeRoom(config, assignedName), requestedName: config.name, assignedName }
    },
    getRoom,
    getRoomsForAgent: (agentId) => [...rooms.values()].filter(room => room.hasMember(agentId)),
    listAllRooms: () => [...rooms.values()].map(room => room.profile),
    removeRoom: (id) => {
      const room = rooms.get(id)
      if (!room) return false
      nameIndex.delete(room.profile.name.toLowerCase())
      rooms.delete(id)
      callbacks.onRoomDeleted?.(id, room.profile.name)
      return true
    },
    restoreRoom: (profile) => {
      if (rooms.has(profile.id) || nameIndex.has(profile.name.toLowerCase())) {
        throw new Error(`Cannot restore duplicate Room: ${profile.id} (${profile.name})`)
      }
      const room = createRoom(profile, makeRoomCallbacks())
      rooms.set(profile.id, room)
      nameIndex.set(profile.name.toLowerCase(), profile.id)
      return room
    },
  }
}
