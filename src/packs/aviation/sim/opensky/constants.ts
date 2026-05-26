// OpenSky V2 API + OAuth2 endpoints.
// Norway bbox (lamin, lomin, lamax, lomax) covers ENOR including offshore extensions.
// Polling cadence is configurable but defaults conservatively to fit the free-tier
// 4000-credit/day budget.

export const OPENSKY_API_BASE = 'https://opensky-network.org'
export const OPENSKY_STATES_PATH = '/api/states/all'
export const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'

export const OPENSKY_DEFAULT_POLL_INTERVAL_MS = 15_000
export const OPENSKY_DEFAULT_STALE_AFTER_MS = 60_000

export const NORWAY_BBOX = {
  lamin: 57.5,
  lomin: 3.0,
  lamax: 71.5,
  lomax: 32.0,
} as const

export type OpenSkyBbox = {
  readonly lamin: number
  readonly lomin: number
  readonly lamax: number
  readonly lomax: number
}
