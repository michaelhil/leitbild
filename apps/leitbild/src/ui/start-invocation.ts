import type { WorkspaceDefinitionRevisionReference, WorkspaceResourceReference } from '@leitbild/contracts'
import { plainError } from './error-text.ts'
import { readHostJson } from './launch-workspace.ts'

type StartReceipt =
  | { readonly kind: 'accepted'; readonly created: ReadonlyArray<WorkspaceResourceReference> }
  | { readonly kind: 'aborted' | 'outcome-unknown' | 'capacity' | 'failed'; readonly cause: unknown }

/** Dispatch once, and distinguish an explicit refusal from a missing or untrustworthy receipt. */
export const invokeDefinitionStart = async ({
  workspaceId, definition, capabilityId, input = {}, fetch, signal, onDispatch, requiredResource,
}: {
  readonly workspaceId: string
  readonly definition: Omit<WorkspaceDefinitionRevisionReference, 'revisionId'> & { readonly revisionId: string }
  readonly capabilityId: string
  readonly input?: Readonly<Record<string, unknown>>
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly signal?: AbortSignal | undefined
  readonly onDispatch: () => void
  readonly requiredResource?: string | undefined
}): Promise<StartReceipt> => {
  const { moduleCapabilityInvocationResultSchema, workspaceDefinitionRevisionReferenceSchema } = await import('@leitbild/contracts')
  if (signal?.aborted) return { kind: 'aborted', cause: signal.reason }
  if (definition.workspaceId !== workspaceId) {
    return { kind: 'failed', cause: new Error('The selected Definition belongs to another Workspace.') }
  }
  const target = workspaceDefinitionRevisionReferenceSchema.safeParse(definition)
  if (!target.success) {
    return { kind: 'failed', cause: new Error('The selected Definition revision is invalid.', { cause: target.error }) }
  }
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/${encodeURIComponent(capabilityId)}/invoke`
  const body = JSON.stringify({ definition: target.data, input, actor: { kind: 'human' } })
  let value: unknown
  onDispatch()
  try {
    value = await readHostJson(await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      ...(signal === undefined ? {} : { signal }),
    }))
  } catch (cause) {
    if (signal?.aborted) return { kind: 'aborted', cause }
    const { code, status } = plainError(cause)
    if (code === 'workspace_capacity_exceeded') return { kind: 'capacity', cause }
    // An unexplained server failure can arrive after creation. The Host's
    // module_unavailable error comes from discovery before forwarding the POST.
    if (code !== 'module_unavailable' && (status === null || status >= 500 || code === 'module_outcome_unknown')) {
      return { kind: 'outcome-unknown', cause }
    }
    return { kind: 'failed', cause }
  }
  if (signal?.aborted) return { kind: 'aborted', cause: signal.reason }
  const parsed = moduleCapabilityInvocationResultSchema.safeParse(value)
  if (!parsed.success) return { kind: 'outcome-unknown', cause: parsed.error }
  const created = parsed.data.createdResources ?? []
  if (created.some(resource => resource.workspaceId !== workspaceId)) {
    return { kind: 'outcome-unknown', cause: new Error('The start reported Resources in another Workspace.') }
  }
  if (requiredResource && created.filter(resource => resource.type === requiredResource).length !== 1) {
    return { kind: 'outcome-unknown', cause: new Error(`The start did not identify exactly one ${requiredResource}.`) }
  }
  return { kind: 'accepted', created }
}
