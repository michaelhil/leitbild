import { expect, test } from 'bun:test'
import type { AIAgentConfig } from '../core/types/agent.ts'
import type { ToolDefinition, ToolExecutor } from '../core/types/tool.ts'
import { createOpenAICompatibleProvider } from '../llm/openai-compatible.ts'
import type { ContextResult } from './context-builder.ts'
import { evaluate } from './evaluation.ts'

// These tests keep the real HTTP/SSE adapter, evaluator and ToolExecutor
// boundary. Only transport bytes and the mutation target are test fixtures.
// No server, socket, provider account or World Module is involved.
const model = 'fixture/mutator'
const tool: ToolDefinition = { type: 'function', function: { name: 'mutate_unit', description: 'Operate the test unit',
  parameters: { type: 'object', properties: { unit: { type: 'integer' }, action: { type: 'string' } }, required: ['unit', 'action'], additionalProperties: false } } }
const context = (): ContextResult => ({ messages: [{ role: 'system', content: 'Use offered operations and report the actual result.' },
  { role: 'user', content: 'Trip test unit 2 exactly once.' }], flushInfo: { ids: new Set<string>(), triggerRoomId: 'fixture-room' }, warnings: [] })
const config: AIAgentConfig = { name: 'Fixture operator', model, persona: 'Test operator' }
const event = (delta: Record<string, unknown>, finishReason?: string) => JSON.stringify({ model,
  choices: [{ index: 0, delta, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }] })
const mutation = (id: string) => event({ tool_calls: [{ index: 0, id, type: 'function',
  function: { name: tool.function.name, arguments: '{"unit":2,"action":"trip"}' } }] })
const terminalTool = () => event({}, 'tool_calls')
const finalAnswer = () => event({ content: 'The accepted operation completed once.' }, 'stop')
const usage = JSON.stringify({ model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } })
const upstreamError = JSON.stringify({ error: { message: 'Fixture upstream failed after emitting tool arguments', code: 'upstream_error' } })

const sse = (payloads: string[], newline = '\n'): Response => {
  const bytes = new TextEncoder().encode(payloads.map(payload => `data: ${payload}${newline}${newline}`).join(''))
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    // Split within both data prefixes and CRLF separators, as a real transport can.
    const cut = Math.floor(bytes.length / 2)
    controller.enqueue(bytes.slice(0, 1)); controller.enqueue(bytes.slice(1, cut)); controller.enqueue(bytes.slice(cut)); controller.close()
  } })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

interface WireRequest { model: string; stream: boolean; messages: Array<{ role: string; content: unknown; tool_call_id?: string }> }
const run = async (responses: Array<() => Response>) => {
  const requests: WireRequest[] = []
  const executed: Array<{ providerCallId: string | undefined; arguments: Record<string, unknown> }> = []
  const accepted: Array<{ commandId: string; unit: number; state: string; exactValue: number }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    expect(url.origin).toBe('https://sse-execution.fixture.invalid')
    expect(url.pathname).toBe('/v1/chat/completions')
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body)) as WireRequest
    expect(body.stream).toBe(true); expect(body.model).toBe(model)
    requests.push(body)
    const response = responses[requests.length - 1]
    if (response === undefined) throw new Error('Unexpected additional provider request in fixture')
    return response()
  }) as typeof fetch
  const executor: ToolExecutor = async calls => calls.map(call => {
    expect(call.tool).toBe(tool.function.name)
    expect(call.arguments).toEqual({ unit: 2, action: 'trip' })
    executed.push({ providerCallId: call.providerCallId, arguments: structuredClone(call.arguments) })
    const receipt = { commandId: `accepted:${accepted.length + 1}`, unit: 2, state: 'tripped', exactValue: 2.000001 }
    accepted.push(receipt)
    return { success: true, data: receipt }
  })
  try {
    const provider = createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => 'https://sse-execution.fixture.invalid/v1', getApiKey: () => 'fixture-only' })
    const result = await evaluate(context(), config, provider, executor, undefined, 'fixture-room', { toolDefinitions: [tool] })
    return { result, requests, executed, accepted }
  } finally { globalThis.fetch = original }
}

for (const newline of ['\n', '\r\n']) test(`valid ${newline === '\n' ? 'LF' : 'CRLF'} provider stream executes one mutation through evaluate and retains its exact receipt`, async () => {
  const { result, requests, executed, accepted } = await run([
    () => sse([mutation('accepted001'), terminalTool(), usage, '[DONE]'], newline),
    () => sse([finalAnswer(), usage, '[DONE]'], newline),
  ])
  expect(result.decision.response).toMatchObject({ action: 'respond', content: 'The accepted operation completed once.' })
  expect(executed).toEqual([{ providerCallId: 'accepted001', arguments: { unit: 2, action: 'trip' } }])
  expect(accepted).toHaveLength(1); expect(requests).toHaveLength(2)
  const retained = requests[1]!.messages.filter(message => message.role === 'tool')
  expect(retained).toHaveLength(1)
  expect(retained[0]!.tool_call_id).toBe('accepted001')
  expect(JSON.parse(String(retained[0]!.content))).toEqual(accepted[0])
})

const failedStreams = [
  { name: 'in-band upstream error after complete-looking terminal tool arguments', response: () => sse([mutation('failed002'), terminalTool(), upstreamError, '[DONE]']) },
  { name: 'premature EOF after complete-looking tool arguments without terminal completion', response: () => sse([mutation('failed002')]) },
]
for (const failure of failedStreams) {
  test(`${failure.name} cannot mutate through the real adapter and evaluate`, async () => {
    const { result, requests, executed, accepted } = await run([failure.response, () => sse([finalAnswer(), '[DONE]'])])
    expect(executed).toEqual([]); expect(accepted).toEqual([])
    expect(result.decision.response.action).toBe('error')
    expect(requests).toHaveLength(1)
  })
  test(`an accepted receipt survives a later ${failure.name} without replaying or executing another mutation`, async () => {
    const { result, requests, executed, accepted } = await run([
      () => sse([mutation('accepted001'), terminalTool(), '[DONE]']), failure.response,
      () => sse([finalAnswer(), '[DONE]']),
    ])
    expect(executed.map(call => call.providerCallId)).toEqual(['accepted001'])
    expect(result.decision.response.action).toBe('error')
    expect(accepted).toHaveLength(1); expect(requests).toHaveLength(2)
    const retained = requests[1]!.messages.filter(message => message.role === 'tool')
    expect(retained).toHaveLength(1); expect(retained[0]!.tool_call_id).toBe('accepted001')
    expect(JSON.parse(String(retained[0]!.content))).toEqual(accepted[0])
    expect(result.decision.toolTrace?.filter(entry => entry.success)).toHaveLength(1)
  })
}
