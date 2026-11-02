import { expect, test } from 'bun:test'
import { newWorkspaceId, workspaceResourceReferenceSchema, type PerspectiveAssistantOffer } from '@leitbild/contracts'
import { createPerspectiveAssistantDelivery } from '../src/ui/perspective-assistant-delivery.ts'

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const fixture = () => {
  const workspaceId = newWorkspaceId(), at = new Date().toISOString()
  const perspective = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.perspective', id: 'perspective-blue' })
  const room = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'agents', type: 'agents.room', id: 'private-blue' })
  const binding = { perspective, room, admissionGeneration: crypto.randomUUID(), actualAgentId: 'actual-blue', runtimeGeneration: crypto.randomUUID(), templateId: 'template', templateRevision: 'revision' }
  const admission = { resource: perspective, status: 'active' as const, revision: 1, admissionGeneration: binding.admissionGeneration, runIncarnation: crypto.randomUUID(), roleSetDigest: 'a'.repeat(64), binding, createdAt: at, updatedAt: at }
  const offer: PerspectiveAssistantOffer = { type: 'leitbild:perspective-assistant-offer', worldDocumentId: crypto.randomUUID(), requestId: crypto.randomUUID(), admission, roleLabels: ['Blue'], recipient: { subject: perspective, clientId: 'client', documentId: 'world-document', leaseId: 'lease', expiresAt: new Date(Date.now() + 60_000).toISOString() } }
  const state = { now: Date.now(), requests: [] as string[], world: [] as unknown[], agents: [] as unknown[], hold: null as (() => Promise<void>) | null, expire: () => {} }
  const token = crypto.randomUUID()
  const delivery = createPerspectiveAssistantDelivery({ workspaceId: () => workspaceId, available: () => true, uuid: () => crypto.randomUUID(), now: () => state.now,
    postWorld: message => { state.world.push(message) }, postAgents: message => { state.agents.push(message) }, changed: () => {},
    timer: (_ms, action) => { state.expire = action; return () => {} },
    request: async (path, body) => { state.requests.push(path); const hold = state.hold; state.hold = null; await hold?.(); const input = body as { agentsDocumentId: string }; return { token, room, perspective, documentId: input.agentsDocumentId, expiresAt: new Date(state.now + 30_000).toISOString() } },
  })
  delivery.availabilityChanged()
  offer.worldDocumentId = (state.world[0] as { worldDocumentId: string }).worldDocumentId
  return { delivery, state, offer }
}

test('renewal coalesces World polls and retains the same private frame and document', async () => {
  const f = fixture()
  f.delivery.fromWorld(f.offer); await settle()
  const initial = f.delivery.state()
  expect(initial.frameUrl).toContain('#perspective-view=')
  for (let i = 0; i < 4; i++) { f.delivery.fromWorld({ ...f.offer, recipient: { ...f.offer.recipient!, expiresAt: new Date(f.state.now + 90_000 + i).toISOString() } }); await settle() }
  expect(f.state.requests).toHaveLength(1)
  f.state.now += 21_000
  f.delivery.fromWorld(f.offer); await settle()
  expect(f.state.requests).toHaveLength(2)
  expect(f.delivery.state().frameUrl).toBe(initial.frameUrl)
  expect(f.delivery.state().lease?.documentId).toBe(initial.lease?.documentId)
  expect(f.delivery.state().lease?.expiresAt).not.toBe(initial.lease?.expiresAt)
})

test('a withdrawn World document cannot receive a late private view or reappear after A to B to A', async () => {
  const f = fixture()
  let release!: () => void
  f.state.hold = () => new Promise<void>(resolve => { release = resolve })
  f.delivery.fromWorld(f.offer); await settle()
  f.delivery.fromWorld({ ...f.offer, admission: null, recipient: null, roleLabels: [] })
  release(); await settle()
  expect(f.delivery.state().frameUrl).toBeNull()
  expect(f.state.agents).toEqual([])
  const again = { ...f.offer, requestId: crypto.randomUUID() }
  f.delivery.fromWorld(again); await settle()
  expect(f.delivery.state().lease).not.toBeNull()
  expect(f.delivery.fromAgents({ type: 'leitbild:perspective-view-ready', ...f.delivery.state().lease, token: undefined })).toBe(false)
})

test('readiness requires the exact private Room, Perspective and document', async () => {
  const f = fixture(); f.delivery.fromWorld(f.offer); await settle()
  const lease = f.delivery.state().lease!
  const ready = { type: 'leitbild:perspective-view-ready', room: lease.room, perspective: lease.perspective, documentId: lease.documentId }
  expect(f.delivery.fromAgents({ ...ready, documentId: crypto.randomUUID() })).toBe(false)
  expect(f.delivery.fromAgents({ ...ready, room: { ...lease.room, id: 'private-red' } })).toBe(false)
  expect(f.delivery.fromAgents(ready)).toBe(true)
})

test('a known unavailable runtime is not silently rebound or resumed', async () => {
  const f = fixture()
  f.delivery.fromWorld({ ...f.offer, admission: { ...f.offer.admission!, runtimeAvailability: { status: 'unavailable', reason: 'Runtime restarted; begin fresh' } } })
  await settle()
  expect(f.state.requests).toEqual([])
  expect(f.delivery.state().frameUrl).toBeNull()
  expect(f.delivery.state().problem).toContain('begin fresh')
})

test('loss of World renewal retires the private document at lease expiry', async () => {
  const f = fixture(); f.delivery.fromWorld(f.offer); await settle()
  const priorDocument = f.delivery.state().lease!.documentId
  f.state.expire()
  expect(f.delivery.state().frameUrl).toBeNull()
  expect(f.delivery.state().problem).toContain('expired')
  f.delivery.retryView(); await settle()
  expect(f.delivery.state().lease!.documentId).not.toBe(priorDocument)
})

test('queued offers from an unloaded World document cannot reopen its private view', async () => {
  const f = fixture(); f.delivery.fromWorld(f.offer); await settle()
  expect(f.state.requests).toHaveLength(1)
  f.delivery.worldUnloaded()
  f.delivery.availabilityChanged()
  f.delivery.fromWorld(f.offer); await settle()
  expect(f.delivery.state().offer).toBeNull()
  expect(f.delivery.state().frameUrl).toBeNull()
  expect(f.state.requests).toHaveLength(1)
  const handshake = f.state.world.at(-1) as { worldDocumentId: string }
  expect(handshake.worldDocumentId).not.toBe(f.offer.worldDocumentId)
  f.delivery.fromWorld({ ...f.offer, worldDocumentId: handshake.worldDocumentId }); await settle()
  expect(f.state.requests).toHaveLength(2)
})

test('an actual Agents document replacement gets a fresh lease while ordinary renewal keeps its draft document', async () => {
  const f = fixture(); f.delivery.fromWorld(f.offer); await settle()
  const first = f.delivery.state().lease!, firstUrl = f.delivery.state().frameUrl
  f.delivery.agentsLoaded(true)
  expect(f.delivery.state().frameUrl).toBeNull()
  await settle()
  expect(f.delivery.state().lease?.documentId).not.toBe(first.documentId)
  expect(f.delivery.state().frameUrl).not.toBe(firstUrl)
  expect(f.delivery.fromAgents({ type: 'leitbild:perspective-view-ready', room: first.room, perspective: first.perspective, documentId: first.documentId })).toBe(false)
})
