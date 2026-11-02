import { z } from 'zod'
import { resourceIdSchema } from './ids.ts'

const identity = z.string().min(1).max(256)

/** Internal Module/Host relationship metadata, never public request or model arguments.
 * It is not authenticated participant identity or a bearer grant. */
export const perspectiveOriginSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('execution'),
    roomId: resourceIdSchema,
    actualAgentId: identity,
    runtimeGeneration: z.string().uuid(),
    turnId: identity,
    perspectiveId: resourceIdSchema,
    admissionGeneration: z.string().uuid(),
  }).strict(),
  // Accepted only by exact admission/verification ports, never as general read authority.
  z.object({ kind: z.literal('owner'), moduleId: z.enum(['host', 'world', 'agents']) }).strict(),
])
export type PerspectiveOrigin = z.infer<typeof perspectiveOriginSchema>
