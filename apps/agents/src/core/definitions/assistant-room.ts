import type {
  WorkspaceResourceSubjectSelection,
  WorkspaceSubjectReference,
} from '@leitbild/contracts'
import type { AgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import type { Room } from '../types/room.ts'
import type { RoomDefinitionLibrary } from './room-definition-library.ts'
import { startRoomDefinition } from './room-definition-service.ts'

export class AssistanceRoomError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) { super(message) }
}

export interface AssistanceRoomResult {
  readonly created: boolean
  readonly room: { readonly id: string; readonly name: string }
  readonly revisionId: string
}

const pending = new WeakMap<AgentsWorkspaceRuntime, Map<string, Promise<Room>>>()

const targetKey = (selection?: WorkspaceResourceSubjectSelection): string => selection === undefined
  ? 'workspace'
  : selection.kind === 'resource'
    ? JSON.stringify(['resource', selection.resource.workspaceId, selection.resource.moduleId, selection.resource.type, selection.resource.id])
    : JSON.stringify(['collection', selection.collection.workspaceId, selection.collection.moduleId, selection.collection.type, selection.collection.id])

const sameTarget = (
  left: WorkspaceResourceSubjectSelection | undefined,
  right: WorkspaceResourceSubjectSelection | undefined,
): boolean => targetKey(left) === targetKey(right)

const resolveAssistanceRevision = async (
  library: RoomDefinitionLibrary,
  selection?: WorkspaceResourceSubjectSelection,
) => {
  const targetType = selection === undefined
    ? undefined
    : selection.kind === 'resource'
      ? selection.resource.type
      : selection.collection.type
  const records = await library.list()
  const revisions = await Promise.all(records.map(record => library.getRevision(record.currentRevisionId)))
  const matches = revisions.filter(revision => revision !== undefined && (
    targetType === undefined
      ? revision.document.assistance?.kind === 'workspace'
      : revision.document.assistance?.kind === 'resource' && revision.document.assistance.resourceType === targetType
  ))
  if (matches.length === 0) throw new AssistanceRoomError(503, 'assistance_definition_unavailable', 'No Assistance Room Definition matches this target')
  if (matches.length > 1) throw new AssistanceRoomError(409, 'assistance_definition_conflict', 'More than one Assistance Room Definition matches this target')
  return matches[0]!
}

export const createAssistanceRoom = async (
  runtime: AgentsWorkspaceRuntime,
  library: RoomDefinitionLibrary,
  flush: () => Promise<void>,
  selection: WorkspaceResourceSubjectSelection,
  title: string,
): Promise<AssistanceRoomResult> => {
  const revision = await resolveAssistanceRevision(library, selection)
  const started = await startRoomDefinition(runtime, library, revision.definitionId, revision.id, { selection, title })
  await flush()
  return { created: true, room: started.room, revisionId: revision.id }
}

export const ensureAssistanceRoom = async (
  runtime: AgentsWorkspaceRuntime,
  library: RoomDefinitionLibrary,
  flush: () => Promise<void>,
  options: {
    readonly selection?: WorkspaceResourceSubjectSelection
    readonly title?: string
    readonly prompt?: string
    readonly focusedSubjects?: ReadonlyArray<WorkspaceSubjectReference>
  } = {},
): Promise<AssistanceRoomResult> => {
  const revision = await resolveAssistanceRevision(library, options.selection)

  const key = targetKey(options.selection)
  let requests = pending.get(runtime)
  if (!requests) { requests = new Map(); pending.set(runtime, requests) }
  const inflight = requests.get(key)
  let created = inflight === undefined
  const creation = inflight ?? (async (): Promise<Room> => {
    const existing = runtime.rooms.listAllRooms()
      .filter(room => room.sourceDefinition?.id === revision.definitionId && sameTarget(room.subjectSelection, options.selection))
      .sort((left, right) => left.createdAt - right.createdAt)[0]
    if (existing) {
      created = false
      const room = runtime.rooms.getRoom(existing.id)
      if (!room) throw new AssistanceRoomError(500, 'assistance_room_disappeared', 'Assistance Room disappeared during lookup')
      return room
    }
    const started = await startRoomDefinition(
      runtime,
      library,
      revision.definitionId,
      revision.id,
      options.selection === undefined
        ? undefined
        : { selection: options.selection, title: options.title ?? 'Assistance' },
    )
    const room = runtime.rooms.getRoom(started.room.id)
    if (!room) throw new AssistanceRoomError(500, 'assistance_room_disappeared', 'Assistance Room disappeared during creation')
    return room
  })()
  if (!inflight) requests.set(key, creation)
  let room: Room
  try { room = await creation }
  finally { if (requests.get(key) === creation) requests.delete(key) }

  const participants = room.getParticipantIds().map(id => runtime.team.getAgent(id)).filter(agent => agent !== undefined)
  const human = participants.find(agent => agent.kind === 'human')
  const assistant = participants.find(agent => agent.kind === 'ai')
  if (!human || !assistant) throw new AssistanceRoomError(409, 'assistance_room_incomplete', 'Assistance Room is missing its human or AI participant')

  if (options.prompt !== undefined) {
    room.setPaused(false)
    room.post({
      senderId: human.id,
      senderName: human.name,
      content: options.prompt,
      type: 'chat',
      ...(options.focusedSubjects === undefined ? {} : { focusedSubjects: options.focusedSubjects }),
    })
  }
  await flush()
  return { created, room: { id: room.profile.id, name: room.profile.name }, revisionId: revision.id }
}
