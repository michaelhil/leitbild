// The checker's own temporal propagation, used to re-derive certificates. It relaxes the plan (resources
// are ignored, each job may work whenever every need has some eligible resource on duty, lags are taken
// in their weaker clock-time form) and keeps only constraints that hold in every schedule the checker
// accepts. So a contradiction here is a proof; the absence of one proves nothing.
import type { PlanInputs } from '../plan/schema.ts'
import { jobDuration, type Context } from './check.ts'

type Job = PlanInputs['jobs'][number]

/** Which optional rebookings are taken in this case (purchases with `replaces` that are not ordered). */
export type World = ReadonlyMap<string, boolean>

export interface JobWindow {
  readonly job: Job
  /** Slots in which the job could work. */
  readonly calendar: Uint8Array
  /** Least work in slots, over its possible resources. */
  readonly work: number
  /** Earliest and latest start, in slots; finishOf gives the finish of a start. */
  readonly es: number
  readonly ls: number
  readonly finishOf: (start: number) => number
}

export type Propagation =
  | { readonly ok: true; readonly windows: ReadonlyMap<string, JobWindow> }
  | { readonly ok: false; readonly job: string; readonly reason: string }

/** The optional rebookings of a variant: each world is one choice of taking or leaving each. */
export const worldsOf = (context: Context): World[] => {
  const optional = context.inputs.purchases.filter(purchase => purchase.replaces.length > 0 && purchase.ordered === undefined && context.permitted.has(purchase.key)).map(purchase => purchase.key)
  if (optional.length > 4) throw new RangeError('more than four optional rebookings: too many cases to re-derive')
  return Array.from({ length: 2 ** optional.length }, (_, mask) => new Map(optional.map((key, index) => [key, (mask >> index & 1) === 1])))
}

/** Slots a resource can work in a world: its base calendar, less rebooked time, plus permitted purchases. */
export const resourceSlots = (context: Context, key: string, world: World): Uint8Array => {
  const resource = context.resources.get(key)
  const slots = new Uint8Array(context.grid.slots)
  if (resource === undefined) return slots
  context.calendars.get(resource.calendar)?.forEach((slot, index) => { if (slot === 1) slots[index] = 1 })
  for (const purchase of context.inputs.purchases) {
    if (purchase.resource !== key) continue
    const taken = purchase.ordered !== undefined || world.get(purchase.key) === true
    if (taken) context.replaced.get(purchase.key)!.forEach((slot, index) => { if (slot === 1) slots[index] = 0 })
  }
  for (const purchase of context.inputs.purchases) {
    if (purchase.resource !== key || !context.permitted.has(purchase.key)) continue
    if (world.get(purchase.key) === false) continue
    context.added.get(purchase.key)!.forEach((slot, index) => { if (slot === 1) slots[index] = 1 })
  }
  return slots
}

/** Slots a job could work: in every need, some eligible resource on duty. */
export const jobSlots = (context: Context, job: Job, world: World): Uint8Array => {
  const slots = new Uint8Array(context.grid.slots).fill(1)
  if (job.duration.calendar === 'elapsed' || job.needs.length === 0) return slots
  for (const need of job.needs) {
    const any = new Uint8Array(context.grid.slots)
    for (const key of need.anyOf) resourceSlots(context, key, world).forEach((slot, index) => { if (slot === 1) any[index] = 1 })
    for (let index = 0; index < slots.length; index++) slots[index] = slots[index]! & any[index]!
  }
  return slots
}

/** The least work of a job over its possible resources, in slots; undefined when no duration is readable. */
export const leastWork = (context: Context, job: Job): number | undefined => {
  const options = [new Set<string>(), ...job.durationWith.map(entry => new Set([entry.resource]))]
  const slots = options.flatMap(chosen => { const duration = jobDuration(context, job, chosen); return duration.ok ? [duration.slots] : [] })
  return slots.length === 0 ? undefined : Math.min(...slots)
}

interface Timing { readonly valid: Uint8Array; readonly finish: Int32Array }

/** For every start slot: whether the job can start there, and when it then finishes. */
const timing = (calendar: Uint8Array, work: number, continuous: boolean, elapsed: boolean, horizon: number): Timing => {
  const valid = new Uint8Array(horizon + 1)
  const finish = new Int32Array(horizon + 1).fill(-1)
  if (work === 0) { valid.fill(1); for (let start = 0; start <= horizon; start++) finish[start] = start; return { valid, finish } }
  if (elapsed) { for (let start = 0; start + work <= horizon; start++) { valid[start] = 1; finish[start] = start + work } return { valid, finish } }
  if (continuous) {
    let run = 0
    for (let slot = horizon - 1; slot >= 0; slot--) {
      run = calendar[slot] === 1 ? run + 1 : 0
      if (run >= work) { valid[slot] = 1; finish[slot] = slot + work }
    }
    return { valid, finish }
  }
  const working: number[] = []
  for (let slot = 0; slot < horizon; slot++) if (calendar[slot] === 1) working.push(slot)
  working.forEach((slot, index) => { const last = working[index + work - 1]; if (last !== undefined) { valid[slot] = 1; finish[slot] = last + 1 } })
  return { valid, finish }
}

export const propagate = (context: Context, world: World): Propagation => {
  const { inputs, grid, active } = context
  const horizon = grid.slots
  const slotOf = (instant: number): number => (instant - context.windowStart) / grid.slotMs
  const unitMs: Readonly<Record<string, number>> = { s: 1_000, min: 60_000, h: 3_600_000, d: 86_400_000 }
  const jobs = [...active].map(key => context.jobs.get(key)!)
  const info = new Map<string, { job: Job; calendar: Uint8Array; work: number; timing: Timing; es: number; ls: number }>()
  for (const job of jobs) {
    const calendar = jobSlots(context, job, world)
    const work = leastWork(context, job) ?? 0
    const elapsed = job.duration.calendar === 'elapsed' || job.needs.length === 0
    const timed = timing(calendar, work, job.continuous, elapsed, horizon)
    let es = 0, ls = horizon
    const dataDate = inputs.settings.dataDate === null ? undefined : Date.parse(inputs.settings.dataDate)
    if (dataDate !== undefined) es = Math.max(es, Math.ceil(slotOf(dataDate)))
    if (job.notBefore !== undefined) es = Math.max(es, Math.ceil(slotOf(Date.parse(job.notBefore.at))))
    if (job.lock !== undefined) { const at = slotOf(Date.parse(job.lock.start)); es = Math.max(es, Math.ceil(at)); ls = Math.min(ls, Math.floor(at)) }
    info.set(job.key, { job, calendar, work, timing: timed, es, ls })
  }
  // difference constraints between events: event(to) >= event(from) + gap, gap in slots
  type Event = { readonly job: string; readonly at: 'start' | 'finish' }
  const constraints: Array<{ readonly from: Event; readonly to: Event; readonly gap: number }> = []
  const add = (from: Event, to: Event, gap: number): void => { if (info.has(from.job) && info.has(to.job)) constraints.push({ from, to, gap }) }
  const S = (job: string): Event => ({ job, at: 'start' }), F = (job: string): Event => ({ job, at: 'finish' })
  for (const link of inputs.links) {
    if (link.method !== undefined && !context.variant.methods.some(chosen => chosen.choice === link.method!.choice && chosen.option === link.method!.option)) continue
    const gap = Math.ceil(link.lag.value * unitMs[link.lag.unit]! / grid.slotMs - 1e-9)
    if (link.type === 'FS') add(F(link.from), S(link.to), gap)
    if (link.type === 'SS') add(S(link.from), S(link.to), gap)
    if (link.type === 'FF') add(F(link.from), F(link.to), gap)
  }
  // items with a single tag-out have a single outage: tag before work before every test, tag before every test
  const tagsOf = new Map<string, Job[]>(), testsOf = new Map<string, Job[]>()
  for (const job of jobs) for (const item of job.equipment) {
    if (job.kind === 'tag-out') tagsOf.set(item, [...(tagsOf.get(item) ?? []), job])
    if (job.kind === 'test') testsOf.set(item, [...(testsOf.get(item) ?? []), job])
  }
  for (const [item, tags] of tagsOf) {
    if (tags.length !== 1) continue
    const tag = tags[0]!
    for (const test of testsOf.get(item) ?? []) add(F(tag.key), S(test.key), 0)
    for (const work of jobs) {
      if (work.kind !== 'work' || work.isolation !== 'inside' || work.equipment[0] !== item) continue
      add(F(tag.key), S(work.key), 0)
      for (const test of testsOf.get(item) ?? []) add(F(work.key), S(test.key), 0)
    }
  }
  // support return order: every supporter's test before every test of the supported item
  const supportersOf = (item: string, seen: ReadonlySet<string> = new Set()): string[] => {
    const direct = inputs.equipment.find(entry => entry.key === item)?.supportedBy ?? []
    return direct.filter(key => !seen.has(key)).flatMap(key => [key, ...supportersOf(key, new Set([...seen, item, key]))])
  }
  for (const item of inputs.equipment) {
    for (const supporter of supportersOf(item.key)) for (const before of testsOf.get(supporter) ?? []) for (const after of testsOf.get(item.key) ?? []) add(F(before.key), S(after.key), 0)
  }
  // single-entry span limits as max-lags: every closer within the limit of every opener
  for (const rule of inputs.rules) {
    if (rule.kind !== 'span-limit' || !rule.singleEntry) continue
    const members = inputs.equipment.filter(item => item.group === rule.group).map(item => item.key)
    const covered = new Set(members.flatMap(member => [member, ...supportersOf(member)]))
    const openers = jobs.filter(job => job.kind === 'tag-out' && job.equipment.some(item => covered.has(item)))
    const closers = jobs.filter(job => job.kind === 'test' && job.equipment.some(item => covered.has(item)))
    const limit = Math.floor(rule.limit.value * unitMs[rule.limit.unit]! / grid.slotMs + 1e-9)
    for (const closer of closers) for (const opener of openers) add(F(closer.key), S(opener.key), -limit)
  }
  for (const rule of inputs.rules) {
    if (rule.kind !== 'due') continue
    const entry = info.get(rule.job)
    if (entry !== undefined) entry.ls = Math.min(entry.ls, latestStartBy(entry, Math.floor(slotOf(Date.parse(rule.finishBy)))))
  }
  for (const entry of info.values()) entry.ls = Math.min(entry.ls, latestStartBy(entry, horizon))

  type Entry = typeof info extends Map<string, infer V> ? V : never
  const earliest = (entry: Entry): number => {
    for (let start = Math.max(0, entry.es); start <= horizon; start++) if (entry.timing.valid[start] === 1) return start
    return Infinity
  }
  const latest = (entry: Entry): number => {
    for (let start = Math.min(horizon, entry.ls); start >= 0; start--) if (entry.timing.valid[start] === 1) return start
    return -1
  }
  for (let round = 0; round < 4 * info.size + 8; round++) {
    let changed = false
    for (const entry of info.values()) {
      const start = earliest(entry), end = latest(entry)
      if (start === Infinity || end < 0) return { ok: false, job: entry.job.key, reason: 'it cannot be placed in the window at all' }
      if (start > end) return { ok: false, job: entry.job.key, reason: 'its earliest start is after its latest start' }
      if (start !== entry.es) { entry.es = start; changed = true }
      if (end !== entry.ls) { entry.ls = end; changed = true }
    }
    for (const { from, to, gap } of constraints) {
      const source = info.get(from.job)!, target = info.get(to.job)!
      // forward: a lower bound on the target event
      const sourceEarliest = earliest(source)
      if (sourceEarliest === Infinity) return { ok: false, job: source.job.key, reason: 'it cannot be placed in the window at all' }
      const low = (from.at === 'start' ? sourceEarliest : source.timing.finish[sourceEarliest]!) + gap
      if (to.at === 'start' && low > target.es) { target.es = low; changed = true }
      if (to.at === 'finish') {
        let start = target.es
        while (start <= horizon && !(target.timing.valid[start] === 1 && target.timing.finish[start]! >= low)) start++
        if (start > target.es) { target.es = start; changed = true }
      }
      // backward: an upper bound on the source event
      const targetLatest = latest(target)
      if (targetLatest < 0) return { ok: false, job: target.job.key, reason: 'it cannot be placed in the window at all' }
      const high = (to.at === 'start' ? targetLatest : target.timing.finish[targetLatest]!) - gap
      const bound = from.at === 'start' ? Math.min(source.ls, high) : Math.min(source.ls, latestStartBy(source, high))
      if (bound < source.ls) { source.ls = bound; changed = true }
    }
    if (!changed) break
  }
  for (const entry of info.values()) {
    const start = earliest(entry), end = latest(entry)
    if (start === Infinity || end < 0 || start > end) return { ok: false, job: entry.job.key, reason: 'its earliest start is after its latest start' }
  }
  const windows = new Map<string, JobWindow>()
  for (const [key, entry] of info) windows.set(key, { job: entry.job, calendar: entry.calendar, work: entry.work, es: entry.es, ls: entry.ls, finishOf: start => entry.timing.finish[start] ?? -1 })
  return { ok: true, windows }
}

/** The latest valid start whose finish is at or before `by`, or -1. */
function latestStartBy (entry: { readonly timing: Timing }, by: number): number {
  for (let start = Math.min(by, entry.timing.valid.length - 1); start >= 0; start--) if (entry.timing.valid[start] === 1 && entry.timing.finish[start]! <= by) return start
  return -1
}
