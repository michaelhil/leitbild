import { z } from 'zod'
import { requestIdSchema, workspaceIdSchema } from './ids.ts'
import { perspectiveOriginSchema } from './perspective-origin.ts'

export const actorContextSchema = z.object({
  kind: z.enum(['human', 'ai', 'system', 'anonymous']),
  id: z.string().min(1).max(256).optional(),
  displayName: z.string().min(1).max(256).optional(),
}).strict()
export type ActorContext = z.infer<typeof actorContextSchema>

export const clientContextSchema = z.object({
  id: z.string().min(1).max(256),
  kind: z.enum(['browser', 'api', 'mcp', 'service', 'system']),
}).strict()
export type ClientContext = z.infer<typeof clientContextSchema>

export const accessContextSchema = z.object({
  workspaceId: workspaceIdSchema,
  requestId: requestIdSchema,
  actor: actorContextSchema,
  client: clientContextSchema.optional(),
  correlationId: z.string().min(1).max(256).optional(),
  // Host admits this only from internal Module calls. It is not in the public invocation shape.
  perspectiveOrigin: perspectiveOriginSchema.optional(),
}).strict()
export type AccessContext = z.infer<typeof accessContextSchema>
