// Pure geometry for composed-display trends. Time is Simulation Run time in
// epoch milliseconds; values are the signal's native unit.

export interface TrendPoint {
  readonly t: number
  readonly v: number
}

export interface ValueDomain {
  readonly min: number
  readonly max: number
}

// The operations Historian re-records an unchanged value at most once per
// minute, so a held value is drawn across gaps up to this length and broken
// beyond it.
export const HOLD_GAP_MS = 90_000

const PAD_FRACTION = 0.08

/** Smallest domain containing every value, or null when there are none. */
export const rawDomain = (values: ReadonlyArray<number>): ValueDomain | null => {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return null
  return { min: Math.min(...finite), max: Math.max(...finite) }
}

/** Fixed display scale: padded, never zero-height. */
export const paddedDomain = (raw: ValueDomain): ValueDomain => {
  const span = raw.max - raw.min
  if (span === 0) {
    const half = Math.max(Math.abs(raw.max) * 0.05, 1)
    return { min: raw.min - half, max: raw.max + half }
  }
  return { min: raw.min - span * PAD_FRACTION, max: raw.max + span * PAD_FRACTION }
}

const niceStep = (span: number, count: number): number => {
  const rough = span / Math.max(1, count)
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  const nice = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10
  return nice * magnitude
}

// Few gridlines: a mini trend is read for direction and margin, not exact values.
export const valueTicks = (domain: ValueDomain, count = 3): ReadonlyArray<number> => {
  const step = niceStep(domain.max - domain.min, count)
  const first = Math.ceil(domain.min / step) * step
  const ticks: number[] = []
  for (let tick = first; tick <= domain.max + step * 1e-9; tick += step) ticks.push(Number(tick.toPrecision(12)))
  return ticks
}

export interface TimeTick {
  readonly t: number
  readonly label: string
}

const relativeLabel = (backMs: number): string => {
  if (backMs === 0) return 'now'
  return backMs % 60_000 === 0 ? `−${backMs / 60_000} min` : `−${Math.round(backMs / 1000)} s`
}

/** Ticks relative to "now" so the trend reads the same at any Simulation Run date. */
export const timeTicks = (now: number, horizonMs: number): ReadonlyArray<TimeTick> => {
  const stepMs = horizonMs <= 120_000 ? 30_000 : horizonMs <= 600_000 ? 120_000 : 600_000
  const ticks: TimeTick[] = []
  for (let back = horizonMs; back >= 0; back -= stepMs) {
    ticks.push({ t: now - back, label: relativeLabel(back) })
  }
  return ticks
}

/** Keeps points ordered and drops those that can no longer influence the window. */
export const appendPoint = (
  points: ReadonlyArray<TrendPoint>,
  point: TrendPoint,
  windowStart: number,
): ReadonlyArray<TrendPoint> => {
  const kept = points.filter(existing => existing.t >= windowStart - HOLD_GAP_MS && existing.t < point.t)
  return [...kept, point]
}

/**
 * Step-hold SVG path: a sampled value holds until the next sample. Holds end
 * at `holdUntil` (the latest Run time) and are broken across gaps longer than
 * HOLD_GAP_MS so missing data is visible rather than interpolated.
 */
export const stepPath = (
  points: ReadonlyArray<TrendPoint>,
  x: (t: number) => number,
  y: (v: number) => number,
  window: { readonly start: number; readonly end: number },
): string => {
  const commands: string[] = []
  let open = false
  points.forEach((point, index) => {
    const next = points[index + 1]
    const holdEnd = Math.min(next?.t ?? window.end, point.t + HOLD_GAP_MS, window.end)
    if (holdEnd < window.start) { open = false; return }
    const start = Math.max(point.t, window.start)
    const yv = y(point.v).toFixed(1)
    commands.push(`${open ? 'L' : 'M'}${x(start).toFixed(1)} ${yv}`)
    commands.push(`L${x(holdEnd).toFixed(1)} ${yv}`)
    open = next !== undefined && next.t <= point.t + HOLD_GAP_MS
  })
  return commands.join(' ')
}

const unitLabels: Readonly<Record<string, string>> = {
  percent: '%',
  degC: '°C',
  fraction: '',
}

export const unitLabel = (unit: string): string => unitLabels[unit] ?? unit

/** Precision follows magnitude; trend readers compare, they do not audit digits. */
export const valueDigits = (value: number): number => {
  const magnitude = Math.abs(value)
  return magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : 3
}

export const formatValue = (value: number): string => value.toFixed(valueDigits(value))
