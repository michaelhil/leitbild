// ============================================================================
// Regression tests for PUT /providers/:name.
//
// Bug: a PUT carrying only non-apiKey fields (e.g. pinnedModels) used to
// silently overwrite the in-memory key with '', breaking env-only providers
// (gray dot in UI, chat 401s) until the next restart. See providers-config.ts
// `'apiKey' in body` gate.
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providersConfigRoutes } from './providers-config.ts'
import { createProviderKeys } from '../../llm/provider-keys.ts'
import { createProviderPolicyStore, mergeWithEnv } from '../../llm/providers-store.ts'
import type { AgentsWorkspaceRuntime } from '../../workspace-runtime.ts'

const findHandler = (method: string, path: string) => {
  for (const entry of providersConfigRoutes) {
    if (entry.method !== method) continue
    const m = path.match(entry.pattern)
    if (m) return { handler: entry.handler, match: m }
  }
  throw new Error(`no route for ${method} ${path}`)
}

const buildWorkspaceRuntime = async (
  providersJson: object,
  envKeyName: string,
  envKeyValue: string,
): Promise<{ system: AgentsWorkspaceRuntime; storePath: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'leitbild-pc-'))
  const storePath = join(dir, 'providers.json')
  const storeData = {
    version: 1,
    providers: providersJson as never,
    defaults: { modelFallback: ['openai:gpt-4.1-mini'] },
  }
  await writeFile(storePath, JSON.stringify(storeData))
  // Seed providerKeys from the merged (env+store) shape, the way boot does.
  const prev = process.env[envKeyName]
  process.env[envKeyName] = envKeyValue
  const merged = mergeWithEnv(storeData)
  if (prev === undefined) delete process.env[envKeyName]
  else process.env[envKeyName] = prev
  const providerKeys = createProviderKeys(merged)
  const system = {
    providersStorePath: storePath,
    providerKeys,
    providerConfig: { baseUrls: {} as Record<string, string | undefined> },
    gateways: {},
    llm: { getOrder: () => [] },
    refreshAvailableModels: () => {},
    providerPolicy: createProviderPolicyStore(storePath, storeData),
  } as unknown as AgentsWorkspaceRuntime
  return { system, storePath }
}

describe('PUT /providers/:name', () => {
  test('pinning models on an env-only provider does NOT wipe the in-memory key', async () => {
    const { system } = await buildWorkspaceRuntime(
      { kimi: { pinnedModels: [] } },  // file has NO apiKey for kimi
      'KIMI_API_KEY',
      'sk-env-only-kimi-key',
    )
    expect(system.providerKeys.get('kimi')).toBe('sk-env-only-kimi-key')

    const { handler, match } = findHandler('PUT', '/providers/kimi')
    const req = new Request('http://localhost/providers/kimi', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinnedModels: ['kimi-k2.6'] }),
    })
    const res = await handler(req, match, { system, broadcastAllWorkspaces: () => {} } as never)
    expect(res.status).toBe(200)

    // The bug: this used to be ''. With the fix, env key survives.
    expect(system.providerKeys.get('kimi')).toBe('sk-env-only-kimi-key')
  })

  test('explicit apiKey:null still clears the in-memory key', async () => {
    const { system } = await buildWorkspaceRuntime(
      { kimi: { apiKey: 'stored', pinnedModels: [] } },
      'KIMI_API_KEY',
      '',
    )
    expect(system.providerKeys.get('kimi')).toBe('stored')

    const { handler, match } = findHandler('PUT', '/providers/kimi')
    const req = new Request('http://localhost/providers/kimi', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: null }),
    })
    await handler(req, match, { system, broadcastAllWorkspaces: () => {} } as never)
    expect(system.providerKeys.get('kimi')).toBe('')
  })

  test('saving a new apiKey replaces the in-memory key', async () => {
    const { system } = await buildWorkspaceRuntime({ kimi: {} }, 'KIMI_API_KEY', '')
    const { handler, match } = findHandler('PUT', '/providers/kimi')
    const req = new Request('http://localhost/providers/kimi', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-fresh' }),
    })
    await handler(req, match, { system, broadcastAllWorkspaces: () => {} } as never)
    expect(system.providerKeys.get('kimi')).toBe('sk-fresh')
  })

  test('PUT preserves stored `order` on disk', async () => {
    const order = ['openai', 'kimi', 'gemini']
    const { system, storePath } = await buildWorkspaceRuntime(
      { kimi: { pinnedModels: [] } } as never,
      'KIMI_API_KEY',
      'sk-env',
    )
    // Re-write store with an order key (buildWorkspaceRuntime doesn't accept order).
    const { readFile } = await import('node:fs/promises')
    await writeFile(storePath, JSON.stringify({
      version: 1,
      providers: { kimi: { pinnedModels: [] } },
      order,
      defaults: { modelFallback: ['openai:gpt-4.1-mini'] },
    }))

    const { handler, match } = findHandler('PUT', '/providers/kimi')
    const req = new Request('http://localhost/providers/kimi', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinnedModels: ['kimi-k2.6'] }),
    })
    await handler(req, match, { system, broadcastAllWorkspaces: () => {} } as never)

    const after = JSON.parse(await readFile(storePath, 'utf-8'))
    expect(after.order).toEqual(order)
  })
})

describe('/providers/fallback', () => {
  test('uses the policy route and persists without losing provider settings', async () => {
    const { system, storePath } = await buildWorkspaceRuntime(
      { openai: { apiKey: 'stored-key' } },
      'OPENAI_API_KEY',
      '',
    )
    const { handler, match } = findHandler('PUT', '/providers/fallback')
    const req = new Request('http://localhost/providers/fallback', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain: ['openai:gpt-5.4-mini'] }),
    })

    const res = await handler(req, match, { system, broadcastAllWorkspaces: () => {} } as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ saved: true, chain: ['openai:gpt-5.4-mini'] })

    const stored = JSON.parse(await Bun.file(storePath).text())
    expect(stored.providers.openai.apiKey).toBe('stored-key')
    expect(stored.defaults.modelFallback).toEqual(['openai:gpt-5.4-mini'])
  })
})
