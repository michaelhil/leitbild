import { expect, test } from 'bun:test'
import { createOpenAICompatibleProvider } from './openai-compatible.ts'
import type { ChatRequest } from '../core/types/llm.ts'
import { createRoom } from '../core/rooms/room.ts'
import type { RoomDirectory } from '../core/rooms/directory.ts'
import { createConversationReadTool } from '../tools/built-in/conversation-read.ts'
import { toolsToDefinitions } from './tool-capability.ts'

const fixture = (script: (request: Request, body: Record<string, unknown>) => Response) => {
  const bodies: Record<string, unknown>[] = []
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = request.method === 'POST' ? await request.json() as Record<string, unknown> : {}
    bodies.push(body)
    return script(request, body)
  } })
  return { url: `http://localhost:${server.port}`, bodies, stop: () => server.stop(true) }
}
const request: ChatRequest = { model: 'qwen/reasoner', messages: [{ role: 'user', content: 'Inspect' }] }
const details = [
  { type: 'reasoning.text', id: 'same', index: 0, text: 'first', signature: 'signed-1', format: 'unknown.future-v2' },
  { type: 'reasoning.encrypted', id: 'same', index: 0, data: 'opaque', extra: { exact: true } },
]
const chunk = (delta: unknown, finish_reason?: string) => JSON.stringify({ model: 'qwen/reasoner', choices: [{ delta, ...(finish_reason ? { finish_reason } : {}) }] })

for (const streaming of [false, true]) test(`${streaming ? 'stream' : 'chat'} keeps history listing optional through real tool schema and HTTP serialization`, async () => {
  const room = createRoom({ id: 'room', name: 'Room', createdBy: 'human', createdAt: 1, scope: { kind: 'workspace' }, scopeRevision: 0 })
  room.addMember('agent')
  const message = room.post({ senderId: 'human', type: 'chat', content: 'An earlier question' })
  const tool = createConversationReadTool({ getRoom: (id: string) => id === room.profile.id ? room : undefined } as RoomDirectory)
  const definitions = toolsToDefinitions([tool])
  const fx = fixture((_request, body) => {
    expect(body.tools).toEqual([{ ...definitions[0], function: { ...definitions[0]!.function, strict: false } }])
    const calls = [{ index: 0, id: 'history01', type: 'function', function: { name: tool.name, arguments: '{}' } }]
    return streaming
      ? new Response([chunk({ tool_calls: calls }, 'tool_calls'), '[DONE]'].map(line => `data: ${line}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
      : Response.json({ choices: [{ message: { content: '', tool_calls: calls }, finish_reason: 'tool_calls' }] })
  })
  try {
    const provider = createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => fx.url, getApiKey: () => 'fixture' })
    const input = { ...request, tools: definitions }
    const response = streaming ? (await Array.fromAsync(provider.stream!(input))).at(-1)! : await provider.chat(input)
    const args = response.toolCalls![0]!.function.arguments
    expect(args).toEqual({})
    expect(await tool.execute(args, { callerId: 'agent', callerName: 'Agent', roomId: room.profile.id })).toMatchObject({ success: true, data: { messages: [{ messageId: message.id }] } })
    expect(definitions[0]!.function).not.toHaveProperty('strict')
  } finally { fx.stop() }
})

for (const streaming of [false, true]) test(`${streaming ? 'stream' : 'chat'} never manufactures a default-argument action from malformed arguments`, async () => {
  let argumentsJSON = '{broken'
  const fx = fixture(() => {
    const tools = [{ index: 0, id: 'call12345', function: { name: 'act', arguments: argumentsJSON } }]
    return streaming
      ? new Response([chunk({ tool_calls: tools }, 'tool_calls'), '[DONE]'].map(line => `data: ${line}\n\n`).join(''))
      : Response.json({ choices: [{ message: { content: '', tool_calls: tools }, finish_reason: 'tool_calls' }] })
  })
  try {
    const provider = createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => fx.url, getApiKey: () => 'fixture' })
    const invoke = () => streaming ? Array.fromAsync(provider.stream!(request)) : provider.chat(request)
    for (const invalid of ['{broken', '[]', 'null', 'false', '']) {
      argumentsJSON = invalid
      await expect(invoke()).rejects.toMatchObject({ kind: 'request_error', code: 'invalid_tool_arguments' })
    }
    argumentsJSON = '{}'
    const result = await invoke()
    expect((Array.isArray(result) ? result.at(-1)! : result).toolCalls?.[0]?.function.arguments).toEqual({})
  } finally { fx.stop() }
})

for (const streaming of [false, true]) test(`${streaming ? 'stream' : 'chat'} preserves ordered continuation and multi-tool IDs on same-route replay`, async () => {
  let pass = 0
  const fx = fixture(() => {
    if (pass++ > 0) return Response.json({ model: 'qwen/reasoner', choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] })
    const tools = [0, 1].map(index => ({ index, id: `native0${index}`, type: 'function', function: { name: 'inspect', arguments: '{"ok":true}' } }))
    if (!streaming) return Response.json({ model: 'qwen/reasoner', choices: [{ message: { content: '', reasoning: 'original', reasoning_details: details, tool_calls: tools }, finish_reason: 'tool_calls' }] })
    return new Response([chunk({ reasoning: 'ori', reasoning_details: [details[0]], tool_calls: tools }), chunk({ reasoning: 'ginal', reasoning_details: [details[1]] }, 'tool_calls'), '[DONE]'].map(line => `data: ${line}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  })
  try {
    const provider = createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => fx.url, getApiKey: () => 'fixture' })
    const response = streaming ? (await Array.fromAsync(provider.stream!(request))).at(-1)! : await provider.chat(request)
    expect(response.continuation).toMatchObject({ provider: 'openrouter', model: 'qwen/reasoner', reasoningDetails: details, reasoning: 'original' })
    expect(response.model).toBe('qwen/reasoner')
    expect(response.toolCalls?.map(call => call.id)).toEqual(['native00', 'native01'])
    await provider.chat({ ...request, messages: [...request.messages, { role: 'assistant', content: '', continuation: response.continuation, toolCalls: response.toolCalls }, ...response.toolCalls!.map(call => ({ role: 'tool' as const, content: 'ok', toolCallId: call.id }))] })
    const messages = fx.bodies[1]!.messages as Record<string, unknown>[]
    expect(messages[1]).toMatchObject({ content: ' ', reasoning: 'original', reasoning_details: details })
    expect(messages.slice(2).map(message => message.tool_call_id)).toEqual(['native00', 'native01'])
  } finally { fx.stop() }
})

for (const streaming of [false, true]) test(`${streaming ? 'stream' : 'chat'} marks length output incomplete without parsing/exposing partial tool arguments`, async () => {
  const tool = { index: 0, id: 'native001', function: { name: 'mutate', arguments: '{broken' } }
  const fx = fixture(() => streaming
    ? new Response([chunk({ content: 'partial', reasoning_details: details, tool_calls: [tool] }, 'length'), '[DONE]'].map(line => `data: ${line}\n\n`).join(''))
    : Response.json({ choices: [{ message: { content: 'partial', reasoning_details: details, tool_calls: [tool] }, finish_reason: 'length' }] }))
  try {
    const provider = createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => fx.url, getApiKey: () => 'fixture' })
    const result = streaming ? (await Array.fromAsync(provider.stream!(request))).at(-1)! : await provider.chat(request)
    expect(result.finishReason).toBe('length')
    expect(result.toolCalls).toBeUndefined()
    expect(result.continuation).toBeUndefined()
  } finally { fx.stop() }
})

test('same /models response supplies alias and capability metadata; endpoint changes clear both before reuse', async () => {
  const fx = fixture(req => new URL(req.url).pathname.endsWith('/models')
    ? Response.json({ data: [{ id: 'openai/gpt-6-astra', context_length: 400_000, top_provider: { max_completion_tokens: 32_000 }, supported_parameters: ['reasoning'], reasoning: { supported_efforts: ['high'], mandatory: true, default_effort: 'high' } }] })
    : Response.json({ model: 'openai/gpt-6-astra', choices: [{ message: { content: 'ok', reasoning_details: details }, finish_reason: 'stop' }] }))
  const second = fixture(() => Response.json({ data: [{ id: 'different', context_length: 1000 }] }))
  let url = fx.url
  try {
    const provider = createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => url, getApiKey: () => 'fixture' })
    await provider.models()
    expect(await provider.modelInfo!('gpt-6-astra')).toEqual({ id: 'openai/gpt-6-astra', provider: 'openrouter', contextMax: 400_000, source: 'openrouter_api', maxOutputTokens: 32_000, supportedParameters: ['reasoning'], reasoning: { supportedEfforts: ['high'], mandatory: true, defaultEffort: 'high' } })
    expect(fx.bodies).toHaveLength(1)
    await expect(provider.chat({ ...request, model: 'gpt-6-astra', reasoningEffort: 'low' })).rejects.toThrow('reasoning_effort_unsupported')
    expect(fx.bodies).toHaveLength(1)
    const response = await provider.chat({ ...request, model: 'gpt-6-astra', reasoningEffort: 'high' })
    expect(fx.bodies[1]).toMatchObject({ model: 'openai/gpt-6-astra', reasoning: { effort: 'high' } })
    url = second.url
    expect(await provider.modelInfo!('gpt-6-astra')).toMatchObject({ id: 'gpt-6-astra', contextMax: 0, source: 'openrouter_api_unknown_model' })
    await expect(provider.chat({ model: 'openai/gpt-6-astra', messages: [{ role: 'assistant', content: '', continuation: response.continuation }] })).rejects.toThrow('provider_continuation_endpoint_changed')
    expect(second.bodies).toHaveLength(1) // catalog only; sensitive replay was never dispatched
  } finally { fx.stop(); second.stop() }
})

test('catalog failure is unknown and retried, not a model availability gate', async () => {
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  let calls = 0
  const fx = fixture(() => ++calls === 1 ? new Response('temporary', { status: 503 }) : Response.json({ data: [{ id: 'qwen/reasoner', context_length: 200_000 }] }))
  try {
    const provider = createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => fx.url, getApiKey: () => 'fixture' })
    expect(await provider.modelInfo!(request.model)).toMatchObject({ contextMax: 0, source: 'openrouter_api_unavailable' })
    expect(await provider.modelInfo!(request.model)).toMatchObject({ contextMax: 0, source: 'openrouter_api_unavailable' })
    expect(calls).toBe(1)
    now += 30_001
    expect(await provider.modelInfo!(request.model)).toMatchObject({ contextMax: 200_000, source: 'openrouter_api' })
    expect(calls).toBe(2)
  } finally { fx.stop(); Date.now = originalNow }
})

test('reported resolved model pins continuation instead of an auto-routing request alias', async () => {
  const fx = fixture(() => Response.json({ model: 'qwen/reasoner', choices: [{ message: { content: '', reasoning_details: details }, finish_reason: 'stop' }] }))
  try {
    const provider = createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => fx.url, getApiKey: () => 'fixture' })
    const response = await provider.chat({ ...request, model: 'openrouter/auto' })
    expect(response.continuation?.model).toBe('qwen/reasoner')
  } finally { fx.stop() }
})

test('nullable non-reasoning responses and invalid optional metadata do not block availability', async () => {
  const fx = fixture(req => new URL(req.url).pathname.endsWith('/models')
    ? Response.json({ data: [{ id: 'qwen/reasoner', context_length: -2, supported_parameters: 4, reasoning: { supported_efforts: 'wrong' } }] })
    : Response.json({ choices: [{ message: { content: 'ordinary', reasoning: null, reasoning_content: null, reasoning_details: null }, finish_reason: 'stop' }] }))
  try {
    const provider = createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => fx.url, getApiKey: () => 'fixture' })
    expect(await provider.models()).toEqual(['qwen/reasoner'])
    expect(await provider.modelInfo!('qwen/reasoner')).toMatchObject({ contextMax: 0 })
    expect((await provider.chat(request)).continuation).toBeUndefined()
  } finally { fx.stop() }
})

test('unknown model metadata is retried instead of permanently negative cached', async () => {
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  let count = 0
  const fx = fixture(() => Response.json({ data: ++count > 1 ? [{ id: 'qwen/new', context_length: 100_000 }] : [] }))
  try {
    const provider = createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => fx.url, getApiKey: () => 'fixture' })
    const initial = await Promise.all(['qwen/new', 'qwen/absent', 'openai/absent'].map(model => provider.modelInfo!(model)))
    expect(initial.every(info => info.contextMax === 0)).toBe(true)
    expect(await provider.modelInfo!('qwen/new')).toMatchObject({ contextMax: 0 })
    expect(count).toBe(1)
    now += 300_001
    expect(await provider.modelInfo!('qwen/new')).toMatchObject({ contextMax: 100_000 })
  } finally { fx.stop(); Date.now = originalNow }
})
