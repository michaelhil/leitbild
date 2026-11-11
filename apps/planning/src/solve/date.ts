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

/** Rows for every planned job (method cost carriers are not jobs), in activity order. */
export const dateSchedule = (prep: Prepared, index: CompileIndex, schedule: Schedule): UndatedFloat[] => {
  const { problem } = prep
  const rows: UndatedFloat[] = []
  problem.activities.forEach((activity, a) => {
    const job = index.jobs[a]
    if (job === null || job === undefined) return
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
