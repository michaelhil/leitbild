import { expect, test } from 'bun:test'
import { presentationRequestSchema, presentationRecipientSchema } from './presentation.ts'
import { moduleCapabilityDescriptorSchema } from './resources.ts'

const subject = { workspaceId: '00000000-0000-4000-8000-000000000001', moduleId: 'world', type: 'world.simulation-run', id: 'run-a' }
const recipient = { subject, clientId: 'browser-a', documentId: 'document-a', leaseId: 'lease-a', expiresAt: '2026-11-02T10:01:00Z' }
const request = { id: 'request-a', recipient, source: { moduleId: 'world', kind: 'guide', id: 'attempt-a', label: 'Orientation' }, target: { subject, type: 'world.object', id: 'unit-a' }, action: { kind: 'focus' }, purpose: 'Locate the unit', mode: 'guide', createdAt: '2026-11-02T10:00:00Z', expiresAt: '2026-11-02T10:00:30Z' }

test('presentation addresses bind exact owner Resource/document and permit no selector or hidden script', () => {
  expect(presentationRequestSchema.parse(request).target.type).toBe('world.object')
  expect(presentationRequestSchema.safeParse({ ...request, target: { ...request.target, subject: { ...subject, id: 'another-run' } } }).success).toBe(false)
  expect(presentationRequestSchema.safeParse({ ...request, target: { ...request.target, type: 'agents.composer' } }).success).toBe(false)
  expect(presentationRequestSchema.safeParse({ ...request, target: { ...request.target, selector: '#button' } }).success).toBe(false)
  expect(presentationRequestSchema.safeParse({ ...request, expiresAt: request.createdAt }).success).toBe(false)
  expect(presentationRecipientSchema.safeParse({ ...recipient, actor: 'person' }).success).toBe(false)
})

test('presentation publication names only a Resource command, distinct from read/context publication', () => {
  const descriptor = { id: 'world.simulation-run.presentation.request', moduleId: 'world', kind: 'command', scope: { kind: 'resource', resourceType: 'world.simulation-run' }, title: 'Offer focus', description: 'Offer one focus to the initiating browser', risk: 'write', idempotent: false, inputSchema: {}, outputSchema: {}, publishes: ['presentation'] }
  expect(moduleCapabilityDescriptorSchema.safeParse(descriptor).success).toBe(true)
  expect(moduleCapabilityDescriptorSchema.safeParse({ ...descriptor, kind: 'query' }).success).toBe(false)
  expect(moduleCapabilityDescriptorSchema.safeParse({ ...descriptor, scope: { kind: 'workspace' } }).success).toBe(false)
})
