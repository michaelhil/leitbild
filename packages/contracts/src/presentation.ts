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
}).strict()

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
}).strict().refine(message => message.request.action.kind === 'draft', { message: 'Only a draft action reaches a composer' })

export const presentationReceiptMessageSchema = z.object({
  type: z.literal('leitbild:presentation-receipt'),
  receipt: presentationReceiptSchema,
}).strict()
