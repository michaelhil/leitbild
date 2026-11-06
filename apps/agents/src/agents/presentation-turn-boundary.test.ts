import { expect, test } from 'bun:test'
import { createAIAgent } from './ai-agent.ts'
import { attachMessagePresentation } from '../core/message-presentation.ts'
import { newWorkspaceId, workspaceResourceReferenceSchema, type PresentationRecipient } from '@leitbild/contracts'
import type { Message } from '../core/types/messaging.ts'
import type { LLMProvider } from '../core/types/llm.ts'

test('queued human turns keep their own exact recipient; completion and scheduled turns have no inherited address', async () => {
  const subject = workspaceResourceReferenceSchema.parse({ workspaceId: newWorkspaceId(), moduleId: 'world', type: 'world.simulation-run', id: 'run' })
  const original = { subject, clientId: 'client', documentId: 'first', leaseId: 'first', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const next = { ...original, documentId: 'second', leaseId: 'second' }
  let first = true
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const seen: Array<PresentationRecipient | undefined> = []
  const provider: LLMProvider = {
    models: async () => ['fixture'],
    modelInfo: async model => ({ id: model, provider: 'fixture', contextMax: 128000, source: 'unavailable' }),
    chat: async () => { seen.push(agent.getPresentationRecipient!('room')); if (first) { first = false; entered.resolve(); await release.promise }; return { content: 'Done', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } } },
  }
  const agent = createAIAgent({ name: 'Helper', model: 'fixture', persona: 'Help' }, provider, () => {})
  const message = (id: string, recipient: PresentationRecipient): Message => {
    const value: Message = { id, roomId: 'room', senderId: 'human', content: id, type: 'chat', timestamp: 1 }
    attachMessagePresentation(value, recipient); return value
  }
  agent.receive(message('first', original))
  await entered.promise
  agent.receive(message('second', next))
  expect(agent.getPresentationRecipient!('room')).toEqual(original)
  release.resolve(); await agent.whenIdle()
  expect(seen).toEqual([original, next])
  expect(agent.getPresentationRecipient!('room')).toBeUndefined()
  await agent.fireTriggerExecute!('Scheduled analysis', 'room')
  expect(seen.at(-1)).toBeUndefined()
})


test('cancelled preparation cannot adopt the recipient of a newer admitted turn', async () => {
  const subject = workspaceResourceReferenceSchema.parse({ workspaceId: newWorkspaceId(), moduleId: 'world', type: 'world.simulation-run', id: 'run' })
  const original = { subject, clientId: 'client', documentId: 'first', leaseId: 'first', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const next = { ...original, documentId: 'second', leaseId: 'second' }
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), nextEntered = Promise.withResolvers<void>(), nextRelease = Promise.withResolvers<void>()
  const seen: Array<PresentationRecipient | undefined> = []
  const provider: LLMProvider = {
    models: async () => ['old', 'new'],
    modelInfo: async model => { if (model === 'old') { entered.resolve(); await release.promise }; return { id: model, provider: 'fixture', contextMax: 128000, source: 'unavailable' } },
    chat: async () => { seen.push(agent.getPresentationRecipient!('room')); nextEntered.resolve(); await nextRelease.promise; return { content: 'Done', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } } },
  }
  const agent = createAIAgent({ name: 'Helper', model: 'old', persona: 'Help' }, provider, () => {})
  const deliver = (id: string, recipient: PresentationRecipient) => {
    const message: Message = { id, roomId: 'room', senderId: 'human', content: id, type: 'chat', timestamp: 1 }
    attachMessagePresentation(message, recipient); agent.receive(message)
  }
  deliver('old', original); await entered.promise
  agent.cancelGeneration!(); agent.updateModel('new'); deliver('new', next)
  await nextEntered.promise; release.resolve(); await Bun.sleep(0)
  expect(seen).toEqual([next])
  expect(agent.getPresentationRecipient!('room')).toEqual(next)
  expect(agent.getPresentationRecipient!('room', 'old-execution')).toBeUndefined()
  nextRelease.resolve(); await agent.whenIdle()
})
