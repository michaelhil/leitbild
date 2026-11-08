import type { ExecutionInspection, JourneyEvent } from './execution-journey.ts'
import type { ExecutionCall } from '../../../core/executions/store.ts'
import { checkViewEnvelope, trustedEngineeringViewEntry } from '../../../core/render-validators/view-fence.ts'

export interface ProgressActivity {
  readonly content: string
  readonly evidence: {
    readonly turnId: string
    readonly callId: string
    readonly callIds: ReadonlyArray<string>
    readonly operationKey?: string
  }
}

/** Explicit runtime membership, never an estimate from message text, time or
 * list position. Two updates may intentionally share a recorded batch. */
export const progressActivityEvents = (
  execution: ExecutionInspection,
  events: ReadonlyArray<JourneyEvent>,
  activity: ProgressActivity,
): ReadonlyArray<JourneyEvent> | undefined => {
  if (execution.turn.id !== activity.evidence.turnId) return
  const calls = new Set(activity.evidence.callIds)
  if (!calls.has(activity.evidence.callId) || calls.size !== activity.evidence.callIds.length || ![...calls].every(id => execution.calls.some(call => call.id === id))) return
  return events.filter(event => event.source.kind === 'tool' ? calls.has(event.source.call.id)
    : event.source.kind === 'model' && (event.source.call.requestedTools?.some(tool => tool.executionCallId !== undefined && calls.has(tool.executionCallId)) ?? false))
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

export interface RecordedOperation {
  readonly key: string
  readonly operationId: string
  readonly input: unknown
  readonly target?: unknown
  readonly result?: Record<string, unknown>
  /** Set only after validating the two built-ins, never copied from tool data. */
  readonly engineeringPublication?: true
}

/** Agents owns the workspace_call envelope; the owning Module's result stays
 * opaque. An accepted command is not reclassified as physical success. */
export const recordedOperations = (call: ExecutionCall): ReadonlyArray<RecordedOperation> => {
  const engineering = trustedEngineeringViewEntry(call)
  if (engineering !== null) return [{ key: engineering.key, operationId: call.tool, input: call.arguments, result: engineering, engineeringPublication: true }]
  if (call.tool !== 'workspace_call') return []
  const args = object(call.arguments)
  if (!Array.isArray(args?.calls)) return []
  const data = object(call.result?.data)
  const results = Array.isArray(data?.results) ? data.results.map(object).filter(item => item !== undefined) : []
  return args.calls.flatMap(item => {
    const operation = object(item)
    if (typeof operation?.key !== 'string' || typeof operation.operationId !== 'string') return []
    const matches = results.filter(result => result.key === operation.key && result.operationId === operation.operationId)
    return [{ key: operation.key, operationId: operation.operationId, input: operation.input,
      ...(operation.target === undefined ? {} : { target: operation.target }),
      ...(matches.length === 1 ? { result: matches[0] } : {}),
    }]
  })
}

export const recordedOperationView = (operation: RecordedOperation, workspaceId: string): ReturnType<typeof checkViewEnvelope> | undefined => {
  // A publication is optional. A provided but invalid one remains an explicit
  // refusal, rather than silently hiding why its view could not be opened.
  if (operation.result?.success !== true || operation.result.embeddedView === undefined) return
  const checked = checkViewEnvelope(operation.result.embeddedView, workspaceId)
  if (checked.kind === 'view' && checked.envelope.moduleId === 'agents' && operation.engineeringPublication !== true) return { kind: 'refused', code: 'view_module_not_embeddable', error: 'Only a retained engineering built-in can publish this Room calculation' }
  return checked
}
