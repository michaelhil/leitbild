import { expect, test } from 'bun:test'
import { buildProvidersFromConfig, warmProviderModels } from './providers-setup.ts'
import { parseProviderConfig, PROVIDER_PROFILES } from './providers-config.ts'
import { createProviderKeys } from './provider-keys.ts'
import { mergeWithEnv, type ProviderMergeInput } from './providers-store.ts'

const fixture = () => {
  const calls: string[] = []
  const server = Bun.serve({ port: 0, fetch: async request => {
    const path = new URL(request.url).pathname
    calls.push(path)
    if (path === '/api/ps') return Response.json({ models: [] })
    if (path === '/api/tags') return Response.json({ models: [{ name: 'fixture', details: {} }] })
    if (path.endsWith('/models')) return Response.json({ data: [{ id: 'fixture', context_length: 128000 }] })
    if (path.endsWith('/chat/completions')) return Response.json({ choices: [{ message: { role: 'assistant', content: 'fixture reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    return Response.json({ error: `Unexpected fixture request ${path}` }, { status: 400 })
  } })
  const origin = `http://127.0.0.1:${server.port}`
  const baseUrlOverrides = Object.fromEntries(Object.keys(PROVIDER_PROFILES).map(name => [name, `${origin}/${name}/v1`]))
  const merged = (providers: ProviderMergeInput['providers']) => mergeWithEnv({ version: 1, providers }, { env: {} })
  return { calls, server, origin, baseUrlOverrides, merged }
}

test('ollama-only boot and runtime discovery never contact constructed cloud gateways or allow a pinned cloud call', async () => {
  const { calls, server, origin, baseUrlOverrides, merged } = fixture()
  const store = merged({ openai: { apiKey: 'fixture-not-a-secret', enabled: true } })
  const keys = createProviderKeys(store)
  const setup = buildProvidersFromConfig(parseProviderConfig({ env: { PROVIDER: 'ollama', OLLAMA_URL: origin }, fileStore: store }), { providerKeys: keys, baseUrlOverrides, isActive: () => false })
  try {
    const result = await warmProviderModels(setup.gateways, setup.isDiscoveryEnabled, 500)
    expect(calls.every(path => path.startsWith('/api/'))).toBe(true)
    expect(calls).toContain('/api/tags')
    expect(result.openai?.status).toBe('skipped')
    expect(await setup.router.models()).toEqual(['ollama:fixture'])
    await expect(setup.router.chat({ model: 'openai:fixture', messages: [{ role: 'user', content: 'Test' }] })).rejects.toThrow()
    expect(calls.some(path => path.includes('openai'))).toBe(false)
    expect(setup.monitors.openai?.getState().sub).toBe('disabled')
    // An explicit named-provider diagnostic remains a deliberate UI action.
    await setup.gateways.openai!.refreshModels()
    expect(calls.filter(path => path.includes('openai'))).toEqual(['/openai/v1/models'])
  } finally { setup.dispose(); server.stop(true) }
})

test('catalog discovery honors live keys and enablement while keyless local providers retain their documented exemption', async () => {
  const { calls, server, origin, baseUrlOverrides, merged } = fixture()
  const store = merged({ openai: { apiKey: 'fixture-not-a-secret', enabled: false } })
  const keys = createProviderKeys(store)
  const setup = buildProvidersFromConfig(parseProviderConfig({ env: { OLLAMA_URL: origin }, fileStore: store }), { providerKeys: keys, baseUrlOverrides, isActive: () => false })
  try {
    const warm = await warmProviderModels(setup.gateways, setup.isDiscoveryEnabled, 500)
    expect(warm.openai?.status).toBe('skipped')
    expect(calls.some(path => path.includes('openai'))).toBe(false)
    expect(await setup.router.models()).toEqual(expect.arrayContaining(['ollama:fixture', 'llamacpp:fixture']))
    expect((await setup.router.models()).some(id => id.startsWith('openai:'))).toBe(false)
    keys.setEnabled('openai', true)
    expect((await setup.router.models()).some(id => id.startsWith('openai:'))).toBe(true)
    expect(calls.filter(path => path.includes('openai'))).toEqual(['/openai/v1/models'])
    keys.set('openai', '')
    expect((await setup.router.models()).some(id => id.startsWith('openai:'))).toBe(false)
    keys.setEnabled('llamacpp', false)
    expect((await setup.router.models()).some(id => id.startsWith('llamacpp:'))).toBe(false)
    expect(calls.every(path => path.startsWith('/api/') || path === '/llamacpp/v1/models' || path === '/openai/v1/models')).toBe(true)
  } finally { setup.dispose(); server.stop(true) }
})


test('an explicitly disabled keyless local provider stays disabled after boot', async () => {
  const { calls, server, origin, baseUrlOverrides, merged } = fixture()
  const store = merged({ llamacpp: { enabled: false } }), keys = createProviderKeys(store)
  const setup = buildProvidersFromConfig(parseProviderConfig({ env: { OLLAMA_URL: origin }, fileStore: store }), { providerKeys: keys, baseUrlOverrides, isActive: () => false })
  try {
    expect(keys.isUserEnabled('llamacpp')).toBe(false)
    const warm = await warmProviderModels(setup.gateways, setup.isDiscoveryEnabled, 500)
    expect(warm.llamacpp?.status).toBe('skipped')
    expect((await setup.router.models()).some(id => id.startsWith('llamacpp:'))).toBe(false)
    expect(calls.every(path => path.startsWith('/api/'))).toBe(true)
  } finally { setup.dispose(); server.stop(true) }
})
