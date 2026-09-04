import { z } from 'zod'
import { capabilityIdSchema } from './ids.ts'

// A Tool Grant authorizes one named Workspace Capability. Workspace scope is
// supplied by the Agent runtime and the concrete Resource is selected for each
// invocation; neither is persisted in the Agent Profile.
export const exactToolGrantSchema = z.object({
  capabilityId: capabilityIdSchema,
}).strict()
export type ExactToolGrant = z.infer<typeof exactToolGrantSchema>

// The Room's Subject Selection identifies candidate Resources; this grant
// independently supplies authority for the declared non-destructive risks.
// The broker resolves collection membership on every invocation.
export const roomSubjectToolGrantSchema = z.object({
  scope: z.literal('room-subject'),
  risks: z.array(z.enum(['read', 'write'])).min(1),
}).strict()
export type RoomSubjectToolGrant = z.infer<typeof roomSubjectToolGrantSchema>

export const toolGrantSchema = z.union([
  exactToolGrantSchema,
  roomSubjectToolGrantSchema,
])
export type ToolGrant = z.infer<typeof toolGrantSchema>

export const isExactToolGrant = (grant: ToolGrant): grant is ExactToolGrant =>
  'capabilityId' in grant

export const toolGrantKey = (grant: ToolGrant): string =>
  isExactToolGrant(grant) ? `capability:${grant.capabilityId}` : `${grant.scope}:${[...grant.risks].sort().join(',')}`

export const toolGrantSetSchema = z.array(toolGrantSchema).superRefine((grants, ctx) => {
  const seen = new Set<string>()
  grants.forEach((grant, index) => {
    const key = toolGrantKey(grant)
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [index],
        message: `duplicate Tool Grant: ${key}`,
      })
    }
    seen.add(key)
  })
})
export type ToolGrantSet = z.infer<typeof toolGrantSetSchema>
