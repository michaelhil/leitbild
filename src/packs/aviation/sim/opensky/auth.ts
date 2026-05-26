import { OPENSKY_TOKEN_URL } from './constants.ts'

// OAuth2 client_credentials flow against the OpenSky Keycloak realm.
//
// Token format: { access_token, expires_in (seconds), token_type: 'Bearer', ... }
// We cache the token and refresh proactively at 80% of expiry. A test seam
// (`fetchFn`, `clock`) lets unit tests exercise refresh / 401 retry without
// hitting the live endpoint.

export type HttpFetch = (
  url: string,
  init?: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string },
) => Promise<Response>

export interface OpenSkyAuthConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly fetchFn?: HttpFetch
  readonly clock?: () => number
}

export interface OpenSkyAuthClient {
  /** Returns a valid bearer token, refreshing if needed. Throws on token-endpoint failure. */
  readonly getAccessToken: () => Promise<string>
  /** Force a refresh on the next call (e.g. after a 401). */
  readonly invalidate: () => void
}

interface CachedToken {
  readonly accessToken: string
  readonly expiresAtMs: number
}

const defaultClock = (): number => Date.now()

const tokenSchema = (raw: unknown): { accessToken: string; expiresInSec: number } => {
  if (!raw || typeof raw !== 'object') throw new Error('opensky auth: token endpoint did not return a JSON object')
  const obj = raw as Record<string, unknown>
  const accessToken = obj.access_token
  const expiresIn = obj.expires_in
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('opensky auth: token response is missing access_token')
  }
  if (typeof expiresIn !== 'number' || expiresIn <= 0) {
    throw new Error('opensky auth: token response is missing expires_in')
  }
  return { accessToken, expiresInSec: expiresIn }
}

export const createOpenSkyAuthClient = (config: OpenSkyAuthConfig): OpenSkyAuthClient => {
  if (!config.clientId) throw new Error('opensky auth: clientId is required')
  if (!config.clientSecret) throw new Error('opensky auth: clientSecret is required')
  const fetchFn: HttpFetch = config.fetchFn ?? ((url, init) => globalThis.fetch(url, init as RequestInit))
  const clock = config.clock ?? defaultClock

  let cached: CachedToken | null = null
  let inflight: Promise<CachedToken> | null = null

  const fetchToken = async (): Promise<CachedToken> => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString()
    const response = await fetchFn(OPENSKY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'accept': 'application/json',
      },
      body,
    })
    if (response.status < 200 || response.status >= 300) {
      const text = await response.text().catch(() => '')
      const trimmed = text.length > 300 ? `${text.slice(0, 300)}…` : text
      throw new Error(`opensky auth: token endpoint HTTP ${response.status} — ${trimmed}`)
    }
    const json = await response.json()
    const { accessToken, expiresInSec } = tokenSchema(json)
    // Refresh at 80% of expiry. expiresInSec is in seconds.
    const expiresAtMs = clock() + Math.floor(expiresInSec * 1000 * 0.8)
    return { accessToken, expiresAtMs }
  }

  const refresh = (): Promise<CachedToken> => {
    if (inflight) return inflight
    inflight = fetchToken().then(token => {
      cached = token
      inflight = null
      return token
    }).catch(err => {
      inflight = null
      throw err
    })
    return inflight
  }

  return {
    getAccessToken: async () => {
      const current = cached
      if (current && current.expiresAtMs > clock()) return current.accessToken
      const fresh = await refresh()
      return fresh.accessToken
    },
    invalidate: () => { cached = null },
  }
}
