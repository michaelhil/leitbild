import { z } from 'zod'
import { moduleIdSchema } from './ids.ts'
import { workspaceResourceReferenceSchema } from './resources.ts'

const identity = z.string().min(1).max(256)

/** An owner's semantic address. A receiver resolves it; DOM selectors never cross this boundary. */
export const presentationTargetSchema = z.object({
  subject: workspaceResourceReferenceSchema,
  type: z.string().min(3).max(128),
  id: identity,
  part: identity.optional(),
}).strict().superRefine((target, ctx) => {
  if (!target.type.startsWith(`${target.subject.moduleId}.`)) {
    ctx.addIssue({ code: 'custom', path: ['type'], message: 'A presentation target belongs to its subject Module' })
  }
})
export type PresentationTarget = z.infer<typeof presentationTargetSchema>

/** Transient delivery address, not an Agent binding, Resource grant, or authenticated Person identity. */
export const presentationRecipientSchema = z.object({
  subject: workspaceResourceReferenceSchema,
  clientId: identity,
  documentId: identity,
  leaseId: identity,
  expiresAt: z.string().datetime({ offset: true }),
}).strict()
export type PresentationRecipient = z.infer<typeof presentationRecipientSchema>

export const presentationActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reveal') }).strict(),
  z.object({ kind: z.literal('focus'), zoom: z.number().finite().min(0).max(24).optional() }).strict(),
  z.object({ kind: z.literal('highlight') }).strict(),
  z.object({ kind: z.literal('explain'), title: z.string().min(1).max(120), text: z.string().min(1).max(2_000) }).strict(),
  z.object({ kind: z.literal('draft'), text: z.string().min(1).max(8_000) }).strict(),
  z.object({ kind: z.literal('clear'), requestId: identity }).strict(),
])
export type PresentationAction = z.infer<typeof presentationActionSchema>

export const presentationSourceSchema = z.object({
  moduleId: moduleIdSchema,
  kind: z.enum(['guide', 'agent', 'person']),
  id: identity,
  label: z.string().min(1).max(120),
  executionId: identity.optional(),
  initiatingRoom: workspaceResourceReferenceSchema.optional(),
}).strict().refine(source => source.initiatingRoom === undefined
  || source.initiatingRoom.moduleId === 'agents' && source.initiatingRoom.type === 'agents.room',
{ message: 'An initiating Room is an exact Agents Room Resource' })

/** One action has one result. A group of actions is deliberately nontransactional. */
export const presentationRequestSchema = z.object({
  id: identity,
  recipient: presentationRecipientSchema,
  source: presentationSourceSchema,
  target: presentationTargetSchema,
  action: presentationActionSchema,
  purpose: z.string().min(1).max(500),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  // An active guide may apply an opted-in effect. Ordinary agents offer it for the person's choice.
  mode: z.enum(['suggest', 'guide']),
}).strict().superRefine((request, ctx) => {
  const a = request.recipient.subject, b = request.target.subject
  if (a.workspaceId !== b.workspaceId || a.moduleId !== b.moduleId || a.type !== b.type || a.id !== b.id) {
    ctx.addIssue({ code: 'custom', path: ['target'], message: 'The target must belong to the recipient Resource' })
  }
  if (Date.parse(request.expiresAt) <= Date.parse(request.createdAt)) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'A presentation request expires after creation' })
  }
  if (request.source.initiatingRoom !== undefined && request.source.initiatingRoom.workspaceId !== a.workspaceId) {
    ctx.addIssue({ code: 'custom', path: ['source', 'initiatingRoom'], message: 'The initiating Room belongs to this Workspace' })
  }
})
export type PresentationRequest = z.infer<typeof presentationRequestSchema>

export const presentationReceiptSchema = z.object({
  requestId: identity,
  documentId: identity,
  status: z.enum(['applied', 'declined', 'unavailable', 'expired', 'superseded', 'cancelled']),
  reason: z.string().min(1).max(500).optional(),
  at: z.string().datetime({ offset: true }),
}).strict()
export type PresentationReceipt = z.infer<typeof presentationReceiptSchema>

/** Host relays the currently challenged World receiver to the current Agents document. */
export const presentationOfferMessageSchema = z.object({
  type: z.literal('leitbild:presentation-offer'),
  recipient: presentationRecipientSchema.nullable(),
}).strict()

/** An Agents composer is resolved by Agents; World does not write or submit its text. */
export const presentationDraftMessageSchema = z.object({
  type: z.literal('leitbild:presentation-draft'),
  request: presentationRequestSchema,
  room: workspaceResourceReferenceSchema,
}).strict().refine(message => message.request.action.kind === 'draft', { message: 'Only a draft action reaches a composer' })
  .refine(message => message.room.moduleId === 'agents' && message.room.type === 'agents.room'
    && message.room.workspaceId === message.request.recipient.subject.workspaceId,
  { message: 'A draft is addressed to one exact Agents Room in this Workspace' })

export const presentationReceiptMessageSchema = z.object({
  type: z.literal('leitbild:presentation-receipt'),
  receipt: presentationReceiptSchema,
}).strict()

/** Clears only an owned suggestion/correlation, never a person's edited composer text. */
export const presentationClearMessageSchema = z.object({
  type: z.literal('leitbild:presentation-clear'),
  recipient: presentationRecipientSchema,
  room: workspaceResourceReferenceSchema,
  requestId: identity,
}).strict().refine(message => message.room.moduleId === 'agents' && message.room.type === 'agents.room'
  && message.room.workspaceId === message.recipient.subject.workspaceId,
{ message: 'A clear addresses one exact Agents Room in this Workspace' })

/** Sent after the asynchronous Room snapshot selects the composer's actual destination. */
export const presentationReadyMessageSchema = z.object({
  type: z.literal('leitbild:presentation-ready'),
  room: workspaceResourceReferenceSchema,
}).strict().refine(message => message.room.moduleId === 'agents' && message.room.type === 'agents.room',
{ message: 'A ready composer names its exact Agents Room' })

/** Causal attribution of an explicitly submitted prompt; no browser address is persisted. */
export const presentationPromptLinkSchema = z.object({
  requestId: identity,
  subject: workspaceResourceReferenceSchema,
  sourceId: identity,
  sourceExecutionId: identity.optional(),
}).strict()
export type PresentationPromptLink = z.infer<typeof presentationPromptLinkSchema>

export const presentationPromptEvidenceInputSchema = z.object({
  requestId: identity,
  messageId: identity,
  subject: workspaceResourceReferenceSchema,
}).strict()

/** Agents-owned facts; neither a UI receipt nor prompt-text matching can produce an AI response. */
export const presentationPromptEvidenceSchema = z.object({
  requestId: identity,
  messageId: identity,
  room: workspaceResourceReferenceSchema,
  found: z.boolean(),
  submission: z.object({
    messageId: identity, senderId: identity, senderName: z.string().optional(), at: z.number().finite(),
    source: presentationPromptLinkSchema,
  }).strict().optional(),
  responses: z.array(z.object({
    messageId: identity, senderId: identity, at: z.number().finite(), kind: z.enum(['chat', 'error']),
    turnId: identity, executionStatus: z.enum(['running', 'completed', 'interrupted', 'failed']),
    finishedAt: z.number().finite().optional(),
  }).strict()),
}).strict().superRefine((value, ctx) => {
  if (value.room.moduleId !== 'agents' || value.room.type !== 'agents.room') ctx.addIssue({ code: 'custom', path: ['room'], message: 'Prompt evidence belongs to an Agents Room' })
  if (value.found !== (value.submission !== undefined) || !value.found && value.responses.length !== 0) ctx.addIssue({ code: 'custom', message: 'Unavailable evidence contains no submission or response claims' })
  if (value.submission !== undefined && (value.submission.messageId !== value.messageId
    || value.submission.source.requestId !== value.requestId || value.submission.source.subject.workspaceId !== value.room.workspaceId)) {
    ctx.addIssue({ code: 'custom', path: ['submission'], message: 'The submission belongs to this request, Message and Workspace' })
  }
})
export type PresentationPromptEvidence = z.infer<typeof presentationPromptEvidenceSchema>

/** A hint to re-read owner evidence, never evidence supplied by the browser itself. */
export const presentationEvidenceMessageSchema = z.object({
  type: z.literal('leitbild:presentation-evidence'),
  recipient: presentationRecipientSchema,
  room: workspaceResourceReferenceSchema,
  requestId: identity,
  messageId: identity,
}).strict().refine(message => message.room.moduleId === 'agents' && message.room.type === 'agents.room'
  && message.room.workspaceId === message.recipient.subject.workspaceId,
{ message: 'The evidence hint names an Agents Room in the receiver Workspace' })
