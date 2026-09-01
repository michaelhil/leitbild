import { nowIso, type CommandEnvelope, type CommandResult, type SimulationRunEvent, type IsoTimestamp, type ObjectId, type OperationalObject, type SimulationClockState } from '../../../../core/model/index.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeConnectionConfig,
  PackRuntimeEvent,
  PackRuntimeEventHandler,
} from '../../../../simulation/protocol.ts'
import { definePackRuntimeOperations } from '../../../../simulation/operations.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../../core/packs/protocol.ts'
import {
  aviationRuntimePackId,
  aviationOpenSkyAdapterId,
  aviationOpenSkyRuntimeId,
} from '../constants.ts'
import {
  createOpenSkyAuthClient,
  responseTextOrEmpty,
  type HttpFetch,
  type OpenSkyAuthClient,
} from './auth.ts'
import {
  NORWAY_BBOX,
  OPENSKY_API_BASE,
  OPENSKY_DEFAULT_POLL_INTERVAL_MS,
  OPENSKY_DEFAULT_STALE_AFTER_MS,
  OPENSKY_STATES_PATH,
  type OpenSkyBbox,
} from './constants.ts'
import { normaliseOpenSkyStates } from './normalise.ts'

// OpenSky V2 PackRuntimeAdapter.
//
// Architecture:
//   - One adapter instance per server process.
//   - Each Simulation Run connection owns its own ephemeral aircraft map and
//     starts polling only while that Simulation Run has subscribers.
//   - The loop fetches the configured bbox, normalises rows, diffs against the
//     last poll, and emits upsert / delete PackRuntimeEvents to subscribers.
//   - Aircraft are ephemeral: `initialObjects` of kind 'aircraft' is ignored;
//     the adapter re-bootstraps from live on each connect.
//   - Stale aircraft (no update in `staleAfterMs`) emit `object.deleted` events
//     and drop from internal state.
//
// All HTTP goes through an injectable `HttpFetch`; timers go through an
// injectable `setIntervalFn` / `clearIntervalFn`. Unit tests run synthetically
// without touching the network.

export interface OpenSkyAdapterConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly bbox?: OpenSkyBbox
  readonly pollIntervalMs?: number
  readonly staleAfterMs?: number
  readonly fetchFn?: HttpFetch
  readonly clock?: () => number
  readonly nowIso?: () => IsoTimestamp
  /** Test seam: defaults to globalThis.setInterval. */
  readonly setIntervalFn?: (cb: () => void, ms: number) => unknown
  readonly clearIntervalFn?: (handle: unknown) => void
}

interface AdapterRuntime {
  readonly auth: OpenSkyAuthClient
  readonly bbox: OpenSkyBbox
  readonly pollIntervalMs: number
  readonly staleAfterMs: number
  readonly fetchFn: HttpFetch
  readonly clock: () => number
  readonly nowIso: () => IsoTimestamp
  readonly setIntervalFn: (cb: () => void, ms: number) => unknown
  readonly clearIntervalFn: (handle: unknown) => void
}

interface AircraftState {
  readonly object: OperationalObject
  /** Wall-clock ms when this aircraft last had a fresh upsert. */
  lastSeenMs: number
}

interface ActivePoll {
  handle: unknown | null
  // Track in-flight fetch so we don't stack them.
  inFlight: Promise<void> | null
}

const buildStatesUrl = (bbox: OpenSkyBbox): string => {
  const params = new URLSearchParams({
    lamin: String(bbox.lamin),
    lomin: String(bbox.lomin),
    lamax: String(bbox.lamax),
    lomax: String(bbox.lomax),
    extended: '1',
  })
  return `${OPENSKY_API_BASE}${OPENSKY_STATES_PATH}?${params.toString()}`
}

const performPoll = async (
  runtime: AdapterRuntime,
  url: string,
  attempts = 0,
): Promise<unknown> => {
  const token = await runtime.auth.getAccessToken()
  const response = await runtime.fetchFn(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
  })
  if (response.status === 401 && attempts === 0) {
    runtime.auth.invalidate()
    return performPoll(runtime, url, attempts + 1)
  }
  if (response.status === 429) {
    throw new Error('opensky adapter: rate-limited (HTTP 429) — backing off until next interval')
  }
  if (response.status < 200 || response.status >= 300) {
    const text = await responseTextOrEmpty(response)
    const trimmed = text.length > 300 ? `${text.slice(0, 300)}…` : text
    throw new Error(`opensky adapter: HTTP ${response.status} — ${trimmed}`)
  }
  return await response.json()
}

const diffAndEmit = (
  state: Map<string, AircraftState>,
  fresh: ReadonlyArray<OperationalObject>,
  runtime: AdapterRuntime,
  emit: (events: ReadonlyArray<PackRuntimeEvent>) => void,
): void => {
  const at = runtime.nowIso()
  const nowMs = runtime.clock()
  const seenIds = new Set<string>()
  const events: PackRuntimeEvent[] = []
  for (const fresher of fresh) {
    seenIds.add(String(fresher.id))
    const existing = state.get(String(fresher.id))
    const revision = existing ? existing.object.revision + 1 : 0
    const updated: OperationalObject = { ...fresher, revision }
    state.set(String(fresher.id), { object: updated, lastSeenMs: nowMs })
    events.push({
      type: 'object.upserted',
      object: updated,
      at,
      history: 'snapshot-only',
      provenance: updated.provenance,
    })
  }
  // Aircraft we previously had but did NOT see this poll: keep if still fresh
  // (occasional gaps are normal); drop when older than staleAfterMs.
  for (const [id, entry] of state) {
    if (seenIds.has(id)) continue
    if (nowMs - entry.lastSeenMs >= runtime.staleAfterMs) {
      events.push({
        type: 'object.deleted',
        objectId: id as ObjectId,
        at,
        history: 'snapshot-only',
        provenance: entry.object.provenance,
      })
      state.delete(id)
    }
  }
  if (events.length > 0) emit(events)
}

const defaultSetInterval = (cb: () => void, ms: number): unknown =>
  setInterval(cb, ms) as unknown

const defaultClearInterval = (handle: unknown): void =>
  clearInterval(handle as ReturnType<typeof setInterval>)

export const createOpenSkyPackRuntimeAdapter = (config: OpenSkyAdapterConfig): PackRuntimeAdapter => {
  // Resolved at module construction so missing creds surface in the systemd
  // logs immediately, not on first poll.
  if (!config.clientId) throw new Error('opensky adapter: clientId is required (OPENSKY_CLIENT_ID env)')
  if (!config.clientSecret) throw new Error('opensky adapter: clientSecret is required (OPENSKY_CLIENT_SECRET env)')

  const runtime: AdapterRuntime = {
    auth: createOpenSkyAuthClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      ...(config.fetchFn ? { fetchFn: config.fetchFn } : {}),
      ...(config.clock ? { clock: config.clock } : {}),
    }),
    bbox: config.bbox ?? NORWAY_BBOX,
    pollIntervalMs: config.pollIntervalMs ?? OPENSKY_DEFAULT_POLL_INTERVAL_MS,
    staleAfterMs: config.staleAfterMs ?? OPENSKY_DEFAULT_STALE_AFTER_MS,
    fetchFn: config.fetchFn ?? ((url, init) => globalThis.fetch(url, init as RequestInit)),
    clock: config.clock ?? (() => Date.now()),
    nowIso: config.nowIso ?? nowIso,
    setIntervalFn: config.setIntervalFn ?? defaultSetInterval,
    clearIntervalFn: config.clearIntervalFn ?? defaultClearInterval,
  }

  const url = buildStatesUrl(runtime.bbox)

  // Per-Simulation-Run state. The adapter is shared at the server level, but
  // each `connect()` gives one Run its own aircraft map,
  // event handler set, and subscriber-gated poll loop.
  return {
    id: aviationOpenSkyRuntimeId,
    version: '1.0.0',
    packId: aviationRuntimePackId,
    clock: 'live',
    operations: definePackRuntimeOperations({ queries: ['aviation.source_status'] }),
    connect: async (connectionConfig: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
      const state = new Map<string, AircraftState>()
      const handlers = new Set<PackRuntimeEventHandler>()
      const poll: ActivePoll = { handle: null, inFlight: null }
      let clock: SimulationClockState = {
        currentTime: connectionConfig.scenario?.world.startsAt ?? runtime.nowIso(),
        updatedAt: runtime.nowIso(),
        paused: false,
        speed: 1,
      }
      let lastError: string | null = null

      const emit = (events: ReadonlyArray<PackRuntimeEvent>): void => {
        if (events.length === 0) return
        const at = runtime.nowIso()
        for (const handler of handlers) {
          handler({
            type: 'event.emission',
            runtimeId: aviationOpenSkyRuntimeId,
            emittedAt: at,
            events,
          })
        }
      }

      const tick = async (): Promise<void> => {
        if (poll.inFlight) return
        poll.inFlight = (async () => {
          try {
            const raw = await performPoll(runtime, url)
            const aircraft = normaliseOpenSkyStates(raw, { now: runtime.nowIso })
            diffAndEmit(state, aircraft, runtime, emit)
            lastError = null
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err)
            console.warn(`opensky adapter: poll failed — ${lastError}`)
          } finally {
            poll.inFlight = null
          }
        })()
        return poll.inFlight
      }

      const startPolling = (): void => {
        if (poll.handle !== null) return
        // Fire immediately so the first subscriber sees an initial batch.
        void tick()
        poll.handle = runtime.setIntervalFn(() => { void tick() }, runtime.pollIntervalMs)
      }

      const stopPolling = (): void => {
        if (poll.handle === null) return
        runtime.clearIntervalFn(poll.handle)
        poll.handle = null
      }

      return {
        getSnapshot: async () => ({
          simulationRunId: connectionConfig.simulationRunId,
          objects: [...state.values()].map(entry => entry.object),
          capturedAt: runtime.nowIso(),
        }),
        subscribe: (handler: PackRuntimeEventHandler): (() => void) => {
          handlers.add(handler)
          if (handlers.size === 1) startPolling()
          return () => {
            handlers.delete(handler)
            if (handlers.size === 0) stopPolling()
          }
        },
        sendCommand: async (command: CommandEnvelope): Promise<CommandResult> => ({
          ok: false,
          commandId: command.id,
          rejectedAt: runtime.nowIso(),
          reason: `aviation.opensky does not accept commands (kind=${command.kind})`,
        }),
        query: async (request: PackQueryRequest): Promise<PackQueryResponse> => {
          if (request.kind === 'aviation.source_status') {
            return {
              ok: true,
              packId: request.packId,
              kind: request.kind,
              result: {
                source: 'opensky',
                aircraftInBbox: state.size,
                lastError,
                polling: poll.handle !== null,
              },
              generatedAt: runtime.nowIso(),
            }
          }
          return {
            ok: false,
            packId: request.packId,
            kind: request.kind,
            reason: `opensky adapter does not answer query kind: ${request.kind}`,
            generatedAt: runtime.nowIso(),
          }
        },
        observeCommittedEvents: async (_events: ReadonlyArray<SimulationRunEvent>): Promise<void> => undefined,
        setClock: async (next: SimulationClockState): Promise<void> => { clock = next },
        close: async (): Promise<void> => {
          stopPolling()
          handlers.clear()
          state.clear()
        },
      }
    },
  }
}

export const __internals = { buildStatesUrl, performPoll, diffAndEmit }
