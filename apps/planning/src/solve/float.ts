// Total float of the chosen schedule (G1 and the goals r2 addendum): the working hours of a job's own
// calendar between its scheduled start and its latest start. The latest start comes from a backward
// pass from the window end over every link (planner links, bracketing, tag-before-test, support order;
// FS lags in clock time, SS and FF lags in working progress as the decoder places them)
// and over each span limit as a max-lag: a closer must finish within the limit of the span's scheduled
// first-out start. That start is held where it is, so a cooling-chain job never shows slack the span
// rule forbids (an opener's float is therefore never overstated). A due rule ends a job's window early
// and is named when it binds. Crews and outage counts are not in it.
import type { CompileIndex } from './compile.ts'
import type { DatedRow } from './date.ts'
import type { Prepared } from './decode.ts'
import type { Schedule } from './problem.ts'

export type Float = DatedRow['float']
type Limit = Float['limitedBy']

/** Latest start in mode m with finish <= hiF and start <= hiS; -1 when none. */
const latestStart = (prep: Prepared, a: number, m: number, hiS: number, hiF: number): number => {
  const mode = prep.problem.activities[a]!.modes[m]!
  hiF = Math.min(hiF, prep.H)
  if (mode.work === 0) return Math.min(hiS, hiF)
  const k = prep.cal[mode.calendar]!
  if (mode.continuous) {
    for (let t = Math.min(hiS, hiF - mode.work, prep.H - 1); t >= 0; t--) if (k.run[t]! >= mode.work) return t
    return -1
  }
  if (hiF <= 0 || hiS < 0) return -1
  const p = Math.min(k.prefix[hiF]! - mode.work, k.prefix[Math.min(prep.H, hiS + 1)]! - 1)
  return p < 0 ? -1 : k.list[p]!
}

/** The latest start of a (mode m) that has done `lag` < work of its working time by slot `by`. */
const ssStartBound = (prep: Prepared, a: number, m: number, by: number, lag: number): number => {
  const mode = prep.problem.activities[a]!.modes[m]!
  if (lag <= 0) return by
  if (mode.continuous) return by - lag
  const k = prep.cal[mode.calendar]!
  const p = k.prefix[Math.max(0, Math.min(prep.H, by))]! - lag
  return p < 0 ? -1 : k.list[p]!
}

/** Where the last `lag` working slots of a (mode m, started at t) begin. */
const lastSlotsStart = (prep: Prepared, a: number, m: number, t: number, lag: number): number => {
  const mode = prep.problem.activities[a]!.modes[m]!
  if (lag >= mode.work) return t
  if (mode.continuous) return t + mode.work - lag
  const k = prep.cal[mode.calendar]!
  return k.list[k.pos[t]! + mode.work - lag]!
}

const finishAt = (prep: Prepared, a: number, m: number, t: number): number => {
  const mode = prep.problem.activities[a]!.modes[m]!
  if (mode.work === 0) return t
  if (mode.continuous) return t + mode.work
  const k = prep.cal[mode.calendar]!
  return k.list[k.pos[t]! + mode.work - 1]! + 1
}

/**
 * Float per activity of `schedule`, in working hours, with the limit that binds. Throws on a negative
 * float: on a schedule that meets the links, the window and the span limits that cannot happen.
 * `overrun` (a preview after an edit that breaks a limit): a job already past its limit has no float (0 h,
 * that limit binding), and its predecessors' float is measured to its planned start; the check names the
 * overrun.
 */
export const totalFloat = (prep: Prepared, index: CompileIndex, schedule: Schedule, overrun = false): Float[] => {
  const { problem, n } = prep
  const slotHours = index.slotMs / 3_600_000
  const ls = new Int32Array(n), lf = new Int32Array(n)
  const sBy: Limit[] = new Array(n), fBy: Limit[] = new Array(n)
  const windowEnd: Limit = { kind: 'window-end' }
  const spanStart = problem.spans.map((_, s) => Math.min(...prep.spanOpeners[s]!.map(o => schedule.start[o]!)))
  for (let i = n - 1; i >= 0; i--) {
    const a = prep.topo[i]!
    const m = schedule.mode[a]!
    let hiF = problem.activities[a]!.deadline, hiS = prep.H
    const dueRule = index.dueRules[a]
    let byF: Limit = dueRule === undefined ? windowEnd : { kind: 'due', rule: dueRule }, byS: Limit = windowEnd
    for (const s of prep.closesSpans[a]!) {
      const limit = problem.spans[s]!.limit
      const rule = index.spans[s]!.rule
      if (limit === undefined || rule === undefined) continue
      if (spanStart[s]! + limit <= hiF) { hiF = spanStart[s]! + limit; byF = { kind: 'span-limit', rule } }
    }
    const mode = problem.activities[a]!.modes[m]!
    for (const l of prep.succs[a]!) {
      if (l.type === 'FS') { if (ls[l.to]! - l.min < hiF) { hiF = ls[l.to]! - l.min; byF = sBy[l.to]! } continue }
      if (l.type === 'SS') {
        // This job must have done `lag` of its working time by the successor's latest start.
        if (l.min >= mode.work) { if (ls[l.to]! < hiF) { hiF = ls[l.to]!; byF = sBy[l.to]! } continue }
        const bound = ssStartBound(prep, a, m, ls[l.to]!, l.min)
        if (bound < hiS) { hiS = bound; byS = sBy[l.to]! }
        continue
      }
      // FF: finish no later than the successor's latest finish, leaving `lag` of its work after it.
      const bound = Math.min(lf[l.to]!, l.min > 0 ? lastSlotsStart(prep, l.to, schedule.mode[l.to]!, ls[l.to]!, l.min) : lf[l.to]!)
      if (bound < hiF) { hiF = bound; byF = fBy[l.to]! }
    }
    const latest = latestStart(prep, a, m, hiS, hiF)
    if (latest < 0 && !overrun) throw new RangeError(`${problem.activities[a]!.id} has no latest start inside its limits`)
    const t = overrun ? Math.max(latest, schedule.start[a]!) : latest
    ls[a] = t
    lf[a] = finishAt(prep, a, m, t)
    // The start's limit is whichever bound stops it: a successor's start (SS) or the finish bound.
    const viaStart = hiS < prep.H && latestStart(prep, a, m, prep.H, hiF) > t
    sBy[a] = viaStart ? byS : byF
    fBy[a] = sBy[a]
  }
  return problem.activities.map((activity, a) => {
    const m = schedule.mode[a]!, start = schedule.start[a]!
    if (ls[a]! < start) throw new RangeError(`${activity.id} has negative float: latest start ${ls[a]} before its start ${start}`)
    const mode = activity.modes[m]!
    const k = prep.cal[mode.calendar]!
    const slots = mode.work === 0 ? 0 : k.prefix[ls[a]!]! - k.prefix[start]!
    return { workingHours: slots * slotHours, limitedBy: sBy[a]! }
  })
}

/** Attaches float to dated rows (rows are in activity order, method cost carriers skipped). */
export const withFloat = (rows: ReadonlyArray<Omit<DatedRow, 'float'>>, floats: readonly Float[], index: CompileIndex): DatedRow[] => {
  const byJob = new Map(index.jobs.flatMap((job, a) => (job === null ? [] : [[job, floats[a]!] as const])))
  return rows.map(row => ({ ...row, float: byJob.get(row.job)! }))
}
