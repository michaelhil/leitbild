import { nowIso, type CommandEnvelope, type CommandResult, type DomainEvent, type IsoTimestamp, type ObjectId, type OperationalObject, type SimulationClockState } from '../../../../core/model/index.ts'
import type {
  SimulationAdapter,
  SimulationConnection,
  SimulationConnectionConfig,
  SimulationEvent,
  SimulationEventHandler,
} from '../../../../simulation/protocol.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../../core/packs/protocol.ts'
import { aviationDomain, aviationVatsimProviderId } from '../constants.ts'
import type { HttpFetch } from '../opensky/auth.ts'
import {
  NORWAY_BBOX,
  VATSIM_DATA_URL,
  VATSIM_DEFAULT_POLL_INTERVAL_MS,
  VATSIM_DEFAULT_STALE_AFTER_MS,
  VATSIM_DEFAULT_USER_AGENT,
  type VatsimBbox,
} from './constants.ts'
import { normaliseVatsimData } from './normalise.ts'

// VATSIM SimulationAdapter — same poll-loop shape as the OpenSky adapter but
// anonymous (no OAuth), 30 s default interval (matching the upstream refresh),
// and client-side bbox filtering (VATSIM serves the world in one payload).

export interface VatsimAdapterConfig {
  readonly dataUrl?: string
  readonly bbox?: VatsimBbox
  readonly pollIntervalMs?: number
  readonly staleAfterMs?: number
  readonly userAgent?: string
  readonly fetchFn?: HttpFetch
  readonly clock?: () => number
  readonly nowIso?: () => IsoTimestamp
  readonly setIntervalFn?: (cb: () => void, ms: number) => unknown
  readonly clearIntervalFn?: (handle: unknown) => void
}

interface AdapterRuntime {
  readonly dataUrl: string
  readonly bbox: VatsimBbox
  readonly pollIntervalMs: number
  readonly staleAfterMs: number
  readonly userAgent: string
  readonly fetchFn: HttpFetch
  readonly clock: () => number
  readonly nowIso: () => IsoTimestamp
  readonly setIntervalFn: (cb: () => void, ms: number) => unknown
  readonly clearIntervalFn: (handle: unknown) => void
}

interface AircraftState {
  readonly object: OperationalObject
  lastSeenMs: number
}

interface ActivePoll {
  handle: unknown | null
  inFlight: Promise<void> | null
}

const performPoll = async (runtime: AdapterRuntime): Promise<unknown> => {
  const response = await runtime.fetchFn(runtime.dataUrl, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': runtime.userAgent,
    },
  })
  if (response.status === 429) {
    throw new Error('vatsim adapter: rate-limited (HTTP 429) — backing off until next interval')
  }
  if (response.status < 200 || response.status >= 300) {
    const text = await response.text().catch(() => '')
    const trimmed = text.length > 300 ? `${text.slice(0, 300)}…` : text
    throw new Error(`vatsim adapter: HTTP ${response.status} — ${trimmed}`)
  }
  return await response.json()
}

const diffAndEmit = (
  state: Map<string, AircraftState>,
  fresh: ReadonlyArray<OperationalObject>,
  runtime: AdapterRuntime,
  emit: (events: ReadonlyArray<SimulationEvent>) => void,
): void => {
  const at = runtime.nowIso()
  const nowMs = runtime.clock()
  const seenIds = new Set<string>()
  const events: SimulationEvent[] = []
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
      provenance: updated.provenance,
    })
  }
  for (const [id, entry] of state) {
    if (seenIds.has(id)) continue
    if (nowMs - entry.lastSeenMs >= runtime.staleAfterMs) {
      events.push({
        type: 'object.deleted',
        objectId: id as ObjectId,
        at,
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

export const createVatsimSimulationAdapter = (config: VatsimAdapterConfig = {}): SimulationAdapter => {
  const runtime: AdapterRuntime = {
    dataUrl: config.dataUrl ?? VATSIM_DATA_URL,
    bbox: config.bbox ?? NORWAY_BBOX,
    pollIntervalMs: config.pollIntervalMs ?? VATSIM_DEFAULT_POLL_INTERVAL_MS,
    staleAfterMs: config.staleAfterMs ?? VATSIM_DEFAULT_STALE_AFTER_MS,
    userAgent: config.userAgent ?? VATSIM_DEFAULT_USER_AGENT,
    fetchFn: config.fetchFn ?? ((url, init) => globalThis.fetch(url, init as RequestInit)),
    clock: config.clock ?? (() => Date.now()),
    nowIso: config.nowIso ?? nowIso,
    setIntervalFn: config.setIntervalFn ?? defaultSetInterval,
    clearIntervalFn: config.clearIntervalFn ?? defaultClearInterval,
  }

  return {
    id: aviationVatsimProviderId,
    packId: 'aviation',
    domain: aviationDomain,
    acceptedCommandKinds: [],
    queryKinds: [],
    connect: async (connectionConfig: SimulationConnectionConfig): Promise<SimulationConnection> => {
      const state = new Map<string, AircraftState>()
      const handlers = new Set<SimulationEventHandler>()
      const poll: ActivePoll = { handle: null, inFlight: null }
      let clock: SimulationClockState = {
        currentTime: connectionConfig.scenario?.world.startsAt ?? runtime.nowIso(),
        updatedAt: runtime.nowIso(),
        paused: false,
        speed: 1,
      }
      let lastError: string | null = null

      const emit = (events: ReadonlyArray<SimulationEvent>): void => {
        if (events.length === 0) return
        const at = runtime.nowIso()
        for (const handler of handlers) {
          handler({
            type: 'event.emission',
            providerId: aviationVatsimProviderId,
            emittedAt: at,
            events,
          })
        }
      }

      const tick = async (): Promise<void> => {
        if (poll.inFlight) return
        poll.inFlight = (async () => {
          try {
            const raw = await performPoll(runtime)
            const aircraft = normaliseVatsimData(raw, { bbox: runtime.bbox, now: runtime.nowIso })
            diffAndEmit(state, aircraft, runtime, emit)
            lastError = null
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err)
            console.warn(`vatsim adapter: poll failed — ${lastError}`)
          } finally {
            poll.inFlight = null
          }
        })()
        return poll.inFlight
      }

      const startPolling = (): void => {
        if (poll.handle !== null) return
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
          controlInstanceId: connectionConfig.controlInstanceId,
          objects: [...state.values()].map(entry => entry.object),
          capturedAt: runtime.nowIso(),
        }),
        subscribe: (handler: SimulationEventHandler): (() => void) => {
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
          reason: `aviation.vatsim does not accept commands (kind=${command.kind})`,
        }),
        query: async (request: PackQueryRequest): Promise<PackQueryResponse> => {
          if (request.kind === 'aviation.source_status') {
            return {
              ok: true,
              packId: request.packId,
              kind: request.kind,
              result: {
                source: 'vatsim',
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
            reason: `vatsim adapter does not answer query kind: ${request.kind}`,
            generatedAt: runtime.nowIso(),
          }
        },
        observeCommittedEvents: async (_events: ReadonlyArray<DomainEvent>): Promise<void> => undefined,
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

export const __internals = { performPoll, diffAndEmit }
