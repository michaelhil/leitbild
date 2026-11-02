import { expect, test } from 'bun:test'
import { newWorkspaceId, presentationRecipientSchema, presentationRequestSchema, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createPresentationBridge } from '../src/ui/presentation-bridge.ts'

const workspaceId = newWorkspaceId()
const subject = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-a' })
const roomA = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'agents', type: 'agents.room', id: 'room-a' })
const roomB = { ...roomA, id: 'room-b' }
const recipient = presentationRecipientSchema.parse({ subject, clientId: 'client-a', documentId: 'document-a', leaseId: 'lease-a', expiresAt: new Date(Date.now() + 60_000).toISOString() })
const draft = (id = 'draft-a', source: object = { moduleId: 'world', kind: 'guide', id: 'attempt-a', label: 'Guide' }) => presentationRequestSchema.parse({
  id, recipient, source, target: { subject, type: 'world.composer', id: 'assistant' }, action: { kind: 'draft', text: 'sitrep unit 1' }, purpose: 'Read the actual response', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(), mode: 'guide',
})
const settle = async () => { for (let n = 0; n < 5; n++) await Promise.resolve() }
const harness = () => {
  const state = { subject: subject as typeof subject | null, room: roomA as typeof roomA | null, world: [] as any[], agents: [] as any[], errors: [] as string[], opens: 0, timers: [] as Array<() => void>, hold: null as (() => void) | null, held: false }
  const bridge = createPresentationBridge({
    subject: () => state.subject, room: () => state.room,
    openAssistant: async () => { state.opens++; if (state.held) await new Promise<void>(resolve => { state.hold = resolve }); return roomA },
    postToWorld: value => state.world.push(value), postToAgents: value => state.agents.push(value), error: value => state.errors.push(value),
    timer: (_ms, callback) => { state.timers.push(callback); return () => {} },
  })
  bridge.fromWorld({ type: 'leitbild:presentation-offer', recipient })
  return { bridge, state }
}

test('draft waits for the actual exact Room ready and returns only its correlated receipt', async () => {
  const { bridge, state } = harness(), request = draft()
  bridge.fromWorld({ type: 'leitbild:presentation-compose', request })
  await settle()
  expect(state.opens).toBe(1)
  expect(state.agents.filter(value => value.type === 'leitbild:presentation-draft')).toHaveLength(0)
  bridge.fromAgents({ type: 'leitbild:presentation-ready', room: roomB })
  expect(state.agents.filter(value => value.type === 'leitbild:presentation-draft')).toHaveLength(0)
  bridge.fromAgents({ type: 'leitbild:presentation-ready', room: roomA })
  expect(state.agents.at(-1)).toEqual({ type: 'leitbild:presentation-draft', request, room: roomA })
  const receipt = { requestId: request.id, documentId: 'wrong-document', status: 'applied', at: new Date().toISOString() }
  bridge.fromAgents({ type: 'leitbild:presentation-receipt', receipt })
  expect(state.world).toHaveLength(0)
  bridge.fromAgents({ type: 'leitbild:presentation-receipt', receipt: { ...receipt, documentId: recipient.documentId } })
  expect(state.world.at(-1).receipt.status).toBe('applied')
  expect(state.errors).toEqual([])
})

test('a new World document or Run cancels an asynchronous Assistant resolution', async () => {
  const { bridge, state } = harness()
  state.held = true
  bridge.fromWorld({ type: 'leitbild:presentation-compose', request: draft() })
  bridge.worldUnloaded()
  state.hold?.()
  await settle()
  bridge.fromAgents({ type: 'leitbild:presentation-ready', room: roomA })
  expect(state.agents.filter(value => value.type === 'leitbild:presentation-draft')).toHaveLength(0)
  expect(state.agents.at(-1).recipient).toBeNull()
})

test('an ordinary agent cannot draft into a different selected Room or create a new Assistant', async () => {
  const { bridge, state } = harness()
  bridge.fromWorld({ type: 'leitbild:presentation-compose', request: draft('agent-draft', { moduleId: 'agents', kind: 'agent', id: 'agent-1', label: 'Analyst', initiatingRoom: roomB }) })
  await settle()
  expect(state.opens).toBe(0)
  expect(state.world.at(-1).receipt.status).toBe('unavailable')
  expect(state.agents.filter(value => value.type === 'leitbild:presentation-draft')).toHaveLength(0)
})

test('malformed and cross-Run offers never create delivery state', async () => {
  const { bridge, state } = harness()
  bridge.fromWorld({ type: 'leitbild:presentation-offer', recipient: { ...recipient, subject: { ...subject, id: 'another-run' } } })
  bridge.fromWorld({ type: 'leitbild:presentation-compose', request: { ...draft(), action: { kind: 'reveal' } } })
  expect(state.errors).toHaveLength(2)
  expect(state.opens).toBe(0)
})

test('reloaded Agents document cannot acknowledge the old document delivery', async () => {
  const { bridge, state } = harness(), request = draft()
  bridge.fromAgents({ type: 'leitbild:presentation-ready', room: roomA })
  bridge.fromWorld({ type: 'leitbild:presentation-compose', request })
  await settle()
  bridge.agentsUnloaded(); bridge.agentsLoaded()
  const count = state.world.length
  bridge.fromAgents({ type: 'leitbild:presentation-receipt', receipt: { requestId: request.id, documentId: recipient.documentId, status: 'applied', at: new Date().toISOString() } })
  expect(state.world).toHaveLength(count)
  expect(state.world.at(-1).receipt.status).toBe('unavailable')
})

test('evidence is a scoped hint for the exact original Room/request/recipient only', async () => {
  const { bridge, state } = harness(), request = draft()
  bridge.fromAgents({ type: 'leitbild:presentation-ready', room: roomA })
  bridge.fromWorld({ type: 'leitbild:presentation-compose', request })
  await settle()
  const hint = { type: 'leitbild:presentation-evidence', recipient, room: roomA, requestId: request.id, messageId: 'message-1' }
  bridge.fromAgents({ ...hint, room: roomB })
  bridge.fromAgents({ ...hint, requestId: 'unknown' })
  bridge.fromAgents({ ...hint, recipient: { ...recipient, leaseId: 'old-lease' } })
  expect(state.world).toHaveLength(0)
  bridge.fromAgents(hint)
  expect(state.world).toEqual([hint])
})

test('unready composers expire explicitly without claiming insertion', async () => {
  const { bridge, state } = harness()
  bridge.fromWorld({ type: 'leitbild:presentation-compose', request: draft() })
  await settle()
  state.timers[0]?.()
  expect(state.world.at(-1).receipt.status).toBe('expired')
})

test('queued cleanup waits for the actual owned Room receipt and never reports postMessage as delivery', async () => {
  const { bridge, state } = harness(), request = draft()
  bridge.fromAgents({ type: 'leitbild:presentation-ready', room: roomA })
  bridge.fromWorld({ type: 'leitbild:presentation-compose', request })
  await settle()
  bridge.fromWorld({ type: 'leitbild:presentation-clear', recipient, requestId: request.id, clearRequestId: 'clear-1' })
  expect(state.world).toHaveLength(0)
  expect(state.agents.at(-1)).toEqual({ type: 'leitbild:presentation-clear', recipient, room: roomA, requestId: request.id, clearRequestId: 'clear-1' })
  bridge.fromAgents({ type: 'leitbild:presentation-receipt', receipt: { requestId: 'clear-1', documentId: recipient.documentId, status: 'applied', at: new Date().toISOString() } })
  expect(state.world.at(-1).receipt.requestId).toBe('clear-1')
})

test('capacity refuses a new request while every retained delivery is unconfirmed', async () => {
  const { bridge, state } = harness()
  for (let n = 0; n < 65; n++) { bridge.fromWorld({ type: 'leitbild:presentation-compose', request: draft(`capacity-${n}`) }); await settle() }
  expect(state.world.at(-1).receipt).toMatchObject({ requestId: 'capacity-64', status: 'unavailable' })
  bridge.fromAgents({ type: 'leitbild:presentation-ready', room: roomA })
  expect(state.agents.filter(message => message.type === 'leitbild:presentation-draft')).toHaveLength(64)
  expect(state.agents.some(message => message.request?.id === 'capacity-0')).toBe(true)
})

test('Assistant reveal waits for exact current Room ready and never inserts a draft', async () => {
  const { bridge, state } = harness()
  const request = { ...draft('reveal-assistant'), target: { subject, type: 'world.control', id: 'assistant' }, action: { kind: 'reveal' } }
  bridge.fromWorld({ type: 'leitbild:presentation-assistant-open', request })
  await settle()
  expect(state.world).toHaveLength(0)
  bridge.fromAgents({ type: 'leitbild:presentation-ready', room: roomB })
  expect(state.world).toHaveLength(0)
  bridge.fromAgents({ type: 'leitbild:presentation-ready', room: roomA })
  expect(state.world.at(-1).receipt).toMatchObject({ requestId: request.id, documentId: recipient.documentId, status: 'applied' })
  expect(state.agents.filter(message => message.type === 'leitbild:presentation-draft')).toHaveLength(0)
})

test('an expired unresolved Assistant request never delivers on a later readiness event', async () => {
  const { bridge, state } = harness()
  bridge.fromWorld({ type: 'leitbild:presentation-compose', request: draft() })
  await settle()
  state.timers[0]?.()
  bridge.fromAgents({ type: 'leitbild:presentation-ready', room: roomA })
  expect(state.world.at(-1).receipt.status).toBe('expired')
  expect(state.agents.filter(message => message.type === 'leitbild:presentation-draft')).toHaveLength(0)
})

test('clear before a suspended Room resolution cancels its source and prevents later draft delivery', async () => {
  const { bridge, state } = harness(), request = draft('pending-open-clear')
  state.held = true
  bridge.fromWorld({ type: 'leitbild:presentation-compose', request })
  bridge.fromWorld({ type: 'leitbild:presentation-clear', recipient, requestId: request.id, clearRequestId: 'cancel-pending-open' })
  expect(state.world.at(-1).receipt).toMatchObject({ requestId: 'cancel-pending-open', status: 'applied' })
  state.hold?.()
  await settle()
  bridge.fromAgents({ type: 'leitbild:presentation-ready', room: roomA })
  expect(state.agents.filter(message => message.type === 'leitbild:presentation-draft')).toHaveLength(0)
})

test('expiry aborts an unresolved Assistant subscriber before it can select UI', async () => {
  let release: (() => void) | undefined, receivedSignal: AbortSignal | undefined, selected = false
  const world: any[] = [], timers: Array<() => void> = []
  const bridge = createPresentationBridge({ subject: () => subject, room: () => roomA,
    openAssistant: async signal => { receivedSignal = signal; await new Promise<void>(resolve => release = resolve); signal.throwIfAborted(); selected = true; return roomA },
    postToWorld: message => world.push(message), postToAgents: () => {}, error: () => {}, timer: (_ms, callback) => { timers.push(callback); return () => {} },
  })
  bridge.fromWorld({ type: 'leitbild:presentation-offer', recipient })
  bridge.fromWorld({ type: 'leitbild:presentation-compose', request: draft('expired-open') })
  timers[0]?.()
  expect(receivedSignal?.aborted).toBe(true)
  release?.(); await settle()
  expect(selected).toBe(false)
  expect(world.at(-1).receipt.status).toBe('expired')
})
