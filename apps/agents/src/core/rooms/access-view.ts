import type { RoomDirectory } from './directory.ts'
import type { Team } from '../types/agent.ts'
import type { RoomProfile } from '../types/messaging.ts'
import { isPerspectiveScope } from './perspective-scope.ts'

export const openRoomVisible = (profile: RoomProfile): boolean => !isPerspectiveScope(profile.scope)

/** A caller-specific domain port. Internal persistence and owner admission keep
 * the full directory; public readers and ordinary tools receive this view.
 * Filtering precedes metadata, counts, lookups and mutation, rather than
 * scrubbing already assembled JSON.
 */
export const createRoomAccessView = (
  rooms: RoomDirectory,
  visible: (profile: RoomProfile) => boolean = openRoomVisible,
): RoomDirectory => {
  const getRoom: RoomDirectory['getRoom'] = key => {
    const room = rooms.getRoom(key)
    return room !== undefined && visible(room.profile) ? room : undefined
  }
  const assertOpenCreation = (scope: RoomProfile['scope'] | undefined) => {
    if (scope !== undefined && isPerspectiveScope(scope)) throw Object.assign(new Error('Perspective Rooms require owner preparation'), { code: 'perspective_preparation_required' })
  }
  return {
    getRoom,
    listAllRooms: () => rooms.listAllRooms().filter(visible),
    getRoomsForAgent: id => rooms.getRoomsForAgent(id).filter(room => visible(room.profile)),
    createRoom: config => { assertOpenCreation(config.scope); return rooms.createRoom(config) },
    createRoomSafe: config => { assertOpenCreation(config.scope); return rooms.createRoomSafe(config) },
    removeRoom: id => getRoom(id) !== undefined && rooms.removeRoom(id),
    restoreRoom: profile => { assertOpenCreation(profile.scope); return rooms.restoreRoom(profile) },
  }
}

export const createTeamAccessView = (
  team: Team,
  visible: (id: string) => boolean,
): Team => ({
  getAgent: key => { const agent = team.getAgent(key); return agent !== undefined && visible(agent.id) ? agent : undefined },
  listAgents: () => team.listAgents().filter(agent => visible(agent.id)),
  listByKind: kind => team.listByKind(kind).filter(agent => visible(agent.id)),
  listByTag: tag => team.listByTag(tag).filter(agent => visible(agent.id)),
  removeAgent: id => visible(id) && team.removeAgent(id),
  renameAgent: (id, name) => visible(id) ? team.renameAgent(id, name) : 'Agent not found',
  addAgent: team.addAgent,
})
