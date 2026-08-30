import { createRoomDefinitionLibrary } from '../../core/definitions/room-definition-library.ts'
import { runPromptDeckEntry } from '../../core/definitions/room-definition-service.ts'
import { errorResponse, json } from './helpers.ts'
import type { RouteContext, RouteEntry } from './types.ts'

const roomDefinitionFor = async (roomId: string, context: RouteContext) => {
  const room = context.system.rooms.getRoom(roomId)
  if (!room) throw new Error(`Room "${roomId}" not found`)
  const source = room.profile.sourceDefinition
  if (!source) throw new Error('Room was not created from a Room Definition')
  const revision = await createRoomDefinitionLibrary(context.workspaceId).getRevision(source.revisionId)
  if (!revision || revision.definitionId !== source.id) throw new Error(`Room Definition Revision "${source.revisionId}" not found`)
  return revision
}

export const promptDeckRoutes: ReadonlyArray<RouteEntry> = [
  {
    method: 'GET',
    pattern: /^\/rooms\/([^/]+)\/prompt-deck$/,
    handler: async (_request, match, context) => {
      try {
        const revision = await roomDefinitionFor(decodeURIComponent(match[1]!), context)
        return json({
          definition: {
            id: revision.definitionId,
            revisionId: revision.id,
            title: revision.definition.title,
            description: revision.definition.blurb,
          },
          promptDeck: revision.definition.deck,
        })
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : 'Prompt Deck unavailable', 404)
      }
    },
  },
  {
    method: 'POST',
    pattern: /^\/rooms\/([^/]+)\/prompt-deck\/([^/]+)\/run$/,
    handler: async (_request, match, context) => {
      try {
        const roomId = decodeURIComponent(match[1]!)
        const entry = await runPromptDeckEntry(
          context.system,
          createRoomDefinitionLibrary(context.workspaceId),
          roomId,
          decodeURIComponent(match[2]!),
        )
        return json({ ran: true, entry })
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : 'Prompt Deck action failed', 400)
      }
    },
  },
]
