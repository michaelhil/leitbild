// Pessimistic re-timing (design §4.2, S4): an option's own schedule re-timed with its ranged jobs at their
// high estimates, by preview's repair path (the same order, the same modes and so the same crews and bought
// time, nothing earlier than planned), first every ranged job together, then each alone. Lane K judges each
// re-timing (check/retime.ts judgeRetiming): it holds, or the first rule it breaks, the job and by how much,
// the job that would run past the window end, or the job that could not be placed. Every figure is lane K's.
// Pure apart from the clock; the solver child runs it after a sub-solve's search.
import type { PlanInputs, Robust, RobustField } from '../plan/schema.ts'
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
  | { readonly ok: true; readonly outcome: Retimed; readonly spans?: ReadonlyArray<{ readonly rule: string; readonly hours: number; readonly margin: number }> }
  | { readonly ok: false; readonly problems: readonly string[] }

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
 * extra rule): each job keeps its order and its crews and tools, and starts no earlier than planned (repair's
 * floors). It keeps its mode (read exactly on the planned inputs) unless that leaves it no slot: then it takes
 * the mode of the same crews and tools with the most working time, the option's bought time included, as the
 * crews would work into time the option already buys. A job that still finds no slot before the horizon (a
 * booked team's period missed, say) has no row, nor has any job that waits on it: `rows` are the placed jobs,
 * `unplaced` the first such job whose own predecessors are placed, and lane K names its crew and from when.
 * Undefined when the rows do not read back on the planned inputs or the two compiles do not line up.
 */
export const retimedRows = (planned: PlanInputs, pessimistic: PlanInputs, option: Planned): { readonly rows: UndatedFloat[]; readonly unplaced?: string } | undefined => {
  const sub = { methods: option.variant.methods, buy: option.variant.purchases }
  const before = compile(planned, sub), after = compile(pessimistic, sub)
  if (!before.ok || !after.ok) return undefined
  const saved = undate(prepare(before.problem), before.index, option.rows)
  if (!saved.ok) return undefined
  const same = before.problem.activities.length === after.problem.activities.length
    && before.problem.activities.every((activity, a) => activity.id === after.problem.activities[a]!.id && activity.modes.length === after.problem.activities[a]!.modes.length)
  if (!same) return undefined
  const prep = prepare(after.problem)
  // The shared repair: a job with no slot in its own mode takes the same crews' widest mode (decode.ts repair).
  const { decoded, lost: unplacedActivities } = repair(prep, saved.schedule)
  const placed = (a: number): boolean => !unplacedActivities.includes(a)
  const lost = after.index.jobs.flatMap((job, a) => (job !== null && !placed(a) ? [a] : []))
  const root = lost.filter(a => prep.preds[a]!.every(link => placed(link.from))).sort((x, y) => decoded.start[x]! - decoded.start[y]! || x - y)[0]
  return { rows: dateSchedule(prep, after.index, { start: decoded.start, mode: decoded.mode }, placed), ...(root === undefined ? {} : { unplaced: after.index.jobs[root]! }) }
}

/**
 * The option's robust record on the plan's `inputs`: every ranged job high together, then each alone, each
 * judged by lane K, a job that could not be placed included. Never a part of one: `{notWorkedOut: 'time'}`
 * when the next re-timing would not end by `until` (epoch ms), judged by the longest so far and before the
 * first by `estimateMs` (the sub-solve's own measured compile and check time); `{notWorkedOut: 'unplaced', job}`
 * when a re-timing left a job unplaced and lane K refused to name a crew without time for it;
 * `{notWorkedOut: 'refused', reason}` when lane K refused a re-timing for another reason; undefined only when a
 * re-timing cannot be made at all (the option's rows no longer read back on its plan).
 */
export const robustOf = (inputs: PlanInputs, option: Planned, judge: JudgeRetimed, until = Infinity, now: () => number = Date.now, estimateMs = 0): RobustField | undefined => {
  const jobs = rangedJobs(inputs, option.rows)
  // Nothing ranged: re-timing changes nothing, and the planned schedule is the one lane K validated.
  if (jobs.length === 0) return { allPessimistic: { holds: true }, single: [] }
  const planned = withExtraRules(inputs, option.variant.also)
  let longest = estimateMs
  let late = false
  const once = (high: readonly string[]): Retimed | undefined => {
    const started = now()
    if (started + longest > until) { late = true; return undefined }
    const retimed = retimedRows(planned, withExtraRules(atHigh(inputs, new Set(high)), option.variant.also), option)
    const judged = retimed === undefined ? undefined : judge({ inputs, variant: option.variant, planned: option.rows, retimed: retimed.rows, high })
    longest = Math.max(longest, now() - started)   // never below the first estimate
    // A job the re-timing could not place, for which lane K names no crew or tool without time: said so; any
    // other refusal by lane K, with lane K's reason. Never left out.
    if (judged?.ok === false && retimed?.unplaced !== undefined) unplaced ??= retimed.unplaced
    else if (judged?.ok === false) refused ??= judged.problems.join(' ').slice(0, 600)
    if (judged?.ok !== true) return undefined
    // A re-timing that holds keeps lane K's spans against their limits, as given (V12).
    return judged.outcome.holds && judged.spans !== undefined ? { ...judged.outcome, spans: judged.spans.map(span => ({ ...span })) } : judged.outcome
  }
  let unplaced: string | undefined
  let refused: string | undefined
  const notWorkedOut = (): RobustField | undefined => (late ? { notWorkedOut: 'time' } : unplaced !== undefined ? { notWorkedOut: 'unplaced', job: unplaced }
    : refused !== undefined && refused.trim() !== '' ? { notWorkedOut: 'refused', reason: refused.trim() } : undefined)
  const allPessimistic = once(jobs)
  if (allPessimistic === undefined) return notWorkedOut()
  const single: Array<Robust['single'][number]> = []
  for (const job of jobs) {
    const outcome = once([job])
    if (outcome === undefined) return notWorkedOut()
    single.push({ job, outcome })
  }
  return { allPessimistic, single }
}
