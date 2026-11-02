import { expect, test } from 'bun:test'
import { workspaceIdSchema } from '@leitbild/contracts'
import { createGuidanceSession, type GuidanceScreen, type GuidanceSession } from '../src/ui/guidance-session.ts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'
import { configureActiveRoleSet, currentActiveRoleSet } from '../src/ui/roles/role-session.ts'

test('clearing, closing, reconnecting or manual camera interruption prevents a suspended old cue from applying later', async () => {
  for (const action of ['clear', 'supersede-visual', 'stop', 'reconnect', 'manual-camera'] as const) {
    const oldFetch = globalThis.fetch, oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location'), priorRoles = currentActiveRoleSet()
    const subject = { workspaceId: '00000000-0000-4000-8000-000000000001', moduleId: 'world', type: 'world.simulation-run', id: 'run' }
    const recipient = { subject, clientId: 'client', documentId: 'document', leaseId: 'lease', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>()
    const mutations: string[] = [], receipts: any[] = []
    let registration = 0, queued = false, screen: GuidanceScreen | undefined, session: GuidanceSession | undefined
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { parent: {} } })
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://world.test' } })
    configureActiveWorkspace(workspaceIdSchema.parse(subject.workspaceId)); configureActiveRoleSet(null)
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input), body = JSON.parse(String(init?.body ?? '{}'))
      if (path.endsWith('/presentation/register')) { registration++; return Response.json({ result: { ...recipient, documentId: `document-${registration}`, leaseId: `lease-${registration}` } }) }
      if (path.endsWith('/presentation/poll')) {
        const requests = queued ? [] : [{ id: 'attention', recipient: { ...recipient, documentId: 'document-1', leaseId: 'lease-1' }, source: { moduleId: 'world', kind: 'agent', id: 'analyst', label: 'Analyst' }, target: { subject, type: 'world.object', id: 'unit' }, action: { kind: 'focus' }, purpose: 'Inspect the unit', mode: 'suggest', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() }]
        queued = true
        return Response.json({ result: { recipient: body.recipient, requests } })
      }
      if (path.endsWith('/guide/read')) return Response.json({ result: { available: true, title: 'Guide' } })
      if (path.endsWith('/presentation/receipt')) { receipts.push(body.receipt); return Response.json({ result: body.receipt }) }
      return Response.json({ result: { closed: true } })
    }) as typeof fetch
    try {
      session = createGuidanceSession({ runId: subject.id, perspective: 'open',
        apply: async (request, signal) => { entered.resolve(); await release.promise; signal?.throwIfAborted(); mutations.push(request.id); return { status: 'applied' } },
        clear: () => {}, changed: value => { screen = value; if (screen.suggestion && !screen.busy) ready.resolve() }, post: () => {},
        storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      })
      await ready.promise
      const applying = session.accept(); await entered.promise
      let reconnecting: Promise<void> | undefined
      if (action === 'clear') session.clearCue()
      if (action === 'supersede-visual') session.clearVisualCue()
      if (action === 'stop') session.stop()
      if (action === 'reconnect') reconnecting = session.reconnect()
      if (action === 'manual-camera') session.manualCamera()
      release.resolve(); await applying; await reconnecting
      expect(mutations, action).toEqual([])
      expect(receipts.some(receipt => receipt.status === 'applied'), action).toBe(false)
      if (action === 'clear') expect(receipts.at(-1)?.status).toBe('cancelled')
      if (action === 'manual-camera') expect(receipts.at(-1)?.status).toBe('superseded')
    } finally {
      release.resolve(); session?.stop(); configureActiveRoleSet(priorRoles); globalThis.fetch = oldFetch
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window')
      if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else Reflect.deleteProperty(globalThis, 'location')
    }
  }
})
