// A refusal in the preview's own words (walk 4, R4-2): a due time no plan can meet says when the job can
// finish at the earliest and how far past its due time, with the rule, never a solver word ("release",
// "slot", "mode"). The earliest finish is lane K's own propagation, on the plan without that due rule.
import { prepare, type CheckVariant } from '../check/check.ts'
import { propagate, worldsOf } from '../check/propagate.ts'
import type { PlanInputs } from './schema.ts'
import { decimal, nameOf, timeWords } from './summary.ts'

/**
 * "'Deliver food' finishes Thu 11:45 at the earliest, 1.25 h after it is due at Thu 10:30 (the due-time rule
 * 'Food at the south shelter by 10:30')", or undefined when the job has no due rule it misses. Over the
 * variant's optional rebookings the least earliest finish is used, so the hours are never overstated.
 */
export const dueTimeWords = (inputs: PlanInputs, variant: CheckVariant, job: string): string | undefined => {
  const rules = inputs.rules.filter(rule => rule.kind === 'due' && rule.job === job)
  const rule = rules[0]
  if (rule === undefined || rule.kind !== 'due') return undefined
  const prepared = prepare({ ...inputs, rules: inputs.rules.filter(entry => !rules.includes(entry)) }, variant)
  if (!prepared.ok) return undefined
  const context = prepared.context
  let earliest = Infinity
  for (const world of worldsOf(context)) {
    const timed = propagate(context, world)
    if (!timed.ok) continue
    const window = timed.windows.get(job)
    if (window === undefined) continue
    const finish = window.finishOf(window.es)
    if (finish >= 0) earliest = Math.min(earliest, finish)
  }
  if (!Number.isFinite(earliest)) return undefined
  const finishMs = context.windowStart + earliest * context.grid.slotMs
  const lateHours = (finishMs - Date.parse(rule.finishBy)) / 3_600_000
  if (!(lateHours > 0)) return undefined
  const zone = inputs.settings.timeZone
  return `'${nameOf(inputs, job)}' finishes ${timeWords(new Date(finishMs).toISOString(), zone)} at the earliest, ${decimal(lateHours)} h after it is due at ${timeWords(rule.finishBy, zone)} (the due-time rule '${rule.words}').`
}
