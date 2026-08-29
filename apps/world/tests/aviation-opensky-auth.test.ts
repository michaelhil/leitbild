import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { createOpenSkyAuthClient, type HttpFetch } from '../src/packs/aviation/sim/opensky/auth.ts'

const FIXTURE_PATH = new URL('./fixtures/opensky-token-response.json', import.meta.url)

const loadTokenResponse = async (): Promise<unknown> =>
  JSON.parse(await readFile(FIXTURE_PATH, 'utf8'))

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('createOpenSkyAuthClient', () => {
  it('caches the access token until 80 % of expiry passes, then refreshes', async () => {
    const tokenBody = await loadTokenResponse()
    let now = 1_000_000
    let calls = 0
    const fetchFn: HttpFetch = async () => {
      calls += 1
      return jsonResponse(200, calls === 1
        ? tokenBody
        : { ...(tokenBody as Record<string, unknown>), access_token: 'second-token' })
    }
    const client = createOpenSkyAuthClient({
      clientId: 'cid',
      clientSecret: 'sec',
      fetchFn,
      clock: () => now,
    })

    const first = await client.getAccessToken()
    expect(first).toBe('test-access-token-abc123')
    expect(calls).toBe(1)

    // Just inside the 80 % window (1800 s expiry → refresh at +1440 s).
    now += 1_000 * 1_000
    expect(await client.getAccessToken()).toBe('test-access-token-abc123')
    expect(calls).toBe(1)

    // Past the refresh threshold.
    now += 600 * 1_000
    expect(await client.getAccessToken()).toBe('second-token')
    expect(calls).toBe(2)
  })

  it('coalesces concurrent refreshes into a single token request', async () => {
    const tokenBody = await loadTokenResponse()
    let calls = 0
    const fetchFn: HttpFetch = async () => {
      calls += 1
      // Slow the response so concurrent callers all race the same refresh.
      await Bun.sleep(5)
      return jsonResponse(200, tokenBody)
    }
    const client = createOpenSkyAuthClient({
      clientId: 'cid',
      clientSecret: 'sec',
      fetchFn,
      clock: () => 0,
    })

    const [a, b, c] = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ])
    expect([a, b, c]).toEqual(['test-access-token-abc123', 'test-access-token-abc123', 'test-access-token-abc123'])
    expect(calls).toBe(1)
  })

  it('invalidate() forces the next call to fetch a new token', async () => {
    const tokenBody = await loadTokenResponse()
    let calls = 0
    const fetchFn: HttpFetch = async () => {
      calls += 1
      return jsonResponse(200, { ...(tokenBody as Record<string, unknown>), access_token: `t${calls}` })
    }
    const client = createOpenSkyAuthClient({ clientId: 'cid', clientSecret: 'sec', fetchFn, clock: () => 0 })
    expect(await client.getAccessToken()).toBe('t1')
    client.invalidate()
    expect(await client.getAccessToken()).toBe('t2')
  })

  it('surfaces HTTP errors from the token endpoint', async () => {
    const fetchFn: HttpFetch = async () =>
      new Response('invalid_client', { status: 401 })
    const client = createOpenSkyAuthClient({ clientId: 'cid', clientSecret: 'bad', fetchFn, clock: () => 0 })
    await expect(client.getAccessToken()).rejects.toThrow(/HTTP 401/)
  })

  it('rejects malformed token payloads', async () => {
    const fetchFn: HttpFetch = async () =>
      jsonResponse(200, { access_token: 'ok', expires_in: 'not-a-number' })
    const client = createOpenSkyAuthClient({ clientId: 'cid', clientSecret: 'sec', fetchFn, clock: () => 0 })
    await expect(client.getAccessToken()).rejects.toThrow(/expires_in/)
  })
})
