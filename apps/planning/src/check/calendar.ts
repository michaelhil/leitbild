// The checker's own calendar expansion. It shares only time/zone.ts with the compiler, so a slip in
// either expansion shows up as a disagreement instead of agreeing with itself.
import { addDays, localParts, localToInstant, weekdayOf, type LocalDate, type Weekday } from '../time/zone.ts'

/** Slot i covers [origin + i * slotMs, origin + (i + 1) * slotMs). */
export interface Grid {
  readonly zone: string | null
  readonly slotMs: number
  readonly origin: number
  readonly slots: number
}

export interface CalendarShape {
  readonly key: string
  readonly weekly: ReadonlyArray<{ readonly days: readonly Weekday[]; readonly from: string; readonly to: string }>
  readonly periods: ReadonlyArray<{ readonly start: string; readonly end: string }>
  readonly except: ReadonlyArray<{ readonly start: string; readonly end: string }>
}

export type Expansion =
  | { readonly ok: true; readonly work: Uint8Array }
  | { readonly ok: false; readonly reason: 'needs-zone' | 'off-grid'; readonly at?: number }

const minutesOf = (text: string): number => {
  const match = /^(\d\d):(\d\d)$/.exec(text)
  if (match === null) throw new RangeError(`Not a clock time: ${text}`)
  return Number(match[1]) * 60 + Number(match[2])
}

const dateKey = (date: LocalDate): number => Date.UTC(date.year, date.month - 1, date.day)

/**
 * Marks a slot as working only when the whole slot lies inside working time. A boundary that falls
 * inside the grid but off it is reported (the plan is then not valid), and the slot it cuts is not
 * counted as working.
 */
export const expand = (calendar: CalendarShape, grid: Grid): Expansion => {
  const { slotMs, origin, slots } = grid
  const end = origin + slots * slotMs
  const inside = new Int32Array(slots)   // +1 per covering working interval, before removals
  const removed = new Uint8Array(slots)
  let offGrid: number | undefined

  const note = (instant: number): void => {
    if (offGrid === undefined && instant > origin && instant < end && (instant - origin) % slotMs !== 0) offGrid = instant
  }
  const cover = (from: number, to: number, into: Int32Array | Uint8Array, value: number): void => {
    note(from); note(to)
    const first = Math.max(0, Math.ceil((from - origin) / slotMs))
    const last = Math.min(slots, Math.floor((to - origin) / slotMs))
    for (let slot = first; slot < last; slot++) into[slot] = into === removed ? 1 : (into[slot]! + value)
  }

  if (calendar.weekly.length > 0) {
    if (grid.zone === null) return { ok: false, reason: 'needs-zone' }
    const zone = grid.zone
    const firstDate = addDays(localParts(zone, origin), -1)
    const lastDate = localParts(zone, end)
    for (let date: LocalDate = firstDate; dateKey(date) <= dateKey(lastDate); date = addDays(date, 1)) {
      const weekday = weekdayOf(date)
      for (const entry of calendar.weekly) {
        if (!entry.days.includes(weekday)) continue
        const from = minutesOf(entry.from), to = minutesOf(entry.to)
        const endDate = to <= from ? addDays(date, 1) : date
        const startAt = localToInstant(zone, { ...date, hour: Math.floor(from / 60), minute: from % 60 })
        const endAt = localToInstant(zone, { ...endDate, hour: Math.floor(to / 60), minute: to % 60 })
        cover(startAt, endAt, inside, 1)
      }
    }
  }
  for (const period of calendar.periods) cover(Date.parse(period.start), Date.parse(period.end), inside, 1)
  for (const period of calendar.except) cover(Date.parse(period.start), Date.parse(period.end), removed, 1)
  if (offGrid !== undefined) return { ok: false, reason: 'off-grid', at: offGrid }
  const work = new Uint8Array(slots)
  for (let slot = 0; slot < slots; slot++) work[slot] = inside[slot]! > 0 && removed[slot] === 0 ? 1 : 0
  return { ok: true, work }
}

/** Slots wholly inside the given periods. */
export const periodSlots = (periods: ReadonlyArray<{ readonly start: string; readonly end: string }>, grid: Grid): Uint8Array => {
  const work = new Uint8Array(grid.slots)
  for (const period of periods) {
    const first = Math.max(0, Math.ceil((Date.parse(period.start) - grid.origin) / grid.slotMs))
    const last = Math.min(grid.slots, Math.floor((Date.parse(period.end) - grid.origin) / grid.slotMs))
    for (let slot = first; slot < last; slot++) work[slot] = 1
  }
  return work
}
