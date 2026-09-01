import type { AgentsWorkspaceRuntime } from '../../../workspace-runtime.ts'
import type { Room } from '../../../core/types/room.ts'
import type { Agent } from '../../../core/types/agent.ts'

export const textResult = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
})

export const errorResult = (message: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
  isError: true as const,
})

export const resolveRoom = (system: AgentsWorkspaceRuntime, roomName: string): Room => {
  const room = system.rooms.getRoom(roomName)
  if (!room) throw new Error(`Room "${roomName}" not found`)
  return room
}

export const resolveAgent = (system: AgentsWorkspaceRuntime, agentName: string): Agent => {
  const agent = system.team.getAgent(agentName)
  if (!agent) throw new Error(`Agent "${agentName}" not found`)
  return agent
}
