// Independent re-verification of "proven optimal". The checker derives its own lower bound for each goal
// from the plan inputs, in every case of the variant's optional rebookings, and confirms the claim only
// when that bound reaches the claimed value at the goal's resolution. A claim it cannot confirm is shown as
// "best found under budget". The solver's bound and its source are never taken on trust.
//
// Bounds (all valid in every schedule the checker accepts, so the least over the cases is a bound):
// - span-over: per group, the least span the other rules allow from any opening (no span limit applied);
// - finish: the latest earliest finish of any job;
// - lateness: each targeted job's earliest finish past its target;
// - unavailable-hours: per item with a single tag-out, the least outage from that tag-out to its tests;
// - extra-cost: what is charged whatever the plan does (the chosen method costs and ordered purchases).
// Each goal's value is net of its threshold, as the status shows it.
import { goalResolution, type PlanInputs, type Status } from '../plan/schema.ts'
import { prepare, type CheckVariant, type Context } from './check.ts'
import { propagate, resourceSlots, worldsOf } from './propagate.ts'

type GoalStatus = Extract<Status, { word: 'validated feasible' }>['goals'][number]

export interface OptimalCheck {
  readonly goal: number
  readonly claimed: number
  /** The checker's own lower bound, in the goal's unit and net of its threshold. */
  readonly bound: number
  /** The claim is confirmed: the bound reaches the value at the goal's resolution. */
  readonly proves: boolean
}

const hourMs = 3_600_000
const unitHours: Readonly<Record<string, number>> = { s: 1 / 3_600, min: 1 / 60, h: 1, d: 24 }

/** What every schedule of this variant is charged: the chosen method options and ordered purchases. */
const committedCost = (context: Context): number => {
  let cost = 0
  for (const chosen of context.variant.methods) {
    cost += context.inputs.methods.find(method => method.key === chosen.choice)?.options.find(option => option.key === chosen.option)?.fixedCost ?? 0
  }
  for (const purchase of context.inputs.purchases) {
    if (purchase.ordered === undefined) continue
    const added = context.added.get(purchase.key)!
    const slots = added.reduce((sum, slot) => sum + slot, 0)
    const periods = 'periods' in purchase.adds ? purchase.adds.periods.length : added.reduce((count, slot, index) => count + (slot === 1 && added[index - 1] !== 1 ? 1 : 0), 0)
    const resource = context.resources.get(purchase.resource)
    cost += (purchase.price.once ?? 0) + (purchase.price.perPeriodUsed ?? 0) * periods
      + (purchase.price.perPersonHour ?? 0) * slots * context.grid.slotMs / hourMs * (resource?.count ?? 1) * (resource?.crewSize ?? 1)
  }
  return cost
}

/**
 * The finish a keep-in-service rule over crews or tools forces, in slots from the window start. While the
 * rule holds, at least `atLeast` of its members are on duty and free, so at each slot the jobs that need a
 * member in every choice can use at most (members on duty) - atLeast of them, plus members working only in
 * bought time (not on duty for the rule). Those jobs' least work must fit in that capacity from their
 * earliest start; the slot where it first can is a lower bound on the last of them to finish. Only rules
 * whose members are single units are counted (a member of several units can be busy and still free).
 */
const keptFreeFinish = (context: Context, world: Parameters<typeof resourceSlots>[2], windows: ReadonlyMap<string, { readonly es: number; readonly work: number; readonly job: PlanInputs['jobs'][number] }>): number => {
  const { inputs, grid } = context
  let latest = 0
  for (const rule of inputs.rules) {
    if (rule.kind !== 'keep-in-service' || rule.members.some(member => 'equipment' in member)) continue
    const members = rule.members.map(member => 'resource' in member ? member.resource : '')
    if (members.some(key => (context.resources.get(key)?.count ?? 0) !== 1)) continue
    const inside = new Set(members)
    // member-slots the jobs need: one per unit of each need that only members can serve
    const needing = [...windows.values()].filter(window => window.job.needs.some(need => need.anyOf.every(key => inside.has(key))))
    const required = needing.reduce((sum, window) => sum + window.work * window.job.needs.filter(need => need.anyOf.every(key => inside.has(key))).reduce((total, need) => total + need.amount, 0), 0)
    if (required === 0) continue
    const from = rule.during === undefined ? 0 : Math.max(0, Math.floor((Date.parse(rule.during.start) - context.windowStart) / grid.slotMs))
    const to = rule.during === undefined ? grid.slots : Math.min(grid.slots, Math.ceil((Date.parse(rule.during.end) - context.windowStart) / grid.slotMs))
    // on duty for the rule: the normal calendar (less a rebooking taken in this case) and ordered time
    const duty = members.map(key => {
      const resource = context.resources.get(key)!
      const slots = new Uint8Array(grid.slots)
      context.calendars.get(resource.calendar)?.forEach((slot, index) => { if (slot === 1) slots[index] = 1 })
      for (const purchase of inputs.purchases) {
        if (purchase.resource !== key) continue
        if (purchase.ordered !== undefined || world.get(purchase.key) === true) context.replaced.get(purchase.key)!.forEach((slot, index) => { if (slot === 1) slots[index] = 0 })
        if (purchase.ordered !== undefined) context.added.get(purchase.key)!.forEach((slot, index) => { if (slot === 1) slots[index] = 1 })
      }
      return slots
    })
    const usable = members.map(key => resourceSlots(context, key, world))
    let capacity = 0, slot = Math.min(...needing.map(window => window.es))
    for (; slot < grid.slots && capacity < required; slot++) {
      const onDuty = duty.filter(slots => slots[slot] === 1).length
      const boughtOnly = usable.filter((slots, index) => slots[slot] === 1 && duty[index]![slot] !== 1).length
      capacity += (slot >= from && slot < to ? Math.max(0, onDuty - rule.atLeast) : onDuty) + boughtOnly
    }
    latest = Math.max(latest, capacity >= required ? slot : grid.slots)
  }
  return latest
}

/** The checker's lower bound for one goal, raw (before the threshold), in hours or the currency. */
const rawBound = (context: Context, goal: PlanInputs['goals'][number]): number => {
  const { inputs, grid } = context
  if (goal.metric === 'extra-cost') return committedCost(context)
  const slotHours = grid.slotMs / hourMs
  const supportersOf = (item: string, seen: ReadonlySet<string> = new Set()): string[] => (inputs.equipment.find(entry => entry.key === item)?.supportedBy ?? []).filter(key => !seen.has(key)).flatMap(key => [key, ...supportersOf(key, new Set([...seen, item, key]))])
  const active = [...context.active].map(key => context.jobs.get(key)!)
  const covering = (items: ReadonlySet<string>, kinds: ReadonlyArray<'tag-out' | 'test'>) => active.filter(job => kinds.includes(job.kind as 'tag-out' | 'test') && job.equipment.some(item => items.has(item))).map(job => job.key)
  let least = Infinity
  for (const world of worldsOf(context)) {
    const timed = propagate(context, world)
    if (!timed.ok) continue   // this case has no schedule at all
    const earliestFinish = (key: string): number => { const window = timed.windows.get(key)!; return window.finishOf(window.es) * slotHours }
    let value = 0
    switch (goal.metric) {
      case 'span-over': {
        // one raw span per group; the goal's value sums each group's excess, so return the excesses' sum
        const threshold = goal.threshold === undefined ? 0 : goal.threshold.value * (unitHours[goal.threshold.unit] ?? 1)
        const groups = goal.scope?.groups ?? inputs.groups.map(group => group.key)
        for (const group of groups) {
          const covered = new Set(inputs.equipment.filter(item => item.group === group).flatMap(item => [item.key, ...supportersOf(item.key)]))
          const span = timed.shortestSpan(covering(covered, ['tag-out', 'test']), covering(covered, ['test']))
          if (Number.isFinite(span)) value += Math.max(0, span * slotHours - threshold)
        }
        break
      }
      case 'finish':
        value = Math.max(0, ...active.map(job => earliestFinish(job.key)), keptFreeFinish(context, world, timed.windows) * slotHours)
        break
      case 'lateness':
        for (const job of active) {
          if (job.target === undefined || (goal.scope?.tags !== undefined && !job.tags.some(tag => goal.scope!.tags!.includes(tag)))) continue
          value += Math.max(0, earliestFinish(job.key) - (Date.parse(job.target.finishBy) - context.windowStart) / hourMs)
        }
        break
      case 'unavailable-hours':
        for (const item of inputs.equipment) {
          const tags = covering(new Set([item.key]), ['tag-out'])
          if (tags.length !== 1) continue   // a second outage could split it: no bound claimed
          const span = timed.shortestSpan(tags, covering(new Set([item.key]), ['test']))
          if (Number.isFinite(span)) value += span * slotHours
        }
        break
    }
    least = Math.min(least, value)
  }
  return least
}

/** The checker's lower bound for goal `index`, net of its threshold, in `unit` (h, min, s or the currency). */
const boundFor = (context: Context, index: number, unit: string): number | undefined => {
  const definition = context.inputs.goals[index]
  if (definition === undefined) return undefined
  const raw = rawBound(context, definition)
  // span-over's bound is already its excess; the others are net of the threshold here
  const threshold = definition.metric === 'span-over' || definition.threshold === undefined ? 0
    : definition.metric === 'extra-cost' ? definition.threshold.value : definition.threshold.value * (unitHours[definition.threshold.unit] ?? 1)
  const net = Math.max(0, raw - threshold)
  return definition.metric === 'extra-cost' ? net : net / (unitHours[unit] ?? 1)
}

/** The checker's own lower bound for every goal, net of thresholds, in each goal's unit (for harnesses). */
export const checkerBounds = (inputs: PlanInputs, variant: CheckVariant): number[] => {
  const prepared = prepare(inputs, variant)
  if (!prepared.ok) return []
  return inputs.goals.map((goal, index) => boundFor(prepared.context, index, goal.metric === 'extra-cost' ? inputs.settings.currency : goal.tolerance.unit) ?? 0)
}

/**
 * Lane S's port: does the checker's own bound for goal `goal` reach `bound.value` (net of the threshold, in
 * the goal's unit) at the goal's resolution? The solver's certificate is not needed and not trusted; it is
 * accepted for the record only.
 */
export const verifyBound = (inputs: PlanInputs, variant: CheckVariant, goal: number, bound: { readonly value: number }): { readonly proves: boolean; readonly reasons: readonly string[]; readonly checkerBound?: number } => {
  const prepared = prepare(inputs, variant)
  if (!prepared.ok) return { proves: false, reasons: prepared.problems.map(problem => problem.words) }
  const definition = inputs.goals[goal]
  if (definition === undefined) return { proves: false, reasons: [`The plan has no goal ${goal}.`] }
  const unit = definition.metric === 'extra-cost' ? inputs.settings.currency : definition.tolerance.unit
  const own = boundFor(prepared.context, goal, unit)
  if (own === undefined) return { proves: false, reasons: [`The plan has no goal ${goal}.`] }
  const resolution = goalResolution(unit, inputs.settings.grid) ?? 0
  const proves = own >= bound.value - resolution / 2
  return { proves, checkerBound: own, reasons: proves ? [] : [`The checker's own bound for goal ${goal} is ${own} ${unit}, below the claimed ${bound.value} ${unit}.`] }
}

/**
 * Re-verifies every "proven optimal" goal of a validated feasible status. Goal order applies: once one is
 * not confirmed, no later goal is either (a later goal is proven only when every earlier one is).
 */
export const verifyOptimality = (inputs: PlanInputs, variant: CheckVariant, status: Status): OptimalCheck[] => {
  if (status.word !== 'validated feasible') return []
  const prepared = prepare(inputs, variant)
  const claims = status.goals.filter((goal): goal is GoalStatus => goal.word === 'proven optimal')
  if (!prepared.ok) return claims.map(goal => ({ goal: goal.goal, claimed: goal.value, bound: 0, proves: false }))
  let broken = false
  return claims.map(goal => {
    const bound = boundFor(prepared.context, goal.goal, goal.unit) ?? 0
    const resolution = goalResolution(goal.unit, inputs.settings.grid) ?? 0
    const proves = !broken && bound >= goal.value - resolution / 2
    if (!proves) broken = true
    return { goal: goal.goal, claimed: goal.value, bound, proves }
  })
}
