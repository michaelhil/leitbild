import { describe, expect, jest, test } from 'bun:test'
import { workspaceIdSchema } from '@leitbild/contracts'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { createRealtimeConnectionController, reconnectDelayMs, type RealtimeConnectionCallbacks } from '../src/ui/app/realtime-connection.ts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'

// The walkthrough's F3: after a host suspension (an iPad's lock, for Safari) the channel closed and never came back,
// so the screen froze with no sign. A close the screen did not ask for now reconnects and its first ready says so.
const workspaceId = workspaceIdSchema.parse('22222222-2222-4222-8222-222222222222')
const runId = 'run-reconnect' as SimulationRunId
configureActiveWorkspace(workspaceId)

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static made: FakeSocket[] = []
  readyState = FakeSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { readonly data: string }) => void) | null = null
  constructor(readonly url: string) { FakeSocket.made.push(this) }
  send(): void {}
  close(): void { this.readyState = FakeSocket.CLOSED }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.() }
  /** The browser's close event: the server went, the network dropped, or Safari closed a locked tab's socket. */
  drop(): void { this.readyState = FakeSocket.CLOSED; this.onclose?.() }
  receive(message: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify({ workspaceId, simulationRunId: runId, snapshotSeq: 1, ...message }) }) }
}

const page = Object.assign(new EventTarget(), { visibilityState: 'hidden' as 'hidden' | 'visible' })

const withController = (roleIds: ReadonlyArray<string> | null, body: (seen: string[], connection: ReturnType<typeof createRealtimeConnectionController>) => void): void => {
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { WebSocket: globals.WebSocket, location: globals.location, window: globals.window, document: globals.document }
  Object.assign(globals, { WebSocket: FakeSocket, location: { protocol: 'http:', host: 'world.test' }, window: new EventTarget(), document: page })
  FakeSocket.made = []
  page.visibilityState = 'hidden'
  jest.useFakeTimers()
  const connection = createRealtimeConnectionController()
  try {
    const seen: string[] = []
    const callbacks: RealtimeConnectionCallbacks = {
      onOpen: () => {}, onError: () => {}, onInvalidMessage: message => { seen.push(`invalid ${message}`) },
      onClose: retry => { seen.push(`closed, attempt ${retry.attempt} in ${retry.inMs} ms`) },
      onReady: (_message, resumed) => { seen.push(resumed ? 'ready, resync' : 'ready') },
      onEvent: () => {}, onRuntimeRealtime: () => {}, onRoleRefused: () => {},
    }
    connection.connect(runId, callbacks, roleIds)
    body(seen, connection)
  } finally {
    connection.disconnect()
    jest.useRealTimers()
    Object.assign(globals, saved)
  }
}

const latest = (): FakeSocket => FakeSocket.made.at(-1)!

describe('the realtime channel reconnects after a close the screen did not ask for', () => {
  test('close, reconnecting with backoff, ready, and that ready asks for a resync once', () => {
    withController(null, seen => {
      latest().open()
      latest().receive({ type: 'realtime.ready' })
      latest().drop()
      expect(seen).toEqual(['ready', 'closed, attempt 1 in 1000 ms'])
      jest.advanceTimersByTime(999)
      expect(FakeSocket.made.length).toBe(1)
      jest.advanceTimersByTime(1)
      expect(FakeSocket.made.length).toBe(2)
      expect(latest().url).toBe(FakeSocket.made[0]!.url)
      // The attempt fails too: the next one waits twice as long.
      latest().drop()
      jest.advanceTimersByTime(1_999)
      expect(FakeSocket.made.length).toBe(2)
      jest.advanceTimersByTime(1)
      latest().open()
      latest().receive({ type: 'realtime.ready' })
      latest().receive({ type: 'realtime.ready' })
      expect(seen.slice(2)).toEqual(['closed, attempt 2 in 2000 ms', 'ready, resync', 'ready'])
      // A ready ends the backoff: the next close starts again at the first attempt.
      latest().drop()
      expect(seen.at(-1)).toBe('closed, attempt 1 in 1000 ms')
    })
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(reconnectDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
  })

  test('disconnect() never reconnects, also when it ends a reconnect under way', () => {
    withController(null, (seen, connection) => {
      const first = latest()
      first.open()
      first.receive({ type: 'realtime.ready' })
      connection.disconnect()
      first.drop()
      jest.advanceTimersByTime(60_000)
      expect(FakeSocket.made.length).toBe(1)
      expect(seen).toEqual(['ready'])
    })
    withController(null, (seen, connection) => {
      latest().drop()
      connection.disconnect()
      page.visibilityState = 'visible'
      page.dispatchEvent(new Event('visibilitychange'))
      jest.advanceTimersByTime(60_000)
      expect(FakeSocket.made.length).toBe(1)
      expect(seen).toEqual(['closed, attempt 1 in 1000 ms'])
    })
  })

  test('the page becoming visible again, or the network coming back, tries at once', () => {
    withController(null, () => {
      latest().drop()
      jest.advanceTimersByTime(500)
      page.dispatchEvent(new Event('visibilitychange'))
      expect(FakeSocket.made.length).toBe(1)
      page.visibilityState = 'visible'
      page.dispatchEvent(new Event('visibilitychange'))
      expect(FakeSocket.made.length).toBe(2)
      // An attempt under way is not doubled; a failed one waits for the next wake or its backoff.
      ;(globalThis as unknown as { window: EventTarget }).window.dispatchEvent(new Event('online'))
      expect(FakeSocket.made.length).toBe(2)
      latest().drop()
      ;(globalThis as unknown as { window: EventTarget }).window.dispatchEvent(new Event('online'))
      expect(FakeSocket.made.length).toBe(3)
      // Connected again, the page stops listening for wakes.
      latest().open()
      latest().receive({ type: 'realtime.ready' })
      page.dispatchEvent(new Event('visibilitychange'))
      jest.advanceTimersByTime(60_000)
      expect(FakeSocket.made.length).toBe(3)
    })
  })

  test('a role Run reconnects with the role set the Run last adopted', () => {
    const ready = (epoch: number, roleIds: ReadonlyArray<string>) => ({ type: 'realtime.ready', epoch, roleIds, snapshot: { objects: [], seq: epoch }, compiledScenario: { id: 'roles', roles: [] } })
    withController(['dispatch'], () => {
      latest().open()
      latest().receive(ready(1, ['dispatch']))
      latest().receive(ready(2, ['control']))
      latest().drop()
      jest.advanceTimersByTime(1_000)
      expect(FakeSocket.made.map(socket => new URL(socket.url).searchParams.get('roles'))).toEqual(['dispatch', 'control'])
    })
  })
})
