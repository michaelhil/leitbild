// The coordinated timeline: availability lanes per function group with their limit and guideline marks,
// load lanes per crew or tool with their shifts, and one bar per job. Pure; positions are percentages.
import type { PlanInputs } from '../plan/schema.ts'
import { expandCalendar } from '../time/calendar.ts'
import { gridSlotMs, isTimeUnit, timeUnitMs } from '../time/units.ts'
import { localParts } from '../time/zone.ts'
import { hoursNumber, hoursText, spanText, type Mark, type TimeFormat } from './format.ts'
import { joinWords, type DatedRow, type Job } from './model.ts'

const hourMs = timeUnitMs.h

export interface Bar { readonly left: number; readonly width: number; readonly text: string }
export interface Tick { readonly left: number; readonly label: string }

export interface ItemLane { readonly label: string; readonly segments: readonly Bar[] }
export interface AvailabilityLane {
  readonly group: string
  /** "Out 54 h of 72 h allowed; 18 h margin; within the 54 h guideline", or the limits before a plan exists. */
  readonly summary: string
  readonly span: Bar | null
  /** Where the limit and the guideline end, counted from the first tag-out. */
  readonly limitAt: number | null
  readonly guidelineAt: number | null
  readonly breaks: 'limit' | 'guideline' | null
  readonly items: readonly ItemLane[]
}
export interface LoadSegment extends Bar { readonly count: number; readonly over: boolean; readonly bought: boolean }
export interface LoadLane {
  readonly label: string
  readonly capacity: string
  readonly offShift: readonly Bar[]
  readonly segments: readonly LoadSegment[]
  readonly summary: string
}
export interface JobBar extends Bar {
  readonly key: string
  readonly title: string
  readonly mark: Mark
  readonly who: string
  readonly locked: boolean
}
export interface TimelineLayout {
  readonly from: number
  readonly to: number
  readonly ticks: readonly Tick[]
  readonly now: Tick | null
  readonly availability: readonly AvailabilityLane[]
  readonly loads: readonly LoadLane[]
  readonly jobs: readonly JobBar[]
}

export const jobMark = (kind: Job['kind']): Mark => ({
  'tag-out': { shape: '◧', word: 'Tag-out' },
  work: { shape: '▬', word: 'Work' },
  test: { shape: '◆', word: 'Test' },
} as const)[kind]

interface Interval { readonly start: number; readonly end: number }

const merge = (intervals: readonly Interval[]): readonly Interval[] => {
  const sorted = [...intervals].filter(interval => interval.end > interval.start).sort((left, right) => left.start - right.start)
  const merged: Interval[] = []
  for (const interval of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && interval.start <= last.end) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, interval.end) }
    else merged.push(interval)
  }
  return merged
}

/** Each item's own outage in the schedule: first covering tag-out start to last covering test finish. */
const ownOutages = (inputs: PlanInputs, rows: readonly DatedRow[], from: number, to: number): ReadonlyMap<string, Interval> => {
  const jobs = new Map(inputs.jobs.map(job => [job.key, job]))
  const opens = new Map<string, number>()
  const closes = new Map<string, number>()
  for (const row of rows) {
    const job = jobs.get(row.job)
    if (job === undefined) continue
    for (const item of job.equipment) {
      if (job.kind === 'tag-out') opens.set(item, Math.min(opens.get(item) ?? Infinity, Date.parse(row.start)))
      if (job.kind === 'test') closes.set(item, Math.max(closes.get(item) ?? -Infinity, Date.parse(row.finish)))
    }
  }
  const items = new Set([...opens.keys(), ...closes.keys()])
  return new Map([...items].map(item => [item, { start: opens.get(item) ?? from, end: closes.get(item) ?? to }]))
}

/** Own outage plus every supporter's outage, followed through supports (a cycle is not followed twice). */
const outagesWithSupport = (inputs: PlanInputs, own: ReadonlyMap<string, Interval>): ReadonlyMap<string, readonly Interval[]> => {
  const supporters = new Map(inputs.equipment.map(item => [item.key, item.supportedBy]))
  const result = new Map<string, readonly Interval[]>()
  for (const item of inputs.equipment) {
    const seen = new Set<string>()
    const intervals: Interval[] = []
    const visit = (key: string): void => {
      if (seen.has(key)) return
      seen.add(key)
      const outage = own.get(key)
      if (outage !== undefined) intervals.push(outage)
      for (const supporter of supporters.get(key) ?? []) visit(supporter)
    }
    visit(item.key)
    const merged = merge(intervals)
    if (merged.length > 0) result.set(item.key, merged)
  }
  return result
}

const ticksFor = (from: number, to: number, format: TimeFormat): readonly Tick[] => {
  const length = to - from
  const step = length > 36 * hourMs ? hourMs : length > 3 * hourMs ? hourMs : 5 * timeUnitMs.min
  const ticks: Tick[] = []
  for (let at = Math.ceil(from / step) * step; at <= to; at += step) {
    const local = localParts(format.zone, at)
    if (length > 36 * hourMs) {
      if (local.hour === 0 && local.minute === 0) ticks.push({ left: (at - from) / length * 100, label: format.day(at) })
    } else if (length > 3 * hourMs) {
      if (local.minute === 0 && local.hour % 3 === 0) ticks.push({ left: (at - from) / length * 100, label: format.time(at) })
    } else ticks.push({ left: (at - from) / length * 100, label: format.time(at) })
  }
  return ticks
}

export const layoutTimeline = (inputs: PlanInputs, rows: readonly DatedRow[], format: TimeFormat): TimelineLayout | null => {
  const window = inputs.settings.window
  const starts = rows.map(row => Date.parse(row.start))
  const finishes = rows.map(row => Date.parse(row.finish))
  const from = window === null ? Math.min(...starts) : Math.min(Date.parse(window.start), ...starts)
  const to = window === null ? Math.max(...finishes) : Math.max(Date.parse(window.end), ...finishes)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null
  const length = to - from
  const position = (start: number, end: number) => {
    const left = Math.max(0, Math.min(100, (start - from) / length * 100))
    const right = Math.max(left, Math.min(100, (end - from) / length * 100))
    return { left, width: right - left }
  }
  const resources = new Map(inputs.resources.map(resource => [resource.key, resource]))
  const jobs = new Map(inputs.jobs.map(job => [job.key, job]))

  // Availability per function group.
  const outages = outagesWithSupport(inputs, ownOutages(inputs, rows, from, to))
  const laneFor = (label: string, members: readonly PlanInputs['equipment'][number][], group: string | null): AvailabilityLane | null => {
    const limitRule = group === null ? undefined : inputs.rules.find(rule => rule.kind === 'span-limit' && rule.group === group)
    const limitMs = limitRule?.kind === 'span-limit' ? limitRule.limit.value * timeUnitMs[limitRule.limit.unit] : null
    const guideline = group === null ? undefined : inputs.goals.find(goal => goal.metric === 'span-over' && goal.threshold !== undefined && (goal.scope?.groups === undefined || goal.scope.groups.includes(group)))
    const guidelineMs = guideline?.threshold !== undefined && isTimeUnit(guideline.threshold.unit) ? guideline.threshold.value * timeUnitMs[guideline.threshold.unit] : null
    const items = members.flatMap((item): ItemLane[] => {
      const intervals = outages.get(item.key) ?? []
      if (group === null && intervals.length === 0) return []
      return [{ label: item.label, segments: intervals.map(interval => ({ ...position(interval.start, interval.end), text: `${item.label} out ${format.range(interval.start, interval.end)}` })) }]
    })
    if (items.length === 0) return null
    const all = members.flatMap(item => outages.get(item.key) ?? [])
    if (all.length === 0) {
      const limits = [limitMs === null ? 'No outage limit' : `Out at most ${hoursText(limitMs / hourMs)}`, ...guidelineMs === null ? [] : [`guideline ${hoursText(guidelineMs / hourMs)}`]]
      return { group: label, summary: `${limits.join('; ')}. Not planned yet.`, span: null, limitAt: null, guidelineAt: null, breaks: null, items }
    }
    const start = Math.min(...all.map(interval => interval.start))
    const end = Math.max(...all.map(interval => interval.end))
    const out = end - start
    const parts = [`Out ${hoursText(out / hourMs)}${limitMs === null ? '' : ` of ${hoursText(limitMs / hourMs)} allowed`}`]
    if (limitMs !== null) parts.push(out <= limitMs ? `${hoursText((limitMs - out) / hourMs)} margin` : `${hoursText((out - limitMs) / hourMs)} over the limit`)
    if (guidelineMs !== null) parts.push(out <= guidelineMs ? `within the ${hoursText(guidelineMs / hourMs)} guideline` : `${hoursText((out - guidelineMs) / hourMs)} over the ${hoursText(guidelineMs / hourMs)} guideline`)
    return {
      group: label, summary: `${parts.join('; ')}.`,
      span: { ...position(start, end), text: `${label} out ${format.range(start, end)}` },
      limitAt: limitMs === null ? null : position(from, start + limitMs).width,
      guidelineAt: guidelineMs === null ? null : position(from, start + guidelineMs).width,
      breaks: limitMs !== null && out > limitMs ? 'limit' : guidelineMs !== null && out > guidelineMs ? 'guideline' : null,
      items,
    }
  }
  const availability = [
    ...inputs.groups.map(group => laneFor(group.label, inputs.equipment.filter(item => item.group === group.key), group.key)),
    laneFor('Other equipment', inputs.equipment.filter(item => item.group === undefined), null),
  ].filter((lane): lane is AvailabilityLane => lane !== null)

  // Load per crew or tool.
  const slotMs = gridSlotMs[inputs.settings.grid]
  const origin = Math.floor(from / slotMs) * slotMs
  const slots = Math.ceil((to - origin) / slotMs)
  const calendars = new Map(inputs.calendars.map(calendar => [calendar.key, calendar]))
  const loads = inputs.resources.map((resource): LoadLane => {
    const calendar = calendars.get(resource.calendar)
    const offShift: Bar[] = []
    if (calendar !== undefined) {
      const expanded = expandCalendar(calendar, { zone: inputs.settings.timeZone, slotMs, origin, slots })
      if (expanded.ok) {
        let runStart: number | null = null
        expanded.work.forEach((slot, index) => {
          const at = origin + index * slotMs
          if (slot === 0 && runStart === null) runStart = at
          if (slot === 1 && runStart !== null) { offShift.push({ ...position(runStart, at), text: 'off shift' }); runStart = null }
        })
        if (runStart !== null) offShift.push({ ...position(runStart, origin + slots * slotMs), text: 'off shift' })
      }
    }
    const uses = rows.flatMap(row => row.uses.filter(use => use.resource === resource.key).map(use => ({ start: Date.parse(use.from), end: Date.parse(use.to), bought: use.purchase !== undefined })))
    const edges = [...new Set(uses.flatMap(use => [use.start, use.end]))].sort((left, right) => left - right)
    const segments: LoadSegment[] = []
    let busyMs = 0
    for (let index = 0; index + 1 < edges.length; index += 1) {
      const start = edges[index]!, end = edges[index + 1]!
      const active = uses.filter(use => use.start <= start && use.end >= end)
      if (active.length === 0) continue
      busyMs += active.length * (end - start)
      segments.push({
        ...position(start, end), count: active.length, over: active.length > resource.count, bought: active.some(use => use.bought),
        text: `${active.length} of ${resource.count} busy ${format.range(start, end)}${active.some(use => use.bought) ? ' (bought time)' : ''}`,
      })
    }
    return {
      label: resource.label,
      capacity: resource.count === 1 ? 'one at a time' : `${resource.count} at a time`,
      offShift, segments,
      summary: segments.length === 0
        ? 'Not used in this plan.'
        : `${resource.kind === 'crew' && busyMs >= hourMs ? `${hoursNumber(busyMs / hourMs)} crew-hours used` : `in use ${spanText(busyMs)}`}${segments.some(segment => segment.over) ? '; over capacity' : ''}.`,
    }
  })

  // One bar per scheduled job, in start order.
  const bars = [...rows].sort((left, right) => Date.parse(left.start) - Date.parse(right.start)).flatMap((row): JobBar[] => {
    const job = jobs.get(row.job)
    if (job === undefined) return []
    const who = [...new Set(row.uses.map(use => resources.get(use.resource)?.label).filter(label => label !== undefined))]
    return [{
      key: job.key, title: job.title, mark: jobMark(job.kind), who: joinWords(who), locked: job.lock !== undefined,
      ...position(Date.parse(row.start), Date.parse(row.finish)), text: `${job.title}: ${format.range(row.start, row.finish)}`,
    }]
  })

  const dataDate = inputs.settings.dataDate === null ? null : Date.parse(inputs.settings.dataDate)
  return {
    from, to, ticks: ticksFor(from, to, format),
    now: dataDate !== null && dataDate >= from && dataDate <= to ? { left: (dataDate - from) / length * 100, label: `Now: ${format.clock(dataDate)}` } : null,
    availability, loads, jobs: bars,
  }
}
