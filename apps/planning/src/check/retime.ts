// The pessimistic card's check (design §4.2). Lane S re-times an option's schedule by preview's repair path,
// with ranged jobs at their high estimate; this judges the re-timing. It is a re-timing only when it keeps
// every job and each job's crews and tools, and starts nothing earlier than planned; anything else is
// refused, never judged. Then the checker judges it at the high estimates, the plan's rules and the
// what-if's extra rules alike, and the outcome is the checker's own: it holds, or the first rule it breaks
// in time, the job at which that rule breaks, and by how much.
// - span limit: it runs out at the span's first instant plus the limit; the job is the test that returns the
//   group last (the span's end), and `by` is the span past the limit;
// - due: it runs out at its due time; the job is the due job, and `by` is its finish past the due time;
// - the window: work that runs past the window end is judged on the plan's calendars continued past it; the
//   window runs out at its end, the job is the first one past it, and `window.by` is when the work would end.
// A rule that runs out at the same instant as the window comes first. Any other finding (a link, a crew, a
// keep-in-service or protection rule the repair path keeps by construction) is no outcome of a re-timing: it
// is refused with the checker's words.
import type { PlanInputs, Robust } from '../plan/schema.ts'
import { checkPlan, mergeIntervals, prepare, type CheckRow, type CheckVariant } from './check.ts'

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

/** Why `retimed` is not a re-timing of `planned`: a job missing, added, moved earlier or given other crews. */
const notARetiming = (inputs: PlanInputs, planned: readonly CheckRow[], retimed: readonly CheckRow[]): string[] => {
  const title = (key: string) => `'${inputs.jobs.find(job => job.key === key)?.title ?? key}'`
  const problems: string[] = []
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
    if (moved === undefined) { problems.push(`${title(key)} is planned but not in the re-timing.`); continue }
    if (Date.parse(moved.start) < Date.parse(row.start)) problems.push(`${title(key)} starts earlier than planned in the re-timing.`)
    if (crewsOf(moved) !== crewsOf(row)) problems.push(`${title(key)} has other crews or tools in the re-timing.`)
  }
  for (const key of after.keys()) if (!before.has(key)) problems.push(`${title(key)} is in the re-timing but not planned.`)
  return problems
}

/**
 * Judges a re-timing of `planned` with the jobs `high` at their high estimates (all ranged jobs for the
 * card's "all pessimistic", one for each `single` entry). `variant` is the option's, with any extra rule.
 */
export const judgeRetiming = (inputs: PlanInputs, variant: CheckVariant, planned: readonly CheckRow[], retimed: readonly CheckRow[], high: readonly string[]): RetimeJudgement => {
  const ranged = high.flatMap(key => { const problem = notRanged(inputs.jobs.find(job => job.key === key), key); return problem === undefined ? [] : [problem] })
  if (ranged.length > 0) return { ok: false, problems: ranged }
  const shape = notARetiming(inputs, planned, retimed)
  if (shape.length > 0) return { ok: false, problems: shape }
  const pessimistic = atHigh(inputs, high)
  const prepared = prepare(pessimistic, variant)
  if (!prepared.ok) return { ok: false, problems: prepared.problems.map(problem => problem.words) }
  const rules = prepared.context.inputs.rules   // the plan's, then the what-if's extra rules
  // Work past the window end is judged on the calendars continued to the last finish, on the grid.
  const { windowStart, windowEnd, grid } = prepared.context
  const last = retimed.reduce<CheckRow | undefined>((latest, row) => latest === undefined || Date.parse(row.finish) > Date.parse(latest.finish) ? row : latest, undefined)
  const lastFinish = last === undefined ? NaN : Date.parse(last.finish)
  const pastWindow = Number.isFinite(lastFinish) && lastFinish > windowEnd
  const judgedEnd = pastWindow ? windowStart + Math.ceil((lastFinish - windowStart) / grid.slotMs) * grid.slotMs : windowEnd
  const judged = pastWindow ? { ...pessimistic, settings: { ...pessimistic.settings, window: { start: pessimistic.settings.window!.start, end: new Date(judgedEnd).toISOString() } } } : pessimistic
  const check = checkPlan(judged, variant, retimed)
  const ruled = check.violations.filter(violation => (violation.code === 'span-limit' || violation.code === 'due') && rules.some(rule => rule.key === violation.about[0]))
  const other = check.violations.filter(violation => !ruled.includes(violation))
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
    const limit = rule.limit.value * { s: 1_000, min: 60_000, h: hourMs, d: 86_400_000 }[rule.limit.unit]
    const over = spans.find(span => span.to - span.from > limit + 1e-6)
    if (over === undefined) return
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
  const first = [...breaks].sort((left, right) => left.at - right.at || left.order - right.order)[0]
  return { ok: true, outcome: first === undefined ? { holds: true } : first.outcome }
}
