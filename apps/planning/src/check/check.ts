// The one arbiter of feasibility for every engine. It reads only the plan inputs, the variant and the
// dated rows, re-derives every derived rule itself, and never trusts a solver's resource record: the
// worked slots of each job are recomputed from its start, duration and calendars, and the recorded uses
// must serve every need for exactly those slots. It shares only time/zone.ts with the compiler.
import type { PlanInputs } from '../plan/schema.ts'
import { localParts } from '../time/zone.ts'
import { expand, periodSlots, type Grid } from './calendar.ts'
import { computeMetrics, type GoalValue, type Metric } from './metrics.ts'

/**
 * The version of lane K's rules: the checker, the certificate re-verification and the optimality bounds.
 * A stored status is only as good as the rules it was checked by, so this belongs in the solver's
 * formulation: a stored option checked by older rules is then out of date. Raise it whenever any rule,
 * verifier or bound in check/ changes what it accepts.
 */
export const CHECKER_VERSION = 'lane-k rules 1'

type Inputs = PlanInputs
type Job = Inputs['jobs'][number]
type Resource = Inputs['resources'][number]
type Purchase = Inputs['purchases'][number]
type Rule = Inputs['rules'][number]

export interface CheckUse { readonly resource: string; readonly from: string; readonly to: string; readonly purchase?: string | undefined }
/** A dated row as the checker reads it; stored rows carry float too, which the checker ignores. */
export interface CheckRow { readonly job: string; readonly start: string; readonly finish: string; readonly uses: readonly CheckUse[] }
/** The method options and the purchases this variant may use (a variant's buy overrides `allowed`). */
export interface CheckVariant {
  readonly methods: ReadonlyArray<{ readonly choice: string; readonly option: string }>
  readonly purchases: readonly string[]
}

export type ViolationCode =
  // inputs that cannot be checked or cannot be valid
  | 'no-window' | 'window-off-grid' | 'calendar-needs-zone' | 'calendar-off-grid' | 'unknown-key' | 'method-choice'
  | 'support-cycle' | 'bracket-missing' | 'equipment-missing' | 'world-value-unread' | 'below-minimum' | 'duration-ambiguous'
  | 'no-working-calendar' | 'where-unit'
  // rows
  | 'not-scheduled' | 'scheduled-twice' | 'not-in-variant' | 'time-unreadable' | 'off-grid' | 'outside-window'
  | 'finish-mismatch' | 'start-off-calendar' | 'not-continuous' | 'beyond-window' | 'release' | 'lock' | 'before-data-date'
  // resources
  | 'need-not-served' | 'use-outside-work' | 'use-outside-calendar' | 'ineligible-resource' | 'where-not-met'
  | 'handover-not-allowed' | 'over-capacity' | 'max-jobs' | 'purchase-not-allowed' | 'purchase-past-deadline' | 'purchase-wrong-resource'
  // logic and availability
  | 'link' | 'bracket' | 'tag-before-test' | 'support-order' | 'never-returned' | 'span-limit' | 'keep-in-service' | 'due'
  | 'protected-equipment' | 'protected-unavailable' | 'precondition-unread' | 'precondition-unmet'

/** Codes that say the inputs cannot give a valid plan: the status is "invalid input", never "proven infeasible". */
export const inputCodes: ReadonlySet<ViolationCode> = new Set<ViolationCode>([
  'no-window', 'window-off-grid', 'calendar-needs-zone', 'calendar-off-grid', 'unknown-key', 'method-choice', 'support-cycle',
  'bracket-missing', 'equipment-missing', 'world-value-unread', 'below-minimum', 'duration-ambiguous', 'no-working-calendar', 'where-unit',
])

/** Structure for code and the Assistant; `words` is generated from it for people and never stored. */
export interface Violation { readonly code: ViolationCode; readonly about: readonly string[]; readonly at?: string; readonly words: string }

export interface Interval { readonly from: number; readonly to: number }   // ms; `to` is Infinity when never returned

export interface CheckResult {
  readonly feasible: boolean
  /** Some violation is an input problem (see inputCodes): the plan is invalid input, not infeasible. */
  readonly invalidInput: boolean
  readonly violations: readonly Violation[]
  readonly metrics: readonly Metric[]
  /** One per plan goal, in goal order, raw (no threshold applied), in the goal's unit. */
  readonly goals: readonly GoalValue[]
  /** Each item's unavailable intervals, its own and its supporters', merged. */
  readonly outages: ReadonlyMap<string, readonly Interval[]>
}

const unitMs: Readonly<Record<string, number>> = { s: 1_000, min: 60_000, h: 3_600_000, d: 86_400_000 }
const massKg: Readonly<Record<string, number>> = { kg: 1 }
const slotMsOf = { '30s': 30_000, '30min': 1_800_000 } as const

/** Converts within one dimension only (time or mass); undefined when the units do not convert. */
const convert = (value: number, from: string, to: string): number | undefined => {
  if (from === to) return value
  const table = Object.hasOwn(unitMs, from) && Object.hasOwn(unitMs, to) ? unitMs : Object.hasOwn(massKg, from) && Object.hasOwn(massKg, to) ? massKg : undefined
  return table === undefined ? undefined : value * table[from]! / table[to]!
}

// ───────────── prepared inputs ─────────────

export interface Context {
  readonly inputs: Inputs
  readonly variant: CheckVariant
  readonly grid: Grid
  readonly windowStart: number
  readonly windowEnd: number
  readonly jobs: ReadonlyMap<string, Job>
  readonly active: ReadonlySet<string>
  readonly resources: ReadonlyMap<string, Resource>
  readonly purchases: ReadonlyMap<string, Purchase>
  /** Purchases this variant may use, after the order deadline at the data date, and every ordered purchase. */
  readonly permitted: ReadonlySet<string>
  readonly calendars: ReadonlyMap<string, Uint8Array>
  readonly added: ReadonlyMap<string, Uint8Array>
  readonly replaced: ReadonlyMap<string, Uint8Array>
  readonly slotOf: (instant: number) => number
  readonly when: (instant: number) => string
}

export type Prepared = { readonly ok: true; readonly context: Context; readonly problems: readonly Violation[] } | { readonly ok: false; readonly problems: readonly Violation[] }

const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const pad = (value: number): string => String(value).padStart(2, '0')

const formatWhen = (zone: string | null) => (instant: number): string => {
  if (!Number.isFinite(instant)) return 'never'
  if (zone === null) {
    const date = new Date(instant)
    return `${dayNames[date.getUTCDay()]} ${date.getUTCDate()} ${monthNames[date.getUTCMonth()]} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  }
  const local = localParts(zone, instant)
  const weekday = dayNames[new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay()]
  const seconds = local.second === 0 ? '' : `:${pad(local.second)}`
  return `${weekday} ${local.day} ${monthNames[local.month - 1]} ${pad(local.hour)}:${pad(local.minute)}${seconds}`
}

const violation = (code: ViolationCode, about: readonly string[], words: string, at?: number): Violation =>
  ({ code, about, words, ...(at === undefined || !Number.isFinite(at) ? {} : { at: new Date(at).toISOString() }) })

const isActive = (part: { readonly method?: { readonly choice: string; readonly option: string } | undefined }, variant: CheckVariant): boolean =>
  part.method === undefined || variant.methods.some(chosen => chosen.choice === part.method!.choice && chosen.option === part.method!.option)

export const prepare = (inputs: Inputs, variant: CheckVariant): Prepared => {
  const problems: Violation[] = []
  const window = inputs.settings.window
  if (window === null) return { ok: false, problems: [violation('no-window', [], 'The plan has no window, so no schedule can be checked.')] }
  const slotMs = slotMsOf[inputs.settings.grid]
  const windowStart = Date.parse(window.start), windowEnd = Date.parse(window.end)
  const zone = inputs.settings.timeZone
  const when = formatWhen(zone)
  if (windowStart % slotMs !== 0 || windowEnd % slotMs !== 0) {
    return { ok: false, problems: [violation('window-off-grid', [], `The window ${when(windowStart)} to ${when(windowEnd)} does not fall on the plan grid.`)] }
  }
  const grid: Grid = { zone, slotMs, origin: windowStart, slots: (windowEnd - windowStart) / slotMs }
  const slotOf = (instant: number): number => (instant - windowStart) / slotMs

  const calendars = new Map<string, Uint8Array>()
  const expandOrNote = (shape: Parameters<typeof expand>[0], owner: string): Uint8Array | undefined => {
    const result = expand(shape, grid)
    if (result.ok) return result.work
    problems.push(result.reason === 'needs-zone'
      ? violation('calendar-needs-zone', [owner], `The calendar '${shape.key}' uses weekly hours, so the plan needs a time zone.`)
      : violation('calendar-off-grid', [owner], `The calendar '${shape.key}' has a boundary off the plan grid at ${when(result.at!)}.`, result.at))
    return undefined
  }
  for (const calendar of inputs.calendars) {
    const work = expandOrNote(calendar, calendar.key)
    if (work !== undefined) calendars.set(calendar.key, work)
  }

  const resources = new Map(inputs.resources.map(resource => [resource.key, resource]))
  const purchases = new Map(inputs.purchases.map(purchase => [purchase.key, purchase]))
  const jobs = new Map(inputs.jobs.map(job => [job.key, job]))

  for (const chosen of variant.methods) {
    const choice = inputs.methods.find(method => method.key === chosen.choice)
    if (choice === undefined || !choice.options.some(option => option.key === chosen.option)) {
      problems.push(violation('unknown-key', [chosen.choice, chosen.option], `The variant names a method option '${chosen.choice}: ${chosen.option}' that the plan does not have.`))
    }
  }
  for (const method of inputs.methods) {
    const count = variant.methods.filter(chosen => chosen.choice === method.key).length
    if (count !== 1) problems.push(violation('method-choice', [method.key], `The variant must choose exactly one option for '${method.label}'; it chooses ${count}.`))
  }
  for (const key of variant.purchases) {
    if (!purchases.has(key)) problems.push(violation('unknown-key', [key], `The variant allows a purchase '${key}' that the plan does not have.`))
  }

  const dataDate = inputs.settings.dataDate === null ? undefined : Date.parse(inputs.settings.dataDate)
  const permitted = new Set<string>()
  for (const key of variant.purchases) {
    const purchase = purchases.get(key)
    if (purchase === undefined) continue
    const lapsed = purchase.ordered === undefined && purchase.orderBy !== undefined && dataDate !== undefined && dataDate > Date.parse(purchase.orderBy)
    if (!lapsed) permitted.add(key)
  }
  for (const purchase of inputs.purchases) if (purchase.ordered !== undefined) permitted.add(purchase.key)   // already bought
  const added = new Map<string, Uint8Array>()
  const replaced = new Map<string, Uint8Array>()
  for (const purchase of inputs.purchases) {
    if (!resources.has(purchase.resource)) problems.push(violation('unknown-key', [purchase.key, purchase.resource], `The purchase '${purchase.label}' is for a resource the plan does not have.`))
    if ('calendar' in purchase.adds) {
      const key = purchase.adds.calendar
      if (!inputs.calendars.some(known => known.key === key)) problems.push(violation('unknown-key', [purchase.key, key], `The purchase '${purchase.label}' adds a calendar the plan does not have.`))
      added.set(purchase.key, calendars.get(key) ?? new Uint8Array(grid.slots))
    } else {
      added.set(purchase.key, periodSlots(purchase.adds.periods, grid))
      for (const period of purchase.adds.periods) {
        for (const instant of [Date.parse(period.start), Date.parse(period.end)]) {
          if (instant > windowStart && instant < windowEnd && (instant - windowStart) % slotMs !== 0) {
            problems.push(violation('calendar-off-grid', [purchase.key], `The purchase '${purchase.label}' has a period boundary off the plan grid at ${when(instant)}.`, instant))
          }
        }
      }
    }
    replaced.set(purchase.key, periodSlots(purchase.replaces, grid))
  }
  for (const resource of inputs.resources) {
    if (!inputs.calendars.some(calendar => calendar.key === resource.calendar)) problems.push(violation('unknown-key', [resource.key, resource.calendar], `The resource '${resource.label}' uses a calendar the plan does not have.`))
  }

  const active = new Set(inputs.jobs.filter(job => isActive(job, variant)).map(job => job.key))
  return { ok: true, problems, context: { inputs, variant, grid, windowStart, windowEnd, jobs, active, resources, purchases, permitted, calendars, added, replaced, slotOf, when } }
}

// ───────────── durations ─────────────

export type DurationResult = { readonly ok: true; readonly slots: number; readonly ms: number } | { readonly ok: false; readonly problem: Violation }

const sumWorldRefs = (context: Context, refs: ReadonlyArray<{ readonly locator: string; readonly fact: string }>, unit: string): number | undefined => {
  let total = 0
  for (const ref of refs) {
    const matches = context.inputs.world.facts.filter(fact => fact.locator === ref.locator && fact.id === ref.fact)
    if (matches.length !== 1) return undefined
    const fact = matches[0]!
    if (typeof fact.value !== 'number' || fact.unit === undefined) return undefined
    const converted = convert(fact.value, fact.unit, unit)
    if (converted === undefined) return undefined
    total += converted
  }
  return total
}

/** The job's duration for the resources its row chose: a matching durationWith entry, else its own. */
export const jobDuration = (context: Context, job: Job, chosen: ReadonlySet<string>): DurationResult => {
  const unit = job.duration.unit
  const toResult = (value: number | undefined, from: string): DurationResult => {
    if (value === undefined) return { ok: false, problem: violation('world-value-unread', [job.key], `'${job.title}' takes its duration from World values (${from}) that are not read, or not readable as a time.`) }
    const ms = value * unitMs[unit]!
    return { ok: true, ms, slots: Math.ceil(ms / context.grid.slotMs - 1e-9) }
  }
  const matching = job.durationWith.filter(entry => chosen.has(entry.resource))
  const values = matching.map(entry => 'value' in entry ? entry.value : sumWorldRefs(context, entry.refs, unit))
  if (matching.length > 0) {
    if (new Set(values).size > 1) return { ok: false, problem: violation('duration-ambiguous', [job.key, ...matching.map(entry => entry.resource)], `'${job.title}' uses resources with different durations, so its duration is not defined.`) }
    return toResult(values[0], matching.map(entry => entry.resource).join(', '))
  }
  const origin = job.duration.origin
  if (origin.by === 'world') return toResult(sumWorldRefs(context, origin.refs, unit), origin.refs.map(ref => ref.fact).join(' + '))
  return toResult(job.duration.value ?? undefined, 'none')
}

// ───────────── the check ─────────────

interface Placed { readonly job: Job; readonly start: number; readonly finish: number }

const mergeIntervals = (intervals: readonly Interval[]): Interval[] => {
  const sorted = [...intervals].sort((left, right) => left.from - right.from)
  const merged: Interval[] = []
  for (const interval of sorted) {
    const last = merged.at(-1)
    if (last !== undefined && interval.from <= last.to) merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, interval.to) }
    else merged.push(interval)
  }
  return merged
}

/** Whether the needs can share out these units: each need gets exactly its amount from resources it accepts. */
const canServe = (needs: ReadonlyArray<{ readonly eligible: ReadonlySet<string>; readonly amount: number }>, units: ReadonlyMap<string, number>): boolean => {
  const total = [...units.values()].reduce((sum, count) => sum + count, 0)
  if (total !== needs.reduce((sum, need) => sum + need.amount, 0)) return false
  const left = new Map(units)
  const assign = (index: number, remaining: number): boolean => {
    if (index === needs.length) return true
    const need = needs[index]!
    if (remaining === 0) return assign(index + 1, index + 1 < needs.length ? needs[index + 1]!.amount : 0)
    for (const [resource, count] of left) {
      if (count === 0 || !need.eligible.has(resource)) continue
      left.set(resource, count - 1)
      if (assign(index, remaining - 1)) return true
      left.set(resource, count)
    }
    return false
  }
  return needs.length === 0 ? total === 0 : assign(0, needs[0]!.amount)
}

/** An attribute's value in force at an instant: its own value (or its World value) and announced changes. */
const attributeAt = (context: Context, resource: Resource, key: string, instant: number): { readonly value: number; readonly unit: string } | 'unread' | undefined => {
  const attribute = resource.attributes.find(candidate => candidate.key === key)
  if (attribute === undefined) return undefined
  let value = attribute.origin.by === 'world' ? sumWorldRefs(context, attribute.origin.refs, attribute.unit) : attribute.value ?? undefined
  if (value === undefined) return 'unread'
  let latest = -Infinity
  for (const change of attribute.changes) {
    const at = Date.parse(change.at)
    if (at <= instant && at >= latest) { value = change.value; latest = at }
  }
  return { value, unit: attribute.unit }
}

/**
 * For counterfactual harnesses only (production passes nothing): derived orders not to check, each a
 * (before, after) pair of jobs, so a test can ask "what if this one order did not hold?" while every
 * other rule, equipment and calendar stays as it is. Covers bracketing, tag before test and support order.
 */
export interface CheckWaivers { readonly orders?: ReadonlyArray<readonly [string, string]> }

export const checkPlan = (inputs: Inputs, variant: CheckVariant, rows: readonly CheckRow[], waivers: CheckWaivers = {}): CheckResult => {
  const waived = new Set((waivers.orders ?? []).map(([before, after]) => `${before}>${after}`))
  const isWaived = (before: string, after: string): boolean => waived.has(`${before}>${after}`)
  const prepared = prepare(inputs, variant)
  if (!prepared.ok) return { feasible: false, invalidInput: true, violations: prepared.problems, metrics: [], goals: [], outages: new Map() }
  const context = prepared.context
  const { grid, when, jobs, active, resources, purchases, permitted, calendars, added, replaced } = context
  const found: Violation[] = [...prepared.problems]
  const push = (code: ViolationCode, about: readonly string[], words: string, at?: number): void => { found.push(violation(code, about, words, at)) }
  const slotMs = grid.slotMs
  const instantOf = (slot: number): number => context.windowStart + slot * slotMs
  const onGrid = (instant: number): boolean => Number.isFinite(instant) && (instant - context.windowStart) % slotMs === 0

  // ── rows: one per active job, on the grid, inside the window ──
  const placed = new Map<string, Placed>()
  const rowOf = new Map<string, CheckRow>()
  for (const row of rows) {
    const job = jobs.get(row.job)
    if (job === undefined || !active.has(row.job)) {
      push('not-in-variant', [row.job], job === undefined ? `A schedule row names '${row.job}', which is not a job of this plan.` : `'${job.title}' belongs to a method option this variant does not choose, yet it is scheduled.`)
      continue
    }
    if (rowOf.has(row.job)) { push('scheduled-twice', [row.job], `'${job.title}' is scheduled more than once.`); continue }
    rowOf.set(row.job, row)
    const start = Date.parse(row.start), finish = Date.parse(row.finish)
    if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) { push('time-unreadable', [row.job], `'${job.title}' has no readable start and finish.`); continue }
    if (!onGrid(start) || !onGrid(finish)) push('off-grid', [row.job], `'${job.title}' starts or finishes off the plan grid (${when(start)} to ${when(finish)}).`, start)
    if (start < context.windowStart || finish > context.windowEnd) push('outside-window', [row.job], `'${job.title}' runs ${when(start)} to ${when(finish)}, outside the window ${when(context.windowStart)} to ${when(context.windowEnd)}.`, start)
    placed.set(row.job, { job, start, finish })
  }
  for (const key of active) if (!rowOf.has(key)) push('not-scheduled', [key], `'${jobs.get(key)!.title}' is not scheduled.`)

  // ── per job: duration, worked slots and the uses that serve them ──
  const load = new Map<string, Int32Array>()
  const usedPurchaseSlots = new Map<string, Uint8Array>()
  const jobsPerResource = new Map<string, Set<string>>()
  const personHours = new Map<string, number>()   // purchase -> person-hours bought
  const loadOf = (key: string): Int32Array => { let array = load.get(key); if (array === undefined) { array = new Int32Array(grid.slots); load.set(key, array) } return array }
  const workedOf = new Map<string, readonly number[]>()   // job -> its worked slots, for the progress lags
  const usedPurchases = new Set<string>()
  for (const [, row] of rowOf) for (const use of row.uses) if (use.purchase !== undefined && purchases.has(use.purchase)) usedPurchases.add(use.purchase)
  const replacedNow = new Map<string, Uint8Array>()   // resource -> booked slots made unusable by a used or ordered rebooking
  for (const purchase of inputs.purchases) {
    if (!(usedPurchases.has(purchase.key) || purchase.ordered !== undefined)) continue
    const target = replacedNow.get(purchase.resource) ?? new Uint8Array(grid.slots)
    replaced.get(purchase.key)!.forEach((slot, index) => { if (slot === 1) target[index] = 1 })
    replacedNow.set(purchase.resource, target)
  }
  const baseAvailability = (resource: Resource): Uint8Array => {
    const base = calendars.get(resource.calendar) ?? new Uint8Array(grid.slots)
    const gone = replacedNow.get(resource.key)
    return gone === undefined ? base : base.map((slot, index) => slot === 1 && gone[index] === 0 ? 1 : 0)
  }
  const sourceAvailability = (resource: Resource, purchase: string | undefined): Uint8Array => purchase === undefined ? baseAvailability(resource) : added.get(purchase) ?? new Uint8Array(grid.slots)

  for (const [key, row] of rowOf) {
    const spot = placed.get(key)
    if (spot === undefined) continue
    const job = spot.job
    const startSlot = Math.round(context.slotOf(spot.start)), finishSlot = Math.round(context.slotOf(spot.finish))
    if (!onGrid(spot.start) || !onGrid(spot.finish)) continue

    // where: which resources each need accepts at the start
    const needs = job.needs.map((need, index) => {
      const eligible = new Set<string>()
      for (const candidate of need.anyOf) {
        const resource = resources.get(candidate)
        if (resource === undefined) { push('unknown-key', [job.key, candidate], `'${job.title}' needs a resource '${candidate}' that the plan does not have.`); continue }
        if (need.where !== undefined) {
          const value = attributeAt(context, resource, need.where.attribute, spot.start)
          if (value === 'unread') { push('world-value-unread', [job.key, candidate], `'${resource.label}' takes its ${need.where.attribute} from World values that are not read, so '${job.title}' cannot be checked against it.`); continue }
          const converted = value === undefined ? undefined : convert(value.value, value.unit, need.where.unit)
          if (converted === undefined) {
            if (value !== undefined) push('where-unit', [job.key, candidate], `'${resource.label}' gives ${need.where.attribute} in ${value.unit}, which does not convert to ${need.where.unit}.`)
            continue
          }
          if (converted < need.where.atLeast) continue
        }
        eligible.add(candidate)
      }
      return { index, need, eligible, anyOf: new Set(need.anyOf) }
    })

    // the recorded uses, each checked on its own; a refuted use makes the row's later checks moot
    let refuted = false
    const before = found.length
    const chosen = new Set<string>()
    const units = new Map<string, Int32Array>()   // resource -> units this job uses per slot
    const sourcesOfNeed = new Map<number, Set<string>>()   // need index -> "resource|purchase"
    for (const use of row.uses) {
      const from = Date.parse(use.from), to = Date.parse(use.to)
      const resource = resources.get(use.resource)
      if (resource === undefined) { push('unknown-key', [job.key, use.resource], `'${job.title}' records a resource '${use.resource}' that the plan does not have.`); continue }
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !onGrid(from) || !onGrid(to)) { push('off-grid', [job.key, use.resource], `'${job.title}' records a use of '${resource.label}' that is not a period on the plan grid.`); continue }
      const accepting = needs.filter(need => need.anyOf.has(use.resource))
      if (accepting.length === 0) { push('ineligible-resource', [job.key, use.resource], `'${job.title}' uses '${resource.label}', which none of its needs accepts.`, from); continue }
      if (!accepting.some(need => need.eligible.has(use.resource))) {
        push('where-not-met', [job.key, use.resource], `'${resource.label}' does not meet '${job.title}''s requirement at its start, ${when(spot.start)}.`, spot.start)
        continue
      }
      if (use.purchase !== undefined) {
        const purchase = purchases.get(use.purchase)
        if (purchase === undefined) { push('unknown-key', [job.key, use.purchase], `'${job.title}' records time bought from '${use.purchase}', which the plan does not have.`); continue }
        if (purchase.resource !== use.resource) { push('purchase-wrong-resource', [job.key, use.purchase], `'${purchase.label}' buys time for another resource than '${resource.label}'.`, from); continue }
        if (!variant.purchases.includes(use.purchase) && purchase.ordered === undefined) push('purchase-not-allowed', [job.key, use.purchase], `'${job.title}' uses '${purchase.label}', which this variant does not allow.`, from)
        else if (!permitted.has(use.purchase)) push('purchase-past-deadline', [job.key, use.purchase], `'${job.title}' uses '${purchase.label}', but it was not ordered by ${when(Date.parse(purchase.orderBy!))}.`, from)
      }
      const availability = sourceAvailability(resource, use.purchase)
      const first = Math.round(context.slotOf(from)), last = Math.round(context.slotOf(to))
      let outside: number | undefined
      const perSlot = units.get(use.resource) ?? new Int32Array(grid.slots)
      for (let slot = first; slot < last; slot++) {
        if (slot < 0 || slot >= grid.slots || availability[slot] !== 1) { outside ??= slot; continue }
        perSlot[slot] = perSlot[slot]! + 1
      }
      units.set(use.resource, perSlot)
      if (outside !== undefined) {
        push('use-outside-calendar', [job.key, use.resource], `'${job.title}' uses '${resource.label}' at ${when(instantOf(outside))}, outside its working time${use.purchase === undefined ? '' : ` bought from '${purchases.get(use.purchase)?.label ?? use.purchase}'`}.`, instantOf(outside))
      }
      chosen.add(use.resource)
      for (const need of accepting) {
        const set = sourcesOfNeed.get(need.index) ?? new Set<string>()
        set.add(`${use.resource}|${use.purchase ?? ''}`)
        sourcesOfNeed.set(need.index, set)
      }
      if (use.purchase !== undefined && purchases.has(use.purchase)) {
        const bought = usedPurchaseSlots.get(use.purchase) ?? new Uint8Array(grid.slots)
        for (let slot = Math.max(0, first); slot < Math.min(grid.slots, last); slot++) bought[slot] = 1
        usedPurchaseSlots.set(use.purchase, bought)
        personHours.set(use.purchase, (personHours.get(use.purchase) ?? 0) + (to - from) / 3_600_000 * (resource.crewSize ?? 1))
      }
    }

    refuted = found.length > before
    // duration and worked slots
    if (job.kind === 'test' && job.minimum !== undefined) {
      const declared = job.duration.value === null ? undefined : convert(job.duration.value, job.duration.unit, job.minimum.unit)
      if (declared !== undefined && declared < job.minimum.value - 1e-9) push('below-minimum', [job.key], `'${job.title}' is estimated at ${job.duration.value} ${job.duration.unit}, below its declared minimum of ${job.minimum.value} ${job.minimum.unit}.`)
    }
    const duration = jobDuration(context, job, chosen)
    if (!duration.ok) { found.push(duration.problem); continue }
    const work = duration.slots
    let worked: number[] | undefined
    if (refuted) {
      // the row is already refuted by its uses; its timing is not judged further
    } else if (job.duration.calendar === 'elapsed' || work === 0) {
      worked = Array.from({ length: work }, (_, index) => startSlot + index)
    } else if (job.needs.length === 0) {
      push('no-working-calendar', [job.key], `'${job.title}' counts working time but needs no resource, so it has no working calendar.`)
    } else {
      const calendar = new Uint8Array(grid.slots).fill(1)
      let served = true
      for (const need of needs) {
        const sources = sourcesOfNeed.get(need.index)
        if (sources === undefined) {
          served = false
          if (!refuted) push('need-not-served', [job.key], `'${job.title}' records no ${need.need.anyOf.map(candidate => resources.get(candidate)?.label ?? candidate).join(' or ')} for its work.`, spot.start)
          continue
        }
        const union = new Uint8Array(grid.slots)
        for (const source of sources) {
          const [resourceKey, purchaseKey] = source.split('|') as [string, string]
          const availability = sourceAvailability(resources.get(resourceKey)!, purchaseKey === '' ? undefined : purchaseKey)
          availability.forEach((slot, index) => { if (slot === 1) union[index] = 1 })
        }
        for (let slot = 0; slot < grid.slots; slot++) calendar[slot] = calendar[slot]! & union[slot]!
      }
      if (served) {
        if (job.continuous) {
          worked = Array.from({ length: work }, (_, index) => startSlot + index)
          const gap = worked.find(slot => slot >= grid.slots || calendar[slot] !== 1)
          if (gap !== undefined) push('not-continuous', [job.key], `'${job.title}' must run without a break, but its crews are off at ${when(instantOf(gap))}.`, instantOf(gap))
        } else if (calendar[startSlot] !== 1) {
          push('start-off-calendar', [job.key], `'${job.title}' starts at ${when(spot.start)}, when its crews are not working.`, spot.start)
        } else {
          worked = []
          for (let slot = startSlot; slot < grid.slots && worked.length < work; slot++) if (calendar[slot] === 1) worked.push(slot)
          if (worked.length < work) { push('beyond-window', [job.key], `'${job.title}' cannot get its ${duration.ms / 3_600_000} h of working time before the window ends.`, spot.start); worked = undefined }
        }
      }
    }
    if (worked !== undefined) {
      workedOf.set(job.key, worked)
      const expectedFinish = work === 0 ? startSlot : worked[worked.length - 1]! + 1
      if (expectedFinish !== finishSlot) {
        push('finish-mismatch', [job.key], `'${job.title}' is recorded to finish at ${when(spot.finish)}; its start, duration and calendars give ${when(instantOf(expectedFinish))}.`, spot.finish)
      }
      // every need served for exactly the worked slots, and nothing else used
      const isWorked = new Uint8Array(grid.slots + 1)
      for (const slot of worked) if (slot >= 0 && slot < grid.slots) isWorked[slot] = 1
      const unserved: number[] = []
      let extra: number | undefined
      for (let slot = 0; slot < grid.slots; slot++) {
        const here = new Map<string, number>()
        for (const [resource, perSlot] of units) if (perSlot[slot]! > 0) here.set(resource, perSlot[slot]!)
        if (isWorked[slot] === 1) {
          if (!canServe(needs.map(need => ({ eligible: need.eligible, amount: need.need.amount })), here)) unserved.push(slot)
        } else if (here.size > 0) extra ??= slot
      }
      if (unserved.length > 0) push('need-not-served', [job.key], `'${job.title}' is not served by exactly the crews and tools it needs at ${when(instantOf(unserved[0]!))}${unserved.length > 1 ? ` and ${unserved.length - 1} more half-hours or slots` : ''}.`, instantOf(unserved[0]!))
      if (extra !== undefined) push('use-outside-work', [job.key], `'${job.title}' records crew or tool use at ${when(instantOf(extra))}, when it is not working.`, instantOf(extra))
      // handover: a need without it keeps the same resources throughout (judged only when every slot is served)
      for (const need of unserved.length > 0 ? [] : needs) {
        if (need.need.handover) continue
        const overlapping = needs.some(other => other !== need && [...other.anyOf].some(resource => need.anyOf.has(resource)))
        if (overlapping) continue
        const signatures = new Set(worked.filter(slot => slot >= 0 && slot < grid.slots).map(slot => [...need.anyOf].map(resource => units.get(resource)?.[slot] ?? 0).join(',')))
        if (signatures.size > 1) push('handover-not-allowed', [job.key], `'${job.title}' changes crew part-way, which it may not.`)
      }
    }
    for (const [resource, perSlot] of units) {
      const total = loadOf(resource)
      perSlot.forEach((count, slot) => { total[slot] = total[slot]! + count })
      const set = jobsPerResource.get(resource) ?? new Set<string>()
      set.add(job.key)
      jobsPerResource.set(resource, set)
    }
  }

  // ── capacity and job counts per resource ──
  for (const [key, total] of load) {
    const resource = resources.get(key)!
    const over = total.findIndex(count => count > resource.count)
    if (over >= 0) push('over-capacity', [key], `'${resource.label}' is booked ${total[over]} times at ${when(instantOf(over))}; it has ${resource.count}.`, instantOf(over))
    const count = jobsPerResource.get(key)?.size ?? 0
    if (resource.maxJobs !== undefined && count > resource.maxJobs) push('max-jobs', [key], `'${resource.label}' is given ${count} jobs; the plan allows at most ${resource.maxJobs} ahead.`)
  }

  // ── logic: links, releases, the data date, locks ──
  const dataDate = inputs.settings.dataDate === null ? undefined : Date.parse(inputs.settings.dataDate)
  const timesOf = (key: string): Placed | undefined => placed.get(key)
  for (const link of inputs.links) {
    if (!isActive(link, variant)) continue
    if (!jobs.has(link.from) || !jobs.has(link.to)) { push('unknown-key', [link.from, link.to], `A link names a job the plan does not have (${link.from} to ${link.to}).`); continue }
    if (!active.has(link.from) || !active.has(link.to)) continue
    const from = timesOf(link.from), to = timesOf(link.to)
    if (from === undefined || to === undefined) continue
    const lag = link.lag.value * unitMs[link.lag.unit]!
    const hours = (ms: number): number => ms / 3_600_000
    if (link.type === 'FS') {
      // a wait: clock time from the predecessor's finish
      const gap = to.start - from.finish
      if (gap < lag) push('link', [link.from, link.to], `'${to.job.title}' must start after '${from.job.title}' finishes${lag > 0 ? `, with ${hours(lag)} h between` : ''}; it is ${hours(lag - gap)} h too early.`, to.start)
      continue
    }
    // SS and FF lags count progress: the predecessor's working time done, the successor's working time after.
    // Without the worked slots (a row already refuted) the clock-time form, which progress implies, is used.
    const doneBy = (key: string, instant: number): number | undefined => {
      const slots = workedOf.get(key)
      return slots === undefined ? undefined : slots.filter(slot => instantOf(slot) + slotMs <= instant).length * slotMs
    }
    const total = (key: string): number | undefined => { const slots = workedOf.get(key); return slots === undefined ? undefined : slots.length * slotMs }
    if (link.type === 'SS') {
      const done = doneBy(link.from, to.start)
      // a lag longer than the predecessor's work asks for all of it
      const needed = Math.min(lag, total(link.from) ?? lag)
      if (to.start < from.start) push('link', [link.from, link.to], `'${to.job.title}' starts at ${when(to.start)}, before '${from.job.title}' starts.`, to.start)
      else if (done === undefined ? to.start - from.start < lag : done < needed) {
        push('link', [link.from, link.to], done === undefined
          ? `'${to.job.title}' starts ${hours(to.start - from.start)} h after '${from.job.title}' starts; the link needs ${hours(lag)} h of it done first.`
          : `'${to.job.title}' starts after only ${hours(done)} h of '${from.job.title}'; the link needs ${hours(needed)} h of it done first.`, to.start)
      }
      continue
    }
    const after = (() => { const slots = workedOf.get(link.to); return slots === undefined ? undefined : slots.filter(slot => instantOf(slot) >= from.finish).length * slotMs })()
    const needed = Math.min(lag, total(link.to) ?? lag)
    if (to.finish < from.finish) push('link', [link.from, link.to], `'${to.job.title}' finishes at ${when(to.finish)}, before '${from.job.title}' finishes.`, to.finish)
    else if (after === undefined ? to.finish - from.finish < lag : after < needed) {
      push('link', [link.from, link.to], after === undefined
        ? `'${to.job.title}' finishes ${hours(to.finish - from.finish)} h after '${from.job.title}'; the link needs ${hours(lag)} h of it after.`
        : `Only ${hours(after)} h of '${to.job.title}' is done after '${from.job.title}' finishes; the link needs ${hours(needed)} h of it after.`, to.finish)
    }
  }
  for (const [key, spot] of placed) {
    const job = spot.job
    if (job.notBefore !== undefined && spot.start < Date.parse(job.notBefore.at)) push('release', [key], `'${job.title}' starts at ${when(spot.start)}, before ${when(Date.parse(job.notBefore.at))} (${job.notBefore.words}).`, spot.start)
    if (dataDate !== undefined && spot.start < dataDate) push('before-data-date', [key], `'${job.title}' is planned to start at ${when(spot.start)}, before the data date ${when(dataDate)}; nothing is planned in the past.`, spot.start)
    if (job.lock !== undefined && spot.start !== Date.parse(job.lock.start)) push('lock', [key], `'${job.title}' is locked to start at ${when(Date.parse(job.lock.start))} but is scheduled at ${when(spot.start)}.`, spot.start)
  }

  // ── equipment: bracketing, tag before test, supports, availability ──
  const equipment = new Map(inputs.equipment.map(item => [item.key, item]))
  const activeJobs = [...active].map(key => jobs.get(key)!)
  const tagOuts = new Map<string, Job[]>(), tests = new Map<string, Job[]>()
  for (const job of activeJobs) {
    if (job.kind !== 'work' && job.equipment.length === 0) push('equipment-missing', [job.key], `'${job.title}' is a ${job.kind} that names no equipment.`)
    for (const item of job.equipment) {
      if (!equipment.has(item)) { push('unknown-key', [job.key, item], `'${job.title}' names equipment '${item}' that the plan does not have.`); continue }
      if (job.kind === 'tag-out') tagOuts.set(item, [...(tagOuts.get(item) ?? []), job])
      if (job.kind === 'test') tests.set(item, [...(tests.get(item) ?? []), job])
    }
  }
  const labelOf = (item: string): string => equipment.get(item)?.label ?? item
  // own outages, by pairing in time order: a tag-out opens an outage when the item is in service, and the
  // tests that follow close it (consecutive tests belong to the same outage). A planned second outage
  // (tag, test, tag, test) is two outages; the span rule judges re-entry.
  interface Outage { readonly from: number; to: number; readonly tags: Placed[]; readonly tests: Placed[] }
  const ownOutages = new Map<string, Outage[]>()
  for (const item of inputs.equipment) {
    const placedOf = (list: readonly Job[] | undefined) => (list ?? []).flatMap(job => { const t = timesOf(job.key); return t === undefined ? [] : [t] })
    const tagTimes = placedOf(tagOuts.get(item.key)), testTimes = placedOf(tests.get(item.key))
    if (tagTimes.length + testTimes.length === 0) continue
    const events = [...tagTimes.map(times => ({ times, tag: true })), ...testTimes.map(times => ({ times, tag: false }))]
      .sort((left, right) => left.times.start - right.times.start || Number(right.tag) - Number(left.tag))
    const list: Outage[] = []
    let current: Outage | undefined
    for (const event of events) {
      if (event.tag) {
        if (current === undefined || current.tests.length > 0) { current = { from: event.times.start, to: Infinity, tags: [event.times], tests: [] }; list.push(current) }
        else current.tags.push(event.times)
        continue
      }
      if (current === undefined) {
        // a test with no tag-out before it: an item with tag-outs is tested before it is tagged out
        if (tagTimes.length > 0) push('tag-before-test', [event.times.job.key], `'${event.times.job.title}' starts at ${when(event.times.start)}, before ${item.label} is tagged out.`, event.times.start)
        current = { from: event.times.start, to: event.times.finish, tags: [], tests: [] }
        list.push(current)
      }
      for (const tag of current.tags) {
        if (tag.finish > event.times.start && !isWaived(tag.job.key, event.times.job.key)) push('tag-before-test', [tag.job.key, event.times.job.key], `'${event.times.job.title}' starts at ${when(event.times.start)}, before '${tag.job.title}' has finished: ${item.label} is tested before it is tagged out.`, event.times.start)
      }
      current.tests.push(event.times)
      current.to = Math.max(...current.tests.map(test => test.finish))
    }
    if (list.some(outage => outage.to === Infinity)) push('never-returned', [item.key], `${item.label} is tagged out and never tested back in this plan.`)
    ownOutages.set(item.key, list)
  }
  // inside work lies within one outage of its item: after that outage's tag-outs, before its tests
  for (const job of activeJobs) {
    if (job.kind !== 'work' || job.isolation !== 'inside') continue
    if (job.equipment.length !== 1) { push('equipment-missing', [job.key], `'${job.title}' is work inside an item, so it names exactly one item.`); continue }
    const item = job.equipment[0]!
    const covering = tagOuts.get(item) ?? [], restoring = tests.get(item) ?? []
    if (covering.length === 0 || restoring.length === 0) {
      push('bracket-missing', [job.key, item], `'${job.title}' works inside ${labelOf(item)}, which has no ${covering.length === 0 ? 'tag-out' : 'return-to-service test'} in the plan.`)
      continue
    }
    const work = timesOf(job.key)
    if (work === undefined) continue
    const list = ownOutages.get(item) ?? []
    const lastTag = (outage: Outage) => Math.max(-Infinity, ...outage.tags.filter(tag => !isWaived(tag.job.key, job.key)).map(tag => tag.finish))
    const firstTest = (outage: Outage) => Math.min(Infinity, ...outage.tests.filter(test => !isWaived(job.key, test.job.key)).map(test => test.start))
    if (list.some(outage => outage.tags.length > 0 && lastTag(outage) <= work.start && work.finish <= firstTest(outage))) continue
    const near = list.find(outage => outage.from < Math.max(work.finish, work.start + 1) && work.start < outage.to)
    if (near === undefined || near.tags.length === 0) { push('bracket', [job.key], `'${job.title}' works inside ${labelOf(item)} at ${when(work.start)}, while ${labelOf(item)} is in service.`, work.start); continue }
    const tag = near.tags.find(candidate => candidate.finish > work.start && !isWaived(candidate.job.key, job.key))
    if (tag !== undefined) push('bracket', [tag.job.key, job.key], `'${job.title}' starts at ${when(work.start)}, before '${tag.job.title}' has finished.`, work.start)
    const test = near.tests.find(candidate => work.finish > candidate.start && !isWaived(job.key, candidate.job.key))
    if (test !== undefined) push('bracket', [job.key, test.job.key], `'${test.job.title}' starts at ${when(test.start)}, before '${job.title}' has finished.`, test.start)
  }

  // supports, transitively; a cycle is refused
  const supporters = new Map<string, readonly string[]>()
  const cyclic = new Set<string>()
  const closure = (item: string, path: readonly string[]): readonly string[] => {
    const known = supporters.get(item)
    if (known !== undefined) return known
    if (path.includes(item)) { cyclic.add(item); return [] }
    const direct = equipment.get(item)?.supportedBy ?? []
    const all = new Set<string>()
    for (const supporter of direct) {
      if (!equipment.has(supporter)) { push('unknown-key', [item, supporter], `${labelOf(item)} is supported by '${supporter}', which the plan does not have.`); continue }
      all.add(supporter)
      for (const further of closure(supporter, [...path, item])) all.add(further)
    }
    const result = [...all]
    supporters.set(item, result)
    return result
  }
  for (const item of inputs.equipment) closure(item.key, [])
  for (const item of cyclic) push('support-cycle', [item], `${labelOf(item)} supports itself through its supporters; support chains cannot loop.`)
  const outages = new Map<string, readonly Interval[]>()
  for (const item of inputs.equipment) {
    const parts: Interval[] = [item.key, ...(supporters.get(item.key) ?? [])].flatMap(key => (ownOutages.get(key) ?? []).map(outage => ({ from: outage.from, to: outage.to })))
    if (parts.length > 0) outages.set(item.key, mergeIntervals(parts))
  }
  // return in support order: every supporter's last test before the supported item's tests
  for (const item of inputs.equipment) {
    const restoring = (tests.get(item.key) ?? []).flatMap(job => { const t = timesOf(job.key); return t === undefined ? [] : [t] })
    if (restoring.length === 0) continue
    for (const supporter of supporters.get(item.key) ?? []) {
      for (const job of tests.get(supporter) ?? []) {
        const times = timesOf(job.key)
        const bound = restoring.filter(test => !isWaived(job.key, test.job.key))
        if (bound.length === 0) continue
        const firstTest = bound.reduce((earliest, test) => test.start < earliest.start ? test : earliest)
        if (times !== undefined && times.finish > firstTest.start) {
          push('support-order', [job.key, firstTest.job.key], `'${firstTest.job.title}' starts at ${when(firstTest.start)}, before ${labelOf(supporter)}, which supports ${item.label}, is tested back ('${job.title}').`, firstTest.start)
        }
      }
    }
  }

  // ── rules ──
  const slotOut = (intervals: readonly Interval[] | undefined, slot: number): boolean => {
    if (intervals === undefined) return false
    const from = instantOf(slot), to = from + slotMs
    return intervals.some(interval => interval.from < to && interval.to > from)
  }
  // On duty: the normal calendar (less a used rebooking's booked time) and an ordered purchase's time. Time a
  // job bought is that job's, so it never makes a crew free for anyone else.
  const resourceOnDuty = (resource: Resource): Uint8Array => {
    const duty = new Uint8Array(baseAvailability(resource))
    for (const purchase of inputs.purchases) {
      if (purchase.resource !== resource.key || purchase.ordered === undefined) continue
      added.get(purchase.key)!.forEach((slot, index) => { if (slot === 1) duty[index] = 1 })
    }
    return duty
  }
  const ruleLabel = (rule: Rule): string => `'${rule.words}'`
  for (const rule of inputs.rules) {
    if (rule.kind === 'protected') {
      const shielded = new Set(rule.equipment)
      for (const job of activeJobs) {
        const hit = job.equipment.filter(item => shielded.has(item))
        if (hit.length > 0) push('protected-equipment', [job.key, rule.key, ...hit], `'${job.title}' names protected ${hit.map(labelOf).join(', ')}. ${ruleLabel(rule)}`)
      }
      for (const item of rule.equipment) {
        if (!equipment.has(item)) { push('unknown-key', [rule.key, item], `The rule ${ruleLabel(rule)} names equipment '${item}' that the plan does not have.`); continue }
        const out = outages.get(item)
        if (out !== undefined && (ownOutages.get(item) ?? []).length === 0) {
          push('protected-unavailable', [rule.key, item], `Protected ${labelOf(item)} is unavailable from ${when(out[0]!.from)} because equipment that supports it is out. ${ruleLabel(rule)}`, out[0]!.from)
        }
      }
    } else if (rule.kind === 'span-limit') {
      const members = inputs.equipment.filter(item => item.group === rule.group).map(item => item.key)
      const intervals = mergeIntervals(members.flatMap(member => outages.get(member) ?? []))
      if (intervals.length === 0) continue
      const limit = rule.limit.value * unitMs[rule.limit.unit]!
      const spans = rule.singleEntry ? [{ from: intervals[0]!.from, to: Math.max(...intervals.map(interval => interval.to)) }] : intervals
      for (const span of spans) {
        if (span.to - span.from > limit + 1e-6) {
          const hours = (span.to - span.from) / 3_600_000
          const name = inputs.groups.find(group => group.key === rule.group)?.label ?? rule.group
          const again = rule.singleEntry && intervals.length > 1
            ? ` It is out ${intervals.length} times (back at ${when(intervals[0]!.to)}, out again at ${when(intervals[1]!.from)}); the rule counts one span from the first tag-out to the last test.`
            : ''
          push('span-limit', [rule.key, rule.group], `The ${name} span runs from ${when(span.from)} to ${when(span.to)}${Number.isFinite(hours) ? `, ${hours} h` : ''}; the limit is ${rule.limit.value} ${rule.limit.unit}.${again} ${ruleLabel(rule)}`, span.from)
        }
      }
    } else if (rule.kind === 'due') {
      // a hard deadline; the soft job.target never makes a plan infeasible
      const job = jobs.get(rule.job)
      if (job === undefined) { push('unknown-key', [rule.key, rule.job], `The rule ${ruleLabel(rule)} names a job '${rule.job}' that the plan does not have.`); continue }
      const spot = placed.get(rule.job)
      const by = Date.parse(rule.finishBy)
      if (spot !== undefined && spot.finish > by) {
        push('due', [rule.key, rule.job], `'${job.title}' finishes at ${when(spot.finish)}, ${(spot.finish - by) / 3_600_000} h after it is due at ${when(by)}. ${ruleLabel(rule)}`, spot.finish)
      }
    } else {
      const from = rule.during === undefined ? 0 : Math.max(0, Math.floor(context.slotOf(Date.parse(rule.during.start))))
      const to = rule.during === undefined ? grid.slots : Math.min(grid.slots, Math.ceil(context.slotOf(Date.parse(rule.during.end))))
      const duty = new Map<string, Uint8Array>()
      for (const member of rule.members) {
        if ('equipment' in member) { if (!equipment.has(member.equipment)) push('unknown-key', [rule.key, member.equipment], `The rule ${ruleLabel(rule)} names equipment '${member.equipment}' that the plan does not have.`); continue }
        const resource = resources.get(member.resource)
        if (resource === undefined) { push('unknown-key', [rule.key, member.resource], `The rule ${ruleLabel(rule)} names a resource '${member.resource}' that the plan does not have.`); continue }
        duty.set(member.resource, resourceOnDuty(resource))
      }
      let shortFrom: number | undefined, shortTo = 0, shortCount = Infinity
      for (let slot = from; slot < to; slot++) {
        let available = 0
        for (const member of rule.members) {
          if ('equipment' in member) { if (equipment.has(member.equipment) && !slotOut(outages.get(member.equipment), slot)) available++; continue }
          const resource = resources.get(member.resource)
          if (resource === undefined) continue
          if (duty.get(member.resource)![slot] === 1 && (load.get(member.resource)?.[slot] ?? 0) < resource.count) available++
        }
        if (available >= rule.atLeast) { if (shortFrom !== undefined) break; continue }
        shortFrom ??= slot
        shortTo = slot + 1
        shortCount = Math.min(shortCount, available)
      }
      if (shortFrom !== undefined) {
        push('keep-in-service', [rule.key], `Only ${shortCount} of the ${rule.members.length} named in ${ruleLabel(rule)} ${shortCount === 1 ? 'is' : 'are'} in service from ${when(instantOf(shortFrom))} to ${when(instantOf(shortTo))}; the rule keeps at least ${rule.atLeast}.`, instantOf(shortFrom))
      }
    }
  }

  // ── preconditions at read time ──
  for (const job of activeJobs) {
    for (const check of job.checks) {
      const item = equipment.get(check.equipment)
      if (item === undefined) { push('unknown-key', [job.key, check.equipment], `'${job.title}' checks equipment '${check.equipment}' that the plan does not have.`); continue }
      const facts = context.inputs.world.facts.filter(fact => fact.locator === item.locator && fact.id === check.fact)
      if (item.locator === undefined || facts.length !== 1) { push('precondition-unread', [job.key, check.equipment], `'${job.title}' needs "${check.words}", which has not been read from World.`); continue }
      const fact = facts[0]!
      if (fact.value !== check.expect) push('precondition-unmet', [job.key, check.equipment], `'${job.title}' needs "${check.words}", but World showed ${String(fact.value)} at read time (${when(Date.parse(fact.at))}).`, Date.parse(fact.at))
    }
  }

  const unique = dedupe(found)
  const metrics = computeMetrics({ context, placed, outages, usedPurchaseSlots, personHours, usedPurchases })
  return { feasible: unique.length === 0, invalidInput: unique.some(item => inputCodes.has(item.code)), violations: unique, metrics: metrics.metrics, goals: metrics.goals, outages }
}

const dedupe = (violations: readonly Violation[]): Violation[] => {
  const seen = new Set<string>()
  return violations.filter(item => { const key = `${item.code}|${item.about.join(',')}|${item.at ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true })
}

export type { Placed }
