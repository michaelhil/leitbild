import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createWikiSource } from './wiki-fetcher.ts'
import type { WikiSourceBinding } from '../packs/types.ts'

const REVISION = 'a'.repeat(40)
const BINDING: WikiSourceBinding = {
  org: 'leitbild-wikis',
  repo: 'pwr-ops',
  branch: 'main',
  manifestUrl: 'https://leitbild-wikis.github.io/pwr-ops/_manifest.json',
  citationBase: 'https://leitbild-wikis.github.io/pwr-ops/procedures/',
}
const MANIFEST = {
  version: 1,
  wiki: 'pwr-ops',
  revision: REVISION,
  procmdVersion: '0.7',
  procedures: [{
    id: 'E-0',
    title: 'Reactor Trip',
    file: 'wiki/procedures/E-0.md',
    csfsMonitored: [],
    entryTriggers: [],
    coverage: 'developed',
    stepCount: 18,
    tagDefinitionCount: 12,
  }],
  pages: [],
}

const installFetchMock = (responder: (url: string) => Response | Promise<Response>): (() => void) => {
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(responder(typeof input === 'string' ? input : input.toString()))) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('createWikiSource', () => {
  let restore: () => void
  beforeEach(() => { restore = () => {} })
  afterEach(() => restore())

  test('fetches an explicitly revision-pinned manifest document', async () => {
    const calls: string[] = []
    restore = installFetchMock(url => {
      calls.push(url)
      return new Response('# E-0 content', { status: 200 })
    })
    const source = createWikiSource(BINDING)
    expect(source.citationUrl('E-0')).toBe('https://leitbild-wikis.github.io/pwr-ops/procedures/E-0/')
    expect(await source.fetchDocument('wiki/procedures/E-0.md', REVISION)).toBe('# E-0 content')
    expect(calls).toEqual([
      `https://raw.githubusercontent.com/leitbild-wikis/pwr-ops/${REVISION}/wiki/procedures/E-0.md`,
    ])
  })

  test('coalesces concurrent reads and buffers repeat reads within the TTL', async () => {
    let hits = 0
    restore = installFetchMock(async () => {
      hits += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return new Response('cached', { status: 200 })
    })
    const source = createWikiSource(BINDING, 60_000)
    const [first, second] = await Promise.all([
      source.fetchDocument('wiki/procedures/E-0.md', REVISION),
      source.fetchDocument('wiki/procedures/E-0.md', REVISION),
    ])
    expect(first).toBe('cached')
    expect(second).toBe('cached')
    expect(await source.fetchDocument('wiki/procedures/E-0.md', REVISION)).toBe('cached')
    expect(hits).toBe(1)
  })

  test('re-fetches after the TTL', async () => {
    let hits = 0
    restore = installFetchMock(() => {
      hits += 1
      return new Response('fresh', { status: 200 })
    })
    const source = createWikiSource(BINDING, 1)
    await source.fetchDocument('wiki/procedures/E-0.md')
    await new Promise(resolve => setTimeout(resolve, 5))
    await source.fetchDocument('wiki/procedures/E-0.md')
    expect(hits).toBe(2)
  })

  test('fetches and validates the required published manifest directly', async () => {
    let calls = 0
    restore = installFetchMock(url => {
      if (url === 'https://leitbild-wikis.github.io/pwr-ops/_manifest.json') {
        calls += 1
        return new Response(JSON.stringify(MANIFEST), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })
    const manifest = await createWikiSource(BINDING).fetchManifest()
    expect(manifest.revision).toBe(REVISION)
    expect(manifest.procedures[0]?.file).toBe('wiki/procedures/E-0.md')
    expect(calls).toBe(1)
  })

  test('rejects a malformed manifest instead of scraping a human index', async () => {
    restore = installFetchMock(() => new Response(JSON.stringify({
      version: 1,
      wiki: 'pwr-ops',
      procedures: [{ id: 'E-0' }],
      pages: [],
    }), { status: 200 }))
    await expect(createWikiSource(BINDING).fetchManifest()).rejects.toThrow(/invalid procedure manifest/)
  })

  test('never falls back to current Pages content for a pinned read', async () => {
    const calls: string[] = []
    restore = installFetchMock(url => {
      calls.push(url)
      return new Response('unavailable', { status: 503 })
    })
    await expect(
      createWikiSource(BINDING).fetchDocument('wiki/procedures/E-0.md', REVISION),
    ).rejects.toThrow(/HTTP 503/)
    expect(calls).toHaveLength(1)
  })
})
