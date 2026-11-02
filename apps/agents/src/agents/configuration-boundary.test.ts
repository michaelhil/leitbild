import { expect, test } from 'bun:test'
import { createAIAgent } from './ai-agent.ts'
import type { ChatRequest, LLMProvider } from '../core/types/llm.ts'

test('configuration freezes on turn preparation; queued turns and reused helpers receive later desired edits', async () => {
  const requests: ChatRequest[] = []
  let releasePreparation!: () => void, startedPreparation!: () => void
  const preparationStarted = new Promise<void>(resolve => { startedPreparation = resolve })
  const preparationGate = new Promise<void>(resolve => { releasePreparation = resolve })
  let first = true
  const provider: LLMProvider = {
    models: async () => ['original', 'changed'],
    modelInfo: async model => {
      if (first) { first = false; startedPreparation(); await preparationGate }
      return { id: model, provider: 'fixture', contextMax: 128000, source: 'unavailable' }
    },
    chat: async request => { requests.push(structuredClone(request)); return { content: 'Done.', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } } },
  }
  let skillBody = 'Original skill'
  const agent = createAIAgent({ name: 'Helper', model: 'original', persona: 'Original persona', skills: ['original-skill'], reasoningEffort: 'low' }, provider, () => {}, { getSkills: () => skillBody })
  agent.receive({ id: 'first', roomId: 'room', senderId: 'human', content: 'First', type: 'chat', timestamp: 1 })
  await preparationStarted
  agent.updatePersona('Changed persona')
  agent.updateModel('changed')
  agent.updateReasoningEffort('high')
  agent.updateSkills(['changed-skill'])
  skillBody = 'Changed skill'
  expect(agent.getConfig()).toMatchObject({ model: 'changed', persona: 'Changed persona', skills: ['changed-skill'] })
  expect(agent.getEffectiveConfig!()).toMatchObject({ model: 'original', persona: 'Original persona', skills: ['original-skill'] })
  agent.receive({ id: 'queued', roomId: 'room', senderId: 'human', content: 'Queued', type: 'chat', timestamp: 2 })
  releasePreparation()
  await agent.whenIdle()
  expect(requests.map(request => request.model)).toEqual(['original', 'changed'])
  expect(requests.map(request => request.reasoningEffort)).toEqual(['low', 'high'])
  expect(JSON.stringify(requests[0])).toContain('Original persona')
  expect(JSON.stringify(requests[0])).toContain('Original skill')
  expect(JSON.stringify(requests[0])).not.toContain('Changed skill')
  expect(JSON.stringify(requests[1])).toContain('Changed persona')
  expect(JSON.stringify(requests[1])).toContain('Changed skill')
  expect(agent.getEffectiveConfig!()).toBeUndefined()
})

test('refreshing desired tool support during a turn cannot replace its admitted executor', async () => {
  let release!: () => void, started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let requests = 0, oldCalls = 0, replacementCalls = 0
  const provider: LLMProvider = {
    models: async () => ['fixture'],
    chat: async () => ++requests === 1 ? { content: '', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 }, toolCalls: [{ function: { name: 'work', arguments: {} } }] } : { content: 'Done.', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } },
  }
  const agent = createAIAgent({ name: 'Helper', model: 'fixture', persona: 'Help', tools: ['work'] }, provider, () => {}, {
    toolDefinitions: [{ type: 'function', function: { name: 'work', description: 'Work', parameters: {} } }],
    toolExecutor: async () => { oldCalls++; started(); await gate; return [{ success: true }] },
  })
  agent.receive({ id: 'first', roomId: 'room', senderId: 'human', content: 'Work', type: 'chat', timestamp: 1 })
  await entered
  agent.updateTools!([])
  agent.refreshTools!({ toolExecutor: async () => { replacementCalls++; return [{ success: true }] } })
  release()
  await agent.whenIdle()
  expect(oldCalls).toBe(1)
  expect(replacementCalls).toBe(0)
})

test('cancelled preparation cannot borrow a newer active turn configuration or clear its snapshot', async () => {
  const firstEntered = Promise.withResolvers<void>(), firstRelease = Promise.withResolvers<void>(), secondEntered = Promise.withResolvers<void>(), secondRelease = Promise.withResolvers<void>()
  const requests: ChatRequest[] = []
  const provider: LLMProvider = {
    models: async () => ['old', 'new'],
    modelInfo: async model => {
      if (model === 'old') { firstEntered.resolve(); await firstRelease.promise }
      return { id: model, provider: 'fixture', contextMax: 128000, source: 'unavailable' }
    },
    chat: async request => { requests.push(request); secondEntered.resolve(); await secondRelease.promise; return { content: 'Done', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } } },
  }
  const agent = createAIAgent({ name: 'Helper', model: 'old', persona: 'Old' }, provider, () => {})
  agent.receive({ id: 'first', roomId: 'room', senderId: 'human', content: 'First', type: 'chat', timestamp: 1 })
  await firstEntered.promise
  agent.cancelGeneration!(); agent.updateModel('new'); agent.updatePersona('New')
  agent.receive({ id: 'second', roomId: 'room', senderId: 'human', content: 'Second', type: 'chat', timestamp: 2 })
  await secondEntered.promise
  firstRelease.resolve()
  await Bun.sleep(0) // Let the old preparation's epoch guard and finally run.
  expect(agent.getEffectiveConfig!()).toMatchObject({ model: 'new', persona: 'New' })
  expect(requests.map(request => request.model)).toEqual(['new'])
  secondRelease.resolve(); await agent.whenIdle()
})
