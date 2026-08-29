import { z } from 'zod'
import { nowIso, type CommandEnvelope, type CommandResult, type SimulationRunEvent, type IsoTimestamp, type ObjectId, type SimulationClockState } from '../../../../core/model/index.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeConnectionConfig,
  PackRuntimeEvent,
  PackRuntimeEventHandler,
} from '../../../../simulation/protocol.ts'
import type { PackQueryRequest, PackQueryResponse } from '../../../../core/packs/protocol.ts'
import { aviationRuntimePackId } from '../constants.ts'
import {
  aviationMultiRuntimeId,
  aviationSetSourceCommandKind,
  aviationSources,
  type AviationSourceId,
} from './constants.ts'

// aviation.multi — a per-Simulation-Run proxy that owns at most one
// underlying live-aircraft connection (OpenSky or VATSIM) at a time and lets
// the operator hot-swap between them via the aviation.set_source command.
//
// Why a proxy rather than two independent adapters?
//   - Hot-swap is intrinsically a Run-scoped state machine: one source active
//     at a time, an explicit deletion sweep on switch so the UI doesn't show
//     ghost aircraft from the previous source.
//   - It keeps the rail picker's mental model simple: one command, one Run.
//   - The cost is small: we just forward events from the active sub-adapter,
//     re-stamping the runtimeId so downstream routing sees `aviation.multi`.

const setSourcePayloadSchema = z.object({
  source: z.enum(aviationSources),
})

export interface AviationMultiAdapterConfig {
  readonly opensky?: PackRuntimeAdapter
  readonly vatsim?: PackRuntimeAdapter
  /** Initial source if the scenario doesn't pin one via runtimeConfig. */
  readonly defaultSource?: AviationSourceId
  readonly nowIso?: () => IsoTimestamp
}

const sourceForAdapter = (config: AviationMultiAdapterConfig, source: AviationSourceId): PackRuntimeAdapter | null => {
  if (source === 'opensky') return config.opensky ?? null
  if (source === 'vatsim') return config.vatsim ?? null
  return null
}

const firstAvailableSource = (
  config: AviationMultiAdapterConfig,
  preferred: AviationSourceId,
): AviationSourceId | null => {
  if (sourceForAdapter(config, preferred)) return preferred
  for (const source of aviationSources) {
    if (sourceForAdapter(config, source)) return source
  }
  return null
}

const readInitialSource = (
  connectionConfig: PackRuntimeConnectionConfig,
  fallback: AviationSourceId,
): AviationSourceId => {
  // The catalog routes scenario.runtimeConfigs[packId] to the active
  // runtime's `runtimeConfig` slot — so we read the single value here.
  const raw = connectionConfig.scenario?.runtimeConfig
  if (raw && typeof raw === 'object' && 'source' in raw) {
    const source = (raw as { source?: unknown }).source
    if (source === 'opensky' || source === 'vatsim') return source
  }
  return fallback
}

export const createAviationMultiPackRuntimeAdapter = (
  config: AviationMultiAdapterConfig,
): PackRuntimeAdapter => {
  const clock = config.nowIso ?? nowIso
  const defaultSource: AviationSourceId = config.defaultSource ?? 'opensky'

  return {
    id: aviationMultiRuntimeId,
    version: '1.0.0',
    packId: aviationRuntimePackId,
    acceptedCommandKinds: [aviationSetSourceCommandKind],
    queryKinds: ['aviation.source_status'],
    connect: async (connectionConfig: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
      const handlers = new Set<PackRuntimeEventHandler>()
      // Object ids currently forwarded to the rail; cleared on source switch.
      const trackedIds = new Set<string>()
      const requestedInitialSource = readInitialSource(connectionConfig, defaultSource)
      const availableInitialSource = firstAvailableSource(config, requestedInitialSource)
      if (!availableInitialSource) throw new Error('aviation.multi: no live aircraft source adapter is registered')
      let currentSource: AviationSourceId = availableInitialSource
      let activeConnection: PackRuntimeConnection | null = null
      let activeUnsubscribe: (() => void) | null = null
      let activeProvenanceTemplate: PackRuntimeEvent['provenance'] | null = null
      let clockState: SimulationClockState = {
        currentTime: connectionConfig.scenario?.world.startsAt ?? clock(),
        updatedAt: clock(),
        paused: false,
        speed: 1,
      }

      const emit = (events: ReadonlyArray<PackRuntimeEvent>): void => {
        if (events.length === 0) return
        const at = clock()
        for (const handler of handlers) {
          handler({
            type: 'event.emission',
            runtimeId: aviationMultiRuntimeId,
            emittedAt: at,
            events,
          })
        }
      }

      const handleSubEmission: PackRuntimeEventHandler = (emission) => {
        if (emission.type !== 'event.emission') return
        for (const event of emission.events) {
          if (event.type === 'object.upserted') {
            trackedIds.add(String(event.object.id))
            activeProvenanceTemplate = event.provenance
          } else if (event.type === 'object.deleted') {
            trackedIds.delete(String(event.objectId))
          }
        }
        emit(emission.events)
      }

      const openSubConnection = async (source: AviationSourceId): Promise<void> => {
        const adapter = sourceForAdapter(config, source)
        if (!adapter) {
          throw new Error(`aviation.multi: source "${source}" is not available (adapter not registered)`)
        }
        const conn = await adapter.connect(connectionConfig)
        activeConnection = conn
        activeUnsubscribe = handlers.size > 0 ? conn.subscribe(handleSubEmission) : null
      }

      const closeSubConnection = async (): Promise<void> => {
        if (activeUnsubscribe) {
          activeUnsubscribe()
          activeUnsubscribe = null
        }
        if (activeConnection) {
          await activeConnection.close()
          activeConnection = null
        }
      }

      const switchSource = async (next: AviationSourceId): Promise<void> => {
        if (next === currentSource) return
        // Validate the target source is available *before* tearing down the
        // current connection — otherwise a typo in the command payload would
        // silently kill the operator's data feed.
        if (!sourceForAdapter(config, next)) {
          throw new Error(`aviation.multi: source "${next}" is not available (adapter not registered)`)
        }
        // 1) Sweep: tell consumers everything from the old source is gone, so
        //    the rail doesn't carry stale aircraft into the new source's view.
        if (trackedIds.size > 0 && activeProvenanceTemplate) {
          const at = clock()
          const sweep: PackRuntimeEvent[] = [...trackedIds].map(id => ({
            type: 'object.deleted',
            objectId: id as ObjectId,
            at,
            provenance: activeProvenanceTemplate!,
          }))
          trackedIds.clear()
          emit(sweep)
        }
        // 2) Close the old, open the new.
        await closeSubConnection()
        currentSource = next
        if (handlers.size > 0) await openSubConnection(next)
      }

      // Eagerly open the initial sub-connection. We don't subscribe until a
      // handler arrives, but having the connection lets snapshot/query work
      // immediately.
      await openSubConnection(currentSource)

      return {
        getSnapshot: async () => {
          if (!activeConnection) {
            return { simulationRunId: connectionConfig.simulationRunId, objects: [], capturedAt: clock() }
          }
          const sub = await activeConnection.getSnapshot()
          // Re-stamp simulationRunId for the multi runtime; sub-adapter
          // already filled it but we want to be explicit.
          return { ...sub, simulationRunId: connectionConfig.simulationRunId }
        },
        subscribe: (handler: PackRuntimeEventHandler): (() => void) => {
          handlers.add(handler)
          // Lazy upstream subscription: only attach to the sub-adapter when the
          // first downstream handler is interested. Mirrors OpenSky's pattern.
          if (handlers.size === 1 && activeConnection && !activeUnsubscribe) {
            activeUnsubscribe = activeConnection.subscribe(handleSubEmission)
          }
          return () => {
            handlers.delete(handler)
            if (handlers.size === 0 && activeUnsubscribe) {
              activeUnsubscribe()
              activeUnsubscribe = null
            }
          }
        },
        sendCommand: async (command: CommandEnvelope): Promise<CommandResult> => {
          if (command.kind === aviationSetSourceCommandKind) {
            const parsed = setSourcePayloadSchema.safeParse(command.payload)
            if (!parsed.success) {
              return {
                ok: false,
                commandId: command.id,
                rejectedAt: clock(),
                reason: `aviation.multi: invalid set_source payload (${parsed.error.message})`,
              }
            }
            try {
              await switchSource(parsed.data.source)
              return { ok: true, commandId: command.id, acceptedAt: clock() }
            } catch (err) {
              return {
                ok: false,
                commandId: command.id,
                rejectedAt: clock(),
                reason: err instanceof Error ? err.message : String(err),
              }
            }
          }
          return {
            ok: false,
            commandId: command.id,
            rejectedAt: clock(),
            reason: `aviation.multi does not accept command kind: ${command.kind}`,
          }
        },
        query: async (request: PackQueryRequest): Promise<PackQueryResponse> => {
          if (!activeConnection) {
            return {
              ok: false,
              packId: request.packId,
              kind: request.kind,
              reason: 'aviation.multi has no active sub-connection',
              generatedAt: clock(),
            }
          }
          // Pass through to the active source's query handler, then enrich
          // aviation.source_status with the multi's view (active source +
          // tracked count).
          const sub = await activeConnection.query(request)
          if (request.kind === 'aviation.source_status' && sub.ok) {
            return {
              ok: true,
              packId: sub.packId,
              kind: sub.kind,
              result: {
                ...(sub.result as Record<string, unknown>),
                multi: { activeSource: currentSource, tracked: trackedIds.size },
              },
              generatedAt: sub.generatedAt,
            }
          }
          return sub
        },
        observeCommittedEvents: async (events: ReadonlyArray<SimulationRunEvent>): Promise<void> => {
          if (activeConnection) await activeConnection.observeCommittedEvents(events)
        },
        setClock: async (next: SimulationClockState): Promise<void> => {
          clockState = next
          if (activeConnection) await activeConnection.setClock(next)
        },
        close: async (): Promise<void> => {
          await closeSubConnection()
          handlers.clear()
          trackedIds.clear()
          void clockState
        },
      }
    },
  }
}

export const __internals = { setSourcePayloadSchema, readInitialSource }
