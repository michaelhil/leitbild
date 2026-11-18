import { expect, jest, test } from 'bun:test'
import { workspaceIdSchema } from '@leitbild/contracts'
import { createGuidanceSession, type GuidanceScreen } from '../src/ui/guidance-session.ts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'

// The walkthrough's F3: after a 2 min host suspension every page's presentation/poll stopped for good. The document's
// 60 s lease had lapsed, World answered no_recipient, and the session dropped its recipient and never registered again.
test('a lease that lapsed while the page was suspended is registered again on the next tick, and the poll resumes', async () => {
  const oldFetch = globalThis.fetch, oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
  configureActiveWorkspace(workspaceIdSchema.parse('00000000-0000-4000-8000-000000000001'))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { parent: {} } })
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://world.test' } })
  const subject = { workspaceId: '00000000-0000-4000-8000-000000000001', moduleId: 'world', type: 'world.simulation-run', id: 'run' }
  const recipientOf = (lease: number) => ({ subject, clientId: 'client', documentId: 'document', leaseId: `lease-${lease}`, expiresAt: new Date(Date.now() + 60_000).toISOString() })
  let leases = 0, lapsed = false, screen: GuidanceScreen | undefined
  const polls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://world.test').pathname, body = JSON.parse(String(init?.body ?? '{}'))
    if (path.endsWith('/presentation/register')) return Response.json({ result: recipientOf(++leases) })
    if (path.endsWith('/presentation/poll')) {
      polls.push(body.recipient.leaseId)
      if (lapsed && body.recipient.leaseId === 'lease-1') return Response.json({ error: { code: 'no_recipient', message: 'This browser delivery offer is no longer current' } }, { status: 409 })
      return Response.json({ result: { recipient: body.recipient, requests: [] } })
    }
    if (path.endsWith('/guide/read')) return Response.json({ result: { available: true, title: 'Guide' } })
    return Response.json({ result: { closed: true } })
  }) as typeof fetch
  const settle = async (): Promise<void> => { for (let turn = 0; turn < 20; turn++) await new Promise<void>(resolve => queueMicrotask(resolve)) }
  jest.useFakeTimers()
  const session = createGuidanceSession({
    runId: 'run', perspective: '[]', apply: async () => ({ status: 'applied' }), clear: () => {}, post: () => {},
    changed: value => { screen = value },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  })
  try {
    await settle()
    expect(screen?.recipient?.leaseId).toBe('lease-1')
    lapsed = true
    jest.advanceTimersByTime(3_000)
    await settle()
    expect(screen?.recipient).toBeNull()
    expect(screen?.error).toContain('no longer current')
    jest.advanceTimersByTime(3_000)
    await settle()
    expect(screen?.recipient?.leaseId).toBe('lease-2')
    expect(screen?.error).toBeNull()
    jest.advanceTimersByTime(3_000)
    await settle()
    expect(polls).toEqual(['lease-1', 'lease-1', 'lease-2', 'lease-2'])
  } finally {
    session.stop(); jest.useRealTimers(); globalThis.fetch = oldFetch
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window')
    if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else Reflect.deleteProperty(globalThis, 'location')
  }
})
