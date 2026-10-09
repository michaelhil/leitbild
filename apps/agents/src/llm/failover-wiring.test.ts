// ============================================================================
// End-to-end: the 2026-10-09 production failure with real wiring; only the
// network is a local fixture. Real buildProvidersFromConfig (OpenRouter at its
// catalog maxConcurrent), real gateways and semaphores, real OpenAI-compatible
// wire, real router, real LLMService and a real AI agent with a tool.
//
// Fourteen Assistant rooms asked gpt-5.4 at once. OpenRouter's one slot and
// six queue places were taken, so its gateway shed the next request; the
// router reached direct OpenAI, whose wire refuses gpt-5.4 tools at default
// effort before any I/O. Rooms showed "[error: unknown]
// unsupported_provider_transport: ...". The room must get the shed as the
// cause, with a remedy, and the refusal only as detail.
// ============================================================================

import { expect, test } from 'bun:test'
import { createAIAgent, type Decision } from '../agents/ai-agent.ts'
import type { ToolDefinition } from '../core/types/tool.ts'
import { PROVIDER_PROFILES } from './provider-catalog.ts'
import { createProviderKeys } from './provider-keys.ts'
import { buildProvidersFromConfig } from './providers-setup.ts'
import { mergeWithEnv } from './providers-store.ts'
import { createLLMService } from './llm-service.ts'

const startFixture = () => {
  let release: () => void = () => {}
  const released = new Promise<void>(resolve => { release = resolve })
  const chatRequests: Record<string, number> = { openrouter: 0, openai: 0, anthropic: 0 }
  const server = Bun.serve({ port: 0, fetch: async request => {
    const [, provider, ...rest] = new URL(request.url).pathname.split('/')
    const path = rest.join('/')
    if (path === 'models') {
      if (provider === 'openrouter') return Response.json({ data: [{ id: 'openai/gpt-5.4', context_length: 1_050_000 }] })
      if (provider === 'openai') return Response.json({ data: [{ id: 'gpt-5.4' }] })
      return Response.json({ data: [] })
    }
    if (path === 'chat/completions' && provider !== undefined && provider in chatRequests) {
      chatRequests[provider]!++
      if (provider !== 'openrouter') return new Response('this route must not be dispatched', { status: 500 })
      await released
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'earlier room answered' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    }
    return new Response('unexpected path', { status: 404 })
  } })
  return { url: `http://localhost:${server.port}`, chatRequests, release, stop: () => server.stop(true) }
}

const tools: ReadonlyArray<ToolDefinition> = [{
  type: 'function',
  function: { name: 'signals_search', description: 'Find plant signals', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
}]

test('a room whose request is shed by OpenRouter reports the shed and its remedy, not the direct-OpenAI refusal', async () => {
  const fx = startFixture()
  const providerKeys = createProviderKeys(mergeWithEnv({ version: 1, providers: {} }, { env: {} as Record<string, string | undefined> }))
  providerKeys.set('openrouter', 'fixture-key')
  providerKeys.set('openai', 'fixture-key')
  const cloud = (name: 'openrouter' | 'openai') => ({ apiKey: 'fixture-key', maxConcurrent: PROVIDER_PROFILES[name].defaultMaxConcurrent, source: 'stored' as const, enabled: true })
  const setup = buildProvidersFromConfig({
    order: ['openrouter', 'anthropic', 'openai'],
    cloud: { openrouter: cloud('openrouter'), openai: cloud('openai') },
    ollamaUrl: '', ollamaMaxConcurrent: 2, baseUrls: {}, ollamaOnly: false,
    forceFailProvider: null, droppedFromOrder: [], orderFromUser: false,
  }, {
    providerKeys,
    baseUrlOverrides: { openrouter: `${fx.url}/openrouter`, openai: `${fx.url}/openai`, anthropic: `${fx.url}/anthropic` },
    // No heartbeat traffic during the test.
    isActive: () => false,
  })
  const blockers: Promise<unknown>[] = []
  try {
    await Promise.all([setup.gateways.openrouter!.refreshModels(), setup.gateways.openai!.refreshModels()])
    const openrouter = setup.gateways.openrouter!
    const { maxConcurrent, maxQueueDepth } = openrouter.getConfig()
    expect(maxConcurrent).toBe(1)

    // Earlier rooms hold every OpenRouter slot and queue place.
    for (let i = 0; i < maxConcurrent + maxQueueDepth; i++) {
      blockers.push(setup.router.chat({ model: 'gpt-5.4', messages: [{ role: 'user', content: `room ${i}` }] }))
    }
    while (fx.chatRequests.openrouter === 0 || openrouter.getMetrics().queueDepth < maxQueueDepth) await Bun.sleep(2)

    const decisions: Decision[] = []
    const llm = createLLMService({ router: setup.router }).bound({ source: 'agent' })
    const agent = createAIAgent(
      { name: 'Leitbild Assistant', model: 'gpt-5.4', persona: 'Operator assistant.' },
      llm,
      decision => { decisions.push(decision) },
      { toolDefinitions: tools, toolExecutor: async calls => calls.map(() => ({ success: true, data: 'unused' })) },
    )
    agent.receive({ id: 'q1', senderId: 'operator', content: 'Show the pressurizer level trend.', timestamp: Date.now(), type: 'chat', roomId: 'room-14' })
    await agent.whenIdle()

    const response = decisions[0]?.response
    if (response?.action !== 'error') throw new Error(`expected an error decision, got ${JSON.stringify(response)}`)
    // The posted room message is `[error: ${code}] ${message}` (spawn.ts).
    expect(response.code).toBe('provider_down')
    expect(response.message).toBe([
      'gpt-5.4 could not be served.',
      'openrouter: LLM gateway queue full — request shed (queue_full; maxConcurrent 1).',
      'Retry in a few seconds, or raise the openrouter concurrency limit in the Providers panel.',
      'openai: skipped before dispatch — unsupported_provider_transport: direct OpenAI Chat Completions requires explicit none reasoning effort for this model with tools; choose none or a supported route such as OpenRouter.',
    ].join(' '))
    expect(fx.chatRequests.openai).toBe(0)
    expect(fx.chatRequests.anthropic).toBe(0)
    // A local refusal is not an OpenAI health problem.
    expect(setup.router.getMonitorSnapshot().openai?.sub).toBe('ok')
  } finally {
    fx.release()
    await Promise.allSettled(blockers)
    setup.dispose()
    fx.stop()
  }
})
