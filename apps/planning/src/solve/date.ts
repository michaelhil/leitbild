// Slots back to instants: a schedule becomes dated rows with the resource use of every worked slot.
// The checker recomputes worked slots itself and requires `uses` to match them exactly (A3).
import type { z } from 'zod'
import type { datedRowSchema } from '../plan/schema.ts'
import type { CompileIndex } from './compile.ts'
import { applies, finishOf, workedSlots, type Prepared } from './decode.ts'
import type { Schedule } from './problem.ts'

export type DatedRow = z.infer<typeof datedRowSchema>
export type UndatedFloat = Omit<DatedRow, 'float'>

export const slotInstant = (index: Pick<CompileIndex, 'origin' | 'slotMs'>, slot: number): string => new Date(index.origin + slot * index.slotMs).toISOString()

/** Rows for every planned job (method cost carriers are not jobs), in activity order; `only` leaves the others out. */
export const dateSchedule = (prep: Prepared, index: CompileIndex, schedule: Schedule, only: (activity: number) => boolean = () => true): UndatedFloat[] => {
  const { problem } = prep
  const rows: UndatedFloat[] = []
  problem.activities.forEach((activity, a) => {
    const job = index.jobs[a]
    if (job === null || job === undefined || !only(a)) return
    const m = schedule.mode[a]!, start = schedule.start[a]!
    const finish = finishOf(prep, a, m, start)
    if (finish < 0) throw new RangeError(`${activity.id} cannot start at slot ${start} in mode ${m}`)
    const slots = workedSlots(prep, a, m, start)
    const uses: DatedRow['uses'] = []
    for (const demand of activity.modes[m]!.demands) {
      const owner = index.slotPurchase[demand.resource]!
      let from = -1, last = -1, purchase = -1
      const flush = (): void => {
        if (from < 0) return
        for (let unit = 0; unit < demand.amount; unit++) {
          uses.push({ resource: index.resources[demand.resource]!, from: slotInstant(index, from), to: slotInstant(index, last + 1), ...(purchase >= 0 ? { purchase: index.purchases[purchase]!.key } : {}) })
        }
        from = -1
      }
      for (let q = 0; q < slots.length; q++) {
        const x = slots[q]!
        if (!applies(prep, demand.when, x)) continue
        if (from >= 0 && (x !== last + 1 || owner[x] !== purchase)) flush()
        if (from < 0) { from = x; purchase = owner[x]! }
        last = x
      }
      flush()
    }
    if (uses.length > 64) throw new RangeError(`${job} needs ${uses.length} resource uses; a row holds 64`)
    rows.push({ job, start: slotInstant(index, start), finish: slotInstant(index, finish), uses })
  })
  return rows
}

/**
 * `crews` (only `edited`): the row's crews and tools serve no way of doing the job on these inputs, which the
 * edit changed (what the job needs, or who may do it); the row cannot be re-timed, only planned again.
 */
export type Undated = { readonly ok: true; readonly schedule: Schedule } | { readonly ok: false; readonly job: string; readonly reason: 'no-row' | 'no-fit' | 'crews' }

/**
 * Dated rows back on a compiled grid: each row's start slot and the mode its uses match (the inverse of
 * dateSchedule; mode numbers depend on the compile, so they are found again). `edited` (preview): the
 * inputs may have changed since the rows, so a row's finish need not match (an estimate changed), and a job
 * without a row is new: start -1, its first mode.
 */
export const undate = (prep: Prepared, index: CompileIndex, rows: ReadonlyArray<Pick<DatedRow, 'job' | 'start' | 'finish' | 'uses'>>, edited = false): Undated => {
  const n = prep.problem.activities.length
  const start = new Int32Array(n), mode = new Int32Array(n)
  const byJob = new Map(rows.map(row => [row.job, row] as const))
  for (let a = 0; a < n; a += 1) {
    const job = index.jobs[a]
    if (job === null || job === undefined) continue
    const row = byJob.get(job)
    if (row === undefined && edited) { start[a] = -1; continue }
    if (row === undefined) return { ok: false, job, reason: 'no-row' }
    const s = (Date.parse(row.start) - index.origin) / index.slotMs, f = (Date.parse(row.finish) - index.origin) / index.slotMs
    const used = new Set(row.uses.map(use => use.resource))
    const modes = prep.problem.activities[a]!.modes
    const serves = (k: number) => modes[k]!.demands.every(demand => used.has(index.resources[demand.resource]!))
    const fits = (k: number) => Number.isInteger(s) && finishOf(prep, a, k, s) === f
    // After an edit the row's finish may no longer match (an estimate changed), and another mode can match it
    // by chance (bought time making up the longer work). The mode is read from the row itself: the same crews
    // and tools, and on each need bought time exactly when the row used some on that need's crews or tools, as
    // the re-timing reads it (crew overtime with the crane in its own hours is not the crane's extra day).
    const boughtOn = (resources: readonly string[]) => row.uses.some(use => use.purchase !== undefined && resources.includes(use.resource))
    const sameTime = (k: number) => index.modes[a]![k]!.needs.every(need => need.purchased === boughtOn(need.resources))
    const sameCrews = (k: number) => { const own = new Set(modes[k]!.demands.map(demand => index.resources[demand.resource]!)); return own.size === used.size && [...used].every(key => own.has(key)) }
    const m = !edited ? modes.findIndex((_, k) => fits(k) && serves(k))
      : [(k: number) => sameCrews(k) && sameTime(k) && fits(k), (k: number) => sameCrews(k) && sameTime(k), (k: number) => sameCrews(k) && fits(k), sameCrews, (k: number) => serves(k) && fits(k), serves]
        .map(test => modes.findIndex((_, k) => test(k))).find(k => k >= 0) ?? -1
    if (!Number.isInteger(s) || m < 0) return { ok: false, job, reason: edited && Number.isInteger(s) ? 'crews' : 'no-fit' }
    start[a] = s
    mode[a] = m
  }
  return { ok: true, schedule: { start, mode } }
}
