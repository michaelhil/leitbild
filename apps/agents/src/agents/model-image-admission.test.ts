import { expect, test } from 'bun:test'
import { createAIAgent, type AgentTurnStart } from './ai-agent.ts'
import { createRoom } from '../core/rooms/room.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import { createOpenAICompatibleProvider } from '../llm/openai-compatible.ts'
import { createProviderGateway } from '../llm/provider-gateway.ts'
import { createProviderRouter } from '../llm/router.ts'
import { createLLMService } from '../llm/llm-service.ts'

const model = 'deepseek/deepseek-v4.1-flash-1017'
const image = { kind: 'image' as const, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', mimeType: 'image/png' as const, width: 1, height: 1, source: 'user-upload' as const, capturedAt: 1 }
const protocol = [{ type: 'reasoning.encrypted', id: 'original', data: 'exact-provider-state', format: 'fixture' }]

for (const origin of ['question', 'trigger'] as const) test(`${origin}: provider inventory admits a new image model through Agent, router, native tools, HTTP and Inspector`, async () => {
  const bodies: Record<string, unknown>[] = []
  let inventories = 0
  const server = Bun.serve({ port: 0, fetch: async request => {
    if (new URL(request.url).pathname.endsWith('/models')) {
      inventories++
      return Response.json({ data: [{ id: model, context_length: 100_000, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['reasoning'], reasoning: { supported_efforts: ['low'] } }] })
    }
    bodies.push(await request.json() as Record<string, unknown>)
    const delta = bodies.length === 1
      ? { content: '', reasoning_details: protocol, tool_calls: [{ index: 0, id: 'read-native-1', type: 'function', function: { name: 'read_live', arguments: '{}' } }] }
      : { content: 'The screenshot and current read are available.' }
    return new Response(`data: ${JSON.stringify({ model, choices: [{ delta, finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
  } })
  const adapter = createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => `http://localhost:${server.port}`, getApiKey: () => 'offline-fixture' })
  const gateway = createProviderGateway(adapter)
  const router = createProviderRouter({ openrouter: gateway }, { order: ['openrouter'] })
  const store = createExecutionStore(':memory:')
  const starts: AgentTurnStart[] = []
  const room = createRoom({ id: 'room', name: 'Image evidence', createdBy: 'human', createdAt: 1, scope: { kind: 'workspace' }, scopeRevision: 0 })
  if (origin === 'trigger') room.post({ senderId: 'human', type: 'chat', content: 'Inspect this screenshot.', attachments: [image] })
  const provider = createLLMService({ router }).bound({ source: 'agent', fallbackChain: [] })
  const agent = createAIAgent({ name: 'Agent', model: `openrouter:${model}`, persona: '', reasoningEffort: 'low' }, provider, () => {}, {
    executionStore: store,
    toolDefinitions: [{ type: 'function', function: { name: 'read_live', description: 'Read current evidence', parameters: { type: 'object', properties: {} } } }],
    toolExecutor: async () => [{ success: true, data: { sample: 'fresh owner data' } }],
    onTurnStart: async input => { starts.push(input) },
  })
  try {
    await gateway.refreshModels()
    await agent.join(room)
    if (origin === 'trigger') await agent.fireTriggerExecute!('Inspect the retained screenshot and current state.', room.profile.id)
    else {
      agent.receive(room.post({ senderId: 'human', type: 'chat', content: 'Inspect this screenshot.', attachments: [image] }))
      await agent.whenIdle()
    }
    expect(inventories).toBe(1)
    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      expect(body.model).toBe(model)
      expect(body.reasoning).toEqual({ effort: 'low' })
      const messages = body.messages as Record<string, unknown>[]
      const screenshot = messages.find(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))!
      expect(screenshot.content).toContainEqual({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } })
      expect(JSON.stringify(messages)).not.toContain('cannot view images')
    }
    const second = bodies[1]!.messages as Record<string, unknown>[]
    expect(second.find(message => message.role === 'assistant')).toMatchObject({ reasoning_details: protocol, tool_calls: [{ id: 'read-native-1' }] })
    expect(second.find(message => message.role === 'tool')).toMatchObject({ tool_call_id: 'read-native-1', content: '{"sample":"fresh owner data"}' })
    const turn = starts[0]!.executionTurnId
    const captured = store.getModelCall(room.profile.id, turn, 'model_1')!.request!
    expect(captured.messages.some(message => message.images?.[0]?.dataUrl === image.dataUrl)).toBe(true)
    const continued = store.getModelCall(room.profile.id, turn, 'model_2', true)!.request!
    expect(continued.messages.find(message => message.role === 'assistant')?.continuation?.reasoningDetails).toEqual(protocol)
  } finally { agent.cancelGeneration(); store.close(); router.dispose(); gateway.dispose(); server.stop(true) }
})
