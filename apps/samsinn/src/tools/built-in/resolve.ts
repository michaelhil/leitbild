// Shared room resolver for built-in tool implementations.
// Falls back to the current room from ToolContext if no roomName param provided.

import type { Room } from '../../core/types/room.ts'
import type { RoomDirectory } from '../../core/rooms/directory.ts'
import type { ToolContext } from '../../core/types/tool.ts'

export const resolveRoom = (rooms: RoomDirectory, params: Record<string, unknown>, context: ToolContext): Room | undefined => {
  const name = params.roomName as string | undefined
  if (name) return rooms.getRoom(name)
  if (context.roomId) return rooms.getRoom(context.roomId)
  return undefined
}
