import { describe, expect, test } from 'bun:test'
import { buildToolSupport } from './spawn.ts'
import { createAIAgent } from './ai-agent.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import type { ChatRequest, LLMProvider } from '../core/types/llm.ts'

describe('tool-internal model settings', () => {
  test('live settings and seed survive edits and rebuilding support; authored prompts are unchanged', async () => {
    const requests: ChatRequest[] = []
    const provider: LLMProvider = {
      models: async () => ['fixture'],
      chat: async request => { requests.push(request); return { content: 'result', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } } },
      stream: async function* (request) { requests.push(request); yield { delta: 'stream result', done: true } },
    }
    const agent = createAIAgent({ name: 'Helper', model: 'fixture', persona: 'Outer persona must not be injected', seed: 17, reasoningEffort: 'high', thinking: true }, provider, () => {})
    const registry = createToolRegistry()
    registry.register({ name: 'subcall', description: 'Test nested calls', parameters: {}, execute: async (_params, context) => {
      const options = { systemPrompt: 'Only tool instructions', messages: [{ role: 'user' as const, content: 'Only tool input' }], temperature: 0.2 }
      await context.llm!(options)
      for await (const _chunk of context.llmStream!(options)) { /* consume fixture */ }
      return { success: true }
    } })
    const ref = { id: agent.id, name: agent.name, currentLLMSettings: agent.getConfig }
    const support = await buildToolSupport(['subcall'], registry, ref, provider)
    await support.toolExecutor!([{ tool: 'subcall', arguments: {} }], 'room')
    agent.updateReasoningEffort('low')
    agent.updateThinking!(false)
    agent.updateModel('changed')
    await support.toolExecutor!([{ tool: 'subcall', arguments: {} }], 'room')
    const refreshed = await buildToolSupport(['subcall'], registry, ref, provider)
    await refreshed.toolExecutor!([{ tool: 'subcall', arguments: {} }], 'room')
    expect(requests).toHaveLength(6)
    for (const request of requests) {
      expect(request.seed).toBe(17)
      expect(request.temperature).toBe(0.2)
      expect(request.messages).toEqual([{ role: 'system', content: 'Only tool instructions' }, { role: 'user', content: 'Only tool input' }])
    }
    expect(requests.slice(0, 2).map(request => [request.model, request.reasoningEffort, request.think])).toEqual([['fixture', 'high', true], ['fixture', 'high', true]])
    expect(requests.slice(2).every(request => request.model === 'changed' && request.reasoningEffort === 'low' && request.think === false)).toBe(true)
  })
})
