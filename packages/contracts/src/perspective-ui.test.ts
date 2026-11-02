import { expect, test } from 'bun:test'
import { perspectiveAssistantOfferMessageSchema, perspectiveAssistantResultMessageSchema, perspectiveViewRequestSchema } from './perspective-ui.ts'

const workspaceId = crypto.randomUUID()
const ref = { workspaceId, moduleId: 'world', type: 'world.perspective', id: 'perspective-a' }
const stamp = new Date().toISOString()
const binding = { perspective: ref, admissionGeneration: crypto.randomUUID(), room: { workspaceId, moduleId: 'agents', type: 'agents.room', id: 'room-a' }, actualAgentId: 'agent-a', runtimeGeneration: crypto.randomUUID(), templateId: 'template-a', templateRevision: 'revision-a' }
const admission = { resource: ref, status: 'active', revision: 1, admissionGeneration: binding.admissionGeneration, runIncarnation: crypto.randomUUID(), roleSetDigest: 'a'.repeat(64), binding, createdAt: stamp, updatedAt: stamp }
const recipient = { subject: ref, clientId: 'client-a', documentId: 'document-a', leaseId: 'lease-a', expiresAt: new Date(Date.now() + 60_000).toISOString() }

test('a scoped browser offer cannot substitute the canonical Run or a different Perspective', () => {
  const offer = { type: 'leitbild:perspective-assistant-offer', requestId: crypto.randomUUID(), admission, recipient, roleLabels: ['Blue'] }
  expect(perspectiveAssistantOfferMessageSchema.safeParse(offer).success).toBe(true)
  for (const subject of [{ ...ref, type: 'world.simulation-run' }, { ...ref, id: 'perspective-b' }]) expect(perspectiveAssistantOfferMessageSchema.safeParse({ ...offer, recipient: { ...recipient, subject } }).success).toBe(false)
  expect(perspectiveAssistantOfferMessageSchema.safeParse({ ...offer, admission: null }).success).toBe(false)
})

test('setup and private view requests carry no client-selected execution authority', () => {
  const result = { type: 'leitbild:perspective-assistant-result', requestId: crypto.randomUUID(), admission }
  expect(perspectiveAssistantResultMessageSchema.safeParse(result).success).toBe(true)
  expect(perspectiveAssistantResultMessageSchema.safeParse({ ...result, problem: { code: 'failed', message: 'Failed' } }).success).toBe(false)
  const view = { recipient, agentsDocumentId: crypto.randomUUID() }
  expect(perspectiveViewRequestSchema.safeParse(view).success).toBe(true)
  for (const extra of [{ perspectiveOrigin: { kind: 'owner', moduleId: 'host' } }, { room: binding.room }, { roleIds: ['controller'] }]) expect(perspectiveViewRequestSchema.safeParse({ ...view, ...extra }).success).toBe(false)
})
