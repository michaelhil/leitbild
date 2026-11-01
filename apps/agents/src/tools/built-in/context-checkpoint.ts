import { z } from 'zod'
import { CONTEXT_CHECKPOINT_TOOL, contextCheckpointInputSchema, isWorkingContextArchiveFailure } from '../../core/working-context.ts'
import type { Tool } from '../../core/types/tool.ts'

export const createContextCheckpointTool = (): Tool => ({
  name: CONTEXT_CHECKPOINT_TOOL, contextEffect: 'read',
  description: 'Checkpoint working context at a completed phase or coherent recorded review, not every timer/read/write. Retain returned execution toolCallIds for source-required records/current evidence and unresolved work; explain why. Never use operation keys or inferred IDs. Retaining one call keeps its whole native response group, including every workspace_call operation. Call alone. Full outcomes and manifest remain archived: conversation_read {turnId,toolCallId,part:"arguments"|"result"}. Receipt retainedGroups stay active; archivedGroups is only newly removed groups. returnedChangeGroups is the cumulative ledger factored by exact tool/effects with original call indices and common turnId. Returned invocation receipts do not prove attainment. No summary replaces evidence. Requires a live durable execution archive.',
  parameters: z.toJSONSchema(contextCheckpointInputSchema),
  execute: async (input, context) => {
    if (!context.contextCheckpoint) return { success: false, error: 'context_checkpoint_unavailable: this execution has no durable working-context archive; context is unchanged' }
    try { return { success: true, data: await context.contextCheckpoint(contextCheckpointInputSchema.parse(input)) } }
    catch (error) {
      if (isWorkingContextArchiveFailure(error)) throw error
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },
})
