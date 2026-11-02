import { z } from 'zod'
import { presentationRecipientSchema } from './presentation.ts'
import { agentsPerspectiveRoomAdmissionSchema, perspectiveAdmissionSchema, worldPerspectiveReferenceSchema } from './perspectives.ts'
import { workspaceResourceReferenceSchema } from './resources.ts'

const documentId = z.string().uuid()
const room = workspaceResourceReferenceSchema.refine(ref => ref.moduleId === 'agents' && ref.type === 'agents.room', 'An exact Agents Room is required')

/** A World-owned lease for the exact Perspective document; it grants no Agent authority. */
export const perspectivePresentationRecipientSchema = presentationRecipientSchema.refine(value => value.subject.moduleId === 'world' && value.subject.type === 'world.perspective', 'A Perspective recipient names the exact Perspective Resource')

export const perspectiveViewLeaseSchema = z.object({
  token: z.string().uuid(), room, perspective: worldPerspectiveReferenceSchema, documentId,
  expiresAt: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (value.room.workspaceId !== value.perspective.workspaceId) context.addIssue({ code: 'custom', path: ['room'], message: 'A view belongs to one Workspace' })
})
export type PerspectiveViewLease = z.infer<typeof perspectiveViewLeaseSchema>
export const perspectiveViewMessageSchema = z.object({ type: z.literal('leitbild:perspective-view'), lease: perspectiveViewLeaseSchema }).strict()
export const perspectiveViewReadyMessageSchema = z.object({
  type: z.literal('leitbild:perspective-view-ready'), room, perspective: worldPerspectiveReferenceSchema, documentId,
}).strict().superRefine((value, context) => {
  if (value.room.workspaceId !== value.perspective.workspaceId) context.addIssue({ code: 'custom', message: 'A ready document belongs to one Workspace' })
})

export const perspectiveAssistantAvailabilityMessageSchema = z.object({
  type: z.literal('leitbild:perspective-assistant-availability'), worldDocumentId: documentId, available: z.boolean(),
}).strict()
export const perspectiveAssistantRequestMessageSchema = z.object({
  type: z.literal('leitbild:perspective-assistant-request'), worldDocumentId: documentId, requestId: documentId,
}).strict()
/** Only the currently shown World document prepares its held roles. Host does not select a role. */
export const perspectiveAssistantOfferMessageSchema = z.object({
  type: z.literal('leitbild:perspective-assistant-offer'),
  worldDocumentId: documentId,
  requestId: documentId,
  admission: perspectiveAdmissionSchema.nullable(),
  recipient: perspectivePresentationRecipientSchema.nullable(),
  roleLabels: z.array(z.string().min(1).max(256)).max(32),
}).strict().superRefine((value, context) => {
  if (!value.recipient) return
  if (!value.admission || value.admission.status !== 'active'
    || value.recipient.subject.workspaceId !== value.admission.resource.workspaceId
    || value.recipient.subject.id !== value.admission.resource.id) {
    context.addIssue({ code: 'custom', path: ['recipient'], message: 'A delivery offer belongs to the exact active admission' })
  }
})
export type PerspectiveAssistantOffer = z.infer<typeof perspectiveAssistantOfferMessageSchema>

export const perspectiveAssistantResultMessageSchema = z.object({
  type: z.literal('leitbild:perspective-assistant-result'), worldDocumentId: documentId, requestId: documentId,
  admission: perspectiveAdmissionSchema.optional(),
  problem: z.object({ code: z.string().min(1).max(128), message: z.string().min(1).max(500) }).strict().optional(),
}).strict().refine(value => (value.admission !== undefined) !== (value.problem !== undefined), 'A setup result contains an admission or a problem')

export const perspectiveViewRequestSchema = z.object({
  recipient: perspectivePresentationRecipientSchema,
  agentsDocumentId: documentId,
}).strict()

export const perspectiveAssistantSetupRequestSchema = z.object({
  perspective: worldPerspectiveReferenceSchema,
  templateId: z.string().min(1).max(256), templateRevision: z.string().min(1).max(256), requestId: documentId,
}).strict()
export const perspectiveAssistantSetupResultSchema = z.object({
  admission: perspectiveAdmissionSchema, roomAdmission: agentsPerspectiveRoomAdmissionSchema,
}).strict().superRefine((value, context) => {
  const binding = value.admission.binding
  if (value.admission.status !== 'active' || value.roomAdmission.status !== 'bound' || !binding
    || binding.room.id !== value.roomAdmission.room.id
    || binding.room.workspaceId !== value.roomAdmission.room.workspaceId
    || binding.runtimeGeneration !== value.roomAdmission.runtimeGeneration
    || binding.actualAgentId !== value.roomAdmission.actualAgentId
    || binding.templateId !== value.roomAdmission.templateId || binding.templateRevision !== value.roomAdmission.templateRevision
    || binding.perspective.id !== value.roomAdmission.perspective.id
    || binding.admissionGeneration !== value.roomAdmission.admissionGeneration) {
    context.addIssue({ code: 'custom', message: 'Both owners must admit the exact same Room and runtime' })
  }
})
