import { z } from 'zod'
import {
  capabilityIdSchema,
  isoTimestampSchema,
  moduleIdSchema,
  resourceIdSchema,
  resourceTypeSchema,
  workspaceIdSchema,
} from './ids.ts'

export const workspaceResourceReferenceSchema = z.object({
  workspaceId: workspaceIdSchema,
  moduleId: moduleIdSchema,
  type: resourceTypeSchema,
  id: resourceIdSchema,
}).strict().superRefine((reference, ctx) => {
  if (!reference.type.startsWith(`${reference.moduleId}.`)) {
    ctx.addIssue({ code: 'custom', path: ['type'], message: 'Resource type must be namespaced by its owning Module' })
  }
})
export type WorkspaceResourceReference = z.infer<typeof workspaceResourceReferenceSchema>

const jsonSchemaSchema = z.record(z.string(), z.unknown())

export const moduleCapabilityDescriptorSchema = z.object({
  id: capabilityIdSchema,
  moduleId: moduleIdSchema,
  kind: z.enum(['command', 'query', 'stream']),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('workspace') }).strict(),
    z.object({ kind: z.literal('resource'), resourceType: resourceTypeSchema }).strict(),
  ]),
  title: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(2048),
  risk: z.enum(['read', 'write', 'destructive']),
  idempotent: z.boolean(),
  inputSchema: jsonSchemaSchema,
  outputSchema: jsonSchemaSchema,
}).strict().superRefine((capability, ctx) => {
  if (!capability.id.startsWith(`${capability.moduleId}.`)) {
    ctx.addIssue({ code: 'custom', path: ['id'], message: 'Capability id must be namespaced by its owning Module' })
  }
  if (capability.scope.kind === 'resource' && !capability.scope.resourceType.startsWith(`${capability.moduleId}.`)) {
    ctx.addIssue({ code: 'custom', path: ['scope', 'resourceType'], message: 'Resource type must be owned by the Capability Module' })
  }
})
export type ModuleCapabilityDescriptor = z.infer<typeof moduleCapabilityDescriptorSchema>

export const moduleResourceDescriptorSchema = z.object({
  ref: workspaceResourceReferenceSchema,
  title: z.string().trim().min(1).max(256),
  description: z.string().trim().min(1).max(2048).optional(),
  capabilityIds: z.array(capabilityIdSchema),
  updatedAt: isoTimestampSchema,
}).strict().superRefine((resource, ctx) => {
  const seen = new Set<string>()
  resource.capabilityIds.forEach((capabilityId, index) => {
    if (!capabilityId.startsWith(`${resource.ref.moduleId}.`)) {
      ctx.addIssue({ code: 'custom', path: ['capabilityIds', index], message: 'Resource Capability must be owned by the Resource Module' })
    }
    if (seen.has(capabilityId)) {
      ctx.addIssue({ code: 'custom', path: ['capabilityIds', index], message: `duplicate Capability: ${capabilityId}` })
    }
    seen.add(capabilityId)
  })
})
export type ModuleResourceDescriptor = z.infer<typeof moduleResourceDescriptorSchema>

export const moduleResourceCollectionSchema = z.object({
  resources: z.array(moduleResourceDescriptorSchema),
  nextCursor: z.string().min(1).max(1024).optional(),
}).strict()
export type ModuleResourceCollection = z.infer<typeof moduleResourceCollectionSchema>

export const moduleCapabilityCollectionSchema = z.object({
  capabilities: z.array(moduleCapabilityDescriptorSchema),
}).strict()
export type ModuleCapabilityCollection = z.infer<typeof moduleCapabilityCollectionSchema>
