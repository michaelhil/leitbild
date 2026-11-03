import { z } from 'zod'
import { moduleCapabilityDescriptorSchema, moduleResourceDescriptorSchema, workspaceResourceReferenceSchema } from './resources.ts'
import { presentationRecipientSchema } from './presentation.ts'
import { workspaceIdSchema } from './ids.ts'

/** Operator-owned deployment envelope. A closed pilot retains its exact
 * managed Workspace for owner read/revoke; an empty list manages nothing. */
export const perspectivePilotPolicySchema = z.object({
  enabled: z.boolean(),
  workspaceIds: z.array(workspaceIdSchema).max(1).readonly(),
}).strict().superRefine((policy, context) => {
  if (policy.enabled && policy.workspaceIds.length !== 1) context.addIssue({ code: 'custom', path: ['workspaceIds'], message: 'An enabled pilot names exactly one dedicated Workspace' })
}).readonly()
export type PerspectivePilotPolicy = z.infer<typeof perspectivePilotPolicySchema>

const identity = z.string().min(1).max(256)
const generation = z.string().uuid()
const revision = z.number().int().nonnegative()
const stamp = z.string().datetime({ offset: true })
const roles = z.array(identity).min(1).max(32).refine(ids => new Set(ids).size === ids.length, 'Each held role is named once')
const runtimeAvailability = z.object({ status: z.enum(['available', 'unavailable']), reason: z.string().min(1).max(500).optional() }).strict()

export const worldPerspectiveReferenceSchema = workspaceResourceReferenceSchema.refine(reference => reference.moduleId === 'world' && reference.type === 'world.perspective', 'An exact World Perspective Resource is required')
export type WorldPerspectiveReference = z.infer<typeof worldPerspectiveReferenceSchema>
export const agentsPerspectiveRoomReferenceSchema = workspaceResourceReferenceSchema.refine(reference => reference.moduleId === 'agents' && reference.type === 'agents.room', 'An exact Agents Room Resource is required')

/** Actual owner-established runtime relationship. None of these identifiers is authority by itself. */
export const perspectiveRuntimeBindingSchema = z.object({
  perspective: worldPerspectiveReferenceSchema,
  admissionGeneration: generation,
  room: agentsPerspectiveRoomReferenceSchema,
  actualAgentId: identity,
  runtimeGeneration: generation,
  templateId: identity,
  templateRevision: identity,
}).strict().superRefine((binding, context) => {
  if (binding.perspective.workspaceId !== binding.room.workspaceId) context.addIssue({ code: 'custom', path: ['room'], message: 'A Perspective and its Room belong to the same Workspace' })
})
export type PerspectiveRuntimeBinding = z.infer<typeof perspectiveRuntimeBindingSchema>

/** Read only through owner verification or the holder's qualified management surface.
 * The canonical Run relation and held roles remain World-private. */
export const perspectiveAdmissionSchema = z.object({
  resource: worldPerspectiveReferenceSchema,
  status: z.enum(['pending', 'active', 'revoked']),
  revision,
  admissionGeneration: generation,
  runIncarnation: generation,
  roleSetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  binding: perspectiveRuntimeBindingSchema.optional(),
  createdAt: stamp,
  updatedAt: stamp,
  revokedReason: z.string().min(1).max(500).optional(),
  // Derived for the current reader, never persisted or a replacement for CAS.
  // Owner reads derive local policy/incarnation readiness without peer recursion.
  runtimeAvailability: runtimeAvailability.optional(),
}).strict().superRefine((admission, context) => {
  if (admission.status === 'pending' && admission.binding !== undefined || admission.status === 'active' && admission.binding === undefined) context.addIssue({ code: 'custom', path: ['binding'], message: 'Only an activated Perspective has a runtime binding' })
  const binding = admission.binding
  if (binding !== undefined && (binding.perspective.workspaceId !== admission.resource.workspaceId || binding.perspective.id !== admission.resource.id || binding.admissionGeneration !== admission.admissionGeneration)) context.addIssue({ code: 'custom', path: ['binding'], message: 'The runtime binding names this exact Perspective admission' })
})
export type PerspectiveAdmission = z.infer<typeof perspectiveAdmissionSchema>

export const perspectiveDiscoverySchema = z.object({ resource: moduleResourceDescriptorSchema, capabilities: z.array(moduleCapabilityDescriptorSchema) }).strict()
export const perspectivePresentationVerificationSchema = z.object({
  admission: perspectiveAdmissionSchema, binding: perspectiveRuntimeBindingSchema,
  recipient: presentationRecipientSchema.refine(recipient => recipient.subject.moduleId === 'world' && recipient.subject.type === 'world.perspective', 'A Perspective browser recipient is required'),
}).strict()

/** Private Agents owner facts. Preparing a Room does not make it callable. */
export const agentsPerspectiveRoomAdmissionSchema = perspectiveRuntimeBindingSchema.safeExtend({
  status: z.enum(['prepared', 'bound', 'revoked']), revision, createdAt: stamp, updatedAt: stamp,
  revokedReason: z.string().min(1).max(500).optional(),
  runtimeAvailability: runtimeAvailability.optional(),
})
export type AgentsPerspectiveRoomAdmission = z.infer<typeof agentsPerspectiveRoomAdmissionSchema>

export const perspectivePrepareInputSchema = z.object({ roleIds: roles, requestId: generation }).strict()
export const perspectiveReadInputSchema = z.object({ roleIds: roles.optional() }).strict()
export const perspectiveBindInputSchema = z.object({ expectedRevision: revision, binding: perspectiveRuntimeBindingSchema }).strict()
export const perspectiveRevokeInputSchema = z.object({ expectedRevision: revision, reason: z.string().min(1).max(500), roleIds: roles.optional() }).strict()

export const agentsPerspectiveRoomPrepareInputSchema = z.object({
  perspective: worldPerspectiveReferenceSchema, admissionGeneration: generation,
  templateId: identity, templateRevision: identity, requestId: generation,
}).strict()
export const agentsPerspectiveRoomBindInputSchema = z.object({ expectedRevision: revision }).strict()
export const agentsPerspectiveRoomRevokeInputSchema = z.object({ expectedRevision: revision, reason: z.string().min(1).max(500) }).strict()
