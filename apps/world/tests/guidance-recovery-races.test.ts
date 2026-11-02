import { expect, test } from 'bun:test'
import { workspaceIdSchema } from '@leitbild/contracts'
import { createGuidanceSession, type GuidanceScreen } from '../src/ui/guidance-session.ts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'
import { configureActiveRoleSet, currentActiveRoleSet } from '../src/ui/roles/role-session.ts'

const oldId = '10000000-0000-4000-8000-000000000001', newId = '10000000-0000-4000-8000-000000000002'
const reading = (id: string, status: 'active' | 'completed' = 'active') => ({ available: true, title: 'Guide', attemptId: id, stepAttemptId: '20000000-0000-4000-8000-000000000001', revision: 0, status,
  step: { id: 'step', title: 'Step', instruction: 'Read current facts', completion: 'acknowledge', effects: [] }, receipts: [], completed: status === 'completed' ? [{ stepId: 'step', outcome: 'acknowledged', at: new Date().toISOString() }] : [],
})
const fixture = async (config: { seed?: string; read?: (input: any) => Promise<Response>; start?: () => Promise<Response> } = {}) => {
  const oldFetch = globalThis.fetch, oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location'), priorRoles = currentActiveRoleSet()
  configureActiveWorkspace(workspaceIdSchema.parse('00000000-0000-4000-8000-000000000001')); configureActiveRoleSet(['role-a'])
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { parent: {} } })
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://world.test' } })
  const subject = { workspaceId: '00000000-0000-4000-8000-000000000001', moduleId: 'world', type: 'world.simulation-run', id: 'run' }
  const recipient = { subject, clientId: 'client', documentId: 'document', leaseId: 'lease', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const storage = new Map<string, string>(), calls: Array<{ path: string; roles: string | null; input: any }> = []
  let seeded = false, screen: GuidanceScreen | undefined
  const ready = Promise.withResolvers<void>()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://world.test'), body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ path: url.pathname, roles: url.searchParams.get('roles'), input: body })
    if (url.pathname.endsWith('/presentation/register')) return Response.json({ result: recipient })
    if (url.pathname.endsWith('/presentation/poll')) return Response.json({ result: { recipient, requests: [] } })
    if (url.pathname.endsWith('/guide/read')) return config.read ? config.read(body) : Response.json({ result: body.attemptId ? reading(body.attemptId, 'completed') : { available: true, title: 'Fresh guide' } })
    if (url.pathname.endsWith('/guide/start')) return config.start ? config.start() : Response.json({ result: reading(newId) })
    return Response.json({ result: { closed: true } })
  }) as typeof fetch
  const session = createGuidanceSession({ runId: 'run', perspective: '["role-a"]', apply: async () => ({ status: 'applied' }), clear: () => {}, post: () => {},
    changed: value => { screen = value; if (value.recipient && !value.busy) ready.resolve() },
    storage: { getItem: key => { if (!seeded && config.seed) { storage.set(key, config.seed); seeded = true }; return storage.get(key) ?? null }, setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) } },
  })
  await ready.promise
  return { session, storage, calls, screen: () => screen!, close: () => {
    session.stop(); configureActiveRoleSet(priorRoles); globalThis.fetch = oldFetch
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window')
    if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else Reflect.deleteProperty(globalThis, 'location')
  } }
}

test('a stopped old-role Start response cannot recreate its forgotten local reference; unregister keeps the old role', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<Response>()
  const f = await fixture({ start: async () => { entered.resolve(); return release.promise } })
  try {
    const starting = f.session.action('start'); await entered.promise
    configureActiveRoleSet(['role-b']); f.session.stop()
    // Models a role transition purging local references while the admitted
    // owner operation may still produce an actual saved attempt.
    f.storage.clear()
    release.resolve(Response.json({ result: reading(newId) })); await starting
    expect([...f.storage.values()]).toEqual([])
    expect(f.calls.find(call => call.path.endsWith('/presentation/unregister'))?.roles).toBe('role-a')
  } finally { release.resolve(Response.json({ result: reading(newId) })); f.close() }
})

test('an old missing-attempt read cannot erase a newer explicitly started reference', async () => {
  let deferred = false
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<Response>()
  const f = await fixture({ seed: oldId, read: async input => {
    if (deferred && input.attemptId === oldId) { entered.resolve(); return release.promise }
    return Response.json({ result: input.attemptId ? reading(input.attemptId, input.attemptId === oldId ? 'completed' : 'active') : { available: true, title: 'Fresh guide' } })
  } })
  try {
    deferred = true
    const oldRead = f.session.read(); await entered.promise
    await f.session.action('start')
    expect([...f.storage.values()]).toEqual([newId])
    release.resolve(Response.json({ error: { code: 'guide_attempt_unavailable', message: 'Old attempt removed by Reset' } }, { status: 404 })); await oldRead
    expect([...f.storage.values()]).toEqual([newId])
    expect(f.screen().guide?.attemptId).toBe(newId)
  } finally { release.resolve(Response.json({ error: { code: 'guide_attempt_unavailable', message: 'Old attempt removed' } }, { status: 404 })); f.close() }
})

test('Reset missing-attempt recovery offers a fresh Start while a corrupt saved document remains visible', async () => {
  for (const corrupt of [false, true]) {
    const f = await fixture({ seed: oldId, read: async input => input.attemptId === oldId
      ? Response.json({ error: { code: corrupt ? 'guide_state_unreadable' : 'guide_attempt_unavailable', message: corrupt ? 'Saved guide is unreadable' : 'Attempt no longer exists' } }, { status: corrupt ? 500 : 404 })
      : Response.json({ result: input.attemptId ? reading(input.attemptId) : { available: true, title: 'Fresh guide' } }),
    })
    try {
      if (corrupt) {
        expect([...f.storage.values()]).toEqual([oldId])
        expect(f.screen().error).toContain('unreadable')
        expect(f.calls.some(call => call.path.endsWith('/guide/start'))).toBe(false)
      } else {
        expect([...f.storage.values()]).toEqual([])
        expect(f.screen().guide?.title).toBe('Fresh guide')
        expect(f.screen().guide?.attemptId).toBeUndefined()
        await f.session.action('start')
        expect([...f.storage.values()]).toEqual([newId])
      }
    } finally { f.close() }
  }
})

test('explicit role-transition forgetting removes only this local attempt and suppresses old-scope commands', async () => {
  const f = await fixture({ seed: oldId })
  try {
    expect([...f.storage.values()]).toEqual([oldId])
    ;(f.session as typeof f.session & { forgetAttemptReference: () => void }).forgetAttemptReference()
    expect([...f.storage.values()]).toEqual([])
    const count = f.calls.length
    await f.session.action('start'); await f.session.read()
    expect(f.calls.slice(count).some(call => call.path.includes('/guide/'))).toBe(false)
    expect([...f.storage.values()]).toEqual([])
  } finally { f.close() }
})
