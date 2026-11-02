import { expect, test, spyOn } from 'bun:test'
import { newWorkspaceId, presentationRequestSchema, presentationRecipientSchema, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createPresentationBridge } from '../src/ui/presentation-bridge.ts'

const harness = () => {
  const workspaceId = newWorkspaceId()
  const subject = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run' })
  const room = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'agents', type: 'agents.room', id: 'room' })
  const recipient = presentationRecipientSchema.parse({ subject, clientId: 'client', documentId: 'document', leaseId: 'lease', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  const world: any[] = [], agents: any[] = []
  const bridge = createPresentationBridge({ subject: () => subject, room: () => room, openAssistant: async () => room, postToWorld: value => world.push(value), postToAgents: value => agents.push(value), error: message => { throw new Error(message) }, timer: () => () => {} })
  const request = (id: string, reveal = false) => presentationRequestSchema.parse({ id, recipient,
    source: reveal ? { moduleId: 'world', kind: 'agent', id: 'analyst', label: 'Analyst', initiatingRoom: room } : { moduleId: 'world', kind: 'guide', id: 'attempt', label: 'Guide', executionId: 'step' },
    target: { subject, type: reveal ? 'world.control' : 'world.composer', id: 'assistant' }, action: reveal ? { kind: 'reveal' } : { kind: 'draft', text: 'sitrep unit 1' }, purpose: 'Inspect actual evidence', mode: reveal ? 'suggest' : 'guide', createdAt: new Date(Date.now()).toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(),
  })
  const submit = async (id: string, status: 'applied' | 'declined' = 'applied', reveal = false) => {
    bridge.fromWorld({ type: reveal ? 'leitbild:presentation-assistant-open' : 'leitbild:presentation-compose', request: request(id, reveal) })
    for (let n = 0; n < 8; n++) await Promise.resolve()
    if (!reveal) bridge.fromAgents({ type: 'leitbild:presentation-receipt', receipt: { requestId: id, documentId: recipient.documentId, status, at: new Date().toISOString() } })
  }
  const hint = (id: string) => bridge.fromAgents({ type: 'leitbild:presentation-evidence', recipient, room, requestId: id, messageId: `actual-message-${id}` })
  bridge.fromWorld({ type: 'leitbild:presentation-offer', recipient })
  return { bridge, room, world, agents, submit, hint, request }
}

test('applied draft causality survives later acknowledged attention until its actual human Message arrives', async () => {
  const { bridge, room, submit, hint, world } = harness()
  bridge.fromAgents({ type: 'leitbild:presentation-ready', room })
  await submit('active-draft')
  for (let n = 0; n < 64; n++) await submit(`later-reveal-${n}`, 'applied', true)
  hint('active-draft')
  expect(world.filter(value => value.type === 'leitbild:presentation-evidence')).toMatchObject([{ requestId: 'active-draft', messageId: 'actual-message-active-draft' }])
})

test('all protected applied drafts cause an explicit capacity refusal without sacrificing oldest causality', async () => {
  const { bridge, room, submit, hint, world, agents } = harness()
  bridge.fromAgents({ type: 'leitbild:presentation-ready', room })
  for (let n = 0; n < 64; n++) await submit(`draft-${n}`)
  await submit('new-draft')
  expect(world.find(value => value.receipt?.requestId === 'new-draft')?.receipt.status).toBe('unavailable')
  expect(agents.some(value => value.type === 'leitbild:presentation-draft' && value.request.id === 'new-draft')).toBe(false)
  hint('draft-0')
  expect(world.at(-1).requestId).toBe('draft-0')
})

test('declined and expired uninserted drafts may retire; they do not consume protected causality capacity', async () => {
  const { bridge, room, submit, hint, world } = harness()
  bridge.fromAgents({ type: 'leitbild:presentation-ready', room })
  await submit('declined', 'declined')
  for (let n = 0; n < 63; n++) await submit(`applied-${n}`)
  await submit('replacement')
  expect(world.some(value => value.receipt?.requestId === 'replacement' && value.receipt.status === 'unavailable')).toBe(false)
  hint('applied-0')
  expect(world.at(-1).requestId).toBe('applied-0')

  const expired = harness(), before = Date.now()
  for (let n = 0; n < 64; n++) {
    expired.bridge.fromWorld({ type: 'leitbild:presentation-compose', request: expired.request(`expired-${n}`) })
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  const clock = spyOn(Date, 'now').mockReturnValue(before + 31_000)
  try {
    expired.bridge.fromAgents({ type: 'leitbild:presentation-ready', room: expired.room })
    expect(expired.world.filter(value => value.receipt?.status === 'expired')).toHaveLength(64)
    await expired.submit('fresh-after-expiry')
    expect(expired.world.some(value => value.receipt?.requestId === 'fresh-after-expiry' && value.receipt.status === 'unavailable')).toBe(false)
  } finally { clock.mockRestore() }
})
