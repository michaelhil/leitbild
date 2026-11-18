// Plan measures recomputed by the checker from the dated rows and the plan inputs: span per group, extra
// cost (purchases charged by use, ordered purchases always, method costs), the crew time bought per purchase
// (`bought:<purchase>`, person-hours or periods used), unavailable hours, lateness, finish and last test.
// Goal values are raw: solve/rank.ts alone applies a goal's threshold.
import type { PlanInputs } from '../plan/schema.ts'
import type { Context, Interval, Placed } from './check.ts'

export interface Metric { readonly id: string; readonly value: number; readonly unit: string }
/**
 * A goal's raw value in the goal's unit; solve/rank.ts alone applies thresholds. span-over reports one raw
 * span per group in scope (rank.ts sums the per-group excess over the threshold).
 */
export type GoalValue =
  | { readonly metric: 'span-over'; readonly unit: string; readonly spans: ReadonlyArray<{ readonly group: string; readonly value: number }> }
  | { readonly metric: Exclude<PlanInputs['goals'][number]['metric'], 'span-over'>; readonly value: number; readonly unit: string }

const hourMs = 3_600_000
const timeUnitMs: Readonly<Record<string, number>> = { s: 1_000, min: 60_000, h: hourMs, d: 86_400_000 }

interface MetricInput {
  readonly context: Context
  readonly placed: ReadonlyMap<string, Placed>
  readonly outages: ReadonlyMap<string, readonly Interval[]>
  readonly usedPurchaseSlots: ReadonlyMap<string, Uint8Array>
  readonly personHours: ReadonlyMap<string, number>
  readonly usedPurchases: ReadonlySet<string>
}

const runs = (slots: Uint8Array): Array<[number, number]> => {
  const found: Array<[number, number]> = []
  slots.forEach((slot, index) => {
    const last = found.at(-1)
    if (slot !== 1) return
    if (last !== undefined && last[1] === index) last[1] = index + 1
    else found.push([index, index + 1])
  })
  return found
}

/** Group span and the sum of measured outage, both clipped to the window. */
const clip = (interval: Interval, from: number, to: number): Interval => ({ from: Math.max(interval.from, from), to: Math.min(interval.to, to) })

export const computeMetrics = (input: MetricInput): { readonly metrics: Metric[]; readonly goals: GoalValue[] } => {
  const { context, placed, outages, usedPurchaseSlots, personHours, usedPurchases } = input
  const { inputs, windowStart, windowEnd, grid } = context
  const currency = inputs.settings.currency
  const metrics: Metric[] = []
  /** A purchase's periods as slot ranges: its own periods, or the runs of the calendar it adds. */
  const periodsOf = (purchase: PlanInputs['purchases'][number]): Array<[number, number]> => 'periods' in purchase.adds
    ? purchase.adds.periods.map(period => [Math.max(0, Math.ceil((Date.parse(period.start) - windowStart) / grid.slotMs)), Math.min(grid.slots, Math.floor((Date.parse(period.end) - windowStart) / grid.slotMs))] as [number, number])
    : runs(context.added.get(purchase.key)!)
  /** Its periods in which the rows use it. */
  const usedPeriods = (purchase: PlanInputs['purchases'][number]): number => {
    const bought = usedPurchaseSlots.get(purchase.key)
    return periodsOf(purchase).filter(([from, to]) => { for (let slot = from; slot < to; slot++) if (bought?.[slot] === 1) return true; return false }).length
  }

  // extra cost
  let cost = 0
  for (const purchase of inputs.purchases) {
    const used = usedPurchases.has(purchase.key)
    const ordered = purchase.ordered !== undefined
    if (!used && !ordered) continue
    const price = purchase.price
    if (price.perPersonHour !== undefined) {
      // ordered: every person-hour of the added time is bought, used or not; otherwise the hours used
      const resource = context.resources.get(purchase.resource)
      const ordered = purchase.ordered === undefined || resource === undefined ? undefined
        : context.added.get(purchase.key)!.reduce((sum, slot) => sum + slot, 0) * grid.slotMs / hourMs * resource.count * (resource.crewSize ?? 1)
      cost += (ordered ?? personHours.get(purchase.key) ?? 0) * price.perPersonHour
    }
    if (price.perPeriodUsed !== undefined) {
      const charged = ordered ? periodsOf(purchase).length : usedPeriods(purchase)
      cost += charged * price.perPeriodUsed
    }
    if (price.once !== undefined) cost += price.once
  }
  for (const chosen of context.variant.methods) {
    const option = inputs.methods.find(method => method.key === chosen.choice)?.options.find(candidate => candidate.key === chosen.option)
    if (option !== undefined) cost += option.fixedCost
  }
  cost = Math.round(cost * 100) / 100
  metrics.push({ id: 'extra-cost', value: cost, unit: currency })

  // bought crew time, one figure per purchase the rows use: person-hours for one priced per person-hour,
  // else the periods (its own periods, or runs of its calendar) in which it is used. Ordered time not used
  // is charged (above) but not bought by this schedule, so it has no figure here.
  for (const purchase of inputs.purchases) {
    if (!usedPurchases.has(purchase.key)) continue
    if (purchase.price.perPersonHour !== undefined) {
      metrics.push({ id: `bought:${purchase.key}`, value: personHours.get(purchase.key) ?? 0, unit: 'person-h' })
      continue
    }
    metrics.push({ id: `bought:${purchase.key}`, value: usedPeriods(purchase), unit: 'periods' })
  }

  // spans per group
  const spanHours = new Map<string, number>()
  for (const group of inputs.groups) {
    const intervals = inputs.equipment.filter(item => item.group === group.key).flatMap(item => outages.get(item.key) ?? [])
    if (intervals.length === 0) continue
    const from = Math.min(...intervals.map(interval => interval.from))
    const to = Math.min(windowEnd, Math.max(...intervals.map(interval => interval.to)))
    const hours = Math.max(0, to - from) / hourMs
    spanHours.set(group.key, hours)
    metrics.push({ id: `span:${group.key}`, value: hours, unit: 'h' })
  }

  // unavailable hours over every item
  let unavailable = 0
  for (const [, intervals] of outages) for (const interval of intervals) { const part = clip(interval, windowStart, windowEnd); unavailable += Math.max(0, part.to - part.from) }
  metrics.push({ id: 'unavailable-hours', value: unavailable / hourMs, unit: 'h' })

  // finish and last test
  const finishes = [...placed.values()].map(spot => spot.finish)
  const finish = finishes.length === 0 ? 0 : (Math.max(...finishes) - windowStart) / hourMs
  metrics.push({ id: 'finish', value: finish, unit: 'h' })
  const testFinishes = [...placed.values()].filter(spot => spot.job.kind === 'test').map(spot => spot.finish)
  if (testFinishes.length > 0) metrics.push({ id: 'last-test', value: (Math.max(...testFinishes) - windowStart) / hourMs, unit: 'h' })

  const latenessHours = (tags: readonly string[] | undefined): number => {
    let total = 0
    for (const spot of placed.values()) {
      const target = spot.job.target
      if (target === undefined) continue
      if (tags !== undefined && !spot.job.tags.some(tag => tags.includes(tag))) continue
      total += Math.max(0, spot.finish - Date.parse(target.finishBy))
    }
    return total / hourMs
  }
  metrics.push({ id: 'lateness', value: latenessHours(undefined), unit: 'h' })

  // goal values, raw (rank.ts alone applies a threshold), in each goal's own unit
  const goals = inputs.goals.map((goal): GoalValue => {
    const timeUnit = Object.hasOwn(timeUnitMs, goal.tolerance.unit) ? goal.tolerance.unit : 'h'
    const toUnit = (hours: number): number => hours * hourMs / timeUnitMs[timeUnit]!
    switch (goal.metric) {
      case 'span-over': {
        const groups = goal.scope?.groups ?? [...spanHours.keys()]
        return { metric: goal.metric, unit: timeUnit, spans: groups.map(group => ({ group, value: toUnit(spanHours.get(group) ?? 0) })) }
      }
      case 'finish': return { metric: goal.metric, value: toUnit(finish), unit: timeUnit }
      case 'unavailable-hours': return { metric: goal.metric, value: toUnit(unavailable / hourMs), unit: timeUnit }
      case 'lateness': return { metric: goal.metric, value: toUnit(latenessHours(goal.scope?.tags)), unit: timeUnit }
      case 'extra-cost': return { metric: goal.metric, value: cost, unit: currency }
    }
  })
  return { metrics, goals }
}
