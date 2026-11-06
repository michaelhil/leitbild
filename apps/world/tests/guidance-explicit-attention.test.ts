import { expect, test } from 'bun:test'
import { createGuidanceSession, type GuidanceScreen } from '../src/ui/guidance-session.ts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'
import { configureActiveRoleSet, currentActiveRoleSet } from '../src/ui/roles/role-session.ts'
import { workspaceIdSchema } from '@leitbild/contracts'

test('explicitly accepted analyst focus supersedes an earlier pan; a new gesture still interrupts that one flight', async () => {
  const priorFetch = globalThis.fetch, priorRoles = currentActiveRoleSet()
  configureActiveRoleSet(null)
  const subject = { workspaceId: workspaceIdSchema.parse('00000000-0000-4000-8000-000000000001'), moduleId: 'world', type: 'world.simulation-run', id: 'run-attention' }
  configureActiveWorkspace(subject.workspaceId)
  const recipient = { subject, clientId: 'client', documentId: 'document', leaseId: 'lease', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const request = (id: string) => ({ id, recipient, source: { moduleId: 'agents', kind: 'agent', id: 'analyst', label: 'Analyst' }, target: { subject, type: 'world.object', id: 'unit:one' }, action: { kind: 'focus' }, purpose: 'Inspect this location', mode: 'suggest', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() })
  const pending = [request('focus-a')], receipts: any[] = [], cameraAllowed: boolean[] = []
  let screen: GuidanceScreen | undefined, calls = 0, active: AbortSignal | undefined, release: (() => void) | undefined
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path.endsWith('/presentation/register')) return Response.json({ result: recipient })
    if (path.endsWith('/presentation/poll')) return Response.json({ result: { recipient, requests: pending.splice(0) } })
    if (path.endsWith('/guide/read')) return Response.json({ error: { code: 'guide_not_available', message: 'No guide' } }, { status: 404 })
    if (path.endsWith('/presentation/receipt')) receipts.push(JSON.parse(String(init?.body)).receipt)
    return Response.json({ result: { closed: true } })
  }) as typeof fetch
  const storage = new Map<string, string>()
  const session = createGuidanceSession({ runId: subject.id, perspective: 'open', storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) } }, post: () => {}, changed: value => screen = value, clear: () => {}, apply: async (_request, signal, allowed) => {
    cameraAllowed.push(allowed); calls++; active = signal
    if (calls === 2) { await new Promise<void>(resolve => release = resolve); signal.throwIfAborted() }
    return { status: 'applied' }
  } })
  const until = async (predicate: () => unknown) => { const start = performance.now(); while (!predicate() && performance.now() - start < 5_000) await Bun.sleep(1); expect(Boolean(predicate())).toBe(true) }
  try {
    session.manualCamera()
    await until(() => screen?.suggestion?.id === 'focus-a')
    await session.accept()
    expect(cameraAllowed[0]).toBe(true)
    expect(receipts[0]).toMatchObject({ requestId: 'focus-a', status: 'applied' })
    pending.push(request('focus-b'))
    await until(() => screen?.suggestion?.id === 'focus-b')
    const accepted = session.accept()
    await until(() => release)
    session.manualCamera()
    expect(active?.aborted).toBe(true)
    release?.(); await accepted
    expect(cameraAllowed[1]).toBe(true)
    expect(receipts.at(-1)).toMatchObject({ requestId: 'focus-b', status: 'superseded' })
  } finally { session.stop(); globalThis.fetch = priorFetch; configureActiveRoleSet(priorRoles) }
})
