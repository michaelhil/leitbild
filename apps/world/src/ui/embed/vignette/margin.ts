// How a values row reads its reading's recent record (plan v5 W4.2; owner
// finding 1; #47, #48): its rate per minute, shown only where the last 30 s
// and the last 2 min agree on the way it goes; and its margin to a limit in
// force it is near or past, with which way it goes and, only where that trend
// is established, the time to the limit or back across it. A limit in force
// is one the Pack says the value is past (`past`), or one it declares with no
// condition (`when`): World never reads a condition's words.
import { numberShown, numberText, unitSymbol, type Observable, type Quantity } from '../../../core/observation/model.ts'
import type { SeriesPoint } from '../../../features/displays/compose/model.ts'
import { orderWord } from './readout.ts'

type Threshold = Observable['thresholds'][number]

/** The rate a row states, and the longer one it is checked against. */
export const SHORT_MS = 30_000
export const LONG_MS = 120_000
/** A slope needs its points to span this share of its window. */
const COVER = 0.75

/**
 * Least-squares slope per minute over the window ending at `now`, of the record as a step-and-hold reader reads it: the
 * value held into the window's start (recorded before it, within its hold), each point in it, and the last value held
 * to now; null where the record spans too little of the window. A steady value is recorded rarely (exception
 * recording), and holds: its slope is 0, not unknown.
 */
export const slopePerMinute = (points: ReadonlyArray<SeriesPoint>, now: number, windowMs: number, holdMs: number): number | null => {
  const start = now - windowMs
  const finite = points.filter(point => Number.isFinite(point.v) && point.t <= now)
  const before = finite.filter(point => point.t < start).at(-1)
  const inside = finite.filter(point => point.t >= start)
  const last = inside.at(-1) ?? before
  const held = [
    ...(before !== undefined && before.t >= start - holdMs ? [{ t: start, v: before.v }] : []),
    ...inside,
    ...(last !== undefined && last.t < now && last.t >= now - holdMs ? [{ t: now, v: last.v }] : []),
  ]
  if (held.length < 2 || held.at(-1)!.t - held[0]!.t < windowMs * COVER) return null
  const meanT = held.reduce((sum, point) => sum + point.t, 0) / held.length
  const meanV = held.reduce((sum, point) => sum + point.v, 0) / held.length
  const variance = held.reduce((sum, point) => sum + (point.t - meanT) ** 2, 0)
  if (variance === 0) return null
  return (held.reduce((sum, point) => sum + (point.t - meanT) * (point.v - meanV), 0) / variance) * 60_000
}

export interface Tendency {
  /** Per minute over the last 30 s and the last 2 min; null where the record spans too little. */
  readonly short: number | null
  readonly long: number | null
}

export const tendencyOf = (points: ReadonlyArray<SeriesPoint>, now: number, holdMs: number): Tendency =>
  ({ short: slopePerMinute(points, now, SHORT_MS, holdMs), long: slopePerMinute(points, now, LONG_MS, holdMs) })

/** A reading's way of writing a number: its unit, its declared quantity, read over decades. */
export interface Written { readonly unit: string; readonly quantity?: Quantity; readonly decades?: true }

/** A rate that reads as zero at the value's decimals is steady. */
const steady = (rate: number, written: Written): boolean => numberShown(Math.abs(rate), written.unit, written.quantity).value === 0

/** Where the two slopes agree: both one way, neither steady. */
const agreed = (tendency: Tendency, written: Written): 'rising' | 'falling' | null => {
  const { short, long } = tendency
  if (short === null || long === null || steady(short, written) || steady(long, written) || Math.sign(short) !== Math.sign(long)) return null
  return short > 0 ? 'rising' : 'falling'
}

/** "▼ 0.12" a minute, at the value's decimals, where the 30 s and the 2 min slopes agree; null otherwise. Its column's heading says "/min". */
export const rateText = (tendency: Tendency, written: Written): string | null => {
  const way = agreed(tendency, written)
  return way === null ? null : `${way === 'rising' ? '▲' : '▼'} ${numberText(Math.abs(tendency.short!), written.unit, written.quantity)}`
}

/** How the last 30 s go against the last 2 min: slowing, accelerating, reversing; null where they hold or are not known. */
const changeOf = (tendency: Tendency, written: Written): 'slowing' | 'accelerating' | 'reversing' | null => {
  const { short, long } = tendency
  if (short === null || long === null || steady(long, written)) return null
  if (steady(short, written)) return 'slowing'
  if (Math.sign(short) !== Math.sign(long)) return 'reversing'
  return Math.abs(short) < Math.abs(long) / 2 ? 'slowing' : Math.abs(short) > Math.abs(long) * 2 ? 'accelerating' : null
}

/** The effects a margin names: an alarm's and a trip's limits, never a control set point, a rating or a target. */
const NAMED: ReadonlySet<Threshold['effect']> = new Set(['alarm', 'trip'])
/**
 * Near a limit: within this share of its instrument's span where one is declared, else of the limit's own size (a
 * pressure at power 0.5 MPa under its high alarm is not near it); or reached within this time at an established rate.
 */
const NEAR_SPAN_SHARE = 0.05
const NEAR_LIMIT_SHARE = 0.01
const NEAR_MINUTES = 10
/** A time further off than this says little about the minutes ahead: not shown. */
const PROJECTED_MINUTES = 30

export interface Margin {
  /** "0.66 above LO 14.80 MPa · ALM · falling, slowing · ≈2 min", "0.97 below LO 14.80 MPa · ALM · rising · back above in ≈30 s". */
  readonly text: string
  /** Its parts as the text joins them: how far from which limit, what the limit does, which way it goes, when it gets there. */
  readonly parts: ReadonlyArray<string>
  /** Which parts give way first where room is short: which way it goes, then what the limit does, then the time. */
  readonly giving: ReadonlyArray<number>
  /** Past the limit, not only near it. */
  readonly past: boolean
  /** How urgent among a column's margins: past first, then by share of the scale left. */
  readonly rank: number
}

const timeText = (minutes: number): string => (minutes < 2 ? `≈${Math.max(5, Math.round((minutes * 60) / 5) * 5)} s` : `≈${Math.round(minutes)} min`)

/**
 * A reading's margin to the limit in force it is past, or else the nearest it is near on the way it goes (either side
 * where it holds); null where none is near. `past`: the id of the limit the Pack says it is past now.
 */
export const marginOf = (value: number, thresholds: ReadonlyArray<Threshold>, past: string | undefined, tendency: Tendency, written: Written & { readonly span?: { readonly min: number; readonly max: number } }): Margin | null => {
  const way = agreed(tendency, written)
  const change = changeOf(tendency, written)
  const passed = past === undefined ? undefined : thresholds.find(threshold => threshold.id === past)
  const inForce = thresholds.filter(threshold => NAMED.has(threshold.effect) && threshold.when === undefined)
  const span = written.span
  const scale = (limit: number): number => (span === undefined ? Math.abs(limit) : span.max - span.min) || 1
  const nearShare = span === undefined ? NEAR_LIMIT_SHARE : NEAR_SPAN_SHARE
  const rate = tendency.short
  // Minutes to reach `limit` at the stated rate, where the trend is established: the 30 s and 2 min slopes agree.
  const minutesTo = (limit: number): number | null => {
    if (way === null || rate === null || Math.sign(limit - value) !== Math.sign(rate)) return null
    const minutes = (limit - value) / rate
    return minutes <= PROJECTED_MINUTES ? minutes : null
  }
  const ahead = passed ?? inForce
    .filter(threshold => (threshold.direction === 'low' ? value > threshold.value : value < threshold.value))
    .map(threshold => ({ threshold, share: Math.abs(value - threshold.value) / scale(threshold.value), minutes: minutesTo(threshold.value) }))
    .filter(entry => entry.share <= nearShare || (entry.minutes !== null && entry.minutes <= NEAR_MINUTES))
    .sort((left, right) => left.share - right.share)[0]?.threshold
  if (ahead === undefined) return null
  const isPast = passed !== undefined
  const unit = unitSymbol(written.unit)
  const number = (amount: number): string => numberText(amount, written.unit, written.quantity, written.decades === true)
  const side = value >= ahead.value ? 'above' : 'below'
  const limitName = `${orderWord(ahead)} ${number(ahead.value)}${unit === '' ? '' : ` ${unit}`}`
  // Which way the last 30 s go, and how that compares with the last 2 min.
  const short = tendency.short
  const travel = short === null ? null : steady(short, written) ? 'steady' : short > 0 ? 'rising' : 'falling'
  const motion = travel === null || travel === 'steady' || change === null ? travel : `${travel}, ${change}`
  const minutes = minutesTo(ahead.value)
  const time = minutes === null ? null : isPast ? `back ${side === 'below' ? 'above' : 'below'} in ${timeText(minutes)}` : timeText(minutes)
  const named = [`${number(Math.abs(value - ahead.value))} ${side} ${limitName}`, ahead.consequence, motion, time]
  const parts = named.filter((part): part is string => part !== null && part !== undefined && part !== '')
  const at = (part: string | null | undefined): ReadonlyArray<number> => (part === null || part === undefined || part === '' ? [] : [parts.indexOf(part)])
  return {
    text: parts.join(' · '),
    parts,
    giving: [...at(motion), ...at(ahead.consequence), ...at(time)],
    past: isPast,
    rank: (isPast ? 0 : 1) + Math.min(1, Math.abs(value - ahead.value) / scale(ahead.value)),
  }
}
