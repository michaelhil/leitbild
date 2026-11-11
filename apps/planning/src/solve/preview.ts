// Preview re-timing (planning.plan.edit with preview): the option's own schedule repaired on the edited
// inputs, judged by lane K's checker, and a lock judged against the saved plan. Pure: the solver child runs it
// (pool.ts), so the service keeps none of its memory; the service validates what comes back (wire.ts).
import { checkPlan, type CheckRow } from '../check/check.ts'
import { planningError } from '../errors.ts'
import type { Plan, PlanInputs } from '../plan/schema.ts'
import { nameOf } from '../plan/summary.ts'
import { compile, type CompileIndex } from './compile.ts'
import { dateSchedule, undate, type DatedRow } from './date.ts'
import { finishOf, nearestFit, prepare, repair, type Prepared } from './decode.ts'
import { totalFloat, withFloat } from './float.ts'
import type { Schedule } from './problem.ts'

type Option = NonNullable<Plan['options']>['options'][number]
export interface PreviewViolation { readonly code: string; readonly about: readonly string[]; readonly words?: string }
export interface PreviewResult {
  readonly rows: readonly DatedRow[]
  readonly violations: readonly PreviewViolation[]
  readonly nearestAllowed?: { readonly job: string; readonly at: string }
  readonly lockFindings?: readonly PreviewViolation[]
}

/** The option's schedule back on the compiled grid (date.ts `undate`); `edited` for a preview. */
export const scheduleOf = (prep: Prepared, index: CompileIndex, option: Option, edited = false): Schedule => {
  const found = undate(prep, index, option.rows, edited)
  if (found.ok) return found.schedule
  throw planningError(409, 'option_stale', found.reason === 'no-row' ? `The option has no row for ${found.job}; generate again` : `The option's row for ${found.job} no longer fits the plan; generate again`, { about: [found.job] })
}

export const compiled = (inputs: PlanInputs, option: Option) => {
  const result = compile(inputs, { methods: option.variant.methods, buy: option.variant.purchases })
  if (!result.ok) throw planningError(409, 'option_stale', 'The plan no longer compiles for this option; generate again', { about: [option.key] })
  return { ...result, prep: prepare(result.problem) }
}

/**
 * A lock judged against the SAVED plan (walk 2, R2-5): every other job at its saved option row, never where
 * a preview moved it. `findings` are lane K's on the saved rows with only the locked job at its lock time, so
 * their words match the plan on screen; `nearest` is the start nearest the lock where the job fits there
 * (links both ways, calendar, window, crews), confirmed by lane K on the saved rows with only that job moved.
 */
const lockAgainstSaved = (inputs: PlanInputs, option: Option, index: CompileIndex, prep: Prepared, saved: Schedule) => {
  const job = inputs.jobs.find(entry => entry.lock !== undefined && option.rows.some(row => row.job === entry.key && Date.parse(row.start) !== Date.parse(entry.lock!.start)))
  const a = job === undefined ? -1 : index.jobs.indexOf(job.key)
  const fixed = a < 0 ? undefined : prep.problem.activities[a]!.fixed
  if (job === undefined || fixed === undefined) return undefined
  const rowsWith = (t: number, mode: number): readonly CheckRow[] | undefined => {
    if (finishOf(prep, a, mode, t) < 0) return undefined
    const start = Int32Array.from(saved.start), modes = Int32Array.from(saved.mode)
    start[a] = t; modes[a] = mode
    const moved = dateSchedule(prep, index, { start, mode: modes }).find(row => row.job === job.key)!
    return option.rows.map(row => (row.job === job.key ? moved : row))
  }
  // Judged on every violation the moved job brings that the saved plan does not have (adversary recheck 3):
  // a span-limit or keep-in-service finding names only its rule and group, never the job, yet the move
  // causes it. A finding that names the job is always the job's own.
  const free = { ...inputs, jobs: inputs.jobs.map(entry => (entry.key === job.key ? (({ lock: _lock, ...rest }) => rest)(entry) : entry)) }
  const identity = (violation: { readonly code: string; readonly about: readonly string[] }) => `${violation.code}\u0000${violation.about.join('\u0000')}`
  const before = new Set(checkPlan(free, option.variant, option.rows).violations.filter(violation => !violation.about.includes(job.key)).map(identity))
  const brought = (violation: { readonly code: string; readonly about: readonly string[] }) => violation.about.includes(job.key) || !before.has(identity(violation))
  const atLock = rowsWith(fixed.start, fixed.mode)
  const findings = atLock === undefined ? [] : checkPlan(inputs, option.variant, atLock).violations.filter(brought).map(violation => ({ code: violation.code, about: violation.about, words: violation.words }))
  if (findings.length === 0) return { job: job.key, findings }
  // Without the lock: the nearest start where the job brings nothing new against the saved plan.
  const nearest = nearestFit(prep, saved, a, fixed.start, t => { const rows = rowsWith(t, saved.mode[a]!); return rows !== undefined && !checkPlan(free, option.variant, rows).violations.some(brought) })
  return { job: job.key, findings, ...(nearest < 0 ? {} : { nearest: new Date(index.origin + nearest * index.slotMs).toISOString() }) }
}

/** The preview of `option` on the (edited) `inputs`. Refusals (the option no longer fits) are planning errors. */
export const previewOption = (inputs: PlanInputs, option: Option): PreviewResult => {
  // Repair from the option's own dated schedule: with no edit it comes back exactly; after an edit only
  // the jobs it forces, and what they push, move.
  const { index, prep } = compiled(inputs, option)
  const saved = scheduleOf(prep, index, option, true)
  const { decoded } = repair(prep, saved)
  const lost = decoded.finish.findIndex((finish, a) => index.jobs[a] !== null && finish >= prep.H)
  if (lost >= 0) throw planningError(409, 'option_stale', `After this edit ${nameOf(inputs, index.jobs[lost]!)} has no time left in the plan's horizon; generate again`, { about: [index.jobs[lost]!] })
  const schedule = { start: decoded.start, mode: decoded.mode }
  // A preview may show an edit that breaks a limit in every schedule (a test lengthened past the span
  // limit), with no repair penalty: float is measured as for an overrun, which is the same on a schedule
  // that keeps every limit; the check names the break.
  const rows = withFloat(dateSchedule(prep, index, schedule), totalFloat(prep, index, schedule, true), index)
  const check = checkPlan(inputs, option.variant, rows)
  const lock = lockAgainstSaved(inputs, option, index, prep, saved)
  const result = {
    rows,
    violations: check.violations.map(violation => ({ code: violation.code, about: violation.about, words: violation.words })),
    ...(lock === undefined ? {} : { lockFindings: lock.findings, ...(lock.nearest === undefined ? {} : { nearestAllowed: { job: lock.job, at: lock.nearest } }) }),
  }
  return result
}
