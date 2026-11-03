import { z } from 'zod'
import { agentsPerspectiveRoomAdmissionSchema } from '@leitbild/contracts'

const witness = z.object({ name: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

/** Agents-owned immutable material admitted from the reusable public template.
 * The Profile contains no World binding. Private runtime state belongs to its Room.
 */
export const perspectiveRoomStateSchema = z.object({
  requestId: z.string().uuid(),
  admission: agentsPerspectiveRoomAdmissionSchema,
  workspacePrompt: z.string(),
  responseFormat: z.string(),
  tools: z.array(witness),
  skills: z.array(witness.extend({ description: z.string(), body: z.string(), allowedToolNames: z.array(z.string()) })),
}).strict().superRefine((state, context) => {
  if (state.admission.runtimeAvailability !== undefined) context.addIssue({ code: 'custom', path: ['admission', 'runtimeAvailability'], message: 'Runtime availability is derived on read and is never persisted' })
})
export type PerspectiveRoomState = z.infer<typeof perspectiveRoomStateSchema>

export const perspectiveMessageProvenanceSchema = z.object({
  perspectiveId: z.string().min(1), admissionGeneration: z.string().uuid(),
  actualAgentId: z.string().min(1), runtimeGeneration: z.string().uuid(),
}).strict()
export type PerspectiveMessageProvenance = z.infer<typeof perspectiveMessageProvenanceSchema>
