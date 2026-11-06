import {
  presentationPromptEvidenceInputSchema, presentationPromptEvidenceSchema, workspaceResourceCatalogSchema,
  type PresentationPromptEvidence, type WorkspaceId,
} from '@leitbild/contracts'
import type { RoomDirectory } from '../core/rooms/directory.ts'
import type { ExecutionStore } from '../core/executions/store.ts'
import { resolveScope } from '../tools/built-in/workspace-capability-tools.ts'

const key = (value: { workspaceId: string; moduleId: string; type: string; id: string }): string =>
  `${value.workspaceId}:${value.moduleId}:${value.type}:${value.id}`
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }

/** Reads canonical retained Messages and their actual execution links, never browser claims about an answer. */
export const readPromptEvidence = async (deps: {
  workspaceId: WorkspaceId; rooms: RoomDirectory; executionStore: ExecutionStore; hostBaseUrl?: string; fetchImpl?: typeof fetch;
}, roomId: string, raw: unknown): Promise<PresentationPromptEvidence> => {
  const input = presentationPromptEvidenceInputSchema.parse(raw)
  if (input.subject.workspaceId !== deps.workspaceId || input.subject.moduleId !== 'world') fail('prompt_evidence_subject_invalid', 'The prompt subject must be a World Resource in this Workspace')
  const room = deps.rooms.getRoom(roomId)
  if (room === undefined) return fail('room_not_found', 'The requested Room is unavailable')
  const scope = room.profile.scope, revision = room.profile.scopeRevision
  let allowed = scope.kind === 'resource' && key(scope.resource) === key(input.subject)
  if (scope.kind === 'collection') {
    if (deps.hostBaseUrl === undefined) fail('workspace_host_unavailable', 'Current collection membership requires the Workspace Host')
    const response = await (deps.fetchImpl ?? fetch)(`${deps.hostBaseUrl}/api/workspaces/${deps.workspaceId}/resources`, { signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json' } })
    if (!response.ok) fail('prompt_evidence_scope_unavailable', `The Workspace Host could not verify current collection membership (HTTP ${response.status})`)
    const catalog = workspaceResourceCatalogSchema.parse(await response.json())
    if (catalog.workspaceId !== deps.workspaceId) fail('prompt_evidence_scope_invalid', 'The Resource catalog belongs to another Workspace')
    allowed = resolveScope(scope, catalog.resources, []).resourceKeys.has(key(input.subject))
  }
  if (deps.rooms.getRoom(roomId) !== room || room.profile.scopeRevision !== revision) fail('prompt_evidence_scope_changed', 'The Room Scope changed; read current evidence again')
  if (!allowed) fail('prompt_evidence_scope_mismatch', 'This Room is not scoped to the requested World Resource or an allowed collection member')
  const messages = room.getRetainedMessages()
  const prompt = messages.find(message => message.id === input.messageId && message.type === 'chat'
    && message.presentationPrompt?.requestId === input.requestId && key(message.presentationPrompt.subject) === key(input.subject))
  const roomRef = { workspaceId: deps.workspaceId, moduleId: 'agents', type: 'agents.room', id: room.profile.id }
  if (prompt === undefined) return presentationPromptEvidenceSchema.parse({ requestId: input.requestId, messageId: input.messageId, room: roomRef, found: false, responses: [] })
  const responses = messages.flatMap(message => {
    if (!message.inReplyTo?.includes(prompt.id) || message.progress === true || !['chat', 'error'].includes(message.type) || message.generationTraceId === undefined) return []
    const turn = deps.executionStore.getTurn(room.profile.id, message.generationTraceId)
    if (turn === undefined || turn.agentId !== message.senderId || turn.messageId !== message.id) return []
    return [{ messageId: message.id, senderId: message.senderId, at: message.timestamp, kind: message.type,
      turnId: turn.id, executionStatus: turn.status, ...(turn.finishedAt === undefined ? {} : { finishedAt: turn.finishedAt }) }]
  })
  return presentationPromptEvidenceSchema.parse({ requestId: input.requestId, messageId: prompt.id, room: roomRef, found: true,
    submission: { messageId: prompt.id, senderId: prompt.senderId, ...(prompt.senderName === undefined ? {} : { senderName: prompt.senderName }), at: prompt.timestamp, source: prompt.presentationPrompt }, responses })
}
