import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { readAuthState, submitAccessToken } from './auth.ts'

afterEach(() => { spyOn(globalThis, 'fetch').mockRestore() })

describe('Agents auth status', () => {
  test('only an explicit challenge requests a token', async () => {
    const fetch = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ authEnabled: true, authenticated: false }))
      .mockResolvedValueOnce(Response.json({ authEnabled: false, authenticated: true }))
      .mockResolvedValueOnce(Response.json({ authEnabled: true, authenticated: true }))
    expect(await readAuthState()).toBe('token-required')
    expect(await readAuthState()).toBe('ready')
    expect(await readAuthState()).toBe('ready')
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/auth', '/api/auth', '/api/auth'])
  })

  test('transport, error status and invalid responses are unavailable', async () => {
    spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ authEnabled: true }))
      .mockResolvedValueOnce(Response.json({ authEnabled: false, authenticated: false }))
      .mockResolvedValueOnce(new Response('<html>'))
    for (let i = 0; i < 5; i++) expect(await readAuthState()).toBe('unavailable')
  })

  test('distinguishes rejection and rate limits from unknown POST outcomes', async () => {
    spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(Response.json({ ok: false }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
    expect(await submitAccessToken('test')).toBe('rejected')
    expect(await submitAccessToken('test')).toBe('rate-limited')
    expect(await submitAccessToken('test')).toBe('unavailable')
    expect(await submitAccessToken('test')).toBe('unavailable')
    expect(await submitAccessToken('test')).toBe('ready')
  })
})
