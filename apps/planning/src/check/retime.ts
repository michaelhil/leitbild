// The pessimistic card's check (design §4.2). Lane S re-times an option's schedule by preview's repair path,
// with ranged jobs at their high estimate; this judges the re-timing. It is a re-timing only when it keeps
// each job's crews and tools and starts nothing earlier than planned, and every job is in it but one the
// repair could not place and the jobs that follow that one; anything else is refused, never judged. Then the
// checker judges it at the high estimates, the plan's rules and the what-if's extra rules alike, and the
// outcome is the checker's own: it holds, or the first item broken in time:
// - span limit: it runs out at the span's first instant plus the limit; the job is the test that returns the
//   group last (the span's end), and `by` is the span past the limit;
// - due: it runs out at its due time; the job is the due job, and `by` is its finish past the due time;
// - the window: work that runs past the window end is judged on the plan's calendars continued past it; the
//   window runs out at its end, the job is the first one past it, and `window.by` is when the work would end;
// - unplaced: the job the repair could not place, and a crew or tool of its planned row that has no stretch
//   long enough for it at or after the job is ready, on the plan's calendars continued for the window's
//   length again past the window end, at the plan grid (F3: no further, so a fine grid stays cheap); `after` is
//   the instant from which no stretch of that resource's time long enough for the job remains within that
//   bound, and it runs out then. What lies past the bound is not searched, so the words name it: "no slot long
//   enough left after <after>, within <the window's length> after the window". The findings that only follow from the jobs left out (not scheduled, never returned, a span left
//   open) are part of it. A job whose crews still have time is refused: the repair, not the plan, lost it.
// At one instant a rule comes first, then the window, then an unplaced job. Any other finding (a link, a
// crew, a keep-in-service or protection rule the repair path keeps by construction) is no outcome of a
// re-timing: it is refused with the checker's words.
import type { PlanInputs, Robust } from '../plan/schema.ts'
import { expand, periodSlots, type Grid } from './calendar.ts'
import { checkPlan, jobDuration, mergeIntervals, prepare, type CheckRow, type CheckVariant, type Context } from './check.ts'

/** A re-timing's outcome, as `option.robust` stores it. */
export type Retimed = Robust['allPessimistic']
export type RetimeJudgement =
  | { readonly ok: true; readonly outcome: Retimed }
  | { readonly ok: false; readonly problems: readonly string[] }

type Job = PlanInputs['jobs'][number]
const hourMs = 3_600_000

/** The jobs of this variant with an estimate range, in plan order: the ones a pessimistic re-timing lengthens. */
export const rangedJobs = (inputs: PlanInputs, variant: CheckVariant): string[] => {
  const prepared = prepare(inputs, variant)
  if (!prepared.ok) return []
  return inputs.jobs.filter(job => prepared.context.active.has(job.key) && job.duration.range !== undefined).map(job => job.key)
}

/** Why a job has no high estimate of its own, or undefined when it has one. */
const notRanged = (job: Job | undefined, key: string): string | undefined => {
  if (job === undefined) return `The plan has no job '${key}'.`
  if (job.duration.range === undefined) return `'${job.title}' has no estimate range, so it has no high estimate.`
  if (job.duration.origin.by === 'world' || job.durationWith.length > 0) return `'${job.title}' takes its duration from World values or from the crew chosen, so its range is not its own estimate.`
  return undefined
}

/** The plan inputs with these jobs at their high estimate. Each must have a range of its own (see `notRanged`). */
export const atHigh = (inputs: PlanInputs, jobs: readonly string[]): PlanInputs => {
  const high = new Set(jobs)
  for (const key of high) {
    const problem = notRanged(inputs.jobs.find(job => job.key === key), key)
    if (problem !== undefined) throw new RangeError(problem)
  }
  return { ...inputs, jobs: inputs.jobs.map(job => high.has(job.key) ? { ...job, duration: { ...job.duration, value: job.duration.range!.high } } : job) }
}

const crewsOf = (row: CheckRow): string => [...new Set(row.uses.map(use => use.resource))].sort().join(',')

/**
 * Why `retimed` is not a re-timing of `planned`: a job added, moved earlier or given other crews. Planned jobs
 * it leaves out are listed apart, for the unplaced judgement.
 */
const notARetiming = (inputs: PlanInputs, planned: readonly CheckRow[], retimed: readonly CheckRow[]): { readonly problems: string[]; readonly missing: string[] } => {
  const title = (key: string) => `'${inputs.jobs.find(job => job.key === key)?.title ?? key}'`
  const problems: string[] = []
  const missing: string[] = []
  const byJob = (rows: readonly CheckRow[]) => {
    const map = new Map<string, CheckRow>()
    for (const row of rows) {
      if (map.has(row.job)) problems.push(`${title(row.job)} is scheduled more than once.`)
      map.set(row.job, row)
    }
    return map
  }
  const before = byJob(planned), after = byJob(retimed)
  for (const [key, row] of before) {
    const moved = after.get(key)
    if (moved === undefined) { missing.push(key); continue }
    if (Date.parse(moved.start) < Date.parse(row.start)) problems.push(`${title(key)} starts earlier than planned in the re-timing.`)
    if (crewsOf(moved) !== crewsOf(row)) problems.push(`${title(key)} has other crews or tools in the re-timing.`)
  }
  for (const key of after.keys()) if (!before.has(key)) problems.push(`${title(key)} is in the re-timing but not planned.`)
  return { problems, missing }
}

const unitMs = { s: 1_000, min: 60_000, h: hourMs, d: 86_400_000 } as const
const gridMs = { '30s': 30_000, '30min': 1_800_000 } as const

/**
 * The inputs a re-timing is judged on: the jobs `high` at their high estimate, and, when the re-timed work runs
 * past the window end, the window continued to its last finish (on the grid), so the work there is judged on
 * the plan's own calendars. The checker's figures for a re-timing (its spans, say) are measured on these.
 */
export const judgedInputs = (inputs: PlanInputs, high: readonly string[], retimed: readonly CheckRow[]): PlanInputs => {
  const pessimistic = atHigh(inputs, high)
  const window = pessimistic.settings.window
  const lastFinish = Math.max(-Infinity, ...retimed.map(row => Date.parse(row.finish)))
  if (window === null || !Number.isFinite(lastFinish) || lastFinish <= Date.parse(window.end)) return pessimistic
  const start = Date.parse(window.start), slotMs = gridMs[pessimistic.settings.grid]
  return { ...pessimistic, settings: { ...pessimistic.settings, window: { start: window.start, end: new Date(start + Math.ceil((lastFinish - start) / slotMs) * slotMs).toISOString() } } }
}

/** Jobs that must follow each job: its links, a tag-out's work and tests, inside work's tests, a supporter's tests. */
const followers = (context: Context): ReadonlyMap<string, ReadonlySet<string>> => {
  const { inputs, active } = context
  const next = new Map<string, Set<string>>()
  const add = (from: string, to: string): void => { if (active.has(from) && active.has(to)) next.set(from, new Set([...(next.get(from) ?? []), to])) }
  for (const link of inputs.links) {
    if (link.method !== undefined && !context.variant.methods.some(chosen => chosen.choice === link.method!.choice && chosen.option === link.method!.option)) continue
    add(link.from, link.to)
  }
  const jobs = inputs.jobs.filter(job => active.has(job.key))
  const of = (item: string, kind: Job['kind']) => jobs.filter(job => job.kind === kind && job.equipment.includes(item) && (kind !== 'work' || job.isolation === 'inside'))
  const supportersOf = (item: string, seen: ReadonlySet<string> = new Set()): string[] => (inputs.equipment.find(entry => entry.key === item)?.supportedBy ?? [])
    .filter(key => !seen.has(key)).flatMap(key => [key, ...supportersOf(key, new Set([...seen, item, key]))])
  for (const item of inputs.equipment) {
    for (const tag of of(item.key, 'tag-out')) for (const after of [...of(item.key, 'work'), ...of(item.key, 'test')]) add(tag.key, after.key)
    for (const work of of(item.key, 'work')) for (const test of of(item.key, 'test')) add(work.key, test.key)
    for (const supporter of supportersOf(item.key)) for (const before of of(supporter, 'test')) for (const test of of(item.key, 'test')) add(before.key, test.key)
  }
  return next
}
const downstreamOf = (graph: ReadonlyMap<string, ReadonlySet<string>>, from: string): Set<string> => {
  const seen = new Set<string>()
  const queue = [from]
  while (queue.length > 0) for (const next of graph.get(queue.shift()!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next) }
  return seen
}

type Unplaced = Extract<Retimed, { unplaced: unknown }>['unplaced']

type UnplacedResult = { readonly ok: true; readonly unplaced: Unplaced; readonly at: number } | { readonly ok: false; readonly problems: string[] }

/**
 * The jobs left out that no other one left out leads to (each the start of what the repair could not place),
 * and every other job left out follows one of them; the re-timing places nothing that follows one. Each must
 * be unplaceable, and the first in time is the outcome (at one instant, the first in plan order). A job is
 * unplaceable when a crew or tool of its planned row has no
 * stretch long enough for it at or after it is ready, on the calendars continued for the window's length again
 * past the window end. Ready: no earlier than planned, its release and the data date, its links from the placed jobs
 * (finish-to-start after the finish, start-to-start after the start, each with its lag), and the orders the
 * checker holds every schedule to (an item with one tag-out: its work after the tag-out, its tests after the
 * tag-out and the work; a supported item's tests after its supporters'): a lower bound, so "nothing fits
 * after it" is never claimed too early.
 */
const unplacedOf = (context: Context, planned: readonly CheckRow[], retimed: readonly CheckRow[], missing: readonly string[]): UnplacedResult => {
  const title = (key: string) => `'${context.jobs.get(key)?.title ?? key}'`
  const graph = followers(context)
  const roots = missing.filter(key => !missing.some(other => other !== key && downstreamOf(graph, other).has(key)))
  const after = new Set(roots.flatMap(root => [...downstreamOf(graph, root)]))
  const skipped = retimed.filter(row => after.has(row.job)).map(row => title(row.job))
  if (skipped.length > 0) return { ok: false, problems: [`The re-timing places ${skipped.join(', ')}, which follow a job it leaves out.`] }
  const stray = missing.filter(job => !roots.includes(job) && !after.has(job))
  if (roots.length === 0 || stray.length > 0) return { ok: false, problems: [`The re-timing leaves out ${(stray.length > 0 ? stray : missing).map(title).join(', ')}, which follow no job it could not place.`] }
  const results = roots.map(root => unplaceable(context, planned, retimed, root))
  const failed = results.find(result => !result.ok)
  if (failed !== undefined) return failed
  const order = (key: string) => context.inputs.jobs.findIndex(job => job.key === key)
  return results.filter((result): result is Extract<UnplacedResult, { ok: true }> => result.ok).sort((x, y) => x.at - y.at || order(x.unplaced.job) - order(y.unplaced.job))[0]!
}

/** One job left out: a crew or tool with no time left for it once it is ready, or why it could still be placed. */
const unplaceable = (context: Context, planned: readonly CheckRow[], retimed: readonly CheckRow[], key: string): UnplacedResult => {
  const { inputs, windowStart, grid } = context
  const title = (job: string) => `'${context.jobs.get(job)?.title ?? job}'`
  const job = context.jobs.get(key)!
  const plannedRow = planned.find(row => row.job === key)!
  const placed = new Map(retimed.map(row => [row.job, row]))
  const dataDate = inputs.settings.dataDate === null ? -Infinity : Date.parse(inputs.settings.dataDate)
  let ready = Math.max(Date.parse(plannedRow.start), job.notBefore === undefined ? -Infinity : Date.parse(job.notBefore.at), dataDate)
  for (const link of inputs.links) {
    const before = placed.get(link.from)
    if (link.to !== key || before === undefined || !(link.type === 'FS' || link.type === 'SS')) continue
    ready = Math.max(ready, Date.parse(link.type === 'FS' ? before.finish : before.start) + link.lag.value * unitMs[link.lag.unit])
  }
  const finishOf = (keys: readonly string[]) => Math.max(-Infinity, ...keys.flatMap(other => { const row = placed.get(other); return row === undefined ? [] : [Date.parse(row.finish)] }))
  const activeJobs = inputs.jobs.filter(entry => context.active.has(entry.key))
  const onItem = (item: string, kind: Job['kind']) => activeJobs.filter(entry => entry.kind === kind && entry.equipment.includes(item) && (kind !== 'work' || entry.isolation === 'inside')).map(entry => entry.key)
  for (const item of job.equipment) {
    const tags = onItem(item, 'tag-out')
    if (tags.length === 1 && job.kind !== 'tag-out' && (job.kind === 'test' || job.isolation === 'inside')) ready = Math.max(ready, finishOf(tags))
    if (tags.length === 1 && job.kind === 'test') ready = Math.max(ready, finishOf(onItem(item, 'work')))
    if (job.kind === 'test') {
      const supporters = (of: string, seen: ReadonlySet<string> = new Set()): string[] => (inputs.equipment.find(entry => entry.key === of)?.supportedBy ?? []).filter(other => !seen.has(other)).flatMap(other => [other, ...supporters(other, new Set([...seen, of, other]))])
      ready = Math.max(ready, finishOf(supporters(item).flatMap(supporter => onItem(supporter, 'test'))))
    }
  }
  const resources = [...new Set(plannedRow.uses.map(use => use.resource))]
  const duration = jobDuration(context, job, new Set(resources))
  if (!duration.ok) return { ok: false, problems: [duration.problem.words] }
  const work = duration.slots
  const together = job.continuous || job.duration.calendar === 'elapsed'

  // the calendars continued for the window's length again past the window end, on the plan grid (the bound)
  const purchasesOn = (resource: string) => inputs.purchases.filter(purchase => purchase.resource === resource)
  const continued: Grid = { ...grid, origin: windowStart, slots: 2 * grid.slots }
  const slotOf = (instant: number) => Math.round((instant - windowStart) / grid.slotMs)
  const readySlot = Math.ceil((ready - windowStart) / grid.slotMs - 1e-9)
  const usedByAny = new Set(retimed.flatMap(row => row.uses.flatMap(use => use.purchase === undefined ? [] : [use.purchase])))
  for (const resource of resources) {
    const definition = context.resources.get(resource)!
    const calendarOf = (calendarKey: string): Uint8Array | undefined => {
      const shape = inputs.calendars.find(entry => entry.key === calendarKey)
      const expanded = shape === undefined ? undefined : expand(shape, continued)
      return expanded?.ok === true ? expanded.work : undefined
    }
    const available = calendarOf(definition.calendar)
    if (available === undefined) return { ok: false, problems: [`The calendar of '${definition.label}' cannot be continued past the window.`] }
    // booked time a used or ordered rebooking gives up, then the bought time this job's planned row used
    for (const purchase of purchasesOn(resource)) {
      if (purchase.ordered !== undefined || usedByAny.has(purchase.key)) periodSlots(purchase.replaces, continued).forEach((slot, index) => { if (slot === 1) available[index] = 0 })
    }
    for (const use of plannedRow.uses) {
      const purchase = use.resource === resource && use.purchase !== undefined ? inputs.purchases.find(entry => entry.key === use.purchase) : undefined
      if (purchase === undefined) continue
      const added = 'calendar' in purchase.adds ? calendarOf(purchase.adds.calendar) : periodSlots(purchase.adds.periods, continued)
      if (added === undefined) return { ok: false, problems: [`The time bought from '${purchase.label}' cannot be continued past the window.`] }
      added.forEach((slot, index) => { if (slot === 1) available[index] = 1 })
    }
    // less the units the placed jobs hold, against the units this job held at once
    const load = new Int32Array(continued.slots)
    for (const row of retimed) for (const use of row.uses) if (use.resource === resource) for (let slot = Math.max(0, slotOf(Date.parse(use.from))); slot < Math.min(continued.slots, slotOf(Date.parse(use.to))); slot++) load[slot]!++
    const own = new Int32Array(continued.slots)
    for (const use of plannedRow.uses) if (use.resource === resource) for (let slot = Math.max(0, slotOf(Date.parse(use.from))); slot < Math.min(continued.slots, slotOf(Date.parse(use.to))); slot++) own[slot]!++
    let units = 1   // the most units this job held at once (no spread: a fine grid has a million slots)
    for (const count of own) if (count > units) units = count
    // the latest start that fits: `work` slots in one stretch (continuous or elapsed), or in all the time left
    let latest = -1, run = 0, total = 0
    for (let slot = continued.slots - 1; slot >= 0; slot--) {
      const free = available[slot] === 1 && definition.count - load[slot]! >= units
      run = free ? run + 1 : 0
      total += free ? 1 : 0
      if (free && (together ? run : total) >= work) { latest = slot; break }
    }
    const from = latest + 1
    if (readySlot >= from) return { ok: true, unplaced: { job: key, resource, after: new Date(windowStart + from * grid.slotMs).toISOString() }, at: windowStart + from * grid.slotMs }
  }
  return { ok: false, problems: [`${title(key)} could still be placed: each of its crews and tools has time for it after it is ready.`] }
}

/**
 * Judges a re-timing of `planned` with the jobs `high` at their high estimates (all ranged jobs for the
 * card's "all pessimistic", one for each `single` entry). `variant` is the option's, with any extra rule.
 * `retimed` holds the rows of the jobs the repair placed; one it could not place, and those after it, are
 * left out.
 */
export const judgeRetiming = (inputs: PlanInputs, variant: CheckVariant, planned: readonly CheckRow[], retimed: readonly CheckRow[], high: readonly string[]): RetimeJudgement => {
  const ranged = high.flatMap(key => { const problem = notRanged(inputs.jobs.find(job => job.key === key), key); return problem === undefined ? [] : [problem] })
  if (ranged.length > 0) return { ok: false, problems: ranged }
  const shape = notARetiming(inputs, planned, retimed)
  if (shape.problems.length > 0) return { ok: false, problems: shape.problems }
  const missing = new Set(shape.missing)
  const pessimistic = atHigh(inputs, high)
  const prepared = prepare(pessimistic, variant)
  if (!prepared.ok) return { ok: false, problems: prepared.problems.map(problem => problem.words) }
  const rules = prepared.context.inputs.rules   // the plan's, then the what-if's extra rules
  const unplaced = missing.size === 0 ? undefined : unplacedOf(prepared.context, planned, retimed, shape.missing)
  if (unplaced !== undefined && !unplaced.ok) return { ok: false, problems: unplaced.problems }
  // Work past the window end is judged on the calendars continued to the last finish, on the grid.
  const { windowEnd } = prepared.context
  const last = retimed.reduce<CheckRow | undefined>((latest, row) => latest === undefined || Date.parse(row.finish) > Date.parse(latest.finish) ? row : latest, undefined)
  const lastFinish = last === undefined ? NaN : Date.parse(last.finish)
  const pastWindow = Number.isFinite(lastFinish) && lastFinish > windowEnd
  const check = checkPlan(judgedInputs(inputs, high, retimed), variant, retimed)
  // What only follows from the jobs left out: they are not scheduled, an item they would return is never
  // returned (and its span stays open, below).
  const returnedBy = (item: string) => inputs.jobs.some(job => missing.has(job.key) && job.kind === 'test' && job.equipment.includes(item))
  const follows = (violation: { readonly code: string; readonly about: readonly string[] }) =>
    (violation.code === 'not-scheduled' && missing.has(violation.about[0]!)) || (violation.code === 'never-returned' && returnedBy(violation.about[0]!))
  const ruled = check.violations.filter(violation => (violation.code === 'span-limit' || violation.code === 'due') && rules.some(rule => rule.key === violation.about[0]))
  const other = check.violations.filter(violation => !ruled.includes(violation) && !follows(violation))
  if (other.length > 0) return { ok: false, problems: other.map(violation => violation.words) }

  const rowOf = new Map(retimed.map(row => [row.job, row]))
  const supportersOf = (item: string, seen: ReadonlySet<string> = new Set()): string[] => (inputs.equipment.find(entry => entry.key === item)?.supportedBy ?? [])
    .filter(key => !seen.has(key)).flatMap(key => [key, ...supportersOf(key, new Set([...seen, item, key]))])
  const breaks: Array<{ readonly at: number; readonly order: number; readonly outcome: Extract<Retimed, { holds: false }> }> = []
  const problems: string[] = []
  rules.forEach((rule, order) => {
    if (!ruled.some(violation => violation.about[0] === rule.key && violation.code === rule.kind)) return
    if (rule.kind === 'due') {
      const finish = Date.parse(rowOf.get(rule.job)!.finish), by = Date.parse(rule.finishBy)
      breaks.push({ at: by, order, outcome: { holds: false, rule: rule.key, job: rule.job, by: { value: (finish - by) / hourMs, unit: 'h' } } })
      return
    }
    if (rule.kind !== 'span-limit') return
    // the group's spans as the checker counts them, from its own outages on these rows
    const members = inputs.equipment.filter(item => item.group === rule.group).map(item => item.key)
    const intervals = mergeIntervals(members.flatMap(member => check.outages.get(member) ?? []))
    const spans = rule.singleEntry && intervals.length > 0 ? [{ from: intervals[0]!.from, to: Math.max(...intervals.map(interval => interval.to)) }] : intervals
    const limit = rule.limit.value * unitMs[rule.limit.unit]
    const over = spans.find(span => span.to - span.from > limit + 1e-6)
    if (over === undefined) return
    // a span left open by a job the repair could not place is part of that job's item, not a rule broken by hours
    if (over.to === Infinity && unplaced !== undefined) return
    const covered = new Set(members.flatMap(member => [member, ...supportersOf(member)]))
    const returning = inputs.jobs.find(job => job.kind === 'test' && job.equipment.some(item => covered.has(item)) && rowOf.has(job.key) && Date.parse(rowOf.get(job.key)!.finish) === over.to)
    if (returning === undefined) { problems.push(`No test returns the group at the end of its span, so the re-timing breaks '${rule.words}' at no job.`); return }
    breaks.push({ at: over.from + limit, order, outcome: { holds: false, rule: rule.key, job: returning.key, by: { value: (over.to - over.from - limit) / hourMs, unit: 'h' } } })
  })
  if (problems.length > 0) return { ok: false, problems }
  if (pastWindow) {
    const firstPast = inputs.jobs.flatMap(job => { const row = rowOf.get(job.key); return row !== undefined && Date.parse(row.finish) > windowEnd ? [row] : [] })
      .reduce((earliest, row) => Date.parse(row.start) < Date.parse(earliest.start) ? row : earliest)
    breaks.push({ at: windowEnd, order: rules.length, outcome: { holds: false, window: { by: last!.finish }, job: firstPast.job } })
  }
  if (unplaced !== undefined && unplaced.ok) breaks.push({ at: unplaced.at, order: rules.length + 1, outcome: { holds: false, unplaced: unplaced.unplaced } })
  const first = [...breaks].sort((left, right) => left.at - right.at || left.order - right.order)[0]
  return { ok: true, outcome: first === undefined ? { holds: true } : first.outcome }
}
