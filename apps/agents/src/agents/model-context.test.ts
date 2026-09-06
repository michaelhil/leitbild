import { expect, test } from 'bun:test'
import { createAIAgent } from './ai-agent.ts'
import { createRoom } from '../core/rooms/room.ts'
import type { ChatRequest, LLMProvider } from '../core/types/llm.ts'
import type { ModelInfo } from '../core/types/model-info.ts'
import type { Decision } from './evaluation.ts'

const room = () => createRoom({ id: 'room', name: 'Room', createdBy: 'test', createdAt: 1, scope: { kind: 'workspace' }, scopeRevision: 0 })
const metadata: ModelInfo = { id: 'openai/gpt-5.4', provider: 'openrouter', contextMax: 200_000, source: 'openrouter_api' }

test('bare cloud model uses actual metadata; bounded prior replay does not truncate larger current tool evidence', async () => {
  const requests: ChatRequest[] = []
  const decisions: Decision[] = []
  const provider: LLMProvider = {
    models: async () => ['gpt-5.4'], modelInfo: async () => metadata,
    chat: async request => {
      requests.push(structuredClone(request))
      return { content: requests.length === 1 ? '' : 'Done', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 },
        ...(requests.length === 1 ? { toolCalls: [{ id: 'Ab123Cd45', function: { name: 'read', arguments: {} } }] } : {}),
      }
    },
  }
  const retained = 'evidence:'.repeat(35_000)
  const agent = createAIAgent({ name: 'Agent', model: 'gpt-5.4', persona: '', historyLimit: 100, historyTokenBudget: 8_000 }, provider, decision => { decisions.push(decision) }, {
    toolDefinitions: [{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } } }],
    toolExecutor: async () => [{ success: true, data: retained }],
  })
  const conversation = room()
  for (let i = 0; i < 30; i++) conversation.post({ senderId: 'human', type: 'chat', content: `old-${i} ${'x'.repeat(20_000)}` })
  await agent.join(conversation)
  agent.receive(conversation.post({ senderId: 'human', type: 'chat', content: 'Read current evidence' }))
  await agent.whenIdle()
  expect(requests).toHaveLength(2)
  expect(requests[0]!.messages.map(message => message.content).join('').length).toBeLessThan(32_000)
  expect(requests[1]!.messages.find(message => message.role === 'tool')?.content).toBe(retained)
  expect(agent.getContextPreview(conversation.profile.id).modelMax).toBe(200_000)
  expect(decisions[0]?.response.action).toBe('respond')
})

test('cancellation during model metadata loading does not start a stale generation', async () => {
  let resolve!: (info: ModelInfo) => void
  let calls = 0
  const pending = new Promise<ModelInfo>(done => { resolve = done })
  const provider: LLMProvider = { models: async () => [], modelInfo: () => pending, chat: async () => { calls++; return { content: 'Done', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } } } }
  const agent = createAIAgent({ name: 'Agent', model: 'gpt-5.4', persona: '' }, provider, () => {})
  const conversation = room()
  await agent.join(conversation)
  agent.receive(conversation.post({ senderId: 'human', type: 'chat', content: 'Question' }))
  agent.cancelGeneration()
  await agent.whenIdle()
  resolve(metadata)
  await Bun.sleep(0)
  expect(calls).toBe(0)
})
