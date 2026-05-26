import { describe, expect, it } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, ControlInstanceId, IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { aviationDomainId } from '../src/packs/aviation/model.ts'
import { createAviationMultiSimulationAdapter } from '../src/packs/aviation/sim/multi/adapter.ts'
import { aviationOpenSkyProviderId, aviationVatsimProviderId } from '../src/packs/aviation/sim/constants.ts'
import { aviationSetSourceCommandKind } from '../src/packs/aviation/sim/multi/constants.ts'
import type {
  SimulationAdapter,
  SimulationConnection,
  SimulationEvent,
  SimulationEventHandler,
} from '../src/simulation/protocol.ts'

// Tiny stub SimulationAdapter the multi-adapter can wrap. Each instance
// exposes an `emit(events)` test seam plus tallies for connect/close.

interface StubAdapter extends SimulationAdapter {
  readonly emit: (events: ReadonlyArray<SimulationEvent>) => void
  readonly connectCount: () => number
  readonly closeCount: () => number
  readonly subscribers: () => number
}

const createStubAdapter = (id: string): StubAdapter => {
  let connectCount = 0
  let closeCount = 0
  const handlers = new Set<SimulationEventHandler>()
  let activeEmit: ((events: ReadonlyArray<SimulationEvent>) => void) | null = null
  const adapter: SimulationAdapter = {
    id,
    packId: 'aviation',
    domain: aviationDomainId,
    acceptedCommandKinds: [],
    queryKinds: [],
    connect: async (config): Promise<SimulationConnection> => {
      connectCount += 1
      const connHandlers = new Set<SimulationEventHandler>()
      activeEmit = (events) => {
        if (events.length === 0) return
        const emission = {
          type: 'event.emission' as const,
          providerId: id,
          emittedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
          events,
        }
        for (const h of connHandlers) h(emission)
      }
      return {
        getSnapshot: async () => ({
          controlInstanceId: config.controlInstanceId,
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

const upsertEvent = (id: string, providerId: string): SimulationEvent => ({
  type: 'object.upserted',
  object: {
    id: id as ObjectId,
    kind: 'aircraft',
    domain: aviationDomainId,
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
    provenance: { source: 'simulator', adapterId: providerId as never, externalId: id },
    timestamps: {
      createdAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
      updatedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
    },
    domainData: { type: 'aircraft', schemaVersion: 1, source: 'opensky', icao24: null, callsign: null, originCountry: null, altBaroM: null, altGeoM: null, velocityMps: null, headingDeg: null, vertRateMps: null, onGround: false, squawk: null, lastSeenAt: null },
  } as never,
  at: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
  provenance: { source: 'simulator', adapterId: providerId as never, externalId: id },
})

const issueSetSource = (source: 'opensky' | 'vatsim'): CommandEnvelope => ({
  id: `cmd:${source}` as CommandId,
  controlInstanceId: 'control-instance:test' as ControlInstanceId,
  actorId: 'actor:test' as ActorId,
  kind: aviationSetSourceCommandKind,
  targetObjectIds: [],
  payload: { source },
  issuedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
})

describe('createAviationMultiSimulationAdapter', () => {
  it('forwards events from the initial source and stamps providerId as aviation.multi', async () => {
    const opensky = createStubAdapter(aviationOpenSkyProviderId)
    const vatsim = createStubAdapter(aviationVatsimProviderId)
    const multi = createAviationMultiSimulationAdapter({ opensky, vatsim })
    const connection = await multi.connect({
      controlInstanceId: 'control-instance:test' as ControlInstanceId,
    })

    const emissions: { providerId: string; events: ReadonlyArray<SimulationEvent> }[] = []
    connection.subscribe((emission) => {
      if (emission.type === 'event.emission') emissions.push({ providerId: emission.providerId, events: emission.events })
    })

    expect(opensky.connectCount()).toBe(1)
    expect(vatsim.connectCount()).toBe(0)

    opensky.emit([upsertEvent('aircraft:opensky:a', aviationOpenSkyProviderId)])
    expect(emissions.length).toBe(1)
    expect(emissions[0]?.providerId).toBe('aviation.multi')
    expect(emissions[0]?.events.length).toBe(1)

    await connection.close()
  })

  it('on set_source: sweeps deletes for tracked ids, closes old source, opens new', async () => {
    const opensky = createStubAdapter(aviationOpenSkyProviderId)
    const vatsim = createStubAdapter(aviationVatsimProviderId)
    const multi = createAviationMultiSimulationAdapter({ opensky, vatsim })
    const connection = await multi.connect({
      controlInstanceId: 'control-instance:test' as ControlInstanceId,
    })
    const emissions: ReadonlyArray<SimulationEvent>[] = []
    connection.subscribe((emission) => {
      if (emission.type === 'event.emission') emissions.push(emission.events)
    })

    opensky.emit([
      upsertEvent('aircraft:opensky:a', aviationOpenSkyProviderId),
      upsertEvent('aircraft:opensky:b', aviationOpenSkyProviderId),
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
    vatsim.emit([upsertEvent('aircraft:vatsim:c', aviationVatsimProviderId)])
    expect(emissions.at(-1)?.length).toBe(1)
    expect(emissions.at(-1)?.[0]?.type).toBe('object.upserted')

    await connection.close()
  })

  it('rejects set_source with an invalid payload', async () => {
    const opensky = createStubAdapter(aviationOpenSkyProviderId)
    const vatsim = createStubAdapter(aviationVatsimProviderId)
    const multi = createAviationMultiSimulationAdapter({ opensky, vatsim })
    const connection = await multi.connect({
      controlInstanceId: 'control-instance:test' as ControlInstanceId,
    })
    const bad = await connection.sendCommand({
      ...issueSetSource('opensky'),
      payload: { source: 'mlat' },
    } as never)
    expect(bad.ok).toBe(false)
    await connection.close()
  })

  it('rejects set_source for an unconfigured source', async () => {
    const vatsim = createStubAdapter(aviationVatsimProviderId)
    const multi = createAviationMultiSimulationAdapter({ vatsim, defaultSource: 'vatsim' })
    const connection = await multi.connect({
      controlInstanceId: 'control-instance:test' as ControlInstanceId,
    })
    const result = await connection.sendCommand(issueSetSource('opensky'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/not available/)
    await connection.close()
  })
})
