// "What overtime buys" (design §4.1, C7): the rungs of bought crew time, from plan data, and the rows
// between two adjacent rungs, from stored options only. Where each rung stands (proven, found, refused or
// unsolved) and its figures are lane K's own (check/buys.ts rungStanding, over stored figures): this
// module only words a row on the two ends it is given, and words nothing a standing does not support.
import type { z } from 'zod'
import type { buysRowSchema, buysRungSchema, sectionDataSchemas } from '../api/contract.ts'
import type { metricSchema, PlanInputs } from './schema.ts'

type Metric = z.infer<typeof metricSchema>
export type BuysRung = z.infer<typeof buysRungSchema>
export type BuysRow = z.infer<typeof buysRowSchema>
export type BuysItem = z.infer<typeof sectionDataSchemas.buys>['items'][number]
export type BuysEnd = BuysRow['ends']['from']
/** The higher rung's first cause of what sets the finish, for "proven: no gain". */
export type FinishCause = NonNullable<BuysRow['finish']>

/**
 * Where a rung's stored option stands, by lane K alone (check/buys.ts rungStanding, from stored figures): its
 * end, and when solved, its longest outage (h), extra cost and bought crew time, as the checker stored them.
 */
export interface Standing {
  readonly end: BuysEnd
  readonly outage?: number
  readonly cost?: number
  readonly bought: readonly Metric[]
}

/** Not ordered, past its order-by at the plan's now: compile drops it, so no rung can buy it. */
const lapsed = (inputs: PlanInputs, purchase: PlanInputs['purchases'][number]): boolean =>
  purchase.ordered === undefined && purchase.orderBy !== undefined && inputs.settings.dataDate !== null && Date.parse(inputs.settings.dataDate) > Date.parse(purchase.orderBy)

/**
 * The rungs offered, numbered from 0 with no gaps (api/contract.ts). Crew time is what "days only" removes: a
 * planner-allowed purchase on a crew that replaces nothing (solve/compile.ts), not yet ordered. Every other
 * allowed purchase (rebookings, tool days) and every ordered one is on every rung. Rung 1 adds the crew time
 * priced per person-hour, rung 2 all of it; with one price form only, rung 1 buys all of it. Each `buy` is
 * the list that rung's Generate sends, in the plan's order.
 */
export const rungsOf = (inputs: PlanInputs): Array<{ readonly rung: number; readonly buy: readonly string[] }> => {
  const crews = new Set(inputs.resources.filter(resource => resource.kind === 'crew').map(resource => resource.key))
  const usable = inputs.purchases.filter(purchase => !lapsed(inputs, purchase) && (purchase.allowed || purchase.ordered !== undefined))
  const time = usable.filter(purchase => purchase.ordered === undefined && crews.has(purchase.resource) && purchase.replaces.length === 0)
  const perHour = time.filter(purchase => purchase.price.perPersonHour !== undefined)
  const steps = [[], ...(perHour.length > 0 && perHour.length < time.length ? [perHour] : []), ...(time.length > 0 ? [time] : [])]
  return steps.map((step, rung) => ({ rung, buy: usable.filter(purchase => !time.includes(purchase) || step.includes(purchase)).map(purchase => purchase.key) }))
}

/** A rung with its stored option, fresh on the plan's revision and formulation, and that option's standing. */
export interface LadderRung {
  readonly rung: number
  readonly buy: readonly string[]
  readonly option?: { readonly key: string; readonly standing: Standing }
}
export interface Ladder {
  readonly rungs: readonly BuysRung[]
  /** `finishFrom`: the option whose cause of the finish a "proven: no gain" row still needs. */
  readonly rows: ReadonlyArray<{ readonly row: Omit<BuysRow, 'finish'>; readonly finishFrom?: string }>
}

const solved = (end: BuysEnd): boolean => end === 'proven' || end === 'found'
/** Within float noise of zero is zero; never -0. */
const exact = (value: number): number => (Math.abs(value) < 1e-9 ? 0 : value)

/** The row between two adjacent solved-on-this-revision rungs, or none when no word stands on their ends. */
const rowOf = (lower: Required<LadderRung>, upper: Required<LadderRung>): Ladder['rows'][number] | undefined => {
  const from = lower.option.standing, to = upper.option.standing
  const head = { from: lower.rung, to: upper.rung, ends: { from: from.end, to: to.end } }
  if (from.end === 'refused') {
    if (solved(to.end)) return { row: { ...head, word: 'makes it possible' } }
    return to.end === 'unsolved' ? { row: { ...head, word: 'not solved' } } : undefined   // two refused rungs: no word fits
  }
  if (from.end === 'unsolved' || to.end === 'unsolved') return { row: { ...head, word: 'not solved' } }
  if (!solved(to.end)) return undefined   // a solved rung below a refused one: no word fits
  // Both solved: the differences are the checker's own figures; without them no word is given.
  if (from.outage === undefined || from.cost === undefined || to.outage === undefined || to.cost === undefined) return undefined
  const outage = exact(to.outage - from.outage), cost = exact(to.cost - from.cost)
  const proven = from.end === 'proven' && to.end === 'proven'
  const word = outage < 0 ? (proven ? 'proven' : 'found') : outage === 0 && proven ? 'proven: no gain' : 'not found better'
  return { row: { ...head, word, outage, cost }, ...(word === 'proven: no gain' ? { finishFrom: upper.option.key } : {}) }
}

/** The rungs, each with its option and that option's bought time, and a row for each adjacent pair solved here. */
export const ladderOf = (rungs: readonly LadderRung[]): Ladder => ({
  rungs: rungs.map(rung => ({ rung: rung.rung, buy: [...rung.buy], ...(rung.option === undefined ? {} : { option: rung.option.key }), bought: [...(rung.option?.standing.bought ?? [])] })),
  rows: rungs.slice(1).flatMap((upper, index) => {
    const lower = rungs[index]!
    if (lower.option === undefined || upper.option === undefined) return []
    const row = rowOf(lower as Required<LadderRung>, upper as Required<LadderRung>)
    return row === undefined ? [] : [row]
  }),
})

/**
 * The section's items: every rung, then every row. A "proven: no gain" row names the higher rung's cause of
 * the finish (`finish`, by option key). Without that cause it is never dropped: it reads the weaker "not found
 * better", its higher end stated as found, so it claims no proof it cannot name (adversary review, finding 6).
 */
export const buysItems = (ladder: Ladder, finish: ReadonlyMap<string, FinishCause>): BuysItem[] => [
  ...ladder.rungs.map(rung => ({ rung })),
  ...ladder.rows.flatMap(({ row, finishFrom }) => {
    if (finishFrom === undefined) return [{ row }]
    const cause = finish.get(finishFrom)
    return [cause === undefined ? { row: { ...row, ends: { ...row.ends, to: 'found' as const }, word: 'not found better' as const } } : { row: { ...row, finish: cause } }]
  }),
]
