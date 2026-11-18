// Calendar -> working slots on the plan grid, in UTC. The compiler uses this; the checker expands
// calendars on its own and shares only zone.ts.
import { addDays, formatLocal, localParts, localToInstant, weekdayOf, type LocalDate, type Weekday } from './zone.ts'

/** The calendar fields expansion reads (structurally the stored plan calendar). */
export interface CalendarInput {
  readonly key: string
  readonly weekly: ReadonlyArray<{ readonly days: readonly Weekday[]; readonly from: string; readonly to: string }>
  readonly periods: ReadonlyArray<{ readonly start: string; readonly end: string }>
  readonly except: ReadonlyArray<{ readonly start: string; readonly end: string }>
}

/** Slot i covers [origin + i * slotMs, origin + (i + 1) * slotMs). */
export interface CalendarGrid {
  readonly zone: string | null
  readonly slotMs: number
  readonly origin: number
  readonly slots: number
}

export type CalendarProblem =
  | { readonly code: 'calendar_needs_zone'; readonly calendar: string }
  | { readonly code: 'calendar_off_grid'; readonly calendar: string; readonly part: 'weekly' | 'periods' | 'except'; readonly at: string; readonly local?: string }

export type CalendarExpansion =
  | { readonly ok: true; readonly work: Uint8Array }
  | { readonly ok: false; readonly problem: CalendarProblem }

export const isOnGrid = (instantMs: number, slotMs: number): boolean => instantMs % slotMs === 0

const clock = (text: string): { readonly hour: number; readonly minute: number } => {
  const [hour, minute] = text.split(':').map(Number)
  if (hour === undefined || minute === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) throw new RangeError(`Not a local clock time: ${text}`)
  return { hour, minute }
}

/**
 * Marks every slot inside the calendar's working time with 1. A weekly entry whose `to` is at or before
 * its `from` ends on the next day. `except` removes time. A boundary inside the grid that is not on it is
 * refused, never rounded.
 */
export const expandCalendar = (calendar: CalendarInput, grid: CalendarGrid): CalendarExpansion => {
  const { slotMs, origin, slots } = grid
  if (!Number.isInteger(slotMs) || slotMs <= 0 || !Number.isInteger(origin) || !isOnGrid(origin, slotMs) || !Number.isInteger(slots) || slots < 0) {
    throw new RangeError('A calendar grid needs a positive whole slot, an origin on the grid and a whole slot count')
  }
  const end = origin + slots * slotMs
  const work = new Uint8Array(slots)
  let problem: CalendarProblem | undefined

  const mark = (startMs: number, endMs: number, value: 0 | 1, part: 'weekly' | 'periods' | 'except', local?: string): void => {
    for (const boundary of [startMs, endMs]) {
      if (problem === undefined && boundary > origin && boundary < end && !isOnGrid(boundary, slotMs)) {
        problem = { code: 'calendar_off_grid', calendar: calendar.key, part, at: new Date(boundary).toISOString(), ...(local === undefined ? {} : { local }) }
      }
    }
    const first = Math.max(startMs, origin), last = Math.min(endMs, end)
    if (last <= first) return
    work.fill(value, Math.ceil((first - origin) / slotMs), Math.floor((last - origin) / slotMs))
  }

  if (calendar.weekly.length > 0) {
    const zone = grid.zone
    if (zone === null) return { ok: false, problem: { code: 'calendar_needs_zone', calendar: calendar.key } }
    const firstDay = addDays(localParts(zone, origin), -1)
    const lastDay = localParts(zone, end)
    for (let day: LocalDate = firstDay; Date.UTC(day.year, day.month - 1, day.day) <= Date.UTC(lastDay.year, lastDay.month - 1, lastDay.day); day = addDays(day, 1)) {
      const weekday = weekdayOf(day)
      for (const entry of calendar.weekly) {
        if (!entry.days.includes(weekday)) continue
        const from = clock(entry.from), to = clock(entry.to)
        const nextDay = to.hour * 60 + to.minute <= from.hour * 60 + from.minute
        const startLocal = { ...day, ...from }
        const endLocal = { ...(nextDay ? addDays(day, 1) : day), ...to }
        const startMs = localToInstant(zone, startLocal)
        const endMs = localToInstant(zone, endLocal)
        mark(startMs, endMs, 1, 'weekly', `${formatLocal(startLocal)} to ${formatLocal(endLocal)}`)
      }
    }
  }
  for (const period of calendar.periods) mark(Date.parse(period.start), Date.parse(period.end), 1, 'periods')
  for (const period of calendar.except) mark(Date.parse(period.start), Date.parse(period.end), 0, 'except')
  return problem === undefined ? { ok: true, work } : { ok: false, problem }
}

/** Working milliseconds of an expansion. */
export const workingMs = (work: Uint8Array, slotMs: number): number => work.reduce((sum, slot) => sum + slot, 0) * slotMs
