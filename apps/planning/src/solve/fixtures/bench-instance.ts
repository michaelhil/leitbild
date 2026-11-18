// Test support: or's bench Instance JSON (R/or/gate/src/model.ts; the frozen gate twins) onto the
// NormalizedProblem seam, so the gate and perf tests run this engine on exactly or's instances.
// Helper milestones (X.start, X.end) are kept as activities but spans use the real tag-outs and tests
// they link to (or's note d). The search horizon is or's extendHorizon (the window, then the gap to the
// next Monday with only 24/7 time, then the week repeated): graded lateness for search; deadlines and
// the gate's checker keep the real window.
import type { NormalizedProblem, Schedule } from '../problem.ts'

interface BenchMode { work: number; calendar: string; interruptible: boolean; demands: Array<{ resource: string; amount: number; when?: string }>; fixedCost: number }
export interface BenchInstance {
  name: string; horizon: number
  calendars: Array<{ id: string; work: boolean[] }>
  resources: Array<{ id: string; capacity: number[]; rate: number[]; mobilization?: number; mobilizationGroup?: string }>
  activities: Array<{ id: string; modes: BenchMode[]; release?: number; deadline?: number; due?: number; fixed?: { mode: number; start: number } }>
  links: Array<{ from: string; to: string; type: 'FS' | 'SS' | 'FF'; min: number; max?: number }>
  spans: Array<{ id: string; open: string; close: string; maxOut?: number; guideline?: number }>
  groups: Array<{ id: string; spans: string[]; maxOut: number }>
  mobilizationGroups?: Record<string, number>
  fixedCost?: number
  slotHours?: number
}

const WEEK = 336   // 30-min slots per week, Mon 07:00 to Mon 07:00

export const fromBenchInstance = (inst: BenchInstance, options: { readonly extend?: boolean } = {}): { problem: NormalizedProblem; toBench: (schedule: Schedule) => { mode: number[]; start: number[] } } => {
  const H = inst.horizon
  const horizon = options.extend === false ? H : WEEK + H
  const extend = <T>(values: readonly T[], gap: T): T[] => Array.from({ length: horizon }, (_, t) => (t < H ? values[t]! : t < WEEK ? gap : values[t - WEEK]!))
  const calendarIndex = new Map(inst.calendars.map((calendar, i) => [calendar.id, i]))
  const calendars = inst.calendars.map(calendar => ({ id: calendar.id, work: Uint8Array.from(extend(calendar.work, calendar.id === 'always').map(Number)) }))
  const resourceIndex = new Map(inst.resources.map((resource, i) => [resource.id, i]))
  const resources: Array<NormalizedProblem['resources'][number]> = inst.resources.map(resource => {
    const constant = resource.capacity.every(value => value === resource.capacity[0])
    const periods: Array<NormalizedProblem['resources'][number]['periods'][number]> = []
    const once: Array<NormalizedProblem['resources'][number]['once'][number]> = []
    // Mobilisation: paid once when the resource is used at all; a group's fee once when any member is.
    const purchase = resource.mobilizationGroup ?? (resource.mobilization !== undefined ? `mob:${resource.id}` : undefined)
    if (purchase !== undefined) periods.push({ purchase, from: 0, to: horizon, price: resource.mobilization ?? 0, committed: false })
    return { id: resource.id, capacity: Int16Array.from(extend(resource.capacity, constant ? resource.capacity[0]! : 0)), pricePerUnitSlot: Float64Array.from(extend(resource.rate, 0)), periods, once, forbiddenWhenUsed: [] }
  })
  for (const [group, price] of Object.entries(inst.mobilizationGroups ?? {})) {
    const member = inst.resources.findIndex(resource => resource.mobilizationGroup === group)
    if (member >= 0) (resources[member]!.once as Array<{ purchase: string; price: number; committed: boolean }>).push({ purchase: group, price, committed: false })
  }
  const activityIndex = new Map(inst.activities.map((activity, i) => [activity.id, i]))
  const activities: Array<NormalizedProblem['activities'][number]> = inst.activities.map(activity => ({
    id: activity.id,
    modes: activity.modes.map(mode => ({
      work: mode.work, calendar: calendarIndex.get(mode.calendar)!, continuous: !mode.interruptible,
      demands: mode.demands.map(d => ({ resource: resourceIndex.get(d.resource)!, amount: d.amount, when: d.when === undefined ? -1 : calendarIndex.get(d.when)! })),
      fixedCost: mode.fixedCost, release: 0,
    })),
    release: activity.release ?? 0, deadline: Math.min(activity.deadline ?? H, H),
    ...(activity.due === undefined ? {} : { target: activity.due }),
    ...(activity.fixed === undefined ? {} : { fixed: { ...activity.fixed, history: false } }),
  }))
  if ((inst.fixedCost ?? 0) > 0) activities.push({ id: 'method-parts', modes: [{ work: 0, calendar: calendarIndex.get('always')!, continuous: true, demands: [], fixedCost: inst.fixedCost!, release: 0 }], release: 0, deadline: H })
  const links = inst.links.map(link => ({ from: activityIndex.get(link.from)!, to: activityIndex.get(link.to)!, type: link.type, min: link.min, ...(link.max === undefined ? {} : { max: link.max }), origin: 'link' as const }))
  const real = (id: string, side: 'open' | 'close'): number[] => {
    if (side === 'open' && id.endsWith('.start')) return inst.links.filter(link => link.from === id).map(link => activityIndex.get(link.to)!)
    if (side === 'close' && id.endsWith('.end')) return inst.links.filter(link => link.to === id).map(link => activityIndex.get(link.from)!)
    return [activityIndex.get(id)!]
  }
  const items = inst.spans.map(span => ({ id: span.id, openers: real(span.open, 'open'), closers: real(span.close, 'close'), supportedBy: [] as number[] }))
  const spans = inst.spans.map((span, i) => ({ id: span.id, items: [i], ...(span.maxOut === undefined ? {} : { limit: span.maxOut }), singleEntry: true }))
  const coverage = inst.groups.map(group => {
    const members = group.spans.map(id => inst.spans.findIndex(span => span.id === id))
    return { id: group.id, items: members, resources: [], atLeast: members.length - group.maxOut, from: 0, to: H }
  })
  const guided = inst.spans.flatMap((span, i) => (span.guideline === undefined ? [] : [i]))
  const thresholds = new Set(guided.map(i => inst.spans[i]!.guideline!))
  if (thresholds.size > 1) throw new Error('One span-over goal needs one guideline for every span')
  const slotHours = inst.slotHours ?? 0.5
  const problem: NormalizedProblem = {
    slotMs: slotHours * 3_600_000, origin: Date.parse('2026-11-16T06:00:00Z'), horizon, formulation: `bench ${inst.name}`,
    calendars, resources, activities, links, items, spans, coverage,
    goals: [
      { metric: 'span-over', unit: 'h', spans: guided, threshold: [...thresholds][0]! * slotHours, step: 0 },
      { metric: 'finish', unit: 'h', threshold: 0, step: 1 },
      { metric: 'extra-cost', unit: 'NOK', threshold: 0, step: 5_000 },
    ],
  }
  return { problem, toBench: schedule => ({ mode: [...schedule.mode].slice(0, inst.activities.length), start: [...schedule.start].slice(0, inst.activities.length) }) }
}
