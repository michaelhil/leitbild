import { z } from 'zod'
import {
  capabilityIdSchema,
  definitionIdSchema,
  definitionRevisionIdSchema,
  definitionTypeSchema,
  moduleIdSchema,
  workspaceIdSchema,
} from './ids.ts'
import { moduleQueryOutcomeSchema } from './modules.ts'

export const workspaceDefinitionReferenceSchema = z.object({
  workspaceId: workspaceIdSchema,
  moduleId: moduleIdSchema,
  type: definitionTypeSchema,
  id: definitionIdSchema,
}).strict().superRefine((reference, ctx) => {
  if (!reference.type.startsWith(`${reference.moduleId}.`)) {
    ctx.addIssue({ code: 'custom', path: ['type'], message: 'Definition type must be namespaced by its owning Module' })
  }
})
export type WorkspaceDefinitionReference = z.infer<typeof workspaceDefinitionReferenceSchema>

export const workspaceDefinitionRevisionReferenceSchema = workspaceDefinitionReferenceSchema.extend({
  revisionId: definitionRevisionIdSchema,
}).strict()
export type WorkspaceDefinitionRevisionReference = z.infer<typeof workspaceDefinitionRevisionReferenceSchema>

export const moduleDefinitionDescriptorSchema = z.object({
  ref: workspaceDefinitionReferenceSchema,
  title: z.string().trim().min(1).max(256),
  description: z.string().trim().min(1).max(4096).optional(),
  category: z.string().trim().min(1).max(128).optional(),
  currentRevisionId: definitionRevisionIdSchema,
  capabilityIds: z.array(capabilityIdSchema),
}).strict().superRefine((definition, ctx) => {
  const seen = new Set<string>()
  definition.capabilityIds.forEach((capabilityId, index) => {
    if (!capabilityId.startsWith(`${definition.ref.moduleId}.`)) {
      ctx.addIssue({ code: 'custom', path: ['capabilityIds', index], message: 'Definition Capability must be owned by the Definition Module' })
    }
    if (seen.has(capabilityId)) {
      ctx.addIssue({ code: 'custom', path: ['capabilityIds', index], message: `duplicate Capability: ${capabilityId}` })
    }
    seen.add(capabilityId)
  })
})
export type ModuleDefinitionDescriptor = z.infer<typeof moduleDefinitionDescriptorSchema>

export const moduleDefinitionCollectionSchema = z.object({
  definitions: z.array(moduleDefinitionDescriptorSchema),
  nextCursor: z.string().min(1).max(1024).optional(),
}).strict()
export type ModuleDefinitionCollection = z.infer<typeof moduleDefinitionCollectionSchema>

export const workspaceDefinitionCatalogSchema = z.object({
  workspaceId: workspaceIdSchema,
  modules: z.array(moduleQueryOutcomeSchema),
  definitions: z.array(moduleDefinitionDescriptorSchema),
}).strict().superRefine((catalog, ctx) => {
  const seenModules = new Set<string>()
  catalog.modules.forEach((outcome, index) => {
    if (seenModules.has(outcome.moduleId)) {
      ctx.addIssue({ code: 'custom', path: ['modules', index, 'moduleId'], message: `duplicate Module outcome: ${outcome.moduleId}` })
    }
    seenModules.add(outcome.moduleId)
  })
  const seenDefinitions = new Set<string>()
  catalog.definitions.forEach((definition, index) => {
    if (definition.ref.workspaceId !== catalog.workspaceId) {
      ctx.addIssue({ code: 'custom', path: ['definitions', index, 'ref', 'workspaceId'], message: 'Definition belongs to another Workspace' })
    }
    const key = `${definition.ref.moduleId}:${definition.ref.type}:${definition.ref.id}`
    if (seenDefinitions.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['definitions', index, 'ref'], message: `duplicate Definition: ${key}` })
    }
    seenDefinitions.add(key)
  })
})
export type WorkspaceDefinitionCatalog = z.infer<typeof workspaceDefinitionCatalogSchema>
