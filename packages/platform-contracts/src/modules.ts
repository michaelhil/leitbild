import { z } from 'zod'
import { moduleIdSchema } from './ids.ts'

const relativePathTemplateSchema = z.string().min(1).max(512).superRefine((value, ctx) => {
  if (!value.startsWith('/')) ctx.addIssue({ code: 'custom', message: 'path template must start with /' })
  if (value.includes('://')) ctx.addIssue({ code: 'custom', message: 'path template must not contain an origin' })
  if (!value.includes('{workspaceId}')) ctx.addIssue({ code: 'custom', message: 'path template must contain {workspaceId}' })
})

const invocationPathTemplateSchema = relativePathTemplateSchema.superRefine((value, ctx) => {
  if (!value.includes('{capabilityId}')) ctx.addIssue({ code: 'custom', message: 'invocation path must contain {capabilityId}' })
})

export const workspaceModuleManifestSchema = z.object({
  module: z.object({
    id: moduleIdSchema,
    title: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(2048).optional(),
  }).strict(),
  endpoints: z.object({
    workspace: relativePathTemplateSchema,
    resources: relativePathTemplateSchema,
    capabilities: relativePathTemplateSchema,
    invoke: invocationPathTemplateSchema,
  }).strict(),
}).strict()
export type WorkspaceModuleManifest = z.infer<typeof workspaceModuleManifestSchema>

export const moduleRegistrationSchema = z.object({
  moduleId: moduleIdSchema,
  baseUrl: z.url(),
  manifestPath: z.string().min(1).max(256).startsWith('/'),
}).strict()
export type ModuleRegistration = z.infer<typeof moduleRegistrationSchema>
