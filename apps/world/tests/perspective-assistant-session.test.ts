import { expect, test } from 'bun:test'
import type { PerspectiveAdmission, PresentationRecipient, PresentationRequest } from '@leitbild/contracts'
import { perspectiveAdmissionSchema, presentationRequestSchema } from '@leitbild/contracts'
import { createPerspectiveAssistantSession, type PerspectiveAssistantScreen } from '../src/ui/perspective-assistant-session.ts'
import { createPerspectivePresentationSession, type PerspectiveAttentionScreen } from '../src/ui/perspective-presentation-session.ts'
import type { PerspectiveOwnerClient } from '../src/ui/perspective-client.ts'

const workspaceId = '00000000-0000-4000-8000-000000000001', parent = {}, origin = 'http://world.test'
const pending = (): PerspectiveAdmission => perspectiveAdmissionSchema.parse({ resource: { workspaceId, moduleId: 'world', type: 'world.perspective', id: crypto.randomUUID() }, status: 'pending', revision: 0, admissionGeneration: crypto.randomUUID(), runIncarnation: crypto.randomUUID(), roleSetDigest: 'a'.repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
const active = (base: PerspectiveAdmission): PerspectiveAdmission => perspectiveAdmissionSchema.parse({ ...base, status: 'active', revision: 1, runtimeAvailability: { status: 'available' }, binding: { perspective: base.resource, admissionGeneration: base.admissionGeneration, room: { workspaceId, moduleId: 'agents', type: 'agents.room', id: 'private-room' }, actualAgentId: 'actual-agent', runtimeGeneration: crypto.randomUUID(), templateId: 'public-template', templateRevision: 'revision-a' } })
const until = async (ready: () => unknown) => { for (let n = 0; n < 200; n++) { if (ready()) return; await Bun.sleep(1) } throw new Error('Controller did not settle') }
const fixture = () => {
  let admission = pending(), prepareCount = 0, registerCount = 0
  const revoked: any[] = [], unregistered: any[] = [], receipts: any[] = [], messages: any[] = [], storage = new Map<string, string>()
  let queue: PresentationRequest[] = []
  const owner: PerspectiveOwnerClient = {
    prepare: async () => { prepareCount++; return admission }, read: async () => admission,
    revoke: async (resource, expectedRevision, reason) => { revoked.push({ resource, expectedRevision, reason }); admission = { ...admission, status: 'revoked', revision: admission.revision + 1, revokedReason: reason }; return admission },
    register: async resource => { registerCount++; return { subject: resource, clientId: crypto.randomUUID(), documentId: crypto.randomUUID(), leaseId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    poll: async (_resource, recipient) => { const requests = queue.splice(0).map(request => ({ ...request, recipient })); return { recipient, requests } },
    receipt: async (_resource, _recipient, receipt) => { receipts.push(receipt); return receipt },
    unregister: async (resource, recipient) => { unregistered.push({ resource, recipient }); return { closed: true } },
  }
  const open = (worldDocumentId = crypto.randomUUID()) => {
    let screen: PerspectiveAssistantScreen | undefined
    const session = createPerspectiveAssistantSession({ key: 'own-role-reference', roleLabels: ['EMS'], owner, host: { origin, parent }, post: message => messages.push(message), changed: value => { screen = value }, apply: async () => ({ status: 'applied' }), clear: () => {}, cleanupProblem: () => { throw new Error('Unexpected cleanup failure') }, storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) } }, initialAvailability: { type: 'leitbild:perspective-assistant-availability', worldDocumentId, available: true } })
    const send = (data: unknown) => session.receive({ origin, source: parent, data })
    return { session, send, state: () => screen!, worldDocumentId }
  }
  return { owner, open, messages, storage, revoked, unregistered, receipts, admission: () => admission, set: (next: PerspectiveAdmission) => { admission = next }, counts: () => ({ prepareCount, registerCount }), queue: (requests: PresentationRequest[]) => { queue = requests } }
}

test('a late accepted prepare after a held-role transition is revoked without resurrecting its local reference', async () => {
  const f = fixture(), prepared = Promise.withResolvers<PerspectiveAdmission>(), entered = Promise.withResolvers<void>()
  f.owner.prepare = async () => { entered.resolve(); return await prepared.promise }
  const a = f.open()
  try {
    const asking = a.session.ask(); await entered.promise
    a.session.forgetForRoleChange(); a.session.stop()
    prepared.resolve(f.admission()); await asking
    expect(f.revoked).toHaveLength(1)
    expect(f.revoked[0].resource).toEqual(f.admission().resource)
    expect(f.storage.size).toBe(0)
    expect(f.messages.some(message => message.admission !== null)).toBe(false)
  } finally { prepared.resolve(f.admission()); a.session.stop() }
})

test('pending setup retry and same-role refresh preserve the exact causal id without making another admission', async () => {
  const f = fixture(), a = f.open(), requestId = crypto.randomUUID()
  try {
    await a.session.ask(requestId); a.session.stop()
    const b = f.open()
    try {
      await until(() => b.state().phase === 'pending')
      await b.session.ask(crypto.randomUUID())
      expect(b.state().requestId).toBe(requestId)
      expect(f.messages.filter(message => message.admission?.status === 'pending').every(message => message.requestId === requestId)).toBe(true)
      expect(f.counts().prepareCount).toBe(1)
      expect(f.revoked).toHaveLength(0)
    } finally { b.session.stop() }
  } finally { a.session.stop() }
})

test('a role change during opaque-reference restore also retires the late exact admission', async () => {
  const f = fixture(), restored = Promise.withResolvers<PerspectiveAdmission>(), entered = Promise.withResolvers<void>()
  const admission = active(f.admission()); f.set(admission)
  f.storage.set('own-role-reference', JSON.stringify({ prepareRequestId: crypto.randomUUID(), resource: admission.resource }))
  f.owner.read = async () => { entered.resolve(); return await restored.promise }
  const a = f.open()
  try {
    await entered.promise; a.session.forgetForRoleChange(); a.session.stop(); restored.resolve(admission)
    await until(() => f.revoked.length === 1)
    expect(f.revoked[0].resource).toEqual(admission.resource)
    expect(f.storage.size).toBe(0)
    expect(f.counts().registerCount).toBe(0)
  } finally { restored.resolve(admission); a.session.stop() }
})

test('setup response requires the current World document and admission, and duplicate success does not replace its receiver', async () => {
  const f = fixture(), a = f.open()
  try {
    await a.session.ask(); const requestId = a.state().requestId
    const admitted = active(f.admission()); f.set(admitted)
    a.send({ type: 'leitbild:perspective-assistant-result', worldDocumentId: crypto.randomUUID(), requestId, admission: admitted })
    await Bun.sleep(5); expect(f.counts().registerCount).toBe(0)
    a.send({ type: 'leitbild:perspective-assistant-result', worldDocumentId: a.worldDocumentId, requestId, admission: active(pending()) })
    await Bun.sleep(5); expect(f.counts().registerCount).toBe(0)
    expect(a.state().problem).toContain('does not match')
    const response = { type: 'leitbild:perspective-assistant-result', worldDocumentId: a.worldDocumentId, requestId, admission: admitted }
    a.send(response); await until(() => a.state().phase === 'connected')
    const recipient = a.state().attention.recipient!
    a.send(response); await Bun.sleep(5)
    expect(f.counts().registerCount).toBe(1)
    expect(a.state().attention.recipient).toEqual(recipient)
    await a.session.ask(crypto.randomUUID())
    expect(f.counts().registerCount).toBe(1)
    expect(f.messages.at(-1).recipient.subject).toEqual(admitted.resource)
    expect(a.state().phase).toBe('connected')
  } finally { a.session.stop() }
})

test('an unavailable exact runtime cannot reconnect or silently acquire a replacement admission', async () => {
  const f = fixture(), a = f.open()
  try {
    await a.session.ask()
    const unavailable = { ...active(f.admission()), runtimeAvailability: { status: 'unavailable' as const, reason: 'Exact runtime missing; end this scope first' } }; f.set(unavailable)
    a.send({ type: 'leitbild:perspective-assistant-result', worldDocumentId: a.worldDocumentId, requestId: a.state().requestId, admission: unavailable })
    await until(() => a.state().phase === 'disconnected')
    expect(a.state().problem).toContain('Exact runtime missing')
    await a.session.reconnect(); await a.session.ask()
    expect(f.counts()).toEqual({ prepareCount: 1, registerCount: 0 })
    expect(a.state().admission?.resource).toEqual(unavailable.resource)
  } finally { a.session.stop() }
})

test('an old World document never adopts a later Host nonce during navigation', async () => {
  const f = fixture(), prepared = Promise.withResolvers<PerspectiveAdmission>(), entered = Promise.withResolvers<void>()
  f.owner.prepare = async () => { entered.resolve(); return await prepared.promise }
  const a = f.open(), replacement = crypto.randomUUID()
  try {
    const asking = a.session.ask(); await entered.promise
    a.send({ type: 'leitbild:perspective-assistant-availability', worldDocumentId: replacement, available: true })
    prepared.resolve(f.admission()); await asking
    a.send({ type: 'leitbild:perspective-assistant-request', worldDocumentId: replacement, requestId: crypto.randomUUID() })
    await Bun.sleep(5)
    expect(a.state().available).toBe(false)
    expect(f.messages.some(message => message.worldDocumentId === replacement)).toBe(false)
    expect(f.messages.some(message => message.admission)).toBe(false)
    expect(f.counts().registerCount).toBe(0)
    expect(f.revoked).toHaveLength(0) // Document loss detaches delivery, not another participant's scope.
  } finally { prepared.resolve(f.admission()); a.session.stop() }
})

test('Perspective attention rejects drafts and cancels a suspended visual continuation independently of human Guide state', async () => {
  const f = fixture(), admitted = active(f.admission()), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let screen: PerspectiveAttentionScreen | undefined
  const mutations: string[] = []
  const recipient: PresentationRecipient = { subject: admitted.resource, clientId: 'client', documentId: 'document', leaseId: 'lease', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const request: PresentationRequest = presentationRequestSchema.parse({ id: 'attention', recipient, source: { kind: 'agent', moduleId: 'agents', id: 'agent', label: 'Analyst' }, target: { subject: admitted.resource, type: 'world.object', id: 'permitted-unit' }, action: { kind: 'focus' }, mode: 'suggest', purpose: 'Inspect this permitted unit', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() })
  f.queue([{ ...request, id: 'draft', action: { kind: 'draft', text: 'must not insert' } }, request])
  const session = createPerspectivePresentationSession({ resource: admitted.resource, owner: f.owner, validate: async () => true, apply: async (request, signal) => { entered.resolve(); await release.promise; signal.throwIfAborted(); mutations.push(request.id); return { status: 'applied' } }, clear: () => {}, changed: value => { screen = value } })
  try {
    await until(() => screen?.suggestion)
    const applying = session.accept(); await entered.promise; session.clearVisualCue(); release.resolve(); await applying
    expect(mutations).toEqual([])
    expect(f.receipts.find(receipt => receipt.requestId === 'draft')?.status).toBe('unavailable')
    expect(f.receipts.find(receipt => receipt.requestId === 'attention')?.status).toBe('cancelled')
    expect(screen?.recipient?.subject).toEqual(admitted.resource)
  } finally { release.resolve(); session.stop() }
})
