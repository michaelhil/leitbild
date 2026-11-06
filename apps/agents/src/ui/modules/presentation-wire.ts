// Browser modules are served individually: keep the small checked wire here,
// with type-only contract imports, rather than shipping a bare package import.
import type { PresentationRecipient, PresentationRequest, WorkspaceResourceReference } from '@leitbild/contracts'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []): boolean =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))
export const sameResource = (a: WorkspaceResourceReference, b: WorkspaceResourceReference): boolean =>
  a.workspaceId === b.workspaceId && a.moduleId === b.moduleId && a.type === b.type && a.id === b.id
export const sameRecipient = (a: PresentationRecipient, b: PresentationRecipient): boolean =>
  sameResource(a.subject, b.subject) && a.clientId === b.clientId && a.documentId === b.documentId && a.leaseId === b.leaseId

const resource = (value: unknown): value is WorkspaceResourceReference => record(value)
  && keys(value, ['workspaceId', 'moduleId', 'type', 'id'])
  && typeof value.workspaceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.workspaceId)
  && text(value.moduleId) && text(value.type) && value.type.startsWith(`${value.moduleId}.`) && text(value.id)

export const parsePresentationRecipient = (value: unknown): PresentationRecipient | null => {
  if (!record(value) || !keys(value, ['subject', 'clientId', 'documentId', 'leaseId', 'expiresAt'])
    || !resource(value.subject) || value.subject.moduleId !== 'world'
    || !text(value.clientId) || !text(value.documentId) || !text(value.leaseId) || !date(value.expiresAt)) return null
  return value as unknown as PresentationRecipient
}

export const parsePresentationOffer = (value: unknown): { recipient: PresentationRecipient | null } | null => {
  if (!record(value) || !keys(value, ['type', 'recipient']) || value.type !== 'leitbild:presentation-offer') return null
  if (value.recipient === null) return { recipient: null }
  const recipient = parsePresentationRecipient(value.recipient)
  return recipient === null ? null : { recipient }
}

export const parsePresentationClear = (value: unknown): { recipient: PresentationRecipient; room: WorkspaceResourceReference; requestId: string; clearRequestId?: string } | null => {
  if (!record(value) || !keys(value, ['type', 'recipient', 'room', 'requestId'], ['clearRequestId']) || value.type !== 'leitbild:presentation-clear'
    || !resource(value.room) || value.room.moduleId !== 'agents' || value.room.type !== 'agents.room' || !text(value.requestId)
    || value.clearRequestId !== undefined && !text(value.clearRequestId)) return null
  const recipient = parsePresentationRecipient(value.recipient)
  return recipient === null || recipient.subject.workspaceId !== value.room.workspaceId ? null : { recipient, room: value.room, requestId: value.requestId, ...(value.clearRequestId === undefined ? {} : { clearRequestId: value.clearRequestId as string }) }
}

export const parsePresentationDraft = (value: unknown): { request: PresentationRequest; room: WorkspaceResourceReference } | null => {
  if (!record(value) || !keys(value, ['type', 'request', 'room']) || value.type !== 'leitbild:presentation-draft'
    || !resource(value.room) || value.room.moduleId !== 'agents' || value.room.type !== 'agents.room') return null
  const request = value.request
  if (!record(request) || !keys(request, ['id', 'recipient', 'source', 'target', 'action', 'purpose', 'createdAt', 'expiresAt', 'mode'])) return null
  const recipient = parsePresentationRecipient(request.recipient)
  const source = request.source, target = request.target, action = request.action
  if (recipient === null || recipient.subject.workspaceId !== value.room.workspaceId || !text(request.id)
    || !record(source) || !keys(source, ['moduleId', 'kind', 'id', 'label'], ['executionId', 'initiatingRoom'])
    || !text(source.moduleId) || !['guide', 'agent', 'person'].includes(String(source.kind)) || !text(source.id) || !text(source.label, 120)
    || source.executionId !== undefined && !text(source.executionId)
    || source.initiatingRoom !== undefined && (!resource(source.initiatingRoom) || !sameResource(source.initiatingRoom, value.room))
    || !record(target) || !keys(target, ['subject', 'type', 'id']) || !resource(target.subject) || !sameResource(target.subject, recipient.subject)
    || target.type !== 'world.composer' || target.id !== 'assistant'
    || !record(action) || !keys(action, ['kind', 'text']) || action.kind !== 'draft' || !text(action.text, 8_000)
    || !text(request.purpose, 500) || !date(request.createdAt) || !date(request.expiresAt)
    || Date.parse(request.expiresAt) <= Date.parse(request.createdAt) || !['guide', 'suggest'].includes(String(request.mode))) return null
  return { request: request as unknown as PresentationRequest, room: value.room }
}
