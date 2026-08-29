import { z } from 'zod'
import { isoTimestampSchema, moduleIdSchema, workspaceIdSchema } from './ids.ts'

export const moduleFailureSchema = z.object({
  code: z.string().min(1).max(128).regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
  message: z.string().min(1).max(2048),
  retryable: z.boolean(),
}).strict()
export type ModuleFailure = z.infer<typeof moduleFailureSchema>

export const moduleMembershipSchema = z.object({
  moduleId: moduleIdSchema,
  status: z.enum(['joining', 'ready', 'join_failed', 'leaving', 'leave_failed']),
  failure: moduleFailureSchema.optional(),
  updatedAt: isoTimestampSchema,
}).strict().superRefine((membership, ctx) => {
  const failed = membership.status === 'join_failed' || membership.status === 'leave_failed'
  if (failed && membership.failure === undefined) {
    ctx.addIssue({ code: 'custom', path: ['failure'], message: `${membership.status} requires a failure` })
  }
  if (!failed && membership.failure !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['failure'], message: `${membership.status} cannot carry a failure` })
  }
})
export type ModuleMembership = z.infer<typeof moduleMembershipSchema>

export const workspaceSchema = z.object({
  id: workspaceIdSchema,
  name: z.string().trim().min(1).max(256).nullable(),
  modules: z.array(moduleMembershipSchema),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict().superRefine((workspace, ctx) => {
  const seen = new Set<string>()
  workspace.modules.forEach((membership, index) => {
    if (seen.has(membership.moduleId)) {
      ctx.addIssue({ code: 'custom', path: ['modules', index, 'moduleId'], message: `duplicate Module Membership: ${membership.moduleId}` })
    }
    seen.add(membership.moduleId)
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
