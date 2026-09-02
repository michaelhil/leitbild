import { z } from 'zod'
import { isoTimestampSchema, moduleIdSchema, workspaceIdSchema } from './ids.ts'

export const moduleFailureSchema = z.object({
  code: z.string().min(1).max(128).regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
  message: z.string().min(1).max(2048),
  retryable: z.boolean(),
  status: z.number().int().min(400).max(599).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict()
export type ModuleFailure = z.infer<typeof moduleFailureSchema>

export const moduleProvisioningStateSchema = z.object({
  moduleId: moduleIdSchema,
  status: z.enum(['provisioning', 'ready', 'provision_failed', 'removing', 'remove_failed']),
  failure: moduleFailureSchema.optional(),
  updatedAt: isoTimestampSchema,
}).strict().superRefine((state, ctx) => {
  const failed = state.status === 'provision_failed' || state.status === 'remove_failed'
  if (failed && state.failure === undefined) {
    ctx.addIssue({ code: 'custom', path: ['failure'], message: `${state.status} requires a failure` })
  }
  if (!failed && state.failure !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['failure'], message: `${state.status} cannot carry a failure` })
  }
})
export type ModuleProvisioningState = z.infer<typeof moduleProvisioningStateSchema>

export const workspaceSchema = z.object({
  id: workspaceIdSchema,
  name: z.string().trim().min(1).max(256).nullable(),
  modules: z.array(moduleProvisioningStateSchema),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict().superRefine((workspace, ctx) => {
  const seen = new Set<string>()
  workspace.modules.forEach((state, index) => {
    if (seen.has(state.moduleId)) {
      ctx.addIssue({ code: 'custom', path: ['modules', index, 'moduleId'], message: `duplicate Module provisioning state: ${state.moduleId}` })
    }
    seen.add(state.moduleId)
  })
})
export type Workspace = z.infer<typeof workspaceSchema>

export const createWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1).max(256).nullable().optional(),
}).strict()
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>

export const renameWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1).max(256).nullable(),
}).strict()
export type RenameWorkspaceInput = z.infer<typeof renameWorkspaceInputSchema>
