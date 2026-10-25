import { z } from 'zod'
import type { SimulationRunId } from '../../core/model/ids.ts'
import { withActiveRoleSet } from '../roles/role-session.ts'
import { workspaceApiPath } from '../workspace-context.ts'
import { layoutLiveResponseSchema, type LayoutLiveExpected, type LayoutLiveResponse } from './read-model.ts'
import { admitPhysicalLiveStamp, physicalLiveFresh, type PhysicalLiveStamp } from './status.ts'

export interface LayoutPresence {
  readonly loaded: boolean
  readonly displayEpoch: string | null
  readonly snapshotSeq: number | null
}

export interface LayoutLiveRoutes {
  readonly presence: (runId: SimulationRunId, signal: AbortSignal) => Promise<LayoutPresence | null>
  readonly read: (expected: LayoutLiveExpected, signal: AbortSignal) => Promise<unknown>
}

export interface LayoutLiveSnapshot {
  readonly phase: 'connecting' | 'live' | 'inactive' | 'missing' | 'failed' | 'suspended'
  readonly latest: LayoutLiveResponse | null
  readonly stamp: PhysicalLiveStamp | null
  readonly failure: string | null
}

export const layoutLiveFrozen = (snapshot: LayoutLiveSnapshot, wallNowMs: number): boolean =>
  snapshot.phase !== 'live' || !physicalLiveFresh(snapshot.stamp, wallNowMs, snapshot.failure !== null)

type Timer = (callback: () => void, delayMs: number) => () => void
const timer: Timer = (callback, delayMs) => { const id = setTimeout(callback, delayMs); return () => clearTimeout(id) }

/**
 * One acquisition per visible scope, with presence confirmed before demand and
 * every five samples. It never loads/resumes a Run. A hidden/replaced view
 * cancels its request and cannot absorb a late reply. Role changes recreate
 * the session, so a retained sample never acquires the new role's authority.
 */
export const createLayoutLiveSession = (config: {
  readonly expected: LayoutLiveExpected
  readonly routes: LayoutLiveRoutes
  readonly onChange: (snapshot: LayoutLiveSnapshot) => void
  readonly schedule?: Timer
  readonly wallNow?: () => number
}) => {
  const schedule = config.schedule ?? timer
  const now = config.wallNow ?? Date.now
  let snapshot: LayoutLiveSnapshot = { phase: 'connecting', latest: null, stamp: null, failure: null }
  let closed = false
  let visible = true
  let started = false
  let generation = 0
  let confirmedEpoch: string | null = null
  let acquired = 0
  let request: AbortController | null = null
  let cancel: (() => void) | null = null

  const update = (patch: Partial<LayoutLiveSnapshot>): void => {
    if (closed) return
    snapshot = { ...snapshot, ...patch }
    config.onChange(snapshot)
  }
  const stopTimer = (): void => { cancel?.(); cancel = null }
  const next = (delay: number): void => {
    stopTimer()
    if (!closed && visible && started) cancel = schedule(() => { cancel = null; void step() }, delay)
  }

  const step = async (): Promise<void> => {
    if (closed || !visible || request !== null) return
    const active = new AbortController()
    request = active
    const atGeneration = generation
    const requestedWallMs = now()
    const current = (): boolean => !closed && visible && generation === atGeneration && !active.signal.aborted
    let delay = 1_000
    try {
      if (confirmedEpoch === null || acquired % 5 === 0) {
        const presence = await config.routes.presence(config.expected.runId, active.signal)
        if (!current()) return
        if (presence === null) { update({ phase: 'missing', failure: 'This Run no longer exists' }); return }
        if (!presence.loaded) { confirmedEpoch = null; update({ phase: 'inactive', failure: null }); delay = 5_000; return }
        if (presence.displayEpoch === null || presence.snapshotSeq === null) throw new Error('The loaded Run did not confirm its display epoch and sequence')
        confirmedEpoch = presence.displayEpoch
      }
      const response = layoutLiveResponseSchema.parse(await config.routes.read(config.expected, active.signal))
      if (!current()) return
      if (now() - requestedWallMs > 5_000) throw new Error('Layout acquisition took over five seconds; its evidence is not current')
      if ((Object.keys(config.expected) as ReadonlyArray<keyof LayoutLiveExpected>).some(key => config.expected[key] !== response.scope[key])) throw new Error('The layout response belongs to a different Run, model or binding')
      if (response.scope.epoch !== confirmedEpoch) {
        // The owner may have reset while this request was in flight. Confirm
        // its new epoch through presence, then acquire a whole fresh sample.
        confirmedEpoch = null
        update({ phase: 'connecting', failure: 'Run changed; confirming a fresh sample' })
        // Even a persistently inconsistent owner must not turn this bounded
        // reader into an immediate presence/read loop.
        delay = 1_000
        return
      }
      const stamp: PhysicalLiveStamp = { scope: response.scope, epoch: response.scope.epoch, sequence: response.scope.sequence, receivedWallMs: now() }
      admitPhysicalLiveStamp(config.expected, confirmedEpoch!, snapshot.stamp, stamp)
      acquired += 1
      update({ phase: 'live', latest: response, stamp, failure: null })
    } catch (error) {
      if (!current()) return
      confirmedEpoch = null
      delay = 2_000
      update({ phase: 'failed', failure: error instanceof Error ? error.message : String(error) })
    } finally {
      if (request === active) request = null
      if (!closed && visible && snapshot.phase !== 'missing') next(atGeneration === generation ? delay : 0)
    }
  }

  return {
    start: (): void => { if (started || closed) return; started = true; void step() },
    setVisible: (shown: boolean): void => {
      if (shown === visible || closed) return
      visible = shown
      generation += 1
      stopTimer()
      request?.abort()
      confirmedEpoch = null
      if (!shown) update({ phase: 'suspended', failure: null })
      else { update({ phase: 'connecting', failure: null }); if (request === null && started) void step() }
    },
    close: (): void => { closed = true; generation += 1; stopTimer(); request?.abort() },
  }
}

export type LayoutLiveSession = ReturnType<typeof createLayoutLiveSession>

const runPath = (runId: SimulationRunId, suffix: string): string => withActiveRoleSet(workspaceApiPath(`/simulation-runs/${encodeURIComponent(runId)}${suffix}` as `/${string}`))

const responseBody = async (response: Response, action: string): Promise<unknown> => {
  const body: unknown = await response.json()
  if (response.ok) return body
  const error = z.object({ error: z.object({ message: z.string() }).passthrough() }).passthrough().safeParse(body)
  throw new Error(error.success ? error.data.error.message : `${action}: HTTP ${response.status}`)
}

export const layoutLiveRoutes: LayoutLiveRoutes = {
  presence: async (runId, signal) => {
    const response = await fetch(runPath(runId, '/presence'), { signal })
    if (response.status === 404) return null
    const body = z.object({ loaded: z.boolean(), displayEpoch: z.string().min(1).nullable().optional(), snapshotSeq: z.number().int().nonnegative().nullable().optional() }).passthrough()
      .parse(await responseBody(response, 'Reading Run presence'))
    return { loaded: body.loaded, displayEpoch: body.displayEpoch ?? null, snapshotSeq: body.snapshotSeq ?? null }
  },
  read: async (expected, signal) => responseBody(await fetch(runPath(expected.runId, '/displays/layout'), {
    method: 'POST', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ layoutObjectId: expected.layoutObjectId, expectedRevision: expected.revision }),
  }), 'Reading layout status'),
}
