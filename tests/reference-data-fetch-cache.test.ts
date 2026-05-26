import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCacheEntry, conditionalGetHeaders, createFetchCache } from '../src/reference-data/fetch-cache.ts'
import { asSourceId } from '../src/reference-data/types.ts'

const encoder = new TextEncoder()

describe('fetch-cache', () => {
  test('write + read round-trip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leitbild-fetch-cache-'))
    const cache = createFetchCache(root)
    const sourceId = asSourceId('test-source')
    const body = encoder.encode('hello world')
    const entry = buildCacheEntry({
      sourceId,
      body,
      etag: 'abc123',
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    })
    await cache.write(entry, body)
    const read = await cache.read(sourceId)
    expect(read?.etag).toBe('abc123')
    expect(read?.sha256).toBe(entry.sha256)
    expect(await readFile(read!.path, 'utf8')).toBe('hello world')
  })

  test('read returns null for unknown source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leitbild-fetch-cache-'))
    const cache = createFetchCache(root)
    const read = await cache.read(asSourceId('never-written'))
    expect(read).toBeNull()
  })

  test('sha256 mismatch throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leitbild-fetch-cache-'))
    const cache = createFetchCache(root)
    const body = encoder.encode('body')
    const entry = buildCacheEntry({ sourceId: asSourceId('mismatch'), body, etag: null, lastModified: null })
    const wrongBody = encoder.encode('different body')
    await expect(cache.write(entry, wrongBody)).rejects.toThrow(/sha256 mismatch/)
  })

  test('conditionalGetHeaders emits If-None-Match and If-Modified-Since', () => {
    const headers = conditionalGetHeaders(buildCacheEntry({
      sourceId: asSourceId('x'),
      body: encoder.encode(''),
      etag: 'etag-value',
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    }))
    expect(headers['If-None-Match']).toBe('etag-value')
    expect(headers['If-Modified-Since']).toBe('Wed, 21 Oct 2026 07:28:00 GMT')
  })

  test('conditionalGetHeaders empty when entry is null', () => {
    expect(conditionalGetHeaders(null)).toEqual({})
  })

  test('conditionalGetHeaders omits missing fields', () => {
    const entry = buildCacheEntry({
      sourceId: asSourceId('x'),
      body: encoder.encode(''),
      etag: null,
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    })
    const headers = conditionalGetHeaders(entry)
    expect(headers['If-None-Match']).toBeUndefined()
    expect(headers['If-Modified-Since']).toBe('Wed, 21 Oct 2026 07:28:00 GMT')
  })
})
