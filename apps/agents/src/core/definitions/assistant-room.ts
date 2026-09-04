import type { WorkspaceResourceReference } from '@leitbild/contracts'
import type { AgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import type { RoomDefinitionLibrary } from './room-definition-library.ts'
import { startRoomDefinition } from './room-definition-service.ts'

export const LEITBILD_ASSISTANT_DEFINITION_ID = 'leitbild-assistant'

export class AssistantRoomError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) { super(message) }
}

export interface AssistantRoomResult {
  readonly created: boolean
  readonly room: { readonly id: string; readonly name: string }
  readonly revisionId: string
}

export const ensureAssistantRoom = async (
  runtime: AgentsWorkspaceRuntime,
  library: RoomDefinitionLibrary,
  flush: () => Promise<void>,
  options: {
    readonly revisionId?: string
    readonly prompt?: string
    readonly focusedResources?: ReadonlyArray<WorkspaceResourceReference>
  } = {},
): Promise<AssistantRoomResult> => {
  const requestedRevision = options.revisionId === undefined
    ? await library.currentRevision(LEITBILD_ASSISTANT_DEFINITION_ID)
    : await library.getRevision(options.revisionId)
  if (!requestedRevision || requestedRevision.definitionId !== LEITBILD_ASSISTANT_DEFINITION_ID) {
    throw new AssistantRoomError(503, 'assistant_definition_unavailable', 'Leitbild Assistant Room Definition is unavailable')
  }

  const matches = runtime.rooms.listAllRooms().filter(
    room => room.sourceDefinition?.id === LEITBILD_ASSISTANT_DEFINITION_ID,
  )
  if (matches.length > 1) throw new AssistantRoomError(409, 'assistant_room_conflict', 'Workspace has more than one Leitbild Assistant Room')

  let created = false
  let room = matches[0] === undefined ? undefined : runtime.rooms.getRoom(matches[0].id)
  if (!room) {
    const started = await startRoomDefinition(
      runtime,
      library,
      LEITBILD_ASSISTANT_DEFINITION_ID,
      requestedRevision.id,
    )
    room = runtime.rooms.getRoom(started.room.id)
    if (!room) throw new AssistantRoomError(500, 'assistant_room_disappeared', 'Leitbild Assistant Room disappeared during creation')
    created = true
  }

  const participants = room.getParticipantIds().map(id => runtime.team.getAgent(id)).filter(agent => agent !== undefined)
  const human = participants.find(agent => agent.kind === 'human')
  const assistant = participants.find(agent => agent.kind === 'ai')
  if (!human || !assistant) throw new AssistantRoomError(409, 'assistant_room_incomplete', 'Leitbild Assistant Room is missing its human or AI participant; delete it and open the Assistant again')

  if (options.prompt !== undefined) {
    room.setPaused(false)
    room.post({
      senderId: human.id,
      senderName: human.name,
      content: options.prompt,
      type: 'chat',
      ...(options.focusedResources === undefined ? {} : { focusedResources: options.focusedResources }),
    })
  }
  await flush()
  return { created, room: { id: room.profile.id, name: room.profile.name }, revisionId: room.profile.sourceDefinition!.revisionId }
}
