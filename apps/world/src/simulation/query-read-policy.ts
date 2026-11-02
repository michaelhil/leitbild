/** World-internal immutable read policy. Owners apply it before deriving data,
 * not by scrubbing serialized JSON. It is never accepted from a wire payload. */
export interface QueryReadPolicy {
  readonly key: string
  readonly restricted: boolean
  readonly canInspect: (objectId: string) => boolean
}

export const createQueryReadPolicy = (key: string, deniedObjectIds: ReadonlyArray<string>): QueryReadPolicy => {
  const denied = new Set(deniedObjectIds)
  return Object.freeze({ key, restricted: denied.size > 0, canInspect: (objectId: string) => !denied.has(objectId) })
}

/** Internal mechanical reads and explicit test callers; public calls get a Run/caller policy. */
export const unrestrictedQueryReadPolicy = createQueryReadPolicy('world:internal-mechanics', [])

/** A dependent model cannot subtract hidden contributions without inventing a different physical result. */
export const unavailableQueryReadScope = (reason: string): never => {
  throw Object.assign(new Error(reason), { code: 'query_read_scope_unavailable', status: 403 })
}

export const isQueryReadRefusal = (error: unknown): error is Error & { readonly code: 'query_policy_superseded' | 'query_read_scope_unavailable'; readonly status: 403 | 409 } =>
  error instanceof Error && 'code' in error && 'status' in error && (
    (error.code === 'query_policy_superseded' && error.status === 409)
    || (error.code === 'query_read_scope_unavailable' && error.status === 403)
  )
