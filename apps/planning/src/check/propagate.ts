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
  /** `words`: the contradiction in planner words, with the jobs, hours, calendars and limits that cause it. */
  | { readonly ok: false; readonly job: string; readonly reason: string; readonly words: string }

/** Why a bound holds: where it starts, or which other job's start or finish pushes it, by which rule. */
type Origin =
  | { readonly kind: 'link'; readonly type: 'FS' | 'SS' | 'FF'; readonly lagHours: number }
  | { readonly kind: 'bracket' } | { readonly kind: 'tag-before-test' } | { readonly kind: 'support-order' }
  | { readonly kind: 'span-limit'; readonly group: string; readonly words: string; readonly limitHours: number }
type Why =
  | { readonly kind: 'window' | 'window-end' | 'data-date' | 'lock' }
  | { readonly kind: 'release' | 'due'; readonly words: string }
  | { readonly kind: 'after' | 'before'; readonly job: string; readonly origin: Origin }

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
  const info = new Map<string, { job: Job; calendar: Uint8Array; work: number; timing: Timing; es: number; ls: number; esWhy: Why; lsWhy: Why; esWhyInitial: Why }>()
  for (const job of jobs) {
    const calendar = jobSlots(context, job, world)
    const work = leastWork(context, job) ?? 0
    const elapsed = job.duration.calendar === 'elapsed' || job.needs.length === 0
    const timed = timing(calendar, work, job.continuous, elapsed, horizon)
    let es = 0, ls = horizon
    let esWhy: Why = { kind: 'window' }, lsWhy: Why = { kind: 'window-end' }
    const dataDate = inputs.settings.dataDate === null ? undefined : Date.parse(inputs.settings.dataDate)
    if (dataDate !== undefined && Math.ceil(slotOf(dataDate)) > es) { es = Math.ceil(slotOf(dataDate)); esWhy = { kind: 'data-date' } }
    if (job.notBefore !== undefined && Math.ceil(slotOf(Date.parse(job.notBefore.at))) > es) { es = Math.ceil(slotOf(Date.parse(job.notBefore.at))); esWhy = { kind: 'release', words: job.notBefore.words } }
    if (job.lock !== undefined) { const at = slotOf(Date.parse(job.lock.start)); es = Math.max(es, Math.ceil(at)); ls = Math.min(ls, Math.floor(at)); esWhy = { kind: 'lock' }; lsWhy = { kind: 'lock' } }
    info.set(job.key, { job, calendar, work, timing: timed, es, ls, esWhy, lsWhy, esWhyInitial: esWhy })
  }
  // difference constraints between events: event(to) >= event(from) + gap, gap in slots
  type Event = { readonly job: string; readonly at: 'start' | 'finish' }
  const constraints: Array<{ readonly from: Event; readonly to: Event; readonly gap: number; readonly origin: Origin }> = []
  const add = (from: Event, to: Event, gap: number, origin: Origin): void => { if (info.has(from.job) && info.has(to.job)) constraints.push({ from, to, gap, origin }) }
  const S = (job: string): Event => ({ job, at: 'start' }), F = (job: string): Event => ({ job, at: 'finish' })
  for (const link of inputs.links) {
    if (link.method !== undefined && !context.variant.methods.some(chosen => chosen.choice === link.method!.choice && chosen.option === link.method!.option)) continue
    const gap = Math.ceil(link.lag.value * unitMs[link.lag.unit]! / grid.slotMs - 1e-9)
    const origin: Origin = { kind: 'link', type: link.type, lagHours: link.lag.value * unitMs[link.lag.unit]! / 3_600_000 }
    if (link.type === 'FS') add(F(link.from), S(link.to), gap, origin)
    if (link.type === 'SS') add(S(link.from), S(link.to), gap, origin)
    if (link.type === 'FF') add(F(link.from), F(link.to), gap, origin)
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
    for (const test of testsOf.get(item) ?? []) add(F(tag.key), S(test.key), 0, { kind: 'tag-before-test' })
    for (const work of jobs) {
      if (work.kind !== 'work' || work.isolation !== 'inside' || work.equipment[0] !== item) continue
      add(F(tag.key), S(work.key), 0, { kind: 'bracket' })
      for (const test of testsOf.get(item) ?? []) add(F(work.key), S(test.key), 0, { kind: 'bracket' })
    }
  }
  // support return order: every supporter's test before every test of the supported item
  const supportersOf = (item: string, seen: ReadonlySet<string> = new Set()): string[] => {
    const direct = inputs.equipment.find(entry => entry.key === item)?.supportedBy ?? []
    return direct.filter(key => !seen.has(key)).flatMap(key => [key, ...supportersOf(key, new Set([...seen, item, key]))])
  }
  for (const item of inputs.equipment) {
    for (const supporter of supportersOf(item.key)) for (const before of testsOf.get(supporter) ?? []) for (const after of testsOf.get(item.key) ?? []) add(F(before.key), S(after.key), 0, { kind: 'support-order' })
  }
  // single-entry span limits as max-lags: every closer within the limit of every opener
  const spans: Array<{ readonly origin: Extract<Origin, { kind: 'span-limit' }>; readonly limit: number; readonly openers: readonly string[]; readonly closers: readonly string[] }> = []
  for (const rule of inputs.rules) {
    if (rule.kind !== 'span-limit' || !rule.singleEntry) continue
    const members = inputs.equipment.filter(item => item.group === rule.group).map(item => item.key)
    const covered = new Set(members.flatMap(member => [member, ...supportersOf(member)]))
    const openers = jobs.filter(job => job.kind === 'tag-out' && job.equipment.some(item => covered.has(item)))
    const closers = jobs.filter(job => job.kind === 'test' && job.equipment.some(item => covered.has(item)))
    const limit = Math.floor(rule.limit.value * unitMs[rule.limit.unit]! / grid.slotMs + 1e-9)
    const origin: Origin = { kind: 'span-limit', group: inputs.groups.find(group => group.key === rule.group)?.label ?? rule.group, words: rule.words, limitHours: limit * grid.slotMs / 3_600_000 }
    for (const closer of closers) for (const opener of openers) add(F(closer.key), S(opener.key), -limit, origin)
    spans.push({ origin, limit, openers: openers.map(job => job.key), closers: closers.map(job => job.key) })
  }
  for (const rule of inputs.rules) {
    if (rule.kind !== 'due') continue
    const entry = info.get(rule.job)
    const bound = entry === undefined ? undefined : latestStartBy(entry, Math.floor(slotOf(Date.parse(rule.finishBy))))
    if (entry !== undefined && bound !== undefined && bound < entry.ls) { entry.ls = bound; entry.lsWhy = { kind: 'due', words: rule.words } }
  }
  for (const entry of info.values()) entry.ls = Math.min(entry.ls, latestStartBy(entry, horizon))

  type Entry = typeof info extends Map<string, infer V> ? V : never
  const initial = new Map([...info].map(([key, entry]) => [key, entry.es]))
  const initialLatest = new Map([...info].map(([key, entry]) => [key, entry.ls]))
  const initialLatestWhy = new Map([...info].map(([key, entry]) => [key, entry.lsWhy]))
  for (const entry of info.values()) entry.esWhyInitial = entry.esWhy
  const describe = (entry: Entry, start: number): string => describeJob(context, entry, start)
  const earliest = (entry: Entry): number => {
    for (let start = Math.max(0, entry.es); start <= horizon; start++) if (entry.timing.valid[start] === 1) return start
    return Infinity
  }
  const latest = (entry: Entry): number => {
    for (let start = Math.min(horizon, entry.ls); start >= 0; start--) if (entry.timing.valid[start] === 1) return start
    return -1
  }
  // A span limit too short for the work: for every start s of the span, the earliest the work allows from s
  // (no other limit applied) ends more than the limit later. Then the span alone explains the refusal.
  const spanWords = (): string | undefined => {
    const plain = constraints.filter(constraint => constraint.origin.kind !== 'span-limit')
    // latest starts from the other rules alone: the span must open by the earliest of its openers' latest starts
    const ls = new Map(initialLatest), lsWhy = new Map(initialLatestWhy)
    const latestValid = (key: string, start: number): number => { const entry = info.get(key)!; for (let slot = Math.min(horizon, start); slot >= 0; slot--) if (entry.timing.valid[slot] === 1) return slot; return -1 }
    for (let round = 0, stable = false; round < 2 * info.size + 4 && !stable; round++) {
      stable = true
      for (const [key] of info) { const start = latestValid(key, ls.get(key)!); if (start !== ls.get(key)) { ls.set(key, start); stable = false } }
      for (const { from: source, to: target, gap, origin } of plain) {
        const end = ls.get(target.job)!
        if (end < 0) continue
        const high = (target.at === 'start' ? end : info.get(target.job)!.timing.finish[end]!) - gap
        const bound = source.at === 'start' ? high : latestStartBy(info.get(source.job)!, high)
        if (bound < ls.get(source.job)!) { ls.set(source.job, bound); lsWhy.set(source.job, { kind: 'before', job: target.job, origin }); stable = false }
      }
    }
    for (const span of spans) {
      let best: { from: number; length: number; closer: string; es: Map<string, number>; why: Map<string, Why> } | undefined
      const first = Math.min(...span.openers.map(opener => initial.get(opener)!))
      const openBy = span.openers.reduce((earliest, opener) => (ls.get(opener)! < ls.get(earliest)! ? opener : earliest), span.openers[0]!)
      if (openBy === undefined) continue
      for (let from = Math.max(0, first); from <= ls.get(openBy)!; from++) {
        const es = new Map([...info].map(([key]) => [key, span.openers.includes(key) ? Math.max(initial.get(key)!, from) : initial.get(key)!]))
        const why = new Map<string, Why>([...info].map(([key, entry]) => [key, span.openers.includes(key) && from > initial.get(key)! ? { kind: 'window' } as Why : entry.esWhyInitial]))
        const valid = (key: string, start: number): number => { const entry = info.get(key)!; for (let slot = Math.max(0, start); slot <= horizon; slot++) if (entry.timing.valid[slot] === 1) return slot; return Infinity }
        let stable = false
        for (let round = 0; round < 2 * info.size + 4 && !stable; round++) {
          stable = true
          for (const [key] of info) { const start = valid(key, es.get(key)!); if (start !== es.get(key)) { es.set(key, start); stable = false } }
          for (const { from: source, to: target, gap, origin } of plain) {
            const start = es.get(source.job)!
            if (start === Infinity) continue
            const low = (source.at === 'start' ? start : info.get(source.job)!.timing.finish[start]!) + gap
            const entry = info.get(target.job)!
            let next = es.get(target.job)!
            if (target.at === 'start') next = Math.max(next, low)
            else while (next <= horizon && !(entry.timing.valid[next] === 1 && entry.timing.finish[next]! >= low)) next++
            if (next > es.get(target.job)!) { es.set(target.job, next); why.set(target.job, { kind: 'after', job: source.job, origin }); stable = false }
          }
        }
        if (span.openers.some(opener => es.get(opener) === from) === false && from > first) continue
        const ends = span.closers.map(closer => { const start = es.get(closer)!; return { closer, end: start === Infinity ? Infinity : info.get(closer)!.timing.finish[start]! } })
        const last = ends.reduce((worst, entry) => entry.end > worst.end ? entry : worst)
        // a job that fits nowhere is the cause, not the span: leave it to the general explanation
        const length = [...es.values()].some(start => start === Infinity) ? Infinity : last.end - from
        if (length <= span.limit) { best = undefined; break }
        if (best === undefined || length < best.length) best = { from, length, closer: last.closer, es, why }
      }
      if (best === undefined || best.length === Infinity) continue
      const { grid, when } = context
      const at = (slot: number): string => when(context.windowStart + slot * grid.slotMs)
      const chain: string[] = []
      let current = best.closer
      const seen = new Set<string>()
      while (!seen.has(current) && seen.size < 24) {
        seen.add(current)
        const entry = info.get(current)!, start = best.es.get(current)!
        chain.unshift(`${describe(entry, start)}`)
        const why = best.why.get(current)!
        if (why.kind !== 'after') break
        current = why.job
      }
      const closing: string[] = []
      current = openBy
      seen.clear()
      while (!seen.has(current) && seen.size < 24) {
        seen.add(current)
        const why = lsWhy.get(current)!
        const title = `'${info.get(current)!.job.title}'`
        if (why.kind !== 'before') { closing.push(`${title} must start by ${at(ls.get(current)!)}${why.kind === 'due' ? ` (${why.words})` : why.kind === 'lock' ? ' (locked)' : ''}`); break }
        closing.push(`${title} must start by ${at(ls.get(current)!)} to leave room for '${info.get(why.job)!.job.title}'`)
        current = why.job
      }
      return `${span.origin.group} would be out at least ${best.length * grid.slotMs / 3_600_000} h, against its ${span.origin.limitHours} h limit ('${span.origin.words}'). `
        + `The span must open by ${at(ls.get(openBy)!)}: ${closing.join('; ')}. `
        + `Opened at ${at(best.from)}, the shortest it can be, the work runs: ${chain.join('; then ')}.`
    }
    return undefined
  }
  const conflict = (entry: Entry, reason: string): Propagation => ({ ok: false, job: entry.job.key, reason, words: spanWords() ?? explainConflict(context, entry.job.key, info, reason) })
  for (let round = 0; round < 4 * info.size + 8; round++) {
    let changed = false
    for (const entry of info.values()) {
      const start = earliest(entry), end = latest(entry)
      if (start === Infinity || end < 0) return conflict(entry, 'it cannot be placed in the window at all')
      if (start > end) return conflict(entry, 'its earliest start is after its latest start')
      if (start !== entry.es) { entry.es = start; changed = true }
      if (end !== entry.ls) { entry.ls = end; changed = true }
    }
    for (const { from, to, gap, origin } of constraints) {
      const source = info.get(from.job)!, target = info.get(to.job)!
      // forward: a lower bound on the target event
      const sourceEarliest = earliest(source)
      if (sourceEarliest === Infinity) return conflict(source, 'it cannot be placed in the window at all')
      const low = (from.at === 'start' ? sourceEarliest : source.timing.finish[sourceEarliest]!) + gap
      if (to.at === 'start' && low > target.es) { target.es = low; target.esWhy = { kind: 'after', job: from.job, origin }; changed = true }
      if (to.at === 'finish') {
        let start = target.es
        while (start <= horizon && !(target.timing.valid[start] === 1 && target.timing.finish[start]! >= low)) start++
        if (start > target.es) { target.es = start; target.esWhy = { kind: 'after', job: from.job, origin }; changed = true }
      }
      // backward: an upper bound on the source event
      const targetLatest = latest(target)
      if (targetLatest < 0) return conflict(target, 'it cannot be placed in the window at all')
      const high = (to.at === 'start' ? targetLatest : target.timing.finish[targetLatest]!) - gap
      const bound = from.at === 'start' ? Math.min(source.ls, high) : Math.min(source.ls, latestStartBy(source, high))
      if (bound < source.ls) { source.ls = bound; source.lsWhy = { kind: 'before', job: to.job, origin }; changed = true }
    }
    if (!changed) break
  }
  for (const entry of info.values()) {
    const start = earliest(entry), end = latest(entry)
    if (start === Infinity || end < 0 || start > end) return conflict(entry, 'its earliest start is after its latest start')
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

interface Explained { readonly job: Job; readonly work: number; readonly es: number; readonly ls: number; readonly timing: Timing; readonly esWhy: Why; readonly lsWhy: Why }

/**
 * The contradiction in planner words: the chain of jobs, hours, calendars and links that sets the job's
 * earliest start, the chain that sets its latest start, and the span limit when one is involved.
 */
const explainConflict = (context: Context, key: string, info: ReadonlyMap<string, Explained>, reason: string): string => {
  const { grid, when } = context
  const at = (slot: number): string => when(context.windowStart + slot * grid.slotMs)
  const hours = (slots: number): number => slots * grid.slotMs / 3_600_000
  const titled = (job: string): string => `'${info.get(job)?.job.title ?? job}'`
  const span = (entry: Explained, start: number): string => describeJob(context, entry, start)
  const joint = (origin: Origin): string => origin.kind === 'link' ? (origin.type === 'FS' ? (origin.lagHours > 0 ? `, then ${origin.lagHours} h later` : ', then') : origin.type === 'SS' ? `, and ${origin.lagHours} h into it` : `, finishing ${origin.lagHours} h after it`)
    : origin.kind === 'bracket' ? ', then inside the same outage' : origin.kind === 'tag-before-test' ? ', then its test' : origin.kind === 'support-order' ? ', then, once it is tested back, the item it supports' : ''
  const root = (why: Why): string => why.kind === 'window' ? `the window opens ${at(0)}` : why.kind === 'window-end' ? `the window closes ${at(grid.slots)}`
    : why.kind === 'data-date' ? 'nothing starts before the data date' : why.kind === 'lock' ? 'it is locked' : why.kind === 'release' || why.kind === 'due' ? why.words : ''

  // earliest: from the root forward to the job
  const forward: string[] = []
  let spanLimit: { origin: Extract<Origin, { kind: 'span-limit' }>; closer: string } | undefined
  let current = key
  const seen = new Set<string>()
  while (!seen.has(current) && seen.size < 24) {
    seen.add(current)
    const entry = info.get(current)!
    const why = entry.esWhy
    if (why.kind !== 'after') { forward.unshift(`${root(why)}: ${span(entry, entry.es)}`); break }
    if (why.origin.kind === 'span-limit') { spanLimit ??= { origin: why.origin, closer: why.job }; forward.unshift(`${titled(current)} can start no earlier than ${at(entry.es)}, because ${why.origin.group} must be back within ${why.origin.limitHours} h of its first tag-out`); current = why.job; continue }
    forward.unshift(`${joint(why.origin)} ${span(entry, entry.es)}`.replace(/^, /, ''))
    current = why.job
  }
  // latest: from the job forward to what closes it
  const backward: string[] = []
  current = key
  seen.clear()
  while (!seen.has(current) && seen.size < 24) {
    seen.add(current)
    const entry = info.get(current)!
    const why = entry.lsWhy
    if (why.kind !== 'before') { backward.push(`${titled(current)} must start by ${at(entry.ls)} as ${root(why)}`); break }
    if (why.origin.kind === 'span-limit') spanLimit ??= { origin: why.origin, closer: current }
    backward.push(`${titled(current)} must start by ${at(entry.ls)} to leave room for ${titled(why.job)}`)
    current = why.job
  }
  const entry = info.get(key)!
  const head = `${titled(key)} ${reason === 'its earliest start is after its latest start' ? `cannot start before ${at(entry.es)} but must start by ${at(entry.ls)}` : reason.replace(/^it /, '')}.`
  let tail = ''
  if (spanLimit !== undefined) {
    const closer = info.get(spanLimit.closer)!
    const opener = info.get(key)!
    const least = hours((closer.timing.finish[closer.es] ?? closer.es) - Math.min(opener.ls, opener.es))
    tail = ` So ${spanLimit.origin.group} would be out at least ${least} h, against its ${spanLimit.origin.limitHours} h limit ('${spanLimit.origin.words}').`
  }
  return `${head} Earliest: ${forward.join('; ')}. Latest: ${backward.join('; ')}.${tail}`
}

/** "'Lift out SW A motor' 3 h unbroken in Day shift and Crane hours, Tue 17 Nov 07:00 to 10:00", from a start bound. */
const describeJob = (context: Context, entry: Explained, from: number): string => {
  const { grid, when } = context
  const at = (slot: number): string => when(context.windowStart + slot * grid.slotMs)
  const job = entry.job
  const labels = job.duration.calendar === 'elapsed' || job.needs.length === 0 ? ['clock time']
    : job.needs.map(need => [...new Set(need.anyOf.map(resource => context.inputs.calendars.find(calendar => calendar.key === context.resources.get(resource)?.calendar)?.label ?? resource))].join(' or '))
  const how = `${entry.work * grid.slotMs / 3_600_000} h${job.continuous ? ' unbroken' : ''} in ${[...new Set(labels)].join(' and ')}`
  let start = Math.max(0, from)
  while (start < entry.timing.valid.length && entry.timing.valid[start] !== 1) start++
  if (start >= entry.timing.valid.length) return `'${job.title}' ${how}, which no longer fits before the window closes ${at(grid.slots)}`
  return `'${job.title}' ${how}, ${at(start)} to ${at(entry.timing.finish[start]!)}`
}
