import { describe, expect, it } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, SimulationRunId, IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { aviationPackId } from '../src/packs/aviation/model.ts'
import { createAviationMultiPackRuntimeAdapter } from '../src/packs/aviation/sim/multi/adapter.ts'
import { aviationOpenSkyRuntimeId, aviationVatsimRuntimeId } from '../src/packs/aviation/sim/constants.ts'
import { aviationSetSourceCommandKind } from '../src/packs/aviation/sim/multi/constants.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeEvent,
  PackRuntimeEventHandler,
} from '../src/simulation/protocol.ts'

// Tiny stub PackRuntimeAdapter the multi-adapter can wrap. Each instance
// exposes an `emit(events)` test seam plus tallies for connect/close.

interface StubAdapter extends PackRuntimeAdapter {
  readonly emit: (events: ReadonlyArray<PackRuntimeEvent>) => void
  readonly connectCount: () => number
  readonly closeCount: () => number
  readonly subscribers: () => number
}

const createStubAdapter = (id: string): StubAdapter => {
  let connectCount = 0
  let closeCount = 0
  const handlers = new Set<PackRuntimeEventHandler>()
  let activeEmit: ((events: ReadonlyArray<PackRuntimeEvent>) => void) | null = null
  const adapter: PackRuntimeAdapter = {
    id,
    version: '1.0.0',
    packId: aviationPackId,
    acceptedCommandKinds: [],
    queryKinds: [],
    connect: async (config): Promise<PackRuntimeConnection> => {
      connectCount += 1
      const connHandlers = new Set<PackRuntimeEventHandler>()
      activeEmit = (events) => {
        if (events.length === 0) return
        const emission = {
          type: 'event.emission' as const,
          runtimeId: id,
          emittedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
          events,
        }
        for (const h of connHandlers) h(emission)
      }
      return {
        getSnapshot: async () => ({
          simulationRunId: config.simulationRunId,
          objects: [],
          capturedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
        }),
        subscribe: (handler) => {
          connHandlers.add(handler)
          handlers.add(handler)
          return () => { connHandlers.delete(handler); handlers.delete(handler) }
        },
        sendCommand: async (command) => ({
          ok: false,
          commandId: command.id,
          rejectedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
          reason: 'stub rejects commands',
        }),
        query: async (request) => ({
          ok: true,
          packId: request.packId,
          kind: request.kind,
          result: { stubId: id },
          generatedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
        }),
        observeCommittedEvents: async () => undefined,
        setClock: async () => undefined,
        close: async () => {
          closeCount += 1
          connHandlers.clear()
          activeEmit = null
        },
      }
    },
  }
  return {
    ...adapter,
    emit: (events) => activeEmit?.(events),
    connectCount: () => connectCount,
    closeCount: () => closeCount,
    subscribers: () => handlers.size,
  }
}

const upsertEvent = (id: string, runtimeId: string): PackRuntimeEvent => ({
  type: 'object.upserted',
  object: {
    id: id as ObjectId,
    kind: 'aircraft',
    packId: aviationPackId,
    label: id,
    lifecycle: 'active',
    revision: 0,
    spatial: {
      position: {
        point: { type: 'Point', coordinates: [10, 60] as unknown as [number, number] },
        observedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
      },
      frame: { kind: 'wgs84' },
    },
    operational: { status: 'active', mode: 'live' },
    alerts: [],
    provenance: { source: 'simulator', adapterId: runtimeId as never, externalId: id },
    timestamps: {
      createdAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
      updatedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
    },
    packData: { type: 'aircraft', schemaVersion: 1, source: 'opensky', icao24: null, callsign: null, originCountry: null, altBaroM: null, altGeoM: null, velocityMps: null, headingDeg: null, vertRateMps: null, onGround: false, squawk: null, lastSeenAt: null },
  } as never,
  at: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
  provenance: { source: 'simulator', adapterId: runtimeId as never, externalId: id },
})

const issueSetSource = (source: 'opensky' | 'vatsim'): CommandEnvelope => ({
  id: `cmd:${source}` as CommandId,
  simulationRunId: 'run-test' as SimulationRunId,
  actorId: 'actor:test' as ActorId,
  kind: aviationSetSourceCommandKind,
  targetObjectIds: [],
  payload: { source },
  issuedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
})

describe('createAviationMultiPackRuntimeAdapter', () => {
  it('forwards events from the initial source and stamps runtimeId as aviation.multi', async () => {
    const opensky = createStubAdapter(aviationOpenSkyRuntimeId)
    const vatsim = createStubAdapter(aviationVatsimRuntimeId)
    const multi = createAviationMultiPackRuntimeAdapter({ opensky, vatsim })
    const connection = await multi.connect({
      simulationRunId: 'run-test' as SimulationRunId,
    })

    const emissions: { runtimeId: string; events: ReadonlyArray<PackRuntimeEvent> }[] = []
    connection.subscribe((emission) => {
      if (emission.type === 'event.emission') emissions.push({ runtimeId: emission.runtimeId, events: emission.events })
    })

    expect(opensky.connectCount()).toBe(1)
    expect(vatsim.connectCount()).toBe(0)

    opensky.emit([upsertEvent('aircraft:opensky:a', aviationOpenSkyRuntimeId)])
    expect(emissions.length).toBe(1)
    expect(emissions[0]?.runtimeId).toBe('aviation.multi')
    expect(emissions[0]?.events.length).toBe(1)

    await connection.close()
  })

  it('on set_source: sweeps deletes for tracked ids, closes old source, opens new', async () => {
    const opensky = createStubAdapter(aviationOpenSkyRuntimeId)
    const vatsim = createStubAdapter(aviationVatsimRuntimeId)
    const multi = createAviationMultiPackRuntimeAdapter({ opensky, vatsim })
    const connection = await multi.connect({
      simulationRunId: 'run-test' as SimulationRunId,
    })
    const emissions: ReadonlyArray<PackRuntimeEvent>[] = []
    connection.subscribe((emission) => {
      if (emission.type === 'event.emission') emissions.push(emission.events)
    })

    opensky.emit([
      upsertEvent('aircraft:opensky:a', aviationOpenSkyRuntimeId),
      upsertEvent('aircraft:opensky:b', aviationOpenSkyRuntimeId),
    ])
    expect(emissions[0]?.length).toBe(2)

    const result = await connection.sendCommand(issueSetSource('vatsim'))
    expect(result.ok).toBe(true)

    // Last sweep batch must contain two deletes for the previous source's ids.
    const sweep = emissions.at(-1)
    expect(sweep?.every(event => event.type === 'object.deleted')).toBe(true)
    expect(sweep?.length).toBe(2)

    expect(opensky.closeCount()).toBe(1)
    expect(vatsim.connectCount()).toBe(1)

    // New source's events flow through.
    vatsim.emit([upsertEvent('aircraft:vatsim:c', aviationVatsimRuntimeId)])
    expect(emissions.at(-1)?.length).toBe(1)
    expect(emissions.at(-1)?.[0]?.type).toBe('object.upserted')

    await connection.close()
  })

  it('rejects set_source with an invalid payload', async () => {
    const opensky = createStubAdapter(aviationOpenSkyRuntimeId)
    const vatsim = createStubAdapter(aviationVatsimRuntimeId)
    const multi = createAviationMultiPackRuntimeAdapter({ opensky, vatsim })
    const connection = await multi.connect({
      simulationRunId: 'run-test' as SimulationRunId,
    })
    const bad = await connection.sendCommand({
      ...issueSetSource('opensky'),
      payload: { source: 'mlat' },
    } as never)
    expect(bad.ok).toBe(false)
    await connection.close()
  })

  it('rejects set_source for an unconfigured source', async () => {
    const vatsim = createStubAdapter(aviationVatsimRuntimeId)
    const multi = createAviationMultiPackRuntimeAdapter({ vatsim, defaultSource: 'vatsim' })
    const connection = await multi.connect({
      simulationRunId: 'run-test' as SimulationRunId,
    })
    const result = await connection.sendCommand(issueSetSource('opensky'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/not available/)
    await connection.close()
  })

  it('falls back to the first registered source when scenario config names an unavailable source', async () => {
    const vatsim = createStubAdapter(aviationVatsimRuntimeId)
    const multi = createAviationMultiPackRuntimeAdapter({ vatsim, defaultSource: 'opensky' })
    const connection = await multi.connect({
      simulationRunId: 'run-test' as SimulationRunId,
      scenario: {
        scenarioId: 'scenario:aviation',
        runtimeIds: ['aviation.multi'],
        world: { startsAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp, environment: { mode: 'test' } },
        initialObjects: [],
        runtimeConfigs: {},
        runtimeConfig: { source: 'opensky' },
      },
    })

    expect(vatsim.connectCount()).toBe(1)
    const status = await connection.query({ packId: 'aviation', kind: 'aviation.source_status', payload: {} })
    expect(status.ok).toBe(true)
    if (status.ok) expect((status.result as { multi?: { activeSource?: string } }).multi?.activeSource).toBe('vatsim')

    await connection.close()
  })
})
