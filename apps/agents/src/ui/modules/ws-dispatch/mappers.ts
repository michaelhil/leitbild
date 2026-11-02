// Wire-format mappers: server types (Message, AgentProfile, RoomProfile)
// → UI types. Kept pure so ws-dispatch stays focused on routing, and so
// these can be unit-tested in isolation.

import type { UIMessage, RoomProfile } from '../render/render-types.ts'
import type { Message, AgentProfile, RoomProfile as ServerRoomProfile } from '../../../core/types/messaging.ts'
import type { AgentEntry } from '../stores.ts'
import type { WSOutbound } from '../../../core/types/ws-protocol.ts'

/** Human authors are not execution members of a private Room. Keep the
 * owner's admitted public-human projection so its composer can ask who posts. */
export const snapshotAgentsForView = (
  snapshot: Extract<WSOutbound, { type: 'snapshot' }>,
  roomId: string | null,
): ReadonlyArray<AgentProfile> => {
  if (roomId === null) return snapshot.agents
  const members = new Set(snapshot.roomStates?.[roomId]?.members ?? [])
  const privateRoom = snapshot.rooms.find(room => room.id === roomId)?.perspective !== undefined
  return snapshot.agents.filter(agent => members.has(agent.id) || privateRoom && agent.kind === 'human')
}

export const toUIMessage = (m: Message): UIMessage => ({
  id: m.id,
  senderId: m.senderId,
  ...(m.senderName !== undefined ? { senderName: m.senderName } : {}),
  content: m.content,
  timestamp: m.timestamp,
  type: m.type,
  roomId: m.roomId,
  generationMs: m.generationMs,
  ...(m.generationTraceId !== undefined ? { generationTraceId: m.generationTraceId } : {}),
  ...(m.promptTokens !== undefined ? { promptTokens: m.promptTokens } : {}),
  ...(m.lastPromptTokens !== undefined ? { lastPromptTokens: m.lastPromptTokens } : {}),
  ...(m.completionTokens !== undefined ? { completionTokens: m.completionTokens } : {}),
  ...(m.cacheCreation !== undefined ? { cacheCreation: m.cacheCreation } : {}),
  ...(m.cacheRead !== undefined ? { cacheRead: m.cacheRead } : {}),
  ...(m.cacheMiss !== undefined ? { cacheMiss: m.cacheMiss } : {}),
  ...(m.modelCalls !== undefined ? { modelCalls: m.modelCalls } : {}),
  ...(m.contextMax !== undefined ? { contextMax: m.contextMax } : {}),
  ...(m.provider !== undefined ? { provider: m.provider } : {}),
  ...(m.model !== undefined ? { model: m.model } : {}),
  ...(m.errorCode !== undefined ? { errorCode: m.errorCode } : {}),
  ...(m.errorProvider !== undefined ? { errorProvider: m.errorProvider } : {}),
  // Causality metadata drives the "via script: X" caption and biometric
  // system-message markdown routing. Without this, every live message
  // arrives at the UI with cause=undefined regardless of what the server
  // stamped.
  ...(m.cause ? { cause: m.cause } : {}),
  // A display-request reply links back to its answer through inReplyTo[0].
  ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
  ...(m.progress ? { progress: true as const } : {}),
  ...(m.progressEvidence ? { progressEvidence: m.progressEvidence } : {}),
  ...(m.attachments ? { attachments: m.attachments } : {}),
  ...(m.toolTrace ? { toolTrace: m.toolTrace } : {}),
})

export const toUIRoomProfile = (r: ServerRoomProfile): RoomProfile => ({
  id: r.id,
  name: r.name,
  ...(r.perspective === undefined ? {} : { perspective: { admission: r.perspective.admission } }),
})

export const toAgentEntry = (a: AgentProfile): AgentEntry => ({
  id: a.id,
  name: a.name,
  kind: a.kind,
  model: a.model,
  // Honor the snapshot's state/context/generationStarted when present, so a
  // tab reload mid-generation reconstructs the thinking indicator. Default
  // to 'idle' for fresh agent_joined events that don't carry these fields.
  state: a.state ?? 'idle',
  ...(a.context ? { context: a.context } : {}),
  ...(a.generationStarted !== undefined ? { generationStarted: a.generationStarted } : {}),
})
