// "What overtime buys" (design §4.1, C7): the rungs of bought crew time, from plan data, and the rows
// between two adjacent rungs, from stored options only. Where each rung stands (proven, found, refused or
// unsolved) and its figures are lane K's own (check/buys.ts rungStanding, over stored figures): this
// module only words a row on the two ends it is given, and words nothing a standing does not support.
import type { z } from 'zod'
import type { buysRowSchema, buysRungSchema, sectionDataSchemas } from '../api/contract.ts'
import { ladderRungs } from '../solve/ladder.ts'
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

/**
 * The rungs offered, numbered from 0 with no gaps (api/contract.ts), each `buy` the list its Generate sends:
 * solve/ladder.ts's ladderRungs, the one rung definition (fix round F7).
 */
export const rungsOf = (inputs: PlanInputs): Array<{ readonly rung: number; readonly buy: readonly string[] }> =>
  ladderRungs(inputs).map(rung => ({ rung: rung.rung, buy: rung.buy }))

/** A rung with its stored option, fresh on the plan's revision and formulation, and that option's standing. */
export interface LadderRung {
  readonly rung: number
  readonly buy: readonly string[]
  readonly option?: { readonly key: string; readonly standing: Standing }
}
export interface Ladder {
  readonly rungs: readonly BuysRung[]
  /** `finishFrom`: the higher rung's option, whose cause of the finish a row of two solved rungs carries (G3). */
  readonly rows: ReadonlyArray<{ readonly row: Omit<BuysRow, 'finish'>; readonly finishFrom?: string }>
}

const solved = (end: BuysEnd): boolean => end === 'proven' || end === 'found'
/** Within float noise of zero is zero; never -0. */
const exact = (value: number): number => (Math.abs(value) < 1e-9 ? 0 : value)

/** The row between two adjacent solved-on-this-revision rungs, or none when no word stands on their ends. */
const rowOf = (lower: Required<LadderRung>, upper: Required<LadderRung>, methods: BuysRung['methods']): Ladder['rows'][number] | undefined => {
  const from = lower.option.standing, to = upper.option.standing
  const head = { methods: [...methods], from: lower.rung, to: upper.rung, ends: { from: from.end, to: to.end } }
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
  return { row: { ...head, word, outage, cost }, finishFrom: upper.option.key }
}

/** One method's ladder (U3): its rungs, solved for `methods`, each with its option and that option's bought time, and a row for each adjacent pair solved here. */
export const ladderOf = (rungs: readonly LadderRung[], methods: BuysRung['methods']): Ladder => ({
  rungs: rungs.map(rung => ({ rung: rung.rung, methods: [...methods], buy: [...rung.buy], ...(rung.option === undefined ? {} : { option: rung.option.key }), bought: [...(rung.option?.standing.bought ?? [])] })),
  rows: rungs.slice(1).flatMap((upper, index) => {
    const lower = rungs[index]!
    if (lower.option === undefined || upper.option === undefined) return []
    const row = rowOf(lower as Required<LadderRung>, upper as Required<LadderRung>, methods)
    return row === undefined ? [] : [row]
  }),
})

/**
 * The section's items: every rung, then every row. A row of two solved rungs names the higher rung's cause of
 * the finish (`finish`, by option key) when its chain names one (G3). "Proven: no gain" needs it: without it
 * that row is never dropped, it reads the weaker "not found better", its higher end stated as found, so it
 * claims no proof it cannot name (adversary review, finding 6).
 */
export const buysItems = (ladder: Ladder, finish: ReadonlyMap<string, FinishCause>): BuysItem[] => [
  ...ladder.rungs.map(rung => ({ rung })),
  ...ladder.rows.flatMap(({ row, finishFrom }) => {
    if (finishFrom === undefined) return [{ row }]
    const cause = finish.get(finishFrom)
    if (cause !== undefined) return [{ row: { ...row, finish: cause } }]
    return [row.word === 'proven: no gain' ? { row: { ...row, ends: { ...row.ends, to: 'found' as const }, word: 'not found better' as const } } : { row }]
  }),
]
