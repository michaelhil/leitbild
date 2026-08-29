// VATSIM open data feed (no auth, but a polite User-Agent is required by
// vatsim.net's etiquette guide). The full payload is on the order of a few MB
// and refreshes every ~15 s upstream — there is no point polling faster.
//
// Docs: https://api.vatsim.net/api/ (status feed at
// https://data.vatsim.net/v3/vatsim-data.json).

export const VATSIM_DATA_URL = 'https://data.vatsim.net/v3/vatsim-data.json'

// 30 s feels right: half the upstream refresh interval so we miss at most one
// cycle, and well within the etiquette guide's "no faster than 15 s" rule.
export const VATSIM_DEFAULT_POLL_INTERVAL_MS = 30_000

// Stale-after window. VATSIM pilots disappear when they disconnect; a longer
// fade-out matches the operator's mental model of "they were here a moment ago".
export const VATSIM_DEFAULT_STALE_AFTER_MS = 120_000

// Per-request default User-Agent. Operators can override at adapter
// construction. VATSIM asks consumers to identify themselves.
export const VATSIM_DEFAULT_USER_AGENT = 'leitbild/research (aviation pack)'

export interface VatsimBbox {
  readonly lamin: number
  readonly lomin: number
  readonly lamax: number
  readonly lomax: number
}

// Same as the OpenSky default; VATSIM data is global, so we filter
// client-side to keep the Simulation Run's view scoped.
export const NORWAY_BBOX: VatsimBbox = {
  lamin: 57.5,
  lomin: 3.0,
  lamax: 71.5,
  lomax: 32.0,
}
