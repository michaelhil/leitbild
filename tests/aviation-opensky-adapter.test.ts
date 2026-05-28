import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import type { ControlInstanceId, IsoTimestamp } from '../src/core/model/index.ts'
import { createOpenSkyPackRuntimeAdapter } from '../src/packs/aviation/sim/opensky/adapter.ts'
import type { HttpFetch } from '../src/packs/aviation/sim/opensky/auth.ts'
import type { PackRuntimeEvent, PackRuntimeEventHandler } from '../src/simulation/protocol.ts'

const TOKEN_FIXTURE = new URL('./fixtures/opensky-token-response.json', import.meta.url)
const STATES_FIXTURE = new URL('./fixtures/opensky-states-all.json', import.meta.url)

const loadJson = async (url: URL): Promise<unknown> => JSON.parse(await readFile(url, 'utf8'))

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface FakeClock {
  ms: number
  iso: IsoTimestamp
  advance: (ms: number) => void
}

const createClock = (): FakeClock => {
  const state = {
    ms: 1_700_000_000_000,
    get iso(): IsoTimestamp {
      return new Date(state.ms).toISOString() as IsoTimestamp
    },
    advance: (ms: number): void => {
      state.ms += ms
    },
  }
  return state as unknown as FakeClock
}

// Test scaffolding for the manual interval driver. The adapter calls
// setIntervalFn once; we keep the callback so the test can pump it.
interface ManualTimer {
  callback: (() => void) | null
  intervalMs: number | null
}

const createManualTimer = (): {
  readonly setIntervalFn: (cb: () => void, ms: number) => unknown
  readonly clearIntervalFn: (handle: unknown) => void
  readonly state: ManualTimer
  readonly tickNow: () => void
} => {
  const state: ManualTimer = { callback: null, intervalMs: null }
  return {
    state,
    setIntervalFn: (cb, ms) => {
      state.callback = cb
      state.intervalMs = ms
      return state
    },
    clearIntervalFn: () => {
      state.callback = null
      state.intervalMs = null
    },
    tickNow: () => {
      if (state.callback) state.callback()
    },
  }
}

const collectEvents = (handlers: PackRuntimeEvent[][]): PackRuntimeEventHandler => (message) => {
  if (message.type === 'event.emission') handlers.push([...message.events])
}

describe('createOpenSkyPackRuntimeAdapter', () => {
  it('throws at construction when credentials are missing', () => {
    expect(() => createOpenSkyPackRuntimeAdapter({ clientId: '', clientSecret: 'sec' }))
      .toThrow(/clientId is required/)
    expect(() => createOpenSkyPackRuntimeAdapter({ clientId: 'cid', clientSecret: '' }))
      .toThrow(/clientSecret is required/)
  })

  it('polls on subscribe, emits upserts, then deletes stale aircraft', async () => {
    const tokenBody = await loadJson(TOKEN_FIXTURE)
    const statesBody = await loadJson(STATES_FIXTURE)
    const emptyStates = { time: 0, states: [] }
    const clock = createClock()
    const timer = createManualTimer()

    let statesCalls = 0
    const fetchFn: HttpFetch = async (url) => {
      if (url.includes('/token')) return jsonResponse(200, tokenBody)
      statesCalls += 1
      return jsonResponse(200, statesCalls === 1 ? statesBody : emptyStates)
    }

    const adapter = createOpenSkyPackRuntimeAdapter({
      clientId: 'cid',
      clientSecret: 'sec',
      fetchFn,
      clock: () => clock.ms,
      nowIso: () => clock.iso,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      staleAfterMs: 30_000,
    })

    const connection = await adapter.connect({
      controlInstanceId: 'control-instance:test' as ControlInstanceId,
    })

    const batches: PackRuntimeEvent[][] = []
    connection.subscribe(collectEvents(batches))

    // Wait for the immediate first tick to settle.
    await Bun.sleep(10)
    expect(statesCalls).toBe(1)
    expect(batches.length).toBe(1)
    expect(batches[0]?.every(event => event.type === 'object.upserted')).toBe(true)
    expect(batches[0]?.length).toBe(2)

    // Advance past staleAfterMs and trigger the second tick (empty payload).
    clock.advance(60_000)
    timer.tickNow()
    await Bun.sleep(10)
    expect(statesCalls).toBe(2)
    const deletions = batches[1]?.filter(event => event.type === 'object.deleted') ?? []
    expect(deletions.length).toBe(2)

    await connection.close()
    expect(timer.state.callback).toBeNull()
  })

  it('retries once after a 401 response by invalidating the cached token', async () => {
    const tokenBody = await loadJson(TOKEN_FIXTURE)
    const statesBody = await loadJson(STATES_FIXTURE)
    const clock = createClock()
    const timer = createManualTimer()

    let tokenCalls = 0
    let statesCalls = 0
    const fetchFn: HttpFetch = async (url) => {
      if (url.includes('/token')) {
        tokenCalls += 1
        return jsonResponse(200, tokenBody)
      }
      statesCalls += 1
      if (statesCalls === 1) return new Response('unauthorized', { status: 401 })
      return jsonResponse(200, statesBody)
    }

    const adapter = createOpenSkyPackRuntimeAdapter({
      clientId: 'cid',
      clientSecret: 'sec',
      fetchFn,
      clock: () => clock.ms,
      nowIso: () => clock.iso,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    const connection = await adapter.connect({
      controlInstanceId: 'control-instance:test' as ControlInstanceId,
    })

    const batches: PackRuntimeEvent[][] = []
    connection.subscribe(collectEvents(batches))
    await Bun.sleep(20)

    expect(statesCalls).toBe(2)
    expect(tokenCalls).toBe(2) // initial + post-invalidate refresh
    expect(batches.length).toBe(1)
    expect(batches[0]?.length).toBe(2)

    await connection.close()
  })

  it('answers aviation.source_status query with live counts', async () => {
    const tokenBody = await loadJson(TOKEN_FIXTURE)
    const statesBody = await loadJson(STATES_FIXTURE)
    const clock = createClock()
    const timer = createManualTimer()

    const fetchFn: HttpFetch = async (url) => {
      if (url.includes('/token')) return jsonResponse(200, tokenBody)
      return jsonResponse(200, statesBody)
    }

    const adapter = createOpenSkyPackRuntimeAdapter({
      clientId: 'cid',
      clientSecret: 'sec',
      fetchFn,
      clock: () => clock.ms,
      nowIso: () => clock.iso,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    })
    const connection = await adapter.connect({
      controlInstanceId: 'control-instance:test' as ControlInstanceId,
    })
    connection.subscribe(() => undefined)
    await Bun.sleep(10)

    const response = await connection.query({ packId: 'aviation', kind: 'aviation.source_status', payload: {} })
    expect(response.ok).toBe(true)
    if (!response.ok) return
    const result = response.result as { source: string; aircraftInBbox: number; polling: boolean }
    expect(result.source).toBe('opensky')
    expect(result.aircraftInBbox).toBe(2)
    expect(result.polling).toBe(true)

    const unknown = await connection.query({ packId: 'aviation', kind: 'aviation.unknown', payload: {} })
    expect(unknown.ok).toBe(false)

    await connection.close()
  })
})
