import { describe, expect, spyOn, test } from 'bun:test'
import type { StreamChunk } from '../core/types/llm.ts'
import { isCloudProviderError } from './errors.ts'
import { createOpenAICompatibleProvider } from './openai-compatible.ts'

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const terminal = (reason = 'tool_calls') => event({ choices: [{ delta: {}, finish_reason: reason }] })
const action = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'actual-call', function: {
  name: 'operate', arguments: '{"value":0.08333333333333333,"label":"måling"}',
} }] } }] }

// Replace only fetch in a test. No socket, external provider, or production mock.
const acquire = async (config: {
  text?: string
  bytes?: ReadonlyArray<Uint8Array>
  contentType?: string
  signal?: AbortSignal
  afterChunk?: (chunk: StreamChunk) => void
  breakAfterChunk?: boolean
}) => {
  const original = globalThis.fetch
  let fetches = 0
  let requestSignal: AbortSignal | null | undefined
  let response: Response | undefined
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    fetches++
    requestSignal = init?.signal
    const bytes = config.bytes ?? [new TextEncoder().encode(config.text ?? '')]
    response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const chunk of bytes) controller.enqueue(chunk)
      controller.close()
    } }), { headers: { 'Content-Type': config.contentType ?? 'text/event-stream' } })
    return response
  }) as typeof fetch
  const chunks: StreamChunk[] = []
  let error: unknown
  try {
    const provider = createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => 'https://fixture.invalid/v1', getApiKey: () => 'fixture' })
    try {
      for await (const chunk of provider.stream!({ model: 'fixture', messages: [{ role: 'user', content: 'operate once' }] }, config.signal)) {
        chunks.push(chunk)
        config.afterChunk?.(chunk)
        if (config.breakAfterChunk) break
      }
    } catch (caught) { error = caught }
    return { chunks, error, fetches, bodyLocked: response?.body?.locked ?? false, requestAborted: requestSignal?.aborted }
  } finally { globalThis.fetch = original }
}

describe('OpenAI-compatible stream completion boundary', () => {
  const failures = [
    ['empty transport EOF', '', 'without a terminal'],
    ['keepalive-only EOF', ': OPENROUTER PROCESSING\n\n', 'without a terminal'],
    ['unframed DONE', '[DONE]', 'incomplete SSE event'],
    ['SSE DONE without a finish reason', 'data: [DONE]\n\n', 'without a terminal'],
    ['in-band error before output', event({ error: { code: 'server_error', message: 'upstream disconnected' } }), 'upstream disconnected'],
    ['complete-looking tool followed by upstream error', event(action) + event({ error: { code: 503, message: 'upstream unavailable' }, choices: [{ delta: {}, finish_reason: 'error' }] }), 'upstream unavailable'],
    ['complete-looking tool followed by EOF', event(action), 'without a terminal'],
    ['complete-looking tool followed by error finish', event(action) + terminal('error'), 'generation ended with error'],
    ['complete-looking tool followed by content filter', event(action) + terminal('content_filter'), 'generation ended with content_filter'],
    ['malformed JSON', 'data: {broken}\n\n', 'malformed JSON'],
    ['non-object JSON', 'data: null\n\n', 'not a Chat Completion object'],
    ['unknown empty object', 'data: {}\n\n', 'neither a choice nor usage'],
    ['unfinished event', event(action) + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n', 'incomplete SSE event'],
    ['post-terminal content', event(action) + terminal() + event({ choices: [{ delta: { content: 'late output' } }] }), 'non-accounting data'],
    ['post-terminal tool fragment', event(action) + terminal() + event(action), 'non-accounting data'],
    ['contradictory finish reason', event(action) + terminal() + event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1 } }), 'contradictory terminal'],
    ['data after DONE', event(action) + terminal() + 'data: [DONE]\n\n' + event({ error: { message: 'late error' } }), 'after [DONE]'],
    ['malformed tool arguments type', event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'operate', arguments: {} } }] } }] }) + terminal() + 'data: [DONE]\n\n', 'malformed tool-call arguments'],
  ] as const
  for (const [name, text, reason] of failures) test(name, async () => {
    const result = await acquire({ text })
    expect(isCloudProviderError(result.error)).toBe(true)
    expect(result.error).toMatchObject({ kind: 'cloud_error', code: 'provider_down', provider: 'openrouter', status: 200 })
    expect((result.error as Error).message).toContain(reason)
    expect(result.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toHaveLength(0)
    expect(result.chunks.some(chunk => chunk.done)).toBe(false)
    expect(result.fetches).toBe(1)
    expect(result.requestAborted).toBe(true)
    expect(result.bodyLocked).toBe(false)
  })

  test('CRLF split one byte at a time and multiline data retain exact tool arguments and usage', async () => {
    const multiline = JSON.stringify(action, null, 2).split('\n').map(line => `data: ${line}`).join('\r\n') + '\r\n\r\n'
    const accounting = { id: 'generation-exact', provider: 'OpenAI', model: 'fixture', choices: [{ delta: { content: '', role: 'assistant' }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 123, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 100 }, cost: 0.000123 } }
    const text = '\ufeff: keepalive\r\nevent: message\r\n\r\n' + multiline + terminal().replaceAll('\n', '\r\n') + event(accounting).replaceAll('\n', '\r\n') + 'data: [DONE]\r\n\r\n'
    const result = await acquire({ bytes: [...new TextEncoder().encode(text)].map(byte => new Uint8Array([byte])) })
    expect(result.error).toBeUndefined()
    const done = result.chunks.filter(chunk => chunk.done)
    expect(done).toHaveLength(1)
    expect(done[0]!.finishReason).toBe('tool_calls')
    expect(done[0]!.toolCalls).toEqual([{ id: 'actual-call', function: { name: 'operate', arguments: { value: 0.08333333333333333, label: 'måling' } } }])
    expect(done[0]!.tokensUsed).toEqual({ prompt: 123, completion: 12, cacheRead: 100 })
    expect(done[0]!.billing).toEqual({ generationId: 'generation-exact', upstreamProvider: 'OpenAI', costUsd: 0.000123 })
    expect(result.fetches).toBe(1)
    expect(result.bodyLocked).toBe(false)
    expect(result.requestAborted).toBe(true)
  })

  test('CR-only framing and clean terminal EOF are complete', async () => {
    const result = await acquire({ text: (event(action) + terminal()).replaceAll('\n', '\r') })
    expect(result.error).toBeUndefined()
    expect(result.chunks.filter(chunk => chunk.done)).toHaveLength(1)
    expect(result.chunks.at(-1)!.toolCalls).toHaveLength(1)
  })

  test('a genuine empty completed response remains visibly empty, without retry', async () => {
    const result = await acquire({ text: terminal('stop') + 'data: [DONE]\n\n' })
    expect(result.error).toBeUndefined()
    expect(result.fetches).toBe(1)
    expect(result.chunks).toEqual([expect.objectContaining({ delta: '', done: true, finishReason: 'stop' })])
    expect(result.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toHaveLength(0)
  })

  test('length completion retains its reason but exposes no complete-looking tools', async () => {
    const result = await acquire({ text: event(action) + terminal('length') + 'data: [DONE]\n\n' })
    expect(result.error).toBeUndefined()
    expect(result.chunks.at(-1)).toMatchObject({ done: true, finishReason: 'length' })
    expect(result.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toHaveLength(0)
  })

  test('HTTP 200 JSON error is a provider failure, never a synthetic empty stream', async () => {
    const result = await acquire({ text: JSON.stringify({ error: { code: 502, message: 'provider disconnected' } }), contentType: 'application/json; charset=utf-8' })
    expect(result.error).toMatchObject({ kind: 'cloud_error', code: 'provider_down', status: 200 })
    expect((result.error as Error).message).toContain('provider disconnected')
    expect(result.chunks).toHaveLength(0)
    expect(result.fetches).toBe(1)
  })

  test('actual in-band credit refusal preserves transport 200 and upstream 502 without releasing buffered tools', async () => {
    const message = 'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.'
    const result = await acquire({ text: event(action) + terminal() + event({ error: { code: 502, message } }) + 'data: [DONE]\n\n' })
    expect(result.error).toMatchObject({ kind: 'cloud_error', code: 'credits', provider: 'openrouter', status: 200 })
    expect((result.error as Error).message).toBe(`openrouter stream: upstream error (502): ${message}`)
    expect(result.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toHaveLength(0)
    expect(result.chunks.some(chunk => chunk.done)).toBe(false)
    expect(result.fetches).toBe(1)
    expect(result.requestAborted).toBe(true)
    expect(result.bodyLocked).toBe(false)
  })

  test('a structured billing error in a 200 JSON body uses the same credit classification', async () => {
    const result = await acquire({ text: JSON.stringify({ error: { code: 'credit_balance_exhausted', type: 'insufficient_quota', message: 'No remaining credit balance' } }), contentType: 'application/json' })
    expect(result.error).toMatchObject({ code: 'credits', status: 200 })
    expect(result.chunks).toHaveLength(0)
    expect(result.fetches).toBe(1)
  })

  test('a non-SSE success body is not silently interpreted as another transport', async () => {
    const result = await acquire({ text: JSON.stringify({ choices: [{ message: { content: 'unexpected nonstream' }, finish_reason: 'stop' }] }), contentType: 'application/json' })
    expect(result.error).toMatchObject({ kind: 'cloud_error', code: 'provider_down', status: 200 })
    expect((result.error as Error).message).toContain('expected text/event-stream')
    expect(result.chunks).toHaveLength(0)
  })

  test('cancellation before dispatch performs no request', async () => {
    const controller = new AbortController(); controller.abort()
    const result = await acquire({ text: event(action) + terminal(), signal: controller.signal })
    expect((result.error as Error).name).toBe('AbortError')
    expect(result.fetches).toBe(0)
    expect(result.chunks).toHaveLength(0)
  })

  test('cancellation wins before a final tool call and releases caller resources', async () => {
    const controller = new AbortController()
    const add = spyOn(controller.signal, 'addEventListener')
    const remove = spyOn(controller.signal, 'removeEventListener')
    try {
      const result = await acquire({ text: event({ choices: [{ delta: { content: 'a visible partial response' } }] }) + event(action) + terminal() + 'data: [DONE]\n\n', signal: controller.signal, afterChunk: () => controller.abort() })
      expect((result.error as Error).name).toBe('AbortError')
      expect(result.chunks.some(chunk => chunk.delta.length > 0)).toBe(true)
      expect(result.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toHaveLength(0)
      expect(result.bodyLocked).toBe(false)
      expect(add.mock.calls.filter(call => call[0] === 'abort')).toHaveLength(1)
      expect(remove.mock.calls.filter(call => call[0] === 'abort')).toHaveLength(1)
    } finally { add.mockRestore(); remove.mockRestore() }
  })

  test('an early consumer return clears timers, aborts transport and releases reader lock', async () => {
    const scheduled = spyOn(globalThis, 'setTimeout')
    const cleared = spyOn(globalThis, 'clearTimeout')
    try {
      const result = await acquire({ text: event({ choices: [{ delta: { content: 'a visible partial response' } }] }) + event(action) + terminal() + 'data: [DONE]\n\n', breakAfterChunk: true })
      expect(result.error).toBeUndefined()
      expect(result.chunks.some(chunk => chunk.done)).toBe(false)
      expect(result.requestAborted).toBe(true)
      expect(result.bodyLocked).toBe(false)
      const cancelled = new Set<unknown>(cleared.mock.calls.map(call => call[0]))
      for (const timer of scheduled.mock.results) expect(cancelled.has(timer.value)).toBe(true)
    } finally { scheduled.mockRestore(); cleared.mockRestore() }
  })
})
