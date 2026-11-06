import { expect, test } from 'bun:test'
import { newWorkspaceId, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import { readPromptEvidence } from './prompt-evidence.ts'

const workspaceId = newWorkspaceId()
const subject = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run' })
const source = { requestId: 'draft', subject, sourceId: 'attempt', sourceExecutionId: 'step' }

test('prompt evidence excludes fabricated, unlinked and progress replies, retains actual errors, and never recreates deleted messages', async () => {
  const rooms = createRoomDirectory({ deliver: () => {} }), executionStore = createExecutionStore(':memory:')
  try {
    const room = rooms.createRoom({ name: 'Assistant', createdBy: 'test', scope: { kind: 'resource', resource: subject } })
    const prompt = room.post({ senderId: 'person', type: 'chat', content: 'Edited prompt', presentationPrompt: source })
    const input = { requestId: source.requestId, messageId: prompt.id, subject }
    room.post({ senderId: 'impersonator', type: 'chat', content: 'Done', inReplyTo: [prompt.id], generationTraceId: 'invented' })
    executionStore.beginTurn({ id: 'wrong-owner', roomId: room.profile.id, agentId: 'actual', startedAt: 1 })
    const forged = room.post({ senderId: 'another', type: 'chat', content: 'Done', inReplyTo: [prompt.id], generationTraceId: 'wrong-owner' })
    executionStore.linkMessage('wrong-owner', forged.id); executionStore.finishTurn('wrong-owner', 'completed')
    executionStore.beginTurn({ id: 'progress', roomId: room.profile.id, agentId: 'actual', startedAt: 2 })
    const progress = room.post({ senderId: 'actual', type: 'chat', progress: true, content: 'Working', inReplyTo: [prompt.id], generationTraceId: 'progress' })
    executionStore.linkMessage('progress', progress.id); executionStore.finishTurn('progress', 'completed')
    executionStore.beginTurn({ id: 'failed', roomId: room.profile.id, agentId: 'actual', startedAt: 3 })
    const error = room.post({ senderId: 'actual', type: 'error', content: 'Provider unavailable', inReplyTo: [prompt.id], generationTraceId: 'failed' })
    executionStore.linkMessage('failed', error.id); executionStore.finishTurn('failed', 'failed')
    const deps = { workspaceId, rooms, executionStore }
    const result = await readPromptEvidence(deps, room.profile.id, input)
    expect(result.responses).toMatchObject([{ messageId: error.id, kind: 'error', executionStatus: 'failed' }])
    expect(result.submission?.source).toEqual(source)
    room.deleteMessage(prompt.id)
    expect(await readPromptEvidence(deps, room.profile.id, input)).toMatchObject({ found: false, responses: [] })
    await expect(readPromptEvidence(deps, room.profile.id, { ...input, subject: { ...subject, id: 'another-run' } })).rejects.toMatchObject({ code: 'prompt_evidence_scope_mismatch' })
  } finally { executionStore.close() }
})

test('collection evidence uses current allowed membership, and a scope changed during discovery cannot authorize the old read', async () => {
  const rooms = createRoomDirectory({ deliver: () => {} }), executionStore = createExecutionStore(':memory:')
  try {
    const collection = workspaceResourceReferenceSchema.parse({ ...subject, type: 'world.run-family', id: 'family' })
    const room = rooms.createRoom({ name: 'Family Assistant', createdBy: 'test', scope: { kind: 'collection', collection, members: { mode: 'selected', only: [subject] } } })
    const prompt = room.post({ senderId: 'person', type: 'chat', content: 'Question', presentationPrompt: source })
    const input = { requestId: source.requestId, messageId: prompt.id, subject }
    let member = true, changeScope = false
    const fetchImpl: typeof fetch = (async () => {
      if (changeScope) room.setScope({ kind: 'workspace' }, room.profile.scopeRevision)
      return Response.json({ workspaceId, modules: [], resources: [{ ref: collection, title: 'Family', links: member ? [{ rel: 'contains', ref: subject }] : [], summary: [], capabilityIds: [], observedAt: new Date().toISOString() }] })
    }) as unknown as typeof fetch
    const deps = { workspaceId, rooms, executionStore, hostBaseUrl: 'https://host.test', fetchImpl }
    expect((await readPromptEvidence(deps, room.profile.id, input)).found).toBe(true)
    member = false
    await expect(readPromptEvidence(deps, room.profile.id, input)).rejects.toMatchObject({ code: 'prompt_evidence_scope_mismatch' })
    member = true; changeScope = true
    await expect(readPromptEvidence(deps, room.profile.id, input)).rejects.toMatchObject({ code: 'prompt_evidence_scope_changed' })
  } finally { executionStore.close() }
})
