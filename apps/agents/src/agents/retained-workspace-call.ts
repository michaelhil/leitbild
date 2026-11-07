import { workspaceResourceReferenceSchema, type WorkspaceResourceReference } from '@leitbild/contracts'
import type { ExecutionCall, ExecutionStore } from '../core/executions/store.ts'

export interface RetainedWorkspaceResult {
  readonly callId: string
  readonly key: string
  readonly operationId: string
  readonly resource: WorkspaceResourceReference | undefined
  readonly input: unknown
  readonly data: unknown
  readonly success: boolean
  readonly error: string | undefined
  readonly startedAt: number
  readonly completedAt: number | undefined
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const resourceOf = (target: unknown): WorkspaceResourceReference | undefined => {
  if (!record(target) || target.kind !== 'resource') return undefined
  const parsed = workspaceResourceReferenceSchema.safeParse(target.ref)
  return parsed.success ? parsed.data : undefined
}

/** The executor records its resolved Resource even when the model omits a target.
 * A failed entry can lack a target. Its input and refusal remain available. */
export const retainedWorkspaceResults = (calls: ReadonlyArray<ExecutionCall>): ReadonlyArray<RetainedWorkspaceResult> => calls.flatMap(call => {
  if (call.tool !== 'workspace_call' || call.result?.success !== true || !record(call.arguments) || !Array.isArray(call.arguments.calls)
    || !record(call.result.data) || !Array.isArray(call.result.data.results)) return []
  const requests = call.arguments.calls.filter(record)
  return call.result.data.results.flatMap((entry): ReadonlyArray<RetainedWorkspaceResult> => {
    if (!record(entry) || typeof entry.key !== 'string' || typeof entry.operationId !== 'string' || typeof entry.success !== 'boolean') return []
    // Admission trims keys and requires them to be unique within the batch.
    const matching = requests.filter(request => typeof request.key === 'string' && request.key.trim() === entry.key)
    const request = matching[0]
    if (matching.length !== 1 || request?.operationId !== entry.operationId) return []
    const resource = resourceOf(entry.target)
    if (resource !== undefined && request.target !== undefined) {
      const requested = resourceOf(request.target)
      if (requested === undefined || requested.workspaceId !== resource.workspaceId || requested.moduleId !== resource.moduleId
        || requested.type !== resource.type || requested.id !== resource.id) return []
    }
    return [{ callId: call.id, key: entry.key, operationId: entry.operationId, resource, input: request.input, data: entry.data,
      success: entry.success, error: typeof entry.error === 'string' ? entry.error : undefined, startedAt: call.startedAt, completedAt: call.completedAt }]
  })
})

export const readRetainedWorkspaceResults = (store: Pick<ExecutionStore, 'listCalls' | 'getCall'>, roomId: string, turnId: string): ReadonlyArray<RetainedWorkspaceResult> =>
  retainedWorkspaceResults(store.listCalls(roomId, turnId).flatMap(summary => {
    const call = store.getCall(roomId, turnId, summary.id)
    return call === undefined ? [] : [call] // Missing retained evidence establishes no continuation.
  }))
