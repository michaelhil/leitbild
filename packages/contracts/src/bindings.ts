import { z } from 'zod'
import { bindingIdSchema, isoTimestampSchema, moduleIdSchema, workspaceIdSchema } from './ids.ts'
import { workspaceResourceReferenceSchema } from './resources.ts'

const bindingKindSchema = z.string()
  .min(3)
  .max(128)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)

export const resourceBindingSchema = z.object({
  id: bindingIdSchema,
  workspaceId: workspaceIdSchema,
  ownerModuleId: moduleIdSchema,
  kind: bindingKindSchema,
  source: workspaceResourceReferenceSchema,
  target: workspaceResourceReferenceSchema,
  configuration: z.record(z.string(), z.unknown()),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict().superRefine((binding, ctx) => {
  if (!binding.kind.startsWith(`${binding.ownerModuleId}.`)) {
    ctx.addIssue({ code: 'custom', path: ['kind'], message: 'Binding kind must be namespaced by its owning Module' })
  }
  if (binding.source.workspaceId !== binding.workspaceId) {
    ctx.addIssue({ code: 'custom', path: ['source', 'workspaceId'], message: 'Binding source must belong to the Binding Workspace' })
  }
  if (binding.target.workspaceId !== binding.workspaceId) {
    ctx.addIssue({ code: 'custom', path: ['target', 'workspaceId'], message: 'Binding target must belong to the Binding Workspace' })
  }
})
export type ResourceBinding = z.infer<typeof resourceBindingSchema>
