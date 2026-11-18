// Browser-safe request contract. Revisions remain ordinary Room messages;
// this relation identifies one immutable Mermaid fence and one agent request.
import { marked } from 'marked'
import type { MessageCause } from './types/messaging.ts'

export const DIAGRAM_REQUEST_CAUSE = 'diagram-request'

export interface DiagramRequestBody {
  readonly requesterId: string
  readonly diagramIndex: number
  readonly source: string
  readonly initialSource: string
  readonly instruction: string
}

export interface DiagramRequestAccepted {
  readonly requestId: string
  readonly queued: boolean
}

export const diagramRequestPath = (roomId: string, messageId: string): string =>
  `/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/diagram-request`

export const isMermaidLanguage = (language: string | undefined): boolean =>
  language?.trim().split(/\s+/, 1)[0]?.toLowerCase() === 'mermaid'

// Use the same Markdown grammar/traversal as the message renderer, including
// tilde fences, nested blockquotes/lists and language case. Regex fence counts
// can associate a selected diagram with a different block in the message.
export const mermaidSources = (content: string): ReadonlyArray<string> => {
  const sources: string[] = []
  marked.walkTokens(marked.lexer(content), token => {
    if (token.type === 'code' && isMermaidLanguage(token.lang)) sources.push(token.text)
  })
  return sources
}

interface DiagramReplyMessage {
  readonly senderId: string
  readonly content: string
  readonly type: string
  readonly cause?: MessageCause
  readonly inReplyTo?: ReadonlyArray<string>
  readonly progress?: true
}

export const diagramReply = <T extends DiagramReplyMessage>(
  messages: ReadonlyArray<T>, answerId: string, agentId: string, requestId: string,
): T | undefined => messages.find(message =>
  !message.progress && message.senderId === agentId
  && message.cause?.kind === DIAGRAM_REQUEST_CAUSE
  && message.cause.requestId === requestId
  && message.inReplyTo?.[0] === answerId)

export const replacementFromReply = (reply: DiagramReplyMessage): string => {
  if (reply.type !== 'chat') throw new Error(reply.content || 'The Agent finished without a replacement diagram. Its reply is saved in chat.')
  const sources = mermaidSources(reply.content)
  if (sources.length !== 1) throw new Error('The Agent did not return exactly one Mermaid diagram. Review its reply in chat; the current diagram is preserved.')
  return sources[0]!
}

export const DIAGRAM_REQUEST_STATUS = {
  room_not_found: 404,
  message_not_found: 404,
  requester_invalid: 403,
  diagram_missing: 409,
  agent_unavailable: 409,
  room_paused: 409,
  script_running: 409,
  request_pending: 409,
} as const

export type DiagramRequestCode = keyof typeof DIAGRAM_REQUEST_STATUS
export type DiagramRequestRefusal = Error & { readonly code: DiagramRequestCode }
export const diagramRequestRefusal = (code: DiagramRequestCode, text: string): DiagramRequestRefusal =>
  Object.assign(new Error(text), { code })

export const isDiagramRequestRefusal = (error: unknown): error is DiagramRequestRefusal =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' && Object.hasOwn(DIAGRAM_REQUEST_STATUS, error.code)
