import type { PerspectiveViewLease, WorkspaceResourceReference } from '@leitbild/contracts'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const exactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const ref = (value: unknown, module: 'agents' | 'world', type: string): value is WorkspaceResourceReference => record(value)
  && exactKeys(value, ['workspaceId', 'moduleId', 'type', 'id']) && uuid(value.workspaceId) && value.moduleId === module && value.type === type
  && typeof value.id === 'string' && value.id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value.id)
export const samePerspectiveResource = (a: WorkspaceResourceReference, b: WorkspaceResourceReference): boolean => a.workspaceId === b.workspaceId && a.moduleId === b.moduleId && a.type === b.type && a.id === b.id

/** Small strict browser wire; schemas stay owner-published in contracts. */
export const parsePerspectiveViewLease = (value: unknown): PerspectiveViewLease | null => {
  if (!record(value) || !exactKeys(value, ['token', 'room', 'perspective', 'documentId', 'expiresAt']) || !uuid(value.token) || !uuid(value.documentId)
    || !ref(value.room, 'agents', 'agents.room') || !ref(value.perspective, 'world', 'world.perspective') || value.room.workspaceId !== value.perspective.workspaceId
    || typeof value.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value.expiresAt) || !Number.isFinite(Date.parse(value.expiresAt))) return null
  return value as unknown as PerspectiveViewLease
}

export type PerspectiveViewStatus = 'open' | 'connecting' | 'connected' | 'expired' | 'unavailable'

export const createPerspectiveViewSession = (deps: { readonly url: URL; readonly stripFragment: () => void; readonly now?: () => number }) => {
  const now = deps.now ?? Date.now
  const fragment = new URLSearchParams(deps.url.hash.slice(1)), privateIntent = fragment.has('perspective-view')
  let lease: PerspectiveViewLease | undefined, status: PerspectiveViewStatus = privateIntent ? 'unavailable' : 'open'
  let deliveryVersion = 0
  if (privateIntent) {
    const raw = fragment.get('perspective-view')
    deps.stripFragment() // Remove the token before parsing, startup requests, logging or history persistence.
    try {
      const candidate = parsePerspectiveViewLease(JSON.parse(raw ?? 'null'))
      const match = deps.url.pathname.match(/^\/workspaces\/([^/]+)\/agents$/)
      if (candidate !== null && candidate.room.workspaceId === match?.[1] && candidate.room.id === deps.url.searchParams.get('room')
        && deps.url.searchParams.get('view') === 'focused') { lease = candidate; status = Date.parse(candidate.expiresAt) > now() ? 'connecting' : 'expired' }
    } catch { /* Explicit invalid private intent remains locked; it never falls back to an ordinary view. */ }
  }
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const checkExpiry = (): void => {
    if (lease !== undefined && Date.parse(lease.expiresAt) <= now() && status !== 'expired') { status = 'expired'; notify() }
  }
  const requireLease = (): PerspectiveViewLease | undefined => {
    checkExpiry()
    if (!privateIntent) return undefined
    if (lease === undefined || status === 'expired' || status === 'unavailable') throw new Error('Perspective view is unavailable; reconnect from the current exercise. Your unsent draft remains in this compartment.')
    return structuredClone(lease)
  }
  return {
    privateIntent,
    status: () => { checkExpiry(); return status },
    current: () => lease === undefined ? undefined : structuredClone(lease),
    deliveryVersion: () => deliveryVersion,
    requireLease,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    accept: (raw: unknown): boolean => {
      const next = parsePerspectiveViewLease(raw)
      if (!privateIntent || next === null || lease === undefined || next.token !== lease.token || next.documentId !== lease.documentId
        || !samePerspectiveResource(next.room, lease.room) || !samePerspectiveResource(next.perspective, lease.perspective) || Date.parse(next.expiresAt) <= now()) return false
      lease = next
      deliveryVersion++
      if (status === 'expired' || status === 'unavailable') status = 'connecting'
      notify()
      return true
    },
    connected: (connected: boolean) => {
      checkExpiry()
      if (!privateIntent || lease === undefined || status === 'expired' || status === 'unavailable') return
      status = connected ? 'connected' : 'connecting'; notify()
    },
    unavailable: () => { if (privateIntent) { status = 'unavailable'; notify() } },
    canSubmit: (roomId: string): boolean => { checkExpiry(); return !privateIntent || status === 'connected' && lease?.room.id === roomId },
    waitForLease: async (): Promise<void> => {
      if (!privateIntent) return
      if (lease === undefined) throw new Error('Invalid Perspective document. Reopen the Assistant from the current exercise.')
      try { requireLease(); return } catch { /* A stale fragment can wait for this exact document's current owner renewal. */ }
      await new Promise<void>(resolve => {
        const changed = () => {
          try { requireLease(); listeners.delete(changed); resolve() } catch { /* Keep the expired document locked until its exact renewal arrives. */ }
        }
        listeners.add(changed)
      })
    },
  }
}

// One private view lives only in this document's memory. It is never an Agent
// Profile binding, local/session-storage entry, URL query, DOM attribute or log.
export const perspectiveView = createPerspectiveViewSession({
  url: new URL(typeof window === 'undefined' ? 'http://local.invalid/' : location.href),
  stripFragment: () => history.replaceState(history.state, '', `${location.pathname}${location.search}`),
})
if (typeof window !== 'undefined') window.addEventListener('message', event => {
  if (event.source !== window.parent || event.origin !== location.origin || window.parent === window || !record(event.data)
    || !exactKeys(event.data, ['type', 'lease']) || event.data.type !== 'leitbild:perspective-view') return
  perspectiveView.accept(event.data.lease)
})
