import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProviderPolicyStore, loadProviderStore, saveProviderStore, mergeWithEnv, STORE_VERSION } from './providers-store.ts'

const defaults = { modelFallback: ['openai:gpt-4.1-mini'] }

describe('providers-store', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'leitbild-store-'))
    path = join(dir, 'providers.json')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('load on missing file returns empty data, no warnings', async () => {
    const { data, warnings } = await loadProviderStore(path)
    expect(data.version).toBe(STORE_VERSION)
    expect(data.providers).toEqual({})
    expect(data.defaults.modelFallback.length).toBeGreaterThan(0)
    expect(warnings).toHaveLength(0)
  })

  test('save → load roundtrip preserves provider entries', async () => {
    await saveProviderStore(path, {
      version: STORE_VERSION,
      providers: {
        cerebras: { apiKey: 'sk-cere', enabled: true, maxConcurrent: 5 },
        groq: { apiKey: 'gsk-groq', enabled: false },
        ollama: { enabled: true, maxConcurrent: 4 },
      },
      defaults,
    })
    const { data, warnings } = await loadProviderStore(path)
    expect(warnings).toHaveLength(0)
    expect(data.providers.cerebras).toEqual({ apiKey: 'sk-cere', enabled: true, maxConcurrent: 5 })
    expect(data.providers.groq).toEqual({ apiKey: 'gsk-groq', enabled: false })
    expect(data.providers.ollama).toEqual({ enabled: true, maxConcurrent: 4 })
  })

  test('save sets file mode 0600', async () => {
    await saveProviderStore(path, { version: STORE_VERSION, providers: { cerebras: { apiKey: 'x' } }, defaults })
    const s = await stat(path)
    // Mode bits only (mask off type). On some systems temp dir permissions
    // may differ; we just assert group/world have no rwx.
    expect(s.mode & 0o077).toBe(0)
  })

  test('load warns when file mode is wider than 0600', async () => {
    await writeFile(path, JSON.stringify({ version: STORE_VERSION, providers: {}, defaults }))
    await chmod(path, 0o644)
    const { warnings } = await loadProviderStore(path)
    expect(warnings.some(w => w.includes('permissive mode'))).toBe(true)
  })

  test('load rejects invalid JSON', async () => {
    await writeFile(path, '{not json', 'utf-8')
    await expect(loadProviderStore(path)).rejects.toThrow('not valid JSON')
  })

  test('load rejects a schema version mismatch', async () => {
    await writeFile(path, JSON.stringify({ version: 99, providers: { cerebras: { apiKey: 'k' } }, defaults }))
    await expect(loadProviderStore(path)).rejects.toThrow('canonical provider schema')
  })

  test('load rejects unknown fields instead of stripping them', async () => {
    await writeFile(path, JSON.stringify({
      version: STORE_VERSION,
      providers: { cerebras: { apiKey: 'k', legacySetting: true } },
      defaults,
    }))
    await expect(loadProviderStore(path)).rejects.toThrow('canonical provider schema')
  })

  test('load rejects the pre-consolidation shape without defaults', async () => {
    await writeFile(path, JSON.stringify({ version: STORE_VERSION, providers: {} }))
    await expect(loadProviderStore(path)).rejects.toThrow('canonical provider schema')
  })

  test('provider policy updates the canonical file without losing provider settings', async () => {
    const initial = {
      version: STORE_VERSION,
      providers: { groq: { apiKey: 'stored' } },
      defaults,
    } as const
    await saveProviderStore(path, initial)
    const policy = createProviderPolicyStore(path, initial)
    await policy.setModelFallback(['groq:llama-3.3-70b-versatile'])
    const { data } = await loadProviderStore(path)
    expect(data.providers.groq?.apiKey).toBe('stored')
    expect(data.defaults.modelFallback).toEqual(['groq:llama-3.3-70b-versatile'])
  })

  test('atomic write: save is visible either wholly or not at all', async () => {
    // Pre-write a file; then save a new version; before the save returns,
    // the target file should either be the old content or the new one —
    // never partial. We can't easily force a crash in a unit test, but we
    // can verify the temp file is cleaned up (rename moved it).
    await saveProviderStore(path, { version: STORE_VERSION, providers: { groq: { apiKey: 'first' } }, defaults })
    await saveProviderStore(path, { version: STORE_VERSION, providers: { groq: { apiKey: 'second' } }, defaults })
    const { data } = await loadProviderStore(path)
    expect(data.providers.groq?.apiKey).toBe('second')
    // Temp file should not linger.
    try {
      await stat(`${path}.tmp`)
      throw new Error('temp file leaked')
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
    }
  })
})

describe('mergeWithEnv', () => {
  test('env wins over stored', () => {
    const merged = mergeWithEnv(
      { version: STORE_VERSION, providers: { cerebras: { apiKey: 'stored-key' } } },
      { env: { CEREBRAS_API_KEY: 'env-key' } },
    )
    expect(merged.cloud.cerebras?.apiKey).toBe('env-key')
    expect(merged.cloud.cerebras?.source).toBe('env')
  })

  test('stored used when env missing', () => {
    const merged = mergeWithEnv(
      { version: STORE_VERSION, providers: { cerebras: { apiKey: 'stored-key' } } },
      { env: {} },
    )
    expect(merged.cloud.cerebras?.apiKey).toBe('stored-key')
    expect(merged.cloud.cerebras?.source).toBe('stored')
  })

  test('source=none when neither env nor stored has a key', () => {
    const merged = mergeWithEnv({ version: STORE_VERSION, providers: {} }, { env: {} })
    expect(merged.cloud.cerebras?.source).toBe('none')
    expect(merged.cloud.cerebras?.apiKey).toBe('')
  })

  test('maskedKey format', () => {
    const merged = mergeWithEnv(
      { version: STORE_VERSION, providers: { groq: { apiKey: 'gsk_abcdefghijkl' } } },
      { env: {} },
    )
    expect(merged.cloud.groq?.maskedKey).toBe('•••ijkl')
  })

  test('env keys are trimmed (whitespace stripped)', () => {
    const merged = mergeWithEnv(
      { version: STORE_VERSION, providers: {} },
      { env: { GROQ_API_KEY: '  padded-key  ' } },
    )
    expect(merged.cloud.groq?.apiKey).toBe('padded-key')
  })

  test('maxConcurrent: env > stored', () => {
    const merged = mergeWithEnv(
      {
        version: STORE_VERSION,
        providers: { cerebras: { apiKey: 'k', maxConcurrent: 3 } },
      },
      { env: { CEREBRAS_MAX_CONCURRENT: '7' } },
    )
    expect(merged.cloud.cerebras?.maxConcurrent).toBe(7)
  })

  test('enabled defaults to true when key present', () => {
    const merged = mergeWithEnv(
      { version: STORE_VERSION, providers: {} },
      { env: { GROQ_API_KEY: 'k' } },
    )
    expect(merged.cloud.groq?.enabled).toBe(true)
  })

  test('enabled defaults to false when no key anywhere', () => {
    const merged = mergeWithEnv({ version: STORE_VERSION, providers: {} }, { env: {} })
    expect(merged.cloud.cerebras?.enabled).toBe(false)
  })

  test('ollama defaults to enabled', () => {
    const merged = mergeWithEnv({ version: STORE_VERSION, providers: {} }, { env: {} })
    expect(merged.ollama.enabled).toBe(true)
  })
})
