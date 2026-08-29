import { z } from 'zod'
import {
  isoTimestampSchema,
  moduleBindingSchema,
  moduleIdSchema,
  workspaceIdSchema,
} from '@samsinn-leitbild/platform-contracts'

export const moduleTargetSchema = z.object({
  moduleId: moduleIdSchema,
  baseUrl: z.url(),
}).strict()
export type ModuleTarget = z.infer<typeof moduleTargetSchema>

export const moduleProvisioningSchema = z.object({
  moduleId: moduleIdSchema,
  baseUrl: z.url(),
  status: z.enum(['pending', 'ready', 'failed']),
  binding: moduleBindingSchema.optional(),
  workspaceUrl: z.url().optional(),
  error: z.string().min(1).optional(),
  updatedAt: isoTimestampSchema,
}).strict().superRefine((module, ctx) => {
  if (module.status === 'ready' && (!module.binding || !module.workspaceUrl)) {
    ctx.addIssue({ code: 'custom', message: 'ready Module requires a binding and Workspace URL' })
  }
  if (module.status === 'failed' && module.error === undefined) {
    ctx.addIssue({ code: 'custom', message: 'failed Module requires an error' })
  }
})
export type ModuleProvisioning = z.infer<typeof moduleProvisioningSchema>

export const suiteWorkspaceSchema = z.object({
  id: workspaceIdSchema,
  displayName: z.string().min(1).max(256),
  modules: z.array(moduleProvisioningSchema),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict().superRefine((workspace, ctx) => {
  const seen = new Set<string>()
  workspace.modules.forEach((module, index) => {
    if (seen.has(module.moduleId)) {
      ctx.addIssue({ code: 'custom', path: ['modules', index, 'moduleId'], message: `duplicate Module: ${module.moduleId}` })
    }
    seen.add(module.moduleId)
  })
})
export type SuiteWorkspace = z.infer<typeof suiteWorkspaceSchema>
