import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CollabAgentsWorkspaceRuntime } from '../../main.ts'

export const registerMCPResources = (mcpServer: McpServer, system: CollabAgentsWorkspaceRuntime): void => {
  mcpServer.resource(
    'rooms',
    'leitbild://rooms',
    { description: 'List of all rooms in the system', mimeType: 'application/json' },
    async () => ({
      contents: [{
        uri: 'leitbild://rooms',
        mimeType: 'application/json',
        text: JSON.stringify(system.rooms.listAllRooms(), null, 2),
      }],
    }),
  )

  mcpServer.resource(
    'agents',
    'leitbild://agents',
    { description: 'List of all agents in the system', mimeType: 'application/json' },
    async () => ({
      contents: [{
        uri: 'leitbild://agents',
        mimeType: 'application/json',
        text: JSON.stringify(
          system.team.listAgents().map(a => ({
            id: a.id, name: a.name, kind: a.kind, state: a.state.get(),
          })),
          null, 2,
        ),
      }],
    }),
  )

  mcpServer.resource(
    'room-messages',
    new ResourceTemplate('leitbild://rooms/{name}/messages', { list: undefined }),
    { description: 'Recent messages in a specific room', mimeType: 'application/json' },
    async (uri, { name }) => {
      const room = system.rooms.getRoom(name as string)
      if (!room) return { contents: [] }
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(room.getRecent(50), null, 2),
        }],
      }
    },
  )
}
