import { expect, test } from 'bun:test'
import { configureActiveRoleSet, currentActiveRoleSet } from '../src/ui/roles/role-session.ts'
import { createGuidanceSession, type GuidanceScreen } from '../src/ui/guidance-session.ts'

// HTTP and window doubles are confined to this browser-controller test; production uses the real owner APIs.
test('a refused Next preserves an offered prompt link; only successful progression clears owned UI', async () => {
  const priorRoles = currentActiveRoleSet(); configureActiveRoleSet(null)
  const originalFetch = globalThis.fetch, originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
  const parent = {}, messages: any[] = [], calls: Array<{ path: string; input: any }> = []
  const subject = { workspaceId: '00000000-0000-4000-8000-000000000001', moduleId: 'world', type: 'world.simulation-run', id: 'run-guide' }
  const recipient = { subject, clientId: 'client', documentId: 'document', leaseId: 'lease', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const attemptId = crypto.randomUUID(), stepAttemptId = crypto.randomUUID()
  const effect = { id: 'prompt', target: { kind: 'composer' }, action: { kind: 'draft', text: 'sitrep unit 1' }, requestId: 'request-prompt' }
  let guide: any = { available: true, title: 'Guide' }, queued = false, sent = false
  const active = () => ({ available: true, title: 'Guide', attemptId, stepAttemptId, revision: 0, status: 'active', step: { id: 'ask', title: 'Ask', instruction: 'Send explicitly', completion: 'prompt-response', effects: [effect] }, receipts: [], completed: [] })
  let screen: GuidanceScreen | undefined
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { parent } })
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://world.test' } })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), value = JSON.parse(String(init?.body ?? '{}')); calls.push({ path, input: value })
    if (path.endsWith('/presentation/register')) return Response.json({ result: recipient })
    if (path.endsWith('/presentation/poll')) {
      const requests = queued && !sent ? [{ id: 'request-prompt', recipient, source: { moduleId: 'world', kind: 'guide', id: attemptId, label: 'Guide', executionId: stepAttemptId }, target: { subject, type: 'world.composer', id: 'assistant' }, action: effect.action, purpose: 'Ask', mode: 'guide', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() }] : []
      if (requests.length) sent = true
      return Response.json({ result: { recipient, requests } })
    }
    if (path.endsWith('/guide/read')) return Response.json({ result: guide })
    if (path.endsWith('/guide/start')) { guide = active(); queued = true; return Response.json({ result: guide }) }
    if (path.endsWith('/guide/advance')) return Response.json({ error: { code: 'guide_condition_unmet', message: 'No completed response' } }, { status: 409 })
    if (path.endsWith('/guide/prompt')) return Response.json({ result: guide })
    return Response.json({ result: { closed: true } })
  }) as typeof fetch
  const storage = new Map<string, string>()
  let session: ReturnType<typeof createGuidanceSession> | undefined
  try {
    const { configureActiveWorkspace } = await import('../src/ui/workspace-context.ts')
    const { workspaceIdSchema } = await import('@leitbild/contracts')
    configureActiveWorkspace(workspaceIdSchema.parse(subject.workspaceId))
    session = createGuidanceSession({ runId: subject.id, perspective: 'open', apply: async () => ({ status: 'applied' }), clear: () => {}, changed: value => screen = value, post: value => messages.push(value), storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) } } })
    for (let n = 0; n < 30 && !screen?.guide; n++) await Bun.sleep(1)
    await session.action('start')
    expect(messages.some(message => message.type === 'leitbild:presentation-compose')).toBe(true)
    await session.action('next')
    expect(screen?.error).toBe('No completed response')
    expect(messages.filter(message => message.type === 'leitbild:presentation-clear')).toHaveLength(0)
    session.receive({ origin: 'http://world.test', source: parent, data: { type: 'leitbild:presentation-evidence', recipient, room: { ...subject, moduleId: 'agents', type: 'agents.room', id: 'room-a' }, requestId: 'request-prompt', messageId: 'actual-person-message' } } as MessageEvent)
    for (let n = 0; n < 20 && !calls.some(call => call.path.endsWith('/guide/prompt')); n++) await Bun.sleep(1)
    expect(calls.find(call => call.path.endsWith('/guide/prompt'))?.input.messageId).toBe('actual-person-message')
  } finally {
    session?.stop(); configureActiveRoleSet(priorRoles); globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window')
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else Reflect.deleteProperty(globalThis, 'location')
  }
})
