// "What limits us" in hours (walk 4, R4-1): what one more unit of the most limiting resource would allow.
// The option's own job order is decoded again, with no search, once as it is and once with one more unit of
// the resource. The second decode is an achievable plan; when lane K's checker passes it, the finish it
// gains over both the option and the same order without the extra unit is a sound "at least N h earlier".
// Pure: the solver child runs it (pool.ts), so the service keeps none of its memory.
import { checkPlan } from '../check/check.ts'
import type { Plan, PlanInputs } from '../plan/schema.ts'
import { compile } from './compile.ts'
import { withExtraRules } from './keys.ts'
import { dateSchedule } from './date.ts'
import { makeDecoder, precedenceOrder, prepare } from './decode.ts'
import { compiled, scheduleOf } from './preview.ts'

type Option = NonNullable<Plan['options']>['options'][number]
type About = { readonly kind: 'resource'; readonly key: string }
/** Both checked by lane K: a gain in hours, or no gain in this order. Not computed is no Limiting at all. */
export type Limiting = { readonly result: 'gain'; readonly about: About; readonly hoursEarlier: number } | { readonly result: 'no-gain'; readonly about: About }
/** What one more unit does: a gain, no gain (both checked by lane K), or unknown (not decoded or not passed). */
export type OneMore = { readonly kind: 'gain'; readonly hours: number } | { readonly kind: 'none' } | { readonly kind: 'unknown' }


/** The latest finish of a decoded schedule's jobs, as an instant (ms). */
const lastFinish = (rows: ReadonlyArray<{ readonly finish: string }>): number => Math.max(...rows.map(row => Date.parse(row.finish)))

/**
 * What one more unit of `resource` does in the option's own order: the hours it gains, no gain, or unknown
 * (the resource is not in the plan, a decode fails, or lane K's checker refuses the decoded plan).
 */
export const oneMoreUnit = (inputs: PlanInputs, option: Option, resource: string): OneMore => {
  const unknown: OneMore = { kind: 'unknown' }
  if (!inputs.resources.some(entry => entry.key === resource)) return unknown
  const { prep, index } = compiled(inputs, option)
  const saved = scheduleOf(prep, index, option)
  const position = new Int32Array(prep.n)
  prep.topo.forEach((a, i) => { position[a] = i })
  const order = precedenceOrder(prep, [...prep.topo].sort((x, y) => saved.start[x]! - saved.start[y]! || position[x]! - position[y]!))
  const plain = makeDecoder(prep).decode(order, saved.mode)
  if (plain.penalty > 0) return unknown
  const more: PlanInputs = { ...inputs, resources: inputs.resources.map(entry => (entry.key === resource ? { ...entry, count: entry.count + 1 } : entry)) }
  const again = compile(withExtraRules(more, option.variant.also), { methods: option.variant.methods, buy: option.variant.purchases })
  if (!again.ok || again.problem.activities.length !== prep.n) return unknown
  const prepMore = prepare(again.problem)
  if (again.problem.activities.some((activity, a) => activity.modes.length !== prep.problem.activities[a]!.modes.length)) return unknown
  const decoded = makeDecoder(prepMore).decode(order, saved.mode)
  if (decoded.penalty > 0) return unknown
  const rows = dateSchedule(prepMore, again.index, { start: decoded.start, mode: decoded.mode })
  if (!checkPlan(more, option.variant, rows).feasible) return unknown
  const before = Math.min(lastFinish(option.rows), lastFinish(dateSchedule(prep, index, { start: plain.start, mode: plain.mode })))
  const hours = (before - lastFinish(rows)) / 3_600_000
  return hours > 0 ? { kind: 'gain', hours } : { kind: 'none' }
}

/**
 * Of the candidate resources (tied as most limiting): the one whose extra unit gains most; else one checked
 * to gain nothing; else undefined, not computed (no candidate could be decoded and passed by lane K).
 */
export const limitingOf = (inputs: PlanInputs, option: Option, candidates: readonly string[]): Limiting | undefined => {
  let gain: Extract<Limiting, { result: 'gain' }> | undefined, none: Limiting | undefined
  for (const key of candidates) {
    const more = oneMoreUnit(inputs, option, key)
    if (more.kind === 'gain' && (gain === undefined || more.hours > gain.hoursEarlier)) gain = { result: 'gain', about: { kind: 'resource', key }, hoursEarlier: more.hours }
    if (more.kind === 'none') none ??= { result: 'no-gain', about: { kind: 'resource', key } }
  }
  return gain ?? none
}
