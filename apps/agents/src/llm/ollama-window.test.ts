import { expect, test } from 'bun:test'
import { createOllamaProvider, DEFAULT_NUM_CTX } from './ollama.ts'
import { createProviderGateway } from './provider-gateway.ts'
import { createProviderRouter } from './router.ts'
import { getContextWindow } from './models/context-window.ts'

for (const mode of ['chat', 'stream'] as const) test(`local allocation bounds metadata and dispatch without silently raising memory (${mode})`, async () => {
  const bodies: Array<{ options: { num_ctx: number } }> = []
  const server = Bun.serve({ port: 0, fetch: async request => {
    if (new URL(request.url).pathname === '/api/tags') return Response.json({ models: [{ name: 'local-model' }] })
    if (new URL(request.url).pathname === '/api/show') return Response.json({ model_info: { 'architecture.context_length': 131_072 } })
    const body = await request.json() as { stream: boolean; options: { num_ctx: number } }
    bodies.push(body)
    const result = { model: 'local-model', message: { content: 'Done' }, done: true, prompt_eval_count: 30_000, eval_count: 1 }
    return body.stream ? new Response(`${JSON.stringify(result)}\n`) : Response.json(result)
  } })
  const url = server.url.origin
  const gateway = createProviderGateway(createOllamaProvider(url))
  await gateway.refreshModels()
  const router = createProviderRouter({ ollama: gateway }, { order: ['ollama'], contextLookup: async (provider, model) => getContextWindow(provider, model, { ollamaBaseUrl: url }) })
  try {
    expect((await router.modelInfo!('local-model')).contextMax).toBe(DEFAULT_NUM_CTX)
    const request = { model: 'local-model', messages: [{ role: 'user' as const, content: 'x'.repeat(120_000) }] }
    const invoke = (numCtx?: number) => mode === 'chat'
      ? router.chat({ ...request, ...(numCtx === undefined ? {} : { numCtx }) })
      : Array.fromAsync(router.stream({ ...request, ...(numCtx === undefined ? {} : { numCtx }) }))
    await expect(invoke()).rejects.toThrow('capacity 16384')
    expect(bodies).toHaveLength(0)
    const result = await invoke(65_536)
    expect(bodies[0]!.options.num_ctx).toBe(65_536)
    expect((Array.isArray(result) ? result.at(-1)! : result).contextMax).toBe(65_536)
    await expect(invoke(0)).rejects.toThrow('positive integer')
    expect(bodies).toHaveLength(1)
  } finally { router.dispose(); server.stop(true) }
})
