import { z } from 'zod'
import { capabilityIdSchema } from './ids.ts'

// A Tool Grant authorizes one named Workspace Capability. Workspace scope is
// supplied by the Agent runtime and the concrete Resource is selected for each
// invocation; neither is persisted in the Agent Profile.
export const toolGrantSchema = z.object({
  capabilityId: capabilityIdSchema,
}).strict()
export type ToolGrant = z.infer<typeof toolGrantSchema>

export const toolGrantSetSchema = z.array(toolGrantSchema).superRefine((grants, ctx) => {
  const seen = new Set<string>()
  grants.forEach((grant, index) => {
    if (seen.has(grant.capabilityId)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'capabilityId'],
        message: `duplicate Tool Grant: ${grant.capabilityId}`,
      })
    }
    seen.add(grant.capabilityId)
  })
})
export type ToolGrantSet = z.infer<typeof toolGrantSetSchema>
