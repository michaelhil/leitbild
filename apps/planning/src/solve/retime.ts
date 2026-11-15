// Pessimistic re-timing (design §4.2, S4): an option's own schedule re-timed with its ranged jobs at their
// high estimates, by preview's repair path (the same order, the same modes and so the same crews and bought
// time, nothing earlier than planned), first every ranged job together, then each alone. Lane K judges each
// re-timing (check/retime.ts judgeRetiming): it holds, or the first rule it breaks, the job and by how much,
// the job that would run past the window end, or the job that could not be placed. Every figure is lane K's.
// Pure apart from the clock; the solver child runs it after a sub-solve's search.
import type { PlanInputs, Robust } from '../plan/schema.ts'
import { timeUnitMs } from '../time/units.ts'
import { compile } from './compile.ts'
import { withExtraRules } from './keys.ts'
import { dateSchedule, undate, type DatedRow, type UndatedFloat } from './date.ts'
import { prepare, repair } from './decode.ts'
import type { CheckedVariant } from './status.ts'

export type Retimed = Robust['allPessimistic']
type Row = Pick<DatedRow, 'job' | 'start' | 'finish' | 'uses'>
interface Planned { readonly variant: CheckedVariant; readonly rows: readonly Row[] }

/**
 * Lane K's judgement of a re-timing (check/retime.ts judgeRetiming): on the plan's own inputs and the option's
 * variant (with its extra rule), the planned rows, the re-timed rows and the jobs at their high estimate. It
 * refuses what is no re-timing (a job missing, earlier, or on other crews) and findings it does not judge.
 */
export type JudgeRetimed = (plan: { readonly inputs: PlanInputs; readonly variant: CheckedVariant; readonly planned: readonly Row[]; readonly retimed: readonly UndatedFloat[]; readonly high: readonly string[] }) =>
  { readonly ok: true; readonly outcome: Retimed } | { readonly ok: false; readonly problems: readonly string[] }

/** robust.single holds at most this many jobs (plan/schema.ts). */
export const MAX_SINGLE_RETIMINGS = 12

/**
 * The jobs an option schedules whose own estimate has a range above the planned value (not a World value, not
 * a duration per crew: lane K's rule), in plan order; above 12, the 12 with the largest increase.
 */
export const rangedJobs = (inputs: PlanInputs, rows: ReadonlyArray<Pick<Row, 'job'>>): string[] => {
  const scheduled = new Set(rows.map(row => row.job))
  const ranged = inputs.jobs.flatMap((job, order) => {
    const { value, range, unit, origin } = job.duration
    if (!scheduled.has(job.key) || origin.by === 'world' || job.durationWith.length > 0 || value === null || range === undefined || !(range.high > value)) return []
    return [{ key: job.key, order, increase: (range.high - value) * timeUnitMs[unit] }]
  })
  const kept = [...ranged].sort((x, y) => y.increase - x.increase || x.order - y.order).slice(0, MAX_SINGLE_RETIMINGS)
  return kept.sort((x, y) => x.order - y.order).map(entry => entry.key)
}

/** How many re-timings an option scheduling these jobs needs: every ranged job together, then each alone. */
export const retimingCount = (inputs: PlanInputs, jobs: readonly string[]): number => {
  const ranged = rangedJobs(inputs, jobs.map(job => ({ job }))).length
  return ranged === 0 ? 0 : 1 + ranged
}

/** The inputs with the named jobs at their high estimate. */
export const atHigh = (inputs: PlanInputs, jobs: ReadonlySet<string>): PlanInputs => ({
  ...inputs,
  jobs: inputs.jobs.map(job => (jobs.has(job.key) && job.duration.range !== undefined ? { ...job, duration: { ...job.duration, value: job.duration.range.high } } : job)),
})

/**
 * The option's rows re-timed on `pessimistic` (the same plan with some jobs longer; both with the option's
 * extra rule): each job keeps its mode (its crews and bought time, read exactly on the planned inputs) and its
 * order, and starts no earlier than planned (repair's floors). A job that finds no slot with its crews and
 * tools before the horizon (a booked team's period missed, say) has no row, nor has any job that waits on it:
 * `rows` are the placed jobs, and lane K names the job that could not be placed, its crew and from when.
 * Undefined when the rows do not read back on the planned inputs or the two compiles do not line up.
 */
export const retimedRows = (planned: PlanInputs, pessimistic: PlanInputs, option: Planned): { readonly rows: UndatedFloat[] } | undefined => {
  const sub = { methods: option.variant.methods, buy: option.variant.purchases }
  const before = compile(planned, sub), after = compile(pessimistic, sub)
  if (!before.ok || !after.ok) return undefined
  const saved = undate(prepare(before.problem), before.index, option.rows)
  if (!saved.ok) return undefined
  const same = before.problem.activities.length === after.problem.activities.length
    && before.problem.activities.every((activity, a) => activity.id === after.problem.activities[a]!.id && activity.modes.length === after.problem.activities[a]!.modes.length)
  if (!same) return undefined
  const prep = prepare(after.problem)
  const { decoded } = repair(prep, saved.schedule)
  const placed = (a: number): boolean => decoded.finish[a]! >= 0 && decoded.finish[a]! < prep.H && decoded.start[a]! < prep.H
  return { rows: dateSchedule(prep, after.index, { start: decoded.start, mode: decoded.mode }, placed) }
}

/**
 * The option's robust record on the plan's `inputs`: every ranged job high together, then each alone, each
 * judged by lane K, a job that could not be placed included. Undefined (not
 * computed, never partly) when a re-timing cannot be made or is refused by lane K, or when the next one would
 * not end by `until` (epoch ms), judged by the longest re-timing so far, and before the first by `estimateMs`
 * (the sub-solve passes its own work before the search, which a re-timing does not exceed).
 */
export const robustOf = (inputs: PlanInputs, option: Planned, judge: JudgeRetimed, until = Infinity, now: () => number = Date.now, estimateMs = 0): Robust | undefined => {
  const jobs = rangedJobs(inputs, option.rows)
  // Nothing ranged: re-timing changes nothing, and the planned schedule is the one lane K validated.
  if (jobs.length === 0) return { allPessimistic: { holds: true }, single: [] }
  const planned = withExtraRules(inputs, option.variant.also)
  let longest = estimateMs
  const once = (high: readonly string[]): Retimed | undefined => {
    const started = now()
    if (started + longest > until) return undefined
    const retimed = retimedRows(planned, withExtraRules(atHigh(inputs, new Set(high)), option.variant.also), option)
    const judged = retimed === undefined ? undefined : judge({ inputs, variant: option.variant, planned: option.rows, retimed: retimed.rows, high })
    longest = Math.max(longest, now() - started)   // never below the first estimate
    return judged?.ok === true ? judged.outcome : undefined
  }
  const allPessimistic = once(jobs)
  if (allPessimistic === undefined) return undefined
  const single: Array<Robust['single'][number]> = []
  for (const job of jobs) {
    const outcome = once([job])
    if (outcome === undefined) return undefined
    single.push({ job, outcome })
  }
  return { allPessimistic, single }
}
