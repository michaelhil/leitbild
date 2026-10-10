// LLMService — chain walk, cooldown skip, network retry, chain_switch event.
//
// Uses a hand-rolled fake ProviderRouter (LLMProvider + getMonitorSnapshot)
// so we can drive every code path deterministically without booting the
// gateway/circuit-breaker stack. Its failures are the two the real router
// throws: its own all-failed error (routerFailure) for a bare model id, and
// the provider's error itself for a provider-pinned ref.

import { describe, expect, test } from 'bun:test'
import type { ChatRequest, ChatResponse, StreamChunk } from '../core/types/llm.ts'
import type { MonitorState } from './provider-monitor.ts'
import type { ProviderRouter } from './router.ts'
import { createCloudProviderError, createLLMRequestError, isRouteRefusal } from './errors.ts'
import { mapHttpError } from './openai-compatible-errors.ts'
import { buildOAIBody } from './openai-compatible-wire.ts'
import { createLLMService } from './llm-service.ts'
import { classifyLLMError } from '../agents/error-classify.ts'

interface FakeRouterOpts {
  readonly chat?: (req: ChatRequest) => Promise<ChatResponse>
  readonly stream?: (req: ChatRequest, signal?: AbortSignal) => AsyncIterable<StreamChunk>
  readonly models?: ReadonlyArray<string>
  readonly providerNames?: ReadonlyArray<string>
  readonly monitorSnapshot?: Record<string, MonitorState | null>
}

const fakeRouter = (opts: FakeRouterOpts): ProviderRouter => ({
  chat: opts.chat ?? (async () => ({ content: 'ok', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } })),
  stream: opts.stream ?? (async function*() {
    yield { delta: 'ok', done: false }
    yield { delta: '', done: true, tokensUsed: { prompt: 1, completion: 1 } }
  }),
  models: async () => [...(opts.models ?? [])],
  onRoutingEvent: () => {},
  getProviderNames: () => [...(opts.providerNames ?? [])],
  getAggregatedMetrics: () => ({
    byProvider: {}, lastSuccessByModel: {},
    routingEvents: { bound: 0, allFailed: 0, streamFailed: 0 },
  }),
  getMonitorSnapshot: () => opts.monitorSnapshot ?? {},
  getOrder: () => [],
  setOrder: () => {},
  dispose: () => {},
})

const okChat = async (model: string): Promise<ChatResponse> => ({
  content: `from:${model}`,
  generationMs: 1,
  tokensUsed: { prompt: 1, completion: 1 },
  provider: model.split(':')[0] ?? 'unknown',
})

// router.ts exhausted(): cause, remedy and the other tried routes are in the
// message; no structured attempts travel with the error.
const routerFailure = (message: string): Error =>
  createCloudProviderError({ code: 'provider_down', provider: 'router', message })

describe('LLMService — continuation route isolation', () => {
  const continuation = { provider: 'openrouter' as const, model: 'qwen/reasoner', endpointHash: 'a'.repeat(64), reasoningDetails: [{ type: 'reasoning.encrypted', data: 'opaque' }] }
  const request: ChatRequest = { model: 'openrouter:qwen/reasoner', messages: [{ role: 'assistant', content: '', continuation }] }
  for (const streaming of [false, true]) test(`${streaming ? 'stream' : 'chat'} never switches a continuation to a fallback even during cooldown`, async () => {
    const calls: string[] = []
    const fail = (req: ChatRequest): never => {
      calls.push(req.model)
      throw createCloudProviderError({ code: 'rate_limit', provider: 'openrouter', status: 429, message: 'fixture rate limit' })
    }
    const router = fakeRouter({ chat: async req => fail(req), stream: async function*(req) { fail(req) }, monitorSnapshot: {
      openrouter: { sub: 'backoff', retryAt: Date.now() + 30_000, reason: 'rate_limit', since: Date.now(), modelCount: 0, lastError: null, lastErrorAt: null, consecutiveFailures: 1 },
    } })
    const provider = createLLMService({ router, getSystemChain: () => ['openai:gpt-6-astra'] }).bound({ source: 'agent', fallbackChain: ['other:model'] })
    await expect(streaming ? Array.fromAsync(provider.stream!(request)) : provider.chat(request)).rejects.toThrow('fixture rate limit')
    expect(calls).toEqual(['openrouter:qwen/reasoner'])
  })
  test('mixed state or requested model changes fail before invoking the router', async () => {
    let calls = 0
    const provider = createLLMService({ router: fakeRouter({ chat: async req => { calls++; return okChat(req.model) } }) }).bound({ source: 'agent' })
    await expect(provider.chat({ ...request, model: 'openai:gpt-6-astra' })).rejects.toThrow('provider_continuation_route_mismatch')
    await expect(provider.chat({ ...request, messages: [...request.messages, { role: 'assistant', content: '', continuation: { ...continuation, endpointHash: 'b'.repeat(64) } }] })).rejects.toThrow('provider_continuation_route_mismatch')
    expect(calls).toBe(0)
  })
})

describe('LLMService — cooldown skip', () => {
  test('primary in backoff with retryAt > now+1s → routed to chain[0]', async () => {
    const calls: string[] = []
    const router = fakeRouter({
      chat: async (req) => { calls.push(req.model); return okChat(req.model) },
      monitorSnapshot: {
        gemini: {
          sub: 'backoff', retryAt: Date.now() + 30_000,
          reason: 'rate_limit', since: Date.now(), modelCount: 0,
          lastError: null, lastErrorAt: null, consecutiveFailures: 1,
        },
      },
    })
    const svc = createLLMService({
      router,
      getSystemChain: () => ['openai:gpt-4o-mini'],
    })
    const provider = svc.bound({ source: 'agent' })
    const res = await provider.chat({ model: 'gemini:gemini-2.5-flash', messages: [] })
    // Primary skipped — first call is to chain[0].
    expect(calls[0]).toBe('openai:gpt-4o-mini')
    expect(res.content).toContain('openai:gpt-4o-mini')
  })
})

describe('LLMService — chain walk on fallbackable error', () => {
  test('chunk-0 stream failure on primary walks to chain[0]; emits chain_switch once', async () => {
    const events: Array<{ preferred: string; effective: string }> = []
    const calls: string[] = []
    const router = fakeRouter({
      stream: function (req: ChatRequest) {
        calls.push(req.model)
        if (req.model === 'gemini:gemini-2.5-flash') {
          return (async function*() {
            throw createCloudProviderError({
              code: 'rate_limit', provider: 'gemini', status: 429,
              message: 'rate limited',
            })
            // eslint-disable-next-line no-unreachable
            yield {} as StreamChunk
          })()
        }
        return (async function*() {
          yield { delta: 'pong', done: false }
          yield { delta: '', done: true, tokensUsed: { prompt: 1, completion: 1 } }
        })()
      },
    })
    const svc = createLLMService({ router })
    const provider = svc.bound({
      source: 'agent',
      fallbackChain: ['openai:gpt-5.4-mini'],
      onChainSwitch: (preferred, effective) => events.push({ preferred, effective }),
    })

    let collected = ''
    const stream = provider.stream!({ model: 'gemini:gemini-2.5-flash', messages: [] })
    for await (const chunk of stream) {
      if (chunk.delta) collected += chunk.delta
    }
    expect(collected).toBe('pong')
    expect(calls).toEqual(['gemini:gemini-2.5-flash', 'openai:gpt-5.4-mini'])
    expect(events).toEqual([{ preferred: 'gemini:gemini-2.5-flash', effective: 'openai:gpt-5.4-mini' }])
  })

  test('a configured system chain walks on from the router all-failed error', async () => {
    const events: Array<{ preferred: string; effective: string }> = []
    const calls: string[] = []
    const router = fakeRouter({
      chat: async (req) => {
        calls.push(req.model)
        if (req.model === 'gpt-5.4') throw routerFailure('gpt-5.4 could not be served. openrouter: LLM gateway queue full — request shed (queue_full; maxConcurrent 1).')
        return okChat(req.model)
      },
    })
    const svc = createLLMService({ router, getSystemChain: () => ['openai:gpt-5.4-mini'] })
    const provider = svc.bound({
      source: 'agent',
      onChainSwitch: (preferred, effective) => events.push({ preferred, effective }),
    })

    const res = await provider.chat({ model: 'gpt-5.4', messages: [] })
    expect(res.content).toBe('from:openai:gpt-5.4-mini')
    expect(calls).toEqual(['gpt-5.4', 'openai:gpt-5.4-mini'])
    expect(events).toEqual([{ preferred: 'gpt-5.4', effective: 'openai:gpt-5.4-mini' }])
  })
})

describe('LLMService — bare network retry', () => {
  test('one ECONNRESET on primary retries same model and succeeds; chain not advanced', async () => {
    const calls: string[] = []
    let primaryFails = 1
    const router = fakeRouter({
      chat: async (req) => {
        calls.push(req.model)
        if (req.model === 'gemini:gemini-2.5-flash' && primaryFails > 0) {
          primaryFails--
          throw new Error('socket hang up: ECONNRESET')
        }
        return okChat(req.model)
      },
    })
    const svc = createLLMService({
      router,
      getSystemChain: () => ['openai:gpt-5.4-mini'],
    })
    const provider = svc.bound({ source: 'agent' })
    const res = await provider.chat({ model: 'gemini:gemini-2.5-flash', messages: [] })
    // Two attempts on primary (retry), no advance to chain[0].
    expect(calls).toEqual(['gemini:gemini-2.5-flash', 'gemini:gemini-2.5-flash'])
    expect(res.content).toContain('gemini:gemini-2.5-flash')
  })
})

describe('LLMService — provider auth isolation', () => {
  test('cloud auth error preserves diagnosis but walks to another provider/model', async () => {
    const calls: string[] = []
    const router = fakeRouter({
      chat: async (req) => {
        calls.push(req.model)
        if (req.model === 'primary') {
          throw createCloudProviderError({
            code: 'auth', provider: 'openai', status: 401,
            message: 'invalid key',
          })
        }
        return okChat(req.model)
      },
    })
    const svc = createLLMService({
      router,
      getSystemChain: () => ['fallback-1', 'fallback-2'],
    })
    const provider = svc.bound({ source: 'agent' })
    const response = await provider.chat({ model: 'primary', messages: [] })
    expect(response.content).toContain('fallback-1')
    expect(calls).toEqual(['primary', 'fallback-1'])
  })
})

describe('LLMService — empty chain', () => {
  // An empty system chain disables cross-provider recovery (Providers panel)
  // and an empty per-call chain overrides a configured one. Either way a
  // saturated primary is not answered by another model, even when provider
  // catalogs list others, and the router's own failure reaches the agent
  // with its classification, cause and remedy intact.
  const cases = [
    { name: 'empty system chain', systemChain: [], bind: {} },
    { name: 'empty per-call chain', systemChain: ['openai:gpt-5.4-mini'], bind: { fallbackChain: [] } },
  ] as const
  for (const c of cases) for (const streaming of [false, true]) test(`${c.name}: ${streaming ? 'stream' : 'chat'} rethrows the router failure without trying another model`, async () => {
    const calls: string[] = []
    const switches: string[] = []
    const routed = routerFailure('gpt-5.4 could not be served. openrouter: LLM gateway queue full — request shed (queue_full; maxConcurrent 1). Retry in a few seconds, or raise the openrouter concurrency limit in the Providers panel.')
    const fail = (req: ChatRequest): never => {
      calls.push(req.model)
      throw routed
    }
    const router = fakeRouter({
      providerNames: ['openrouter', 'gemini'],
      models: ['openrouter:openai/gpt-5.4', 'gemini:gemini-2.5-flash'],
      chat: async req => fail(req),
      stream: async function*(req) { fail(req) },
    })
    const provider = createLLMService({ router, getSystemChain: () => c.systemChain }).bound({
      source: 'agent',
      ...c.bind,
      onChainSwitch: (_preferred, effective) => switches.push(effective),
    })
    const request = { model: 'gpt-5.4', messages: [] }
    const err = await (streaming ? Array.fromAsync(provider.stream!(request)) : provider.chat(request)).then(() => null, (error: unknown) => error)
    expect(err).toBe(routed)
    expect(classifyLLMError(err)).toEqual({ code: 'provider_down', message: routed.message, providerHint: 'router' })
    expect(calls).toEqual(['gpt-5.4'])
    expect(switches).toEqual([])
  })
})

// Production 2026-10-10: OpenRouter answered a gpt-5.4 tool turn with 402
// in_flight_budget_exhausted and the agent layer walked the system chain. Its
// openai:gpt-5.4-mini refused the tool request before dispatch, the walk
// stopped there, and the room showed that refusal instead of the 402. The
// wire now classifies that 402 in_flight_limit; the router reports it inside
// its provider_down summary unless the route is pinned, when it arrives as
// here, unchanged.
describe('LLMService — fallback route refusals', () => {
  const tools = [{ type: 'function' as const, function: { name: 'signals_search', description: 'Find plant signals', parameters: { type: 'object', properties: {} } } }]
  const inFlight = mapHttpError('openrouter', 402, JSON.stringify({ error: {
    message: 'This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.',
    code: 402, metadata: { reason: 'in_flight_budget_exhausted', limit_source: 'openrouter_in_flight_budget' },
  } }), null)
  // The pinned route refuses exactly as the real router returns a sole
  // route's refusal: the wire's or the capacity check's own error.
  const routed = (served: ReadonlySet<string>) => (req: ChatRequest): ChatResponse => {
    if (req.model === 'gpt-5.4') throw inFlight
    if (req.model.startsWith('openai:')) buildOAIBody(req, false, 'openai')
    if (req.model === 'kimi:moonshot-v1-8k' && !served.has(req.model)) throw createLLMRequestError('context_capacity', 'Request estimate 24800 tokens exceeds kimi:moonshot-v1-8k capacity 8192.')
    return { content: `from:${req.model}`, generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }
  }
  const run = async (streaming: boolean, request: ChatRequest, served: ReadonlySet<string> = new Set()) => {
    const calls: string[] = []
    const switches: string[] = []
    const answer = routed(served)
    const router = fakeRouter({
      chat: async req => { calls.push(req.model); return answer(req) },
      stream: async function*(req) { calls.push(req.model); yield { delta: answer(req).content, done: false }; yield { delta: '', done: true } },
    })
    const provider = createLLMService({ router, getSystemChain: () => ['openai:gpt-5.4-mini', 'kimi:moonshot-v1-8k'] })
      .bound({ source: 'agent', onChainSwitch: (_preferred, effective) => switches.push(effective) })
    const outcome = await (streaming
      ? Array.fromAsync(provider.stream!(request)).then(chunks => chunks.map(chunk => chunk.delta).join(''))
      : provider.chat(request).then(response => response.content)
    ).then(content => ({ content }), (error: unknown) => ({ error }))
    return { ...outcome, calls, switches }
  }

  for (const streaming of [false, true]) {
    const mode = streaming ? 'stream' : 'chat'
    test(`${mode}: when every fallback refuses, the failure that started the walk is reported`, async () => {
      const result = await run(streaming, { model: 'gpt-5.4', messages: [{ role: 'user', content: 'Show the trend.' }], tools })
      expect('error' in result && result.error).toBe(inFlight)
      expect(classifyLLMError(inFlight)).toEqual({ code: 'rate_limited', providerHint: 'openrouter', message: inFlight.message })
      expect(inFlight.message).toBe('openrouter in-flight budget exhausted (HTTP 402, in_flight_budget_exhausted): This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.')
      expect(result.calls).toEqual(['gpt-5.4', 'openai:gpt-5.4-mini', 'kimi:moonshot-v1-8k'])
      expect(result.switches).toEqual(['openai:gpt-5.4-mini', 'kimi:moonshot-v1-8k'])
    })

    test(`${mode}: a refusing fallback is skipped and the next fallback serves`, async () => {
      const result = await run(streaming, { model: 'gpt-5.4', messages: [{ role: 'user', content: 'Show the trend.' }], tools }, new Set(['kimi:moonshot-v1-8k']))
      expect('content' in result && result.content).toBe('from:kimi:moonshot-v1-8k')
      expect(result.calls).toEqual(['gpt-5.4', 'openai:gpt-5.4-mini', 'kimi:moonshot-v1-8k'])
    })

    test(`${mode}: the requested model's own refusal still ends the walk unchanged`, async () => {
      const result = await run(streaming, { model: 'openai:gpt-5.4', messages: [{ role: 'user', content: 'Show the trend.' }], tools }, new Set(['kimi:moonshot-v1-8k']))
      const error = 'error' in result ? result.error : undefined
      expect(isRouteRefusal(error) && error.code).toBe('unsupported_provider_transport')
      expect(result.calls).toEqual(['openai:gpt-5.4'])
      expect(result.switches).toEqual([])
    })
  }
})
