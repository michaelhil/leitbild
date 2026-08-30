import { z } from 'zod'
import {
  capabilityIdSchema,
  definitionTypeSchema,
  isoTimestampSchema,
  moduleIdSchema,
  resourceIdSchema,
  resourceTypeSchema,
  workspaceIdSchema,
} from './ids.ts'
import { accessContextSchema, actorContextSchema } from './access.ts'
import { moduleQueryOutcomeSchema } from './modules.ts'
import {
  workspaceDefinitionRevisionReferenceSchema,
} from './definitions.ts'

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

export const relativeUiPathSchema = z.string().min(1).max(1024).superRefine((value, ctx) => {
  if (!value.startsWith('/')) ctx.addIssue({ code: 'custom', message: 'UI path must start with /' })
  if (value.includes('://')) ctx.addIssue({ code: 'custom', message: 'UI path must not contain an origin' })
})

export const moduleCapabilityDescriptorSchema = z.object({
  id: capabilityIdSchema,
  moduleId: moduleIdSchema,
  kind: z.enum(['command', 'query', 'stream']),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('workspace') }).strict(),
    z.object({ kind: z.literal('definition'), definitionType: definitionTypeSchema }).strict(),
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
  if (capability.scope.kind === 'definition' && !capability.scope.definitionType.startsWith(`${capability.moduleId}.`)) {
    ctx.addIssue({ code: 'custom', path: ['scope', 'definitionType'], message: 'Definition type must be owned by the Capability Module' })
  }
})
export type ModuleCapabilityDescriptor = z.infer<typeof moduleCapabilityDescriptorSchema>
export type ModuleCapabilityDescriptorInput = z.input<typeof moduleCapabilityDescriptorSchema>

export const moduleResourceLinkSchema = z.object({
  rel: z.string().trim().min(1).max(128),
  ref: workspaceResourceReferenceSchema,
  title: z.string().trim().min(1).max(256).optional(),
}).strict()
export type ModuleResourceLink = z.infer<typeof moduleResourceLinkSchema>

export const moduleResourceDescriptorSchema = z.object({
  ref: workspaceResourceReferenceSchema,
  title: z.string().trim().min(1).max(256),
  description: z.string().trim().min(1).max(2048).optional(),
  sourceDefinition: workspaceDefinitionRevisionReferenceSchema.optional(),
  links: z.array(moduleResourceLinkSchema).default([]),
  uiPath: relativeUiPathSchema.optional(),
  capabilityIds: z.array(capabilityIdSchema),
  observedAt: isoTimestampSchema,
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
  if (resource.sourceDefinition !== undefined && (
    resource.sourceDefinition.workspaceId !== resource.ref.workspaceId
    || resource.sourceDefinition.moduleId !== resource.ref.moduleId
  )) {
    ctx.addIssue({ code: 'custom', path: ['sourceDefinition'], message: 'Resource source Definition must belong to the same Module and Workspace' })
  }
  resource.links.forEach((link, index) => {
    if (link.ref.workspaceId !== resource.ref.workspaceId) {
      ctx.addIssue({ code: 'custom', path: ['links', index, 'ref', 'workspaceId'], message: 'Linked Resource must belong to the same Workspace' })
    }
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

export const workspaceResourceCatalogSchema = z.object({
  workspaceId: workspaceIdSchema,
  modules: z.array(moduleQueryOutcomeSchema),
  resources: z.array(moduleResourceDescriptorSchema),
}).strict().superRefine((catalog, ctx) => {
  const seenModules = new Set<string>()
  catalog.modules.forEach((outcome, index) => {
    if (seenModules.has(outcome.moduleId)) {
      ctx.addIssue({ code: 'custom', path: ['modules', index, 'moduleId'], message: `duplicate Module outcome: ${outcome.moduleId}` })
    }
    seenModules.add(outcome.moduleId)
  })
  const seenResources = new Set<string>()
  catalog.resources.forEach((resource, index) => {
    if (resource.ref.workspaceId !== catalog.workspaceId) {
      ctx.addIssue({ code: 'custom', path: ['resources', index, 'ref', 'workspaceId'], message: 'Resource belongs to another Workspace' })
    }
    const key = `${resource.ref.moduleId}:${resource.ref.type}:${resource.ref.id}`
    if (seenResources.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['resources', index, 'ref'], message: `duplicate Resource: ${key}` })
    }
    seenResources.add(key)
  })
})
export type WorkspaceResourceCatalog = z.infer<typeof workspaceResourceCatalogSchema>

export const workspaceCapabilityCatalogSchema = z.object({
  workspaceId: workspaceIdSchema,
  modules: z.array(moduleQueryOutcomeSchema),
  capabilities: z.array(moduleCapabilityDescriptorSchema),
}).strict().superRefine((catalog, ctx) => {
  const seenModules = new Set<string>()
  catalog.modules.forEach((outcome, index) => {
    if (seenModules.has(outcome.moduleId)) {
      ctx.addIssue({ code: 'custom', path: ['modules', index, 'moduleId'], message: `duplicate Module outcome: ${outcome.moduleId}` })
    }
    seenModules.add(outcome.moduleId)
  })
  const seenCapabilities = new Set<string>()
  catalog.capabilities.forEach((capability, index) => {
    if (seenCapabilities.has(capability.id)) {
      ctx.addIssue({ code: 'custom', path: ['capabilities', index, 'id'], message: `duplicate Capability: ${capability.id}` })
    }
    seenCapabilities.add(capability.id)
  })
})
export type WorkspaceCapabilityCatalog = z.infer<typeof workspaceCapabilityCatalogSchema>

export const invokeCapabilityInputSchema = z.object({
  definition: workspaceDefinitionRevisionReferenceSchema.optional(),
  resource: workspaceResourceReferenceSchema.optional(),
  input: z.unknown(),
}).strict().superRefine((invocation, ctx) => {
  if (invocation.definition !== undefined && invocation.resource !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['definition'], message: 'Capability invocation cannot target both a Definition and a Resource' })
  }
})
export type InvokeCapabilityInput = z.infer<typeof invokeCapabilityInputSchema>

// Public Host request shape. `actor` is attribution supplied by the calling
// client, not authentication; a future auth adapter can replace or validate
// it before the Host constructs the authoritative AccessContext.
export const workspaceCapabilityInvocationRequestSchema = invokeCapabilityInputSchema.extend({
  actor: actorContextSchema.optional(),
}).strict()
export type WorkspaceCapabilityInvocationRequest = z.infer<typeof workspaceCapabilityInvocationRequestSchema>

export const moduleCapabilityInvocationSchema = z.object({
  workspaceId: workspaceIdSchema,
  capabilityId: capabilityIdSchema,
  definition: workspaceDefinitionRevisionReferenceSchema.optional(),
  resource: workspaceResourceReferenceSchema.optional(),
  input: z.unknown(),
  access: accessContextSchema,
}).strict().superRefine((invocation, ctx) => {
  if (invocation.access.workspaceId !== invocation.workspaceId) {
    ctx.addIssue({ code: 'custom', path: ['access', 'workspaceId'], message: 'Access context belongs to another Workspace' })
  }
  if (invocation.resource !== undefined && invocation.resource.workspaceId !== invocation.workspaceId) {
    ctx.addIssue({ code: 'custom', path: ['resource', 'workspaceId'], message: 'Resource belongs to another Workspace' })
  }
  if (invocation.definition !== undefined && invocation.definition.workspaceId !== invocation.workspaceId) {
    ctx.addIssue({ code: 'custom', path: ['definition', 'workspaceId'], message: 'Definition belongs to another Workspace' })
  }
  if (invocation.definition !== undefined && invocation.resource !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['definition'], message: 'Capability invocation cannot target both a Definition and a Resource' })
  }
})
export type ModuleCapabilityInvocation = z.infer<typeof moduleCapabilityInvocationSchema>

export const moduleCapabilityInvocationResultSchema = z.object({
  result: z.unknown(),
  createdResources: z.array(workspaceResourceReferenceSchema).optional(),
}).strict()
export type ModuleCapabilityInvocationResult = z.infer<typeof moduleCapabilityInvocationResultSchema>
