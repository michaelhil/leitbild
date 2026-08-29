import { z } from 'zod'
import { isoTimestampSchema, moduleIdSchema, protocolVersionSchema, workspaceIdSchema } from './ids.ts'

export const moduleBindingSchema = z.object({
  moduleId: moduleIdSchema,
  baseUrl: z.url(),
  discoveryUrl: z.url(),
  protocolVersion: protocolVersionSchema,
}).strict()
export type ModuleBinding = z.infer<typeof moduleBindingSchema>

export const workspaceDescriptorSchema = z.object({
  id: workspaceIdSchema,
  displayName: z.string().min(1).max(256),
  status: z.enum(['active', 'archived']),
  modules: z.array(moduleBindingSchema),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict().superRefine((workspace, ctx) => {
  const seen = new Set<string>()
  workspace.modules.forEach((binding, index) => {
    if (seen.has(binding.moduleId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['modules', index, 'moduleId'],
        message: `duplicate module binding: ${binding.moduleId}`,
      })
    }
    seen.add(binding.moduleId)
  })
})
export type WorkspaceDescriptor = z.infer<typeof workspaceDescriptorSchema>

export const moduleDiscoverySchema = z.object({
  schemaVersion: protocolVersionSchema,
  generatedAt: isoTimestampSchema,
  module: z.object({
    id: moduleIdSchema,
    title: z.string().min(1),
    implementationVersion: z.string().min(1),
  }).strict(),
  supportedProtocolVersions: z.array(protocolVersionSchema).min(1),
  workspaceScope: z.object({
    mode: z.enum(['path', 'binding']),
    pathTemplate: z.string().min(1).optional(),
  }).strict(),
  access: z.object({
    posture: z.enum(['open', 'restricted']),
    modes: z.array(z.string().min(1)),
  }).strict(),
  links: z.record(z.string(), z.string().min(1)),
}).strict()
export type ModuleDiscovery = z.infer<typeof moduleDiscoverySchema>
