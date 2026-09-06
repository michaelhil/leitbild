import { expect, test } from 'bun:test'
import type { ChatRequest } from '../core/types/llm.ts'
import { createOllamaProvider } from './ollama.ts'
import { createOllamaGateway } from './gateway.ts'
import { createOpenAICompatibleProvider } from './openai-compatible.ts'
import { createProviderGateway } from './provider-gateway.ts'
import { createProviderRouter } from './router.ts'
import { createLLMService } from './llm-service.ts'
import { isCloudProviderError } from './errors.ts'

const fixture = async () => {
  const ollamaBodies: Record<string, unknown>[] = []
  let cloudCalls = 0
  let backupCalls = 0
  const server = Bun.serve({ port: 0, fetch: async request => {
    const path = new URL(request.url).pathname
    if (path === '/cloud/models') return Response.json({ data: [{ id: 'shared' }] })
    if (path === '/cloud/chat/completions') { cloudCalls++; return new Response('fixture unavailable', { status: 503 }) }
    if (path === '/ollama/api/tags') return Response.json({ models: [{ name: 'shared' }] })
    if (path === '/ollama/api/ps') return Response.json({ models: [] })
    if (path === '/ollama/api/chat') {
      const body = await request.json() as Record<string, unknown>
      ollamaBodies.push(body)
      const result = { model: 'shared', message: { role: 'assistant', content: 'ordinary answer' }, done: true, eval_count: 2, prompt_eval_count: 3 }
      return body.stream ? new Response(`${JSON.stringify(result)}\n`) : Response.json(result)
    }
    return new Response('unexpected path', { status: 404 })
  } })
  const url = `http://localhost:${server.port}`
  const cloud = createProviderGateway(createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => `${url}/cloud`, getApiKey: () => 'fixture' }), {}, { isPermanentError: isCloudProviderError })
  const ollama = createOllamaGateway(createOllamaProvider(`${url}/ollama`), { circuitBreakerThreshold: 1 })
  const backup = createProviderGateway({ models: async () => ['shared'], chat: async () => { backupCalls++; return { content: 'wrong fallback', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } } }, stream: async function*() { backupCalls++; yield { done: true, delta: 'wrong fallback' } } })
  await Promise.all([cloud.refreshModels(), ollama.refreshModels(), backup.refreshModels()])
  const router = createProviderRouter({ cloud, ollama, backup }, { order: ['cloud', 'ollama', 'backup'], contextLookup: async () => ({ contextMax: 0, source: 'fixture_unknown' }) })
  return { router, ollama, ollamaBodies, cloudCalls: () => cloudCalls, backupCalls: () => backupCalls, close: () => { router.dispose(); server.stop(true) } }
}

for (const mode of ['chat', 'stream'] as const) {
  for (const chain of [false, true]) test(`explicit effort is nonfallbackable at Ollama after cloud failure (${mode}, ${chain ? 'service chain' : 'router fallthrough'})`, async () => {
    const fx = await fixture()
    try {
      const provider = chain ? createLLMService({ router: fx.router }).bound({ source: 'agent', fallbackChain: ['ollama:shared', 'backup:shared'] }) : fx.router
      const request: ChatRequest = { model: chain ? 'cloud:shared' : 'shared', messages: [{ role: 'user', content: 'hello' }], reasoningEffort: 'high', think: true }
      const invoke = () => mode === 'chat' ? provider.chat(request) : Array.fromAsync(provider.stream!(request))
      await expect(invoke()).rejects.toThrow('reasoning_effort_unsupported')
      expect(fx.cloudCalls()).toBe(1)
      expect(fx.ollamaBodies).toHaveLength(0)
      expect(fx.backupCalls()).toBe(0)
      expect(fx.ollama.getMetrics().circuitState).toBe('closed')
    } finally { fx.close() }
  })

  test(`ordinary think settings remain exact through real cloud-to-Ollama fallback (${mode})`, async () => {
    const fx = await fixture()
    try {
      for (const think of [undefined, false, true]) {
        const request: ChatRequest = { model: 'shared', messages: [{ role: 'user', content: 'hello' }], ...(think === undefined ? {} : { think }) }
        if (mode === 'chat') expect((await fx.router.chat(request)).content).toBe('ordinary answer')
        else expect((await Array.fromAsync(fx.router.stream(request))).some(chunk => chunk.delta.includes('ordinary answer'))).toBe(true)
        const body = fx.ollamaBodies.at(-1)!
        if (think === undefined) expect(body).not.toHaveProperty('think')
        else expect(body.think).toBe(think)
        expect(body).not.toHaveProperty('reasoningEffort')
        expect(body).not.toHaveProperty('reasoning_effort')
      }
      // After the initial fallback, the router prefers the successful local
      // provider for later calls with the same model.
      expect(fx.cloudCalls()).toBe(1)
      expect(fx.backupCalls()).toBe(0)
    } finally { fx.close() }
  })
}
