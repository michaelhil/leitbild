import { expect, test } from 'bun:test'
import { workspaceIdSchema, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { setupPerspectiveAssistant, openPerspectiveView } from '../src/perspective-delivery.ts'

const fixture = () => {
  const workspaceId = workspaceIdSchema.parse(crypto.randomUUID())
  const perspective = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.perspective', id: 'perspective-a' })
  const room = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'agents', type: 'agents.room', id: 'room-a' })
  const now = new Date().toISOString()
  const binding = { perspective, room, admissionGeneration: crypto.randomUUID(), actualAgentId: 'agent-a', runtimeGeneration: crypto.randomUUID(), templateId: 'template-a', templateRevision: 'configuration-a' }
  const pending = { resource: perspective, status: 'pending', revision: 0, admissionGeneration: binding.admissionGeneration, runIncarnation: crypto.randomUUID(), roleSetDigest: 'a'.repeat(64), createdAt: now, updatedAt: now } as const
  const active = { ...pending, status: 'active', revision: 1, binding } as const
  const prepared = { ...binding, status: 'prepared', revision: 0, createdAt: now, updatedAt: now } as const
  const bound = { ...prepared, status: 'bound', revision: 1 } as const
  const recipient = { subject: perspective, clientId: 'client-a', documentId: 'world-document-a', leaseId: 'lease-a', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  return { workspaceId, perspective, room, binding, pending, active, prepared, bound, recipient }
}

test('setup resumes an owner-accepted partial bind without creating another Room', async () => {
  const f = fixture(), calls: string[] = []
  let worldBound = false, agentsBound = false, dropReply = true
  const invoke = async (id: string) => {
    calls.push(id)
    if (id === 'world.perspective.read') return { result: worldBound ? f.active : f.pending }
    if (id === 'agents.perspective-room.prepare') return { result: f.prepared }
    if (id === 'world.perspective.bind') { worldBound = true; if (dropReply) { dropReply = false; throw new Error('Connection lost after World accepted bind') }; return { result: f.active } }
    if (id === 'agents.perspective-room.read') return { result: agentsBound ? f.bound : f.prepared }
    if (id === 'agents.perspective-room.bind') { agentsBound = true; return { result: f.bound } }
    throw new Error(`Unexpected ${id}`)
  }
  const input = { perspective: f.perspective, templateId: f.binding.templateId, templateRevision: f.binding.templateRevision, requestId: crypto.randomUUID() }
  await expect(setupPerspectiveAssistant(f.workspaceId, input, invoke)).rejects.toThrow('Connection lost')
  const result = await setupPerspectiveAssistant(f.workspaceId, input, invoke)
  expect(result.admission.status).toBe('active')
  expect(result.roomAdmission.status).toBe('bound')
  expect(calls.filter(id => id === 'agents.perspective-room.prepare')).toHaveLength(1)
  expect(calls.filter(id => id === 'world.perspective.bind')).toHaveLength(1)
})

test('a revoke during final Room admission cannot return a successful setup', async () => {
  const f = fixture()
  let revoked = false
  const invoke = async (id: string) => {
    if (id === 'world.perspective.read') return { result: revoked ? { ...f.active, status: 'revoked', revision: 2 } : f.active }
    if (id === 'agents.perspective-room.read') return { result: f.prepared }
    if (id === 'agents.perspective-room.bind') { revoked = true; return { result: f.bound } }
    throw new Error(`Unexpected ${id}`)
  }
  await expect(setupPerspectiveAssistant(f.workspaceId, { perspective: f.perspective, templateId: f.binding.templateId, templateRevision: f.binding.templateRevision, requestId: crypto.randomUUID() }, invoke)).rejects.toThrow('Both owners')
})

test('view delivery verifies the actual World lease before and after minting and cannot choose another Room', async () => {
  const f = fixture(), documentId = crypto.randomUUID(), token = crypto.randomUUID()
  const calls: Array<{ id: string; resource: unknown }> = []
  let failAfterMint = true, minted = false
  const invoke = async (id: string, input: { resource?: unknown }) => {
    calls.push({ id, resource: input.resource })
    if (id === 'world.perspective.presentation.verify') {
      if (minted && failAfterMint) throw new Error('World document was revoked')
      return { result: { admission: f.active, binding: f.binding, recipient: f.recipient } }
    }
    if (id === 'agents.perspective-room.read') return { result: f.bound }
    if (id === 'agents.perspective-room.view-open') { minted = true; return { result: { token, room: f.room, perspective: f.perspective, documentId, expiresAt: f.recipient.expiresAt } } }
    throw new Error(`Unexpected ${id}`)
  }
  const input = { recipient: f.recipient, agentsDocumentId: documentId }
  await expect(openPerspectiveView(f.workspaceId, input, invoke)).rejects.toThrow('World document was revoked')
  failAfterMint = false
  const lease = await openPerspectiveView(f.workspaceId, input, invoke)
  expect(lease.token).toBe(token)
  expect(calls.filter(call => call.id === 'agents.perspective-room.view-open').every(call => JSON.stringify(call.resource) === JSON.stringify(f.room))).toBe(true)
  await expect(openPerspectiveView(f.workspaceId, { ...input, room: { ...f.room, id: 'another-room' } }, invoke)).rejects.toThrow()
})
