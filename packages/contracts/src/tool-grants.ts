import { z } from 'zod'
import { capabilityIdSchema } from './ids.ts'

// A Tool Grant authorizes one named Workspace Capability. Workspace scope is
// supplied by the Agent runtime and the concrete Resource is selected for each
// invocation; neither is persisted in the Agent Profile.
export const exactToolGrantSchema = z.object({
  capabilityId: capabilityIdSchema,
}).strict()
export type ExactToolGrant = z.infer<typeof exactToolGrantSchema>

// The Room association selects a Resource; this grant supplies read authority.
// Neither the association nor this grant is sufficient by itself.
export const roomLinkedResourceReadToolGrantSchema = z.object({
  scope: z.literal('room-linked-resource'),
  risk: z.literal('read'),
}).strict()
export type RoomLinkedResourceReadToolGrant = z.infer<typeof roomLinkedResourceReadToolGrantSchema>

export const toolGrantSchema = z.union([
  exactToolGrantSchema,
  roomLinkedResourceReadToolGrantSchema,
])
export type ToolGrant = z.infer<typeof toolGrantSchema>

export const isExactToolGrant = (grant: ToolGrant): grant is ExactToolGrant =>
  'capabilityId' in grant

export const toolGrantKey = (grant: ToolGrant): string =>
  isExactToolGrant(grant) ? `capability:${grant.capabilityId}` : `${grant.scope}:${grant.risk}`

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
