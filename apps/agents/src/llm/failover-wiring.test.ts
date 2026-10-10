// ============================================================================
// End-to-end: production failures with real wiring; only the network is a
// local fixture. Real buildProvidersFromConfig (OpenRouter at its catalog
// maxConcurrent), real gateways and semaphores, real OpenAI-compatible wire,
// real router, real LLMService and a real AI agent with a tool.
//
// 2026-10-09: fourteen Assistant rooms asked gpt-5.4 at once. OpenRouter's
// one slot and six queue places were taken, so its gateway shed the next
// request; the router reached direct OpenAI, whose wire refuses gpt-5.4 tools
// at default effort before any I/O. Rooms showed "[error: unknown]
// unsupported_provider_transport: ...". The room must get the shed as the
// cause, with a remedy, and the refusal only as detail.
//
// 2026-10-10: OpenRouter answered with 402 in_flight_budget_exhausted. The
// wire classified it bad_request, the router rethrew it, LLMService walked the
// default model chain to openai:gpt-5.4-mini, whose wire refused the tool
// request, and the room again showed that refusal. The room must get
// OpenRouter's 402 in its own words, and, since the refusal clears once
// in-flight requests settle, the next turn must reach OpenRouter again.
// ============================================================================

import { expect, test } from 'bun:test'
import { createAIAgent, type Decision } from '../agents/ai-agent.ts'
import type { ToolDefinition } from '../core/types/tool.ts'
import { PROVIDER_PROFILES } from './provider-catalog.ts'
import { createProviderKeys } from './provider-keys.ts'
import { buildProvidersFromConfig } from './providers-setup.ts'
import { mergeWithEnv } from './providers-store.ts'
import { createLLMService } from './llm-service.ts'
import { DEFAULT_MODEL_FALLBACK } from './models/catalog.ts'

// Only OpenRouter may be dispatched; every other route must refuse or shed
// before any I/O.
const startFixture = (openrouterChat: (released: Promise<void>) => Promise<Response>) => {
  let release: () => void = () => {}
  const released = new Promise<void>(resolve => { release = resolve })
  const chatRequests: Record<string, number> = { openrouter: 0, openai: 0, anthropic: 0, kimi: 0 }
  const server = Bun.serve({ port: 0, fetch: async request => {
    const [, provider, ...rest] = new URL(request.url).pathname.split('/')
    const path = rest.join('/')
    if (path === 'models') {
      if (provider === 'openrouter') return Response.json({ data: [{ id: 'openai/gpt-5.4', context_length: 1_050_000 }] })
      if (provider === 'openai') return Response.json({ data: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-mini' }] })
      if (provider === 'kimi') return Response.json({ data: [{ id: 'moonshot-v1-8k', context_length: 8192 }] })
      return Response.json({ data: [] })
    }
    if (path === 'chat/completions' && provider !== undefined && provider in chatRequests) {
      chatRequests[provider]!++
      if (provider !== 'openrouter') return new Response('this route must not be dispatched', { status: 500 })
      return openrouterChat(released)
    }
    return new Response('unexpected path', { status: 404 })
  } })
  return { url: `http://localhost:${server.port}`, chatRequests, release, stop: () => server.stop(true) }
}

const cloud = (name: 'openrouter' | 'openai' | 'kimi') => ({ apiKey: 'fixture-key', maxConcurrent: PROVIDER_PROFILES[name].defaultMaxConcurrent, source: 'stored' as const, enabled: true })

const buildSetup = (fixtureUrl: string, names: ReadonlyArray<'openrouter' | 'openai' | 'kimi'>) => {
  const providerKeys = createProviderKeys(mergeWithEnv({ version: 1, providers: {} }, { env: {} as Record<string, string | undefined> }))
  for (const name of names) providerKeys.set(name, 'fixture-key')
  return buildProvidersFromConfig({
    order: ['openrouter', 'anthropic', 'openai', 'kimi'].filter(name => name === 'anthropic' || names.some(listed => listed === name)),
    cloud: Object.fromEntries(names.map(name => [name, cloud(name)])),
    ollamaUrl: '', ollamaMaxConcurrent: 2, baseUrls: {}, ollamaOnly: false,
    forceFailProvider: null, droppedFromOrder: [], orderFromUser: false,
  }, {
    providerKeys,
    baseUrlOverrides: Object.fromEntries(['openrouter', 'openai', 'anthropic', 'kimi'].map(name => [name, `${fixtureUrl}/${name}`])),
    // No heartbeat traffic during the test.
    isActive: () => false,
  })
}

const tools: ReadonlyArray<ToolDefinition> = [{
  type: 'function',
  function: { name: 'signals_search', description: 'Find plant signals', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
}]

test('a room whose request is shed by OpenRouter reports the shed and its remedy, not the direct-OpenAI refusal', async () => {
  const fx = startFixture(async released => {
    await released
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'earlier room answered' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
  })
  const setup = buildSetup(fx.url, ['openrouter', 'openai'])
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

test('a room whose gpt-5.4 turn OpenRouter answers with 402 in_flight_budget_exhausted reports it in OpenRouter\'s words, and the next turn is served', async () => {
  const body = { error: {
    message: 'This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.',
    code: 402, metadata: { reason: 'in_flight_budget_exhausted', limit_source: 'openrouter_in_flight_budget' },
  } }
  // The agent streams; the second answer is an SSE stream.
  const served = [JSON.stringify({ choices: [{ delta: { content: 'served once in-flight requests settled' }, finish_reason: 'stop' }] }), '[DONE]']
  let openrouterAnswers = 0
  const fx = startFixture(async () => openrouterAnswers++ === 0
    ? Response.json(body, { status: 402 })
    : new Response(served.map(line => `data: ${line}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }))
  const setup = buildSetup(fx.url, ['openrouter', 'openai', 'kimi'])
  try {
    await Promise.all(['openrouter', 'openai', 'kimi'].map(name => setup.gateways[name]!.refreshModels()))
    const decisions: Decision[] = []
    const switches: string[] = []
    // The production default chain: gpt-5.4-mini refuses tools at default
    // effort and, like the production turn of 24k tokens after three tool
    // rounds, the request exceeds moonshot-v1-8k's window.
    const llm = createLLMService({ router: setup.router, getSystemChain: () => DEFAULT_MODEL_FALLBACK })
      .bound({ source: 'agent', onChainSwitch: (_preferred, effective) => switches.push(effective) })
    const agent = createAIAgent(
      { name: 'Leitbild Assistant', model: 'gpt-5.4', persona: 'Operator assistant.' },
      llm,
      decision => { decisions.push(decision) },
      { toolDefinitions: tools, toolExecutor: async calls => calls.map(() => ({ success: true, data: 'unused' })) },
    )
    const trend = '2026-10-10T09:22:00Z PZR level 54.2 %\n'.repeat(1_000)
    agent.receive({ id: 'q1', senderId: 'operator', content: `Explain this pressurizer level trend:\n${trend}`, timestamp: Date.now(), type: 'chat', roomId: 'display-probe' })
    await agent.whenIdle()

    const response = decisions[0]?.response
    if (response?.action !== 'error') throw new Error(`expected an error decision, got ${JSON.stringify(response)}`)
    // The posted room message is `[error: ${code}] ${message}` (spawn.ts).
    // No other route carries the request, so the router reports OpenRouter's
    // refusal as the cause, in its words and reason, not its raw body.
    expect(response.code).toBe('provider_down')
    expect(response.message).toBe([
      'gpt-5.4 could not be served.',
      'openrouter: openrouter in-flight budget exhausted (HTTP 402, in_flight_budget_exhausted): This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.',
      "Retry in a few seconds, once openrouter's in-flight requests settle; if it recurs, add openrouter credits.",
      'openai: skipped before dispatch — unsupported_provider_transport: direct OpenAI Chat Completions requires explicit none reasoning effort for this model with tools; choose none or a supported route such as OpenRouter.',
    ].join(' '))
    expect(response.message).not.toContain('{"error"')
    expect(switches).toEqual([...DEFAULT_MODEL_FALLBACK])
    expect(fx.chatRequests).toEqual({ openrouter: 1, openai: 0, anthropic: 0, kimi: 0 })
    // The refusal is recorded, but holds OpenRouter in no cooldown; neither
    // fallback refusal is a health problem of its provider.
    const monitors = setup.router.getMonitorSnapshot()
    expect([monitors.openrouter?.sub, monitors.openrouter?.lastError?.code]).toEqual(['ok', 'in_flight_limit'])
    expect(monitors.openai?.sub).toBe('ok')
    expect(monitors.kimi?.sub).toBe('ok')

    agent.receive({ id: 'q2', senderId: 'operator', content: 'And now?', timestamp: Date.now(), type: 'chat', roomId: 'display-probe' })
    await agent.whenIdle()
    expect(decisions[1]?.response).toEqual({ action: 'respond', content: 'served once in-flight requests settled' })
    expect(fx.chatRequests).toEqual({ openrouter: 2, openai: 0, anthropic: 0, kimi: 0 })
  } finally {
    fx.release()
    setup.dispose()
    fx.stop()
  }
})
