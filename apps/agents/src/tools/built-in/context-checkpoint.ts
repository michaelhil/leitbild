import { z } from 'zod'
import { CONTEXT_CHECKPOINT_TOOL, contextCheckpointInputSchema, isWorkingContextArchiveFailure } from '../../core/working-context.ts'
import type { Tool } from '../../core/types/tool.ts'

export const createContextCheckpointTool = (): Tool => ({
  name: CONTEXT_CHECKPOINT_TOOL, contextEffect: 'read',
  description: 'Checkpoint working context at a completed semantic boundary, retaining exact execution toolCallIds and reasons. Use execution selectors from tool outcomes; keep source-required records/current evidence and unresolved work. Full outcomes remain archived and retrievable. Call alone; no summary replaces evidence. Requires a live durable execution archive.',
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
