import { expect, test } from 'bun:test'
import { createGuidanceSession, type GuidanceScreen } from '../src/ui/guidance-session.ts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'
import { configureActiveRoleSet, currentActiveRoleSet } from '../src/ui/roles/role-session.ts'
import { workspaceIdSchema } from '@leitbild/contracts'

test('Stop stays available during delivery and waits for this document’s earlier receipt before choosing its expected revision', async () => {
  const priorFetch = globalThis.fetch, priorRoles = currentActiveRoleSet(); configureActiveRoleSet(null)
  const subject = { workspaceId: workspaceIdSchema.parse('00000000-0000-4000-8000-000000000001'), moduleId: 'world', type: 'world.simulation-run', id: 'run-order' }
  configureActiveWorkspace(subject.workspaceId)
  const recipient = { subject, clientId: 'client', documentId: 'document', leaseId: 'lease', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const attemptId = crypto.randomUUID(), stepAttemptId = crypto.randomUUID()
  const effect = { id: 'focus', target: { kind: 'object', objectId: 'unit:one' }, action: { kind: 'focus' }, requestId: 'focus-request' }
  let guide: any = { available: true, title: 'Guide' }, requestReady = false, receiptStarted = false, releaseReceipt: (() => void) | undefined, advance: any = null, screen: GuidanceScreen | undefined
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), body = JSON.parse(String(init?.body ?? '{}'))
    if (path.endsWith('/presentation/register')) return Response.json({ result: recipient })
    if (path.endsWith('/guide/read')) return Response.json({ result: guide })
    if (path.endsWith('/guide/start')) { guide = { available: true, title: 'Guide', attemptId, stepAttemptId, revision: 0, status: 'active', step: { id: 'one', title: 'One', instruction: 'Inspect', completion: 'presentation', effects: [effect] }, receipts: [], completed: [] }; requestReady = true; return Response.json({ result: guide }) }
    if (path.endsWith('/presentation/poll')) { const requests = requestReady ? [{ id: effect.requestId, recipient, source: { moduleId: 'world', kind: 'guide', id: attemptId, label: 'Guide', executionId: stepAttemptId }, target: { subject, type: 'world.object', id: 'unit:one' }, action: { kind: 'focus' }, purpose: 'Inspect', mode: 'guide', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() }] : []; requestReady = false; return Response.json({ result: { recipient, requests } }) }
    if (path.endsWith('/guide/receipt')) { guide = { ...guide, revision: 1, receipts: [{ effectId: effect.id, receipt: body.receipt }] }; receiptStarted = true; return await new Promise<Response>(resolve => { releaseReceipt = () => resolve(Response.json({ result: guide })) }) }
    if (path.endsWith('/guide/advance')) { advance = body; if (body.expectedRevision !== guide.revision) return Response.json({ error: { code: 'guide_progress_conflict', message: 'Wrong expected revision' } }, { status: 409 }); guide = { ...guide, revision: guide.revision + 1, status: 'stopped' }; return Response.json({ result: guide }) }
    return Response.json({ result: { closed: true } })
  }) as typeof fetch
  const storage = new Map<string, string>()
  const session = createGuidanceSession({ runId: subject.id, perspective: 'open', post: () => {}, changed: value => screen = value, clear: () => {}, apply: async () => ({ status: 'applied' }), storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) } } })
  const until = async (predicate: () => unknown) => { const start = performance.now(); while (!predicate() && performance.now() - start < 1_000) await Bun.sleep(1); expect(Boolean(predicate())).toBe(true) }
  try {
    await until(() => screen?.guide)
    const started = session.action('start')
    await until(() => receiptStarted)
    expect(screen?.busy).toBe(false)
    const stopped = session.action('stop')
    await Bun.sleep(1)
    expect(advance).toBeNull()
    releaseReceipt?.()
    await Promise.all([started, stopped])
    expect(advance.expectedRevision).toBe(1)
    expect(screen?.guide?.status).toBe('stopped')
    expect(screen?.error).toBeNull()
  } finally { releaseReceipt?.(); session.stop(); globalThis.fetch = priorFetch; configureActiveRoleSet(priorRoles) }
})
