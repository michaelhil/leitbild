import type { ContextCheckpointManifest, ExecutionRecallSelector } from '../../../core/working-context.ts'
import type { ExecutionModelCallSummary } from '../../../core/executions/model-evidence.ts'
import type { JourneyEvent } from './execution-journey.ts'

/** Inspect only an explicitly recorded lineage identity. Times or later
 * reduced message counts do not establish that a checkpoint happened. */
export const recordedCheckpointEvent = (events: ReadonlyArray<JourneyEvent>, turnId: string, checkpointId: string): JourneyEvent | undefined =>
  events.find(event => event.source.kind === 'stage' && event.source.stage.event.kind === 'context_checkpoint'
    && event.source.stage.event.manifest.turnId === turnId && event.source.stage.event.manifest.checkpointId === checkpointId)

/** These selectors inspect existing records. They never call the original
 * tool, and never use a provider call ID as an execution identity. */
export const recordedRecallEvent = (events: ReadonlyArray<JourneyEvent>, turnId: string, read: ExecutionRecallSelector): JourneyEvent | undefined => {
  if (read.turnId !== turnId) return undefined
  return events.find(event => event.source.kind === 'tool' && event.source.call.id === read.toolCallId)
}

export const checkpointRequestLineage = (models: ReadonlyArray<ExecutionModelCallSummary>, manifest: ContextCheckpointManifest): {
  readonly preceding: ExecutionModelCallSummary | undefined
  readonly following: ReadonlyArray<ExecutionModelCallSummary>
} => ({
  preceding: models.find(model => model.id === manifest.precedingModelId),
  following: models.filter(model => model.contextCheckpointId === manifest.checkpointId),
})
