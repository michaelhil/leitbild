import { expect, test } from 'bun:test'
import { moduleIdSchema, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createPresentationDelivery, presentationDeliveryMs, presentationLeaseMs, presentationMaxPending } from '../src/core/guides/presentation.ts'

const subject = workspaceResourceReferenceSchema.parse({ workspaceId: '00000000-0000-4000-8000-000000000001', moduleId: 'world', type: 'world.simulation-run', id: 'run-test' })
const source = { moduleId: moduleIdSchema.parse('world'), kind: 'agent' as const, id: 'analyst', label: 'Analyst' }

test('delivery is per-document, rechecks revoked access, retains actual terminal result and never means physical success', () => {
  let time = Date.parse('2026-11-02T10:00:00Z'), allowed = true
  const delivery = createPresentationDelivery(() => time)
  const receiver = delivery.register({ subject, clientId: 'screen-a', documentId: 'doc-a' })
  const target = { subject, type: 'world.object', id: 'unit-a' }
  const input = { id: 'request-a', recipient: receiver, source, target, action: { kind: 'focus' as const }, purpose: 'Show the difference', mode: 'suggest' as const, allowed: () => allowed }
  delivery.request(input)
  expect(delivery.request(input).id).toBe('request-a')
  expect(delivery.pending(receiver)).toHaveLength(1)
  allowed = false
  expect(delivery.pending(receiver)).toHaveLength(0)
  expect(delivery.result(receiver, 'request-a').status).toBe('unavailable')
  const receipt = delivery.receipt(receiver, { requestId: 'request-a', documentId: 'doc-a', status: 'applied', at: new Date(time).toISOString() })
  expect(receipt.status).toBe('unavailable')
  expect(() => delivery.receipt(receiver, { ...receipt, documentId: 'another-document' })).toThrow('current browser request')
  const replacement = delivery.register({ subject, clientId: 'screen-a', documentId: 'doc-b' })
  expect(() => delivery.pending(receiver)).toThrow('no longer current')
  expect(delivery.pending(replacement)).toEqual([])
  time += presentationLeaseMs + 1
  expect(() => delivery.pending(replacement)).toThrow('no longer current')
})

test('a live renewed receiver works for a long admitted turn; guide takeover cannot advance the old document', () => {
  let time = Date.parse('2026-11-02T10:00:00Z')
  const delivery = createPresentationDelivery(() => time)
  const a = delivery.register({ subject, clientId: 'screen-a', documentId: 'doc-a' })
  const b = delivery.register({ subject, clientId: 'screen-b', documentId: 'doc-b' })
  delivery.claimGuide('attempt', a, false)
  expect(() => delivery.claimGuide('attempt', b, false)).toThrow('another document')
  delivery.claimGuide('attempt', b, true)
  expect(() => delivery.assertGuide('attempt', a)).toThrow('current guide lease')
  time += presentationLeaseMs - 1
  delivery.renew(a)
  time += 10
  // The trusted server lease is current; a model turn's original offer timestamp does not revoke a renewed document.
  expect(delivery.current(a).documentId).toBe('doc-a')
  delivery.request({ id: 'late', recipient: a, source, target: { subject, type: 'world.control', id: 'view' }, action: { kind: 'reveal' }, purpose: 'Show view controls', mode: 'suggest', allowed: () => true })
  time += presentationDeliveryMs + 1
  expect(delivery.result(a, 'late').status).toBe('expired')
})

test('cancel clears only its own cue, preserves the actual original outcome and is idempotent and bounded', () => {
  const delivery = createPresentationDelivery()
  const recipient = delivery.register({ subject, clientId: 'screen', documentId: 'doc' })
  const request = (id: string) => delivery.request({ id, recipient, source, target: { subject, type: 'world.control', id: 'view' }, action: { kind: 'highlight' }, purpose: 'Locate the view control', mode: 'suggest', allowed: () => true })
  request('original')
  delivery.receipt(recipient, { requestId: 'original', documentId: 'doc', status: 'applied', at: new Date().toISOString() })
  expect(() => delivery.cancel(recipient, 'original', 'another-agent')).toThrow('not available')
  const cancellation = delivery.cancel(recipient, 'original', source.id)
  expect(delivery.result(recipient, 'original').status).toBe('applied')
  expect(delivery.cancel(recipient, 'original', source.id)).toEqual(cancellation)
  expect(delivery.pending(recipient)[0]?.action).toEqual({ kind: 'clear', requestId: 'original' })
  expect(() => delivery.cancel(recipient, cancellation.clearRequestId, source.id)).toThrow('another cleanup')
  for (let n = 1; n < presentationMaxPending; n++) request(`pending-${n}`)
  expect(delivery.pending(recipient)).toHaveLength(presentationMaxPending)
  // Cancelling a pending action replaces it with one cleanup, rather than growing the pending queue.
  delivery.cancel(recipient, 'pending-1', source.id)
  expect(delivery.pending(recipient)).toHaveLength(presentationMaxPending)
  expect(() => request('overflow')).toThrow('pending attention')
})
