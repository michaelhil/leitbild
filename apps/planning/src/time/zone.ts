// Intl wrappers. All plan arithmetic is UTC milliseconds; local wall time exists only at these edges.
// The checker shares this file with the compiler and nothing else in time/.

export interface LocalDate { readonly year: number; readonly month: number; readonly day: number }
export interface LocalTime extends LocalDate { readonly hour: number; readonly minute: number }
export interface LocalParts extends LocalTime { readonly second: number; readonly weekday: Weekday }
export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'

const weekdays: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const dayMs = 86_400_000
const formatters = new Map<string, Intl.DateTimeFormat>()

const formatter = (zone: string): Intl.DateTimeFormat => {
  const known = formatters.get(zone)
  if (known !== undefined) return known
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  formatters.set(zone, created)
  return created
}

/** True for a zone name Intl knows. Fixed offsets such as "+01:00" are not zone names. */
export const isTimeZone = (name: string): boolean => {
  if (!/^[A-Za-z]/.test(name)) return false
  try {
    formatter(name)
    return true
  } catch (error) {
    if (error instanceof RangeError) return false
    throw error
  }
}

/** The weekday of a calendar date, independent of any zone. */
export const weekdayOf = (date: LocalDate): Weekday => weekdays[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()]!

/** The calendar date `days` after `date`. */
export const addDays = (date: LocalDate, days: number): LocalDate => {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }
}

export const localParts = (zone: string, instantMs: number): LocalParts => {
  const parts = Object.fromEntries(formatter(zone).formatToParts(new Date(instantMs)).map(part => [part.type, part.value]))
  const date = { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) }
  return { ...date, hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), weekday: weekdayOf(date) }
}

/** Local time minus UTC at an instant, in milliseconds. */
export const zoneOffsetMs = (zone: string, instantMs: number): number => {
  const whole = Math.floor(instantMs / 1_000) * 1_000
  const local = localParts(zone, whole)
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - whole
}

/**
 * The instant of a local wall time. A wall time inside a gap (clocks forward) gives the first instant
 * after the gap; one inside an overlap (clocks back) gives the earlier of its two instants.
 */
export const localToInstant = (zone: string, local: LocalTime): number => {
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)
  const offsets = [...new Set([zoneOffsetMs(zone, wall - dayMs), zoneOffsetMs(zone, wall + dayMs)])]
  const valid = offsets.map(offset => wall - offset).filter(instant => zoneOffsetMs(zone, instant) === wall - instant)
  if (valid.length > 0) return Math.min(...valid)
  if (offsets.length !== 2) throw new Error(`Cannot resolve ${formatLocal(local)} in ${zone}: more than one offset change within a day`)
  // In the gap: before the change the offset is offsets[0], after it offsets[1]. Find the change instant.
  let before = wall - Math.max(...offsets)
  let after = wall - Math.min(...offsets)
  const offsetBefore = zoneOffsetMs(zone, before)
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2)
    if (zoneOffsetMs(zone, middle) === offsetBefore) before = middle
    else after = middle
  }
  return after
}

/** Every offset the zone uses in [from, to), sampled hourly and at both ends. */
export const zoneOffsetsIn = (zone: string, fromMs: number, toMs: number): readonly number[] => {
  const offsets = new Set<number>([zoneOffsetMs(zone, fromMs)])
  for (let instant = Math.ceil(fromMs / 3_600_000) * 3_600_000; instant < toMs; instant += 3_600_000) offsets.add(zoneOffsetMs(zone, instant))
  if (toMs > fromMs) offsets.add(zoneOffsetMs(zone, toMs - 1))
  return [...offsets]
}

/**
 * Whether every offset of the zone in [from, to) is a whole number of grid slots, so local clock times
 * fall on the grid. Returns the first offset that does not.
 */
export const zoneOffGridOffset = (zone: string, slotMs: number, fromMs: number, toMs: number): number | undefined =>
  zoneOffsetsIn(zone, fromMs, toMs).find(offset => offset % slotMs !== 0)

const pad = (value: number): string => String(value).padStart(2, '0')

export const formatOffset = (offsetMs: number): string => {
  const sign = offsetMs < 0 ? '-' : '+'
  const seconds = Math.abs(offsetMs) / 1_000
  const text = `${sign}${pad(Math.floor(seconds / 3_600))}:${pad(Math.floor(seconds / 60) % 60)}`
  return seconds % 60 === 0 ? text : `${text}:${pad(seconds % 60)}`
}

export const formatLocal = (local: LocalTime): string =>
  `${local.year}-${pad(local.month)}-${pad(local.day)} ${pad(local.hour)}:${pad(local.minute)}`

// One known transition: Europe/Oslo moves from +01:00 to +02:00 at 2026-03-29T01:00:00Z.
const probe = { zone: 'Europe/Oslo', atMs: Date.UTC(2026, 2, 29, 1) }

/**
 * Names the time-zone data in use, for the formulation version: the ICU version plus the offsets around
 * one known transition. A changed ICU or a changed transition changes the text, so stored proofs stop
 * being reused.
 */
export const zoneDataFingerprint = (): string => {
  const icu = process.versions.icu
  if (icu === undefined) throw new Error('The runtime does not report its ICU version, so time-zone data cannot be named')
  const before = formatOffset(zoneOffsetMs(probe.zone, probe.atMs - 1_000))
  const after = formatOffset(zoneOffsetMs(probe.zone, probe.atMs))
  return `icu ${icu}; ${probe.zone} ${new Date(probe.atMs).toISOString()} ${before}>${after}`
}
