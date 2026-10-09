import { describe, test, expect } from 'bun:test'
import type { ChatRequest, ChatResponse, StreamChunk, ProviderHealth, GatewayMetrics } from '../core/types/llm.ts'
import type { ChatCallOptions, ProviderGateway } from './provider-gateway.ts'
import { createProviderRouter, parseProviderPrefix, type ProviderAllFailedEvent, type ProviderRoutingEvent } from './router.ts'
import { createCloudProviderError, createGatewayError, isCloudProviderError, isLLMRequestError } from './errors.ts'
import { createProviderMonitor, type ProviderMonitor } from './provider-monitor.ts'
import { buildOAIBody } from './openai-compatible-wire.ts'

// Helper: build a fake-monitor map for the given provider names so the
// router enforces cooldown / unhealthy state. Tests that don't care about
// monitor state can omit this and the router behaves as "always allow".
const monitorsFor = (
  names: ReadonlyArray<string>,
  now: () => number = Date.now,
): Record<string, ProviderMonitor> => {
  const out: Record<string, ProviderMonitor> = {}
  for (const n of names) {
    out[n] = createProviderMonitor(
      { name: n, kind: 'cloud', hasKey: () => true, isUserEnabled: () => true },
      { now },
    )
  }
  return out
}

// === Fake gateway — implements ProviderGateway with scriptable behaviour ===

interface FakeScript {
  // Map: call-index (0, 1, 2...) → response or error
  readonly responses?: ReadonlyArray<ChatResponse | Error>
  readonly streamResponses?: ReadonlyArray<ReadonlyArray<StreamChunk> | Error>
  readonly availableModels?: ReadonlyArray<string>
}

const createFakeGateway = (script: FakeScript): ProviderGateway & {
  callCount: () => number
  externalFailCount: () => number
  streamOptions: () => ReadonlyArray<ChatCallOptions>
} => {
  let chatCallIdx = 0
  let streamCallIdx = 0
  let externalFails = 0
  const streamOptions: ChatCallOptions[] = []
  const health: ProviderHealth = {
    status: 'healthy',
    latencyMs: 100,
    availableModels: script.availableModels ?? [],
    lastCheckedAt: Date.now(),
  }

  const chat = async (_request: ChatRequest): Promise<ChatResponse> => {
    const idx = chatCallIdx++
    const r = script.responses?.[idx]
    if (!r) {
      return {
        content: 'default', generationMs: 10,
        tokensUsed: { prompt: 1, completion: 1 },
      }
    }
    if (r instanceof Error) throw r
    return r
  }

  const stream = async function* (_request: ChatRequest, _signal?: AbortSignal, options?: ChatCallOptions): AsyncIterable<StreamChunk> {
    streamOptions.push(options ?? {})
    const idx = streamCallIdx++
    const r = script.streamResponses?.[idx]
    if (!r) {
      yield { delta: 'x', done: false }
      yield { delta: '', done: true }
      return
    }
    if (r instanceof Error) throw r
    for (const chunk of r) yield chunk
  }

  const metrics: GatewayMetrics = {
    requestCount: 0, errorCount: 0, errorRate: 0,
    p50Latency: 0, p95Latency: 0, avgTokensPerSecond: 0,
    queueDepth: 0, concurrentRequests: 0,
    circuitState: 'closed', shedCount: 0, windowMs: 300_000,
  }

  return {
    chat,
    stream,
    models: async () => [...(script.availableModels ?? [])],
    runningModels: async () => [],
    getMetrics: () => metrics,
    getHealth: () => health,
    getConfig: () => ({
      maxConcurrent: 2, maxQueueDepth: 6, queueTimeoutMs: 30_000,
      circuitBreakerThreshold: 5, circuitBreakerCooldownMs: 15_000,
    }),
    updateConfig: () => {},
    onHealthChange: () => {},
    resetCircuitBreaker: () => {},
    refreshModels: async () => {},
    recordExternalFailure: () => { externalFails++ },
    dispose: () => {},
    callCount: () => chatCallIdx,
    externalFailCount: () => externalFails,
    streamOptions: () => streamOptions,
  }
}

const chatReq = (model: string, content = 'hi'): ChatRequest => ({
  model, messages: [{ role: 'user', content }],
})

describe('actual routed model capacity', () => {
  test.each(['chat', 'stream'] as const)('checks a smaller fallback before %s dispatch', async mode => {
    const unavailable = createCloudProviderError({ code: 'provider_down', provider: 'large', message: 'unavailable' })
    const large = createFakeGateway({ availableModels: ['model'], responses: [unavailable], streamResponses: [unavailable] })
    const small = createFakeGateway({ availableModels: ['model'] })
    const router = createProviderRouter({ large, small }, { order: ['large', 'small'], contextLookup: async provider => ({ contextMax: provider === 'large' ? 100_000 : 1_000, source: 'test' }) })
    const request = chatReq('model', 'x'.repeat(20_000))
    const invoke = async () => { if (mode === 'chat') return router.chat(request); for await (const _ of router.stream(request)) { /* drain */ } }
    // The outage on the route that could carry the request is the cause; the
    // smaller route's refusal is detail.
    await expect(invoke()).rejects.toThrow(/^model could not be served\. large: provider unavailable: unavailable\..* small: skipped before dispatch — Request estimate \d+ tokens exceeds small:model capacity 1000/)
    expect(small.callCount()).toBe(0)
    expect(small.streamOptions()).toHaveLength(0)
    router.dispose()
  })

  test('metadata follows the selected provider and canonical wire ID, not a guessed name prefix', async () => {
    const gateway = { ...createFakeGateway({ availableModels: ['gpt-5.4'] }), modelInfo: async () => ({ id: 'openai/gpt-5.4', provider: 'openrouter', contextMax: 1_050_000, source: 'openrouter_api' }) }
    const router = createProviderRouter({ openrouter: gateway }, { order: ['openrouter'] })
    expect(await router.modelInfo?.('gpt-5.4')).toEqual({ id: 'openai/gpt-5.4', provider: 'openrouter', contextMax: 1_050_000, source: 'openrouter_api' })
    expect(await router.chat(chatReq('gpt-5.4'))).toMatchObject({ provider: 'openrouter', contextMax: 1_050_000 })
    router.dispose()
  })

  test('unknown metadata does not reject an explicitly selected unlisted model', async () => {
    const gateway = createFakeGateway({ availableModels: [] })
    const router = createProviderRouter({ test: gateway }, { order: ['test'] })
    expect(await router.chat(chatReq('test:not-listed'))).toMatchObject({ contextMax: 0 })
    expect(gateway.callCount()).toBe(1)
    router.dispose()
  })

  test('explicit output allowance, system instructions and tool schemas count before dispatch', async () => {
    const gateway = createFakeGateway({ availableModels: ['model'] })
    const router = createProviderRouter({ test: gateway }, { order: ['test'], contextLookup: async () => ({ contextMax: 1000, source: 'test' }) })
    await expect(router.chat({ ...chatReq('model'), maxTokens: 1000 })).rejects.toThrow('allowance 1000 included')
    await expect(router.chat({ ...chatReq('model'), systemBlocks: [{ text: 'x'.repeat(5000), cacheable: true }] })).rejects.toThrow('uses provider default')
    await expect(router.chat({ ...chatReq('model'), tools: [{ type: 'function', function: { name: 'read', description: 'x'.repeat(5000), parameters: { type: 'object', properties: {} } } }] })).rejects.toThrow('exceeds')
    expect(gateway.callCount()).toBe(0)
    router.dispose()
  })
})

describe('parseProviderPrefix', () => {
  test('bare model name → no prefix', () => {
    expect(parseProviderPrefix('llama-3.3-70b')).toEqual({ provider: null, modelId: 'llama-3.3-70b' })
  })
  test('simple prefix', () => {
    expect(parseProviderPrefix('groq:llama-3.3-70b')).toEqual({ provider: 'groq', modelId: 'llama-3.3-70b' })
  })
  test('openrouter slug with multiple colons → split on FIRST colon only', () => {
    expect(parseProviderPrefix('openrouter:meta-llama/llama-3.3-70b-instruct:free')).toEqual({
      provider: 'openrouter',
      modelId: 'meta-llama/llama-3.3-70b-instruct:free',
    })
  })
  test('bare slug with slash is NOT treated as prefixed', () => {
    expect(parseProviderPrefix('meta-llama/llama-3.3')).toEqual({
      provider: null,
      modelId: 'meta-llama/llama-3.3',
    })
  })
})

describe('createProviderRouter — failover', () => {
  test('first provider succeeds → no fallback, emits provider_bound transition', async () => {
    const a = createFakeGateway({ availableModels: ['m'] })
    const b = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    const events: ProviderRoutingEvent[] = []
    router.onRoutingEvent(e => events.push(e))
    const r = await router.chat(chatReq('m'), { agentId: 'ag1' })
    expect(r.content).toBe('default')
    expect(a.callCount()).toBe(1)
    expect(b.callCount()).toBe(0)
    expect(events.filter(e => e.type === 'provider_bound')).toHaveLength(1)
    expect((events[0] as { type: 'provider_bound'; oldProvider: null; newProvider: string }).oldProvider).toBeNull()
    expect((events[0] as { newProvider: string }).newProvider).toBe('a')
  })

  test('rate_limit on first → falls through to second, marks first cold', async () => {
    const a = createFakeGateway({
      responses: [createCloudProviderError({ code: 'rate_limit', provider: 'a', message: '429', retryAfterMs: 60_000 })],
      availableModels: ['m'],
    })
    const b = createFakeGateway({ availableModels: ['m'] })
    const monitors = monitorsFor(['a', 'b'])
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'], monitors })
    const r = await router.chat(chatReq('m'))
    expect(r.content).toBe('default')
    expect(a.callCount()).toBe(1)
    expect(b.callCount()).toBe(1)
    const snap = router.getMonitorSnapshot()
    expect(snap.a?.sub).toBe('backoff')
    expect(snap.a?.retryAt).not.toBeNull()
  })

  test('auth error propagates without fallback', async () => {
    const a = createFakeGateway({
      responses: [createCloudProviderError({ code: 'auth', provider: 'a', message: '401' })],
      availableModels: ['m'],
    })
    const b = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    let caught: unknown
    try { await router.chat(chatReq('m')) }
    catch (err) { caught = err }
    expect(caught).toBeDefined()
    expect(b.callCount()).toBe(0)
  })

  test('cooldown respected on second call, then expires', async () => {
    let fakeTime = 1_000_000
    const a = createFakeGateway({
      responses: [
        createCloudProviderError({ code: 'rate_limit', provider: 'a', message: '429', retryAfterMs: 5_000 }),
        { content: 'recovered', generationMs: 10, tokensUsed: { prompt: 1, completion: 1 } },
      ],
      availableModels: ['m'],
    })
    const b = createFakeGateway({ availableModels: ['m'] })
    const monitors = monitorsFor(['a', 'b'], () => fakeTime)
    const router = createProviderRouter(
      { a, b }, { order: ['a', 'b'], monitors },
      { now: () => fakeTime },
    )
    await router.chat(chatReq('m'))                  // 'a' fails → 'b' serves
    expect(a.callCount()).toBe(1)
    expect(b.callCount()).toBe(1)

    fakeTime += 1_000                                // still cold
    await router.chat(chatReq('m'))                  // should go to 'b' again
    expect(a.callCount()).toBe(1)
    expect(b.callCount()).toBe(2)

    fakeTime += 10_000                               // past cooldown
    await router.chat(chatReq('m'))                  // 'a' healthy, but soft pref keeps 'b'
    expect(a.callCount()).toBe(1)
    expect(b.callCount()).toBe(3)
  })

  test('soft preference: after success on b, prefers b over a even when both healthy', async () => {
    const a = createFakeGateway({ availableModels: ['m'] })
    const b = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    // Force first call to go to b via prefix-pinning, which sets lastSuccessByModel[m]=b.
    await router.chat(chatReq('b:m'))
    expect(b.callCount()).toBe(1)
    expect(a.callCount()).toBe(0)
    // Next call with bare model name should also go to b due to soft preference.
    await router.chat(chatReq('m'))
    expect(b.callCount()).toBe(2)
    expect(a.callCount()).toBe(0)
  })

  test('provider_bound fires only on transition, not on repeat', async () => {
    const a = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ a }, { order: ['a'] })
    const events: ProviderRoutingEvent[] = []
    router.onRoutingEvent(e => events.push(e))
    await router.chat(chatReq('m'), { agentId: 'ag1' })
    await router.chat(chatReq('m'), { agentId: 'ag1' })
    await router.chat(chatReq('m'), { agentId: 'ag1' })
    // Only first call is a transition (null → a).
    expect(events.filter(e => e.type === 'provider_bound')).toHaveLength(1)
  })

  test('provider skipped when model not in its available list', async () => {
    const a = createFakeGateway({ availableModels: ['other-model'] })  // doesn't list 'm'
    const b = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    await router.chat(chatReq('m'))
    expect(a.callCount()).toBe(0)
    expect(b.callCount()).toBe(1)
  })

  test('all providers fail → provider_all_failed event + throws', async () => {
    const a = createFakeGateway({
      responses: [createCloudProviderError({ code: 'rate_limit', provider: 'a', message: '429' })],
      availableModels: ['m'],
    })
    const b = createFakeGateway({
      responses: [createCloudProviderError({ code: 'provider_down', provider: 'b', message: '503' })],
      availableModels: ['m'],
    })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    const events: ProviderRoutingEvent[] = []
    router.onRoutingEvent(e => events.push(e))
    let caught: unknown
    try { await router.chat(chatReq('m')) }
    catch (err) { caught = err }
    expect(caught).toBeDefined()
    expect(events.filter(e => e.type === 'provider_all_failed')).toHaveLength(1)
    const evt = events.find(e => e.type === 'provider_all_failed') as {
      type: 'provider_all_failed'
      attempts: ReadonlyArray<{ provider: string; reason: string }>
    }
    expect(evt.attempts).toHaveLength(2)
  })

  test('FORCE_PROVIDER_FAIL skips named provider', async () => {
    const a = createFakeGateway({ availableModels: ['m'] })
    const b = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter(
      { a, b },
      { order: ['a', 'b'], forceFailProvider: 'a' },
    )
    await router.chat(chatReq('m'))
    expect(a.callCount()).toBe(0)
    expect(b.callCount()).toBe(1)
  })

  test('prefix-pinned model with unavailable provider → fails cleanly', async () => {
    const a = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ a }, { order: ['a'] })
    let caught: unknown
    try { await router.chat(chatReq('nonexistent:m')) }
    catch (err) { caught = err }
    expect(caught).toBeDefined()
  })

  test('aggregated metrics expose per-provider breakdown', async () => {
    const a = createFakeGateway({ availableModels: ['m'] })
    const b = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    await router.chat(chatReq('m'))
    const metrics = router.getAggregatedMetrics()
    expect(Object.keys(metrics.byProvider)).toEqual(['a', 'b'])
    expect(metrics.lastSuccessByModel).toEqual({ m: 'a' })
  })
})

// The 2026-10-09 incident shape: OpenRouter's local gateway sheds a gpt-5.4
// tool request under load, the router falls through to direct OpenAI, and
// the real OpenAI wire builder refuses the request before any network I/O.
// The shed must stay the reported cause; the refusal is a recorded skip.
describe('createProviderRouter — route refusals', () => {
  const tools = [{ type: 'function' as const, function: { name: 'inspect', description: 'Inspect', parameters: { type: 'object', properties: {} } } }]
  const toolRequest = (model: string): ChatRequest => ({ ...chatReq(model), tools })
  const shed = () => createGatewayError('queue_full', 'LLM gateway queue full — request shed')
  // Test double confined to this file: runs the production OpenAI body
  // builder so the refusal is the real one, then answers without I/O.
  const directOpenAI = (availableModels: ReadonlyArray<string> = ['gpt-5.4']) => {
    const base = createFakeGateway({ availableModels })
    let wireCalls = 0
    return {
      ...base,
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        buildOAIBody(request, false, 'openai')
        wireCalls++
        return { content: 'served by openai', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }
      },
      stream: async function* (request: ChatRequest): AsyncIterable<StreamChunk> {
        buildOAIBody(request, true, 'openai')
        wireCalls++
        yield { delta: 'served by openai', done: false }
        yield { delta: '', done: true }
      },
      wireCalls: () => wireCalls,
    }
  }
  const invoke = async (router: ReturnType<typeof createProviderRouter>, mode: 'chat' | 'stream', request: ChatRequest): Promise<string> => {
    if (mode === 'chat') return (await router.chat(request)).content
    let text = ''
    for await (const chunk of router.stream(request)) text += chunk.delta
    return text
  }
  const rejection = async (run: () => Promise<unknown>): Promise<unknown> => {
    try { await run() } catch (err) { return err }
    throw new Error('expected the call to fail')
  }

  test.each(['chat', 'stream'] as const)('%s: a shed on the first route stays the cause when the next route refuses the request shape', async mode => {
    const openrouter = createFakeGateway({ availableModels: ['gpt-5.4'], responses: [shed()], streamResponses: [shed()] })
    const openai = directOpenAI()
    const anthropic = createFakeGateway({ availableModels: [] })
    const monitors = monitorsFor(['openrouter', 'anthropic', 'openai'])
    const router = createProviderRouter({ openrouter, anthropic, openai }, { order: ['openrouter', 'anthropic', 'openai'], monitors })
    const events: ProviderRoutingEvent[] = []
    router.onRoutingEvent(event => events.push(event))

    const err = await rejection(() => invoke(router, mode, toolRequest('gpt-5.4')))

    expect(isLLMRequestError(err)).toBe(false)
    expect(isCloudProviderError(err) && err.code).toBe('provider_down')
    const message = (err as Error).message
    expect(message.startsWith('gpt-5.4 could not be served. openrouter: LLM gateway queue full — request shed (queue_full')).toBe(true)
    expect(message).toContain('openai: skipped before dispatch — unsupported_provider_transport')
    expect(message).not.toContain('anthropic')
    expect(openai.wireCalls()).toBe(0)
    const failed = events.find((event): event is ProviderAllFailedEvent => event.type === 'provider_all_failed')
    expect(failed?.primaryCode).toBe('queue_full')
    expect(failed?.attempts.map(attempt => [attempt.provider, attempt.code])).toEqual([
      ['anthropic', 'not_listed'], ['openrouter', 'queue_full'], ['openai', 'unsupported_route'],
    ])
    // A local refusal says nothing about OpenAI's health.
    expect(router.getMonitorSnapshot().openai?.sub).toBe('ok')
    router.dispose()
  })

  test.each(['chat', 'stream'] as const)('%s: a refusing route is skipped and the next route serves the request', async mode => {
    const openai = directOpenAI()
    const openrouter = createFakeGateway({ availableModels: ['gpt-5.4'] })
    const router = createProviderRouter({ openai, openrouter }, { order: ['openai', 'openrouter'] })
    expect(await invoke(router, mode, toolRequest('gpt-5.4'))).not.toContain('openai')
    expect(openai.wireCalls()).toBe(0)
    router.dispose()
  })

  test.each(['chat', 'stream'] as const)('%s: with nothing transient in the way the refusal itself surfaces unchanged', async mode => {
    for (const model of ['gpt-5.4', 'openai:gpt-5.4']) {
      const router = createProviderRouter({ openai: directOpenAI(), groq: createFakeGateway({ availableModels: [] }) }, { order: ['groq', 'openai'] })
      const events: ProviderRoutingEvent[] = []
      router.onRoutingEvent(event => events.push(event))
      const err = await rejection(() => invoke(router, mode, toolRequest(model)))
      expect(isLLMRequestError(err) && err.code).toBe('unsupported_provider_transport')
      expect(events.some(event => event.type === 'provider_all_failed')).toBe(false)
      router.dispose()
    }
  })

  test('routes that never were candidates do not outrank the failure of the route that was tried', async () => {
    const limited = createFakeGateway({ availableModels: ['m'], responses: [createCloudProviderError({ code: 'rate_limit', provider: 'limited', status: 429, message: 'slow down' })] })
    const keyless = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ keyless, limited }, { order: ['keyless', 'limited'], isProviderEnabled: name => name !== 'keyless' })
    const events: ProviderRoutingEvent[] = []
    router.onRoutingEvent(event => events.push(event))
    const err = await rejection(() => router.chat(chatReq('m')))
    expect((err as Error).message.startsWith('m could not be served. limited: rate-limited (HTTP 429): slow down.')).toBe(true)
    expect((err as Error).message).not.toContain('keyless')
    expect(events.find((event): event is ProviderAllFailedEvent => event.type === 'provider_all_failed')?.primaryCode).toBe('rate_limit')
    router.dispose()
  })
})

describe('createProviderRouter — streaming', () => {
  test('initial-connect failure falls through to next provider', async () => {
    const a = createFakeGateway({
      streamResponses: [createCloudProviderError({ code: 'provider_down', provider: 'a', message: '503' })],
      availableModels: ['m'],
    })
    const b = createFakeGateway({
      streamResponses: [[{ delta: 'ok', done: false }, { delta: '', done: true }]],
      availableModels: ['m'],
    })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    const chunks: StreamChunk[] = []
    for await (const chunk of router.stream(chatReq('m'))) chunks.push(chunk)
    expect(chunks.map(c => c.delta).join('')).toBe('ok')
  })

  test('a provider-originated queue_full still falls through without forcing zero-depth queues', async () => {
    const a = createFakeGateway({
      streamResponses: [createGatewayError('queue_full', 'LLM gateway queue full — request shed')],
      availableModels: ['m'],
    })
    const b = createFakeGateway({
      streamResponses: [[{ delta: 'ok', done: false }, { delta: '', done: true }]],
      availableModels: ['m'],
    })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    const chunks: StreamChunk[] = []
    for await (const chunk of router.stream(chatReq('m'))) chunks.push(chunk)

    expect(chunks.map(c => c.delta).join('')).toBe('ok')
    expect(a.streamOptions()[0]?.maxQueueDepth).toBeUndefined()
    expect(b.streamOptions()[0]?.maxQueueDepth).toBeUndefined()
  })

  test('mid-stream failure → provider_stream_failed event, no retry', async () => {
    // First chunk succeeds, then error mid-stream. Built inline since the fake's
    // script-based stream cannot mix yielded chunks with a throw.
    const a: ProviderGateway & { callCount: () => number; externalFailCount: () => number } = {
      chat: async () => { throw new Error('not used') },
      stream: async function* () {
        yield { delta: 'partial', done: false }
        throw createCloudProviderError({ code: 'provider_down', provider: 'a', message: 'died' })
      },
      models: async () => ['m'],
      runningModels: async () => [],
      getMetrics: () => ({
        requestCount: 0, errorCount: 0, errorRate: 0,
        p50Latency: 0, p95Latency: 0, avgTokensPerSecond: 0,
        queueDepth: 0, concurrentRequests: 0,
        circuitState: 'closed', shedCount: 0, windowMs: 300_000,
      }),
      getHealth: () => ({ status: 'healthy', latencyMs: 0, availableModels: ['m'], lastCheckedAt: 0 }),
      getConfig: () => ({ maxConcurrent: 2, maxQueueDepth: 6, queueTimeoutMs: 30_000, circuitBreakerThreshold: 5, circuitBreakerCooldownMs: 15_000 }),
      updateConfig: () => {},
      onHealthChange: () => {},
      resetCircuitBreaker: () => {},
      refreshModels: async () => {},
      recordExternalFailure: () => {},
      dispose: () => {},
      callCount: () => 0,
      externalFailCount: () => 0,
    }
    const b = createFakeGateway({
      streamResponses: [[{ delta: 'ok', done: false }, { delta: '', done: true }]],
      availableModels: ['m'],
    })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    const events: ProviderRoutingEvent[] = []
    router.onRoutingEvent(e => events.push(e))
    const chunks: StreamChunk[] = []
    let caught: unknown
    try {
      for await (const chunk of router.stream(chatReq('m'))) chunks.push(chunk)
    } catch (err) { caught = err }
    expect(caught).toBeDefined()
    // We got the partial chunk before the mid-stream failure.
    expect(chunks.map(c => c.delta).join('')).toContain('partial')
    // No attempt to continue on b.
    expect(b.callCount()).toBe(0)
    expect(events.filter(e => e.type === 'provider_stream_failed')).toHaveLength(1)
  })
})
