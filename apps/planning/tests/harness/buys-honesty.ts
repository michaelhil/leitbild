// "What overtime buys" honesty harness (design §4.1, C7; adversary P2), the test-side guard: no difference
// between rungs is ever worded stronger than its two ends' proofs allow. It reads a `read buys` section (every
// page's items) and the stored plan. Production derives each end from stored figures only (check/buys.ts
// rungStanding); this harness derives it again from lane K's checker itself (`checkedStanding`: the option
// re-checked on the current revision and formulation, a refusal's certificate re-verified, a "proven optimal"
// bound re-derived, the figures measured on the rows), under the same rule for a proven end, and flags:
// - a stored standing that claims more than the checked one, or other figures ('stored');
// - a row whose word is not true of the checked ends and figures, whose stated ends claim more than they,
//   or whose differences are not the checker's own; a rung whose `bought` is not ('word', 'ends', 'figure',
//   'bought'), and a rung naming an option it may not ('rung').
import type { z } from 'zod'
import type { sectionDataSchemas } from '../../src/api/contract.ts'
import { outageGoal, rungStanding, wordStands, type BuysEnd, type RungStanding } from '../../src/check/buys.ts'
import type { CheckResult } from '../../src/check/check.ts'
import type { Metric } from '../../src/check/metrics.ts'
import { recheckOption } from '../../src/check/recheck.ts'
import { goalResolution, type Plan } from '../../src/plan/schema.ts'

export type BuysItem = z.infer<typeof sectionDataSchemas.buys>['items'][number]
type Option = NonNullable<Plan['options']>['options'][number]

const unitHours: Readonly<Record<string, number>> = { s: 1 / 3_600, min: 1 / 60, h: 1, d: 24 }

const longestOutage = (check: Pick<CheckResult, 'metrics'>, groups: readonly string[]): number =>
  Math.max(0, ...groups.map(group => check.metrics.find(metric => metric.id === `span:${group}`)?.value ?? 0))

/**
 * Where one stored option stands as a rung, by lane K's checker itself, under check/buys.ts's rule for a
 * proven end, with the figures measured on its rows. No option: still to solve, so unsolved.
 */
export const checkedStanding = (plan: Plan, option: Option | undefined, formulation: string): RungStanding => {
  if (option === undefined) return { end: 'unsolved', bought: [], stale: false, why: 'no stored option' }
  const recheck = recheckOption(plan, option, formulation)
  const stale = recheck.reasons.includes('inputs-changed') || recheck.reasons.includes('formulation-changed')
  if (!recheck.usable) return { end: 'unsolved', bought: [], stale, why: `not usable here: ${recheck.reasons.join(', ')}` }
  const status = option.status
  if (status.word === 'proven infeasible') return { end: 'refused', bought: [], stale, why: 'refused with a certificate lane K re-verifies' }
  if (status.word !== 'validated feasible') return { end: 'unsolved', bought: [], stale, why: status.word }
  const check = recheck.check
  const { index, goal, groups } = outageGoal(plan)
  const outage = longestOutage(check, groups)
  const cost = check.metrics.find(metric => metric.id === 'extra-cost')?.value ?? 0
  const bought = check.metrics.filter(metric => metric.id.startsWith('bought:'))
  const solved = { outage, cost, bought, stale }
  const line = index < 0 ? undefined : status.goals[index]
  if (goal === undefined || line === undefined || line.word !== 'proven optimal' || recheck.bestFoundGoals.includes(index)) return { end: 'found', ...solved, why: 'no confirmed proof on the outage goal' }
  // the proof fixes the outage only on the checker's own figure, for one group, above its threshold
  const unit = line.unit
  const resolution = goalResolution(unit, plan.inputs.settings.grid) ?? 0
  const threshold = goal.threshold === undefined ? 0 : goal.threshold.value * (unitHours[goal.threshold.unit] ?? 1) / (unitHours[unit] ?? 1)
  const spans = check.goals[index]
  const figure = spans === undefined || spans.metric !== 'span-over' ? undefined : spans.spans.reduce((sum, span) => sum + Math.max(0, span.value - threshold), 0)
  if (figure === undefined || !(Math.abs(figure - line.value) < resolution / 2)) return { end: 'found', ...solved, why: 'the proven value is not the checker\'s figure on these rows' }
  if (groups.length !== 1) return { end: 'found', ...solved, why: 'the outage goal sums several groups, so its proof fixes no one outage' }
  if (threshold > 0 && line.value < resolution / 2) return { end: 'found', ...solved, why: 'proven at 0 past the threshold: the outage itself is not fixed' }
  return { end: 'proven', ...solved, why: 'proven on the outage, which the proof fixes' }
}

const solvedEnd = (end: BuysEnd): boolean => end === 'proven' || end === 'found'

/** A stated end claims no more than the derived one: proven needs proven, found a solved end, refused a refusal. */
const endHolds = (stated: BuysEnd, derived: BuysEnd): boolean =>
  stated === 'unsolved' || stated === derived || (stated === 'found' && derived === 'proven')

export interface BuysFinding {
  readonly kind: 'rung' | 'stored' | 'bought' | 'ends' | 'word' | 'figure'
  /** The rung number, or "from-to" for a row. */
  readonly about: string
  readonly words: string
}

const sameMetrics = (left: readonly Metric[], right: readonly Metric[]): boolean => {
  const key = (metrics: readonly Metric[]) => [...metrics].sort((a, b) => a.id.localeCompare(b.id))
  const a = key(left), b = key(right)
  return a.length === b.length && a.every((metric, index) => metric.id === b[index]!.id && metric.unit === b[index]!.unit && Math.abs(metric.value - b[index]!.value) < 1e-9)
}

/** Every finding on a `read buys` section against the stored plan; none means every word stands. */
export const buysHonesty = (plan: Plan, items: readonly BuysItem[], formulation: string): BuysFinding[] => {
  const findings: BuysFinding[] = []
  const standings = new Map<number, RungStanding>()
  for (const item of items) {
    if (!('rung' in item)) continue
    const rung = item.rung
    const about = String(rung.rung)
    if (standings.has(rung.rung)) findings.push({ kind: 'rung', about, words: `Rung ${about} is listed twice.` })
    const option = rung.option === undefined ? undefined : plan.options?.options.find(entry => entry.key === rung.option)
    if (rung.option !== undefined && option === undefined) {
      findings.push({ kind: 'rung', about, words: `Rung ${about} names an option '${rung.option}' the plan does not store.` })
      standings.set(rung.rung, checkedStanding(plan, undefined, formulation))
      continue
    }
    if (option !== undefined && (option.variant.lead !== undefined || option.variant.also !== undefined)) findings.push({ kind: 'rung', about, words: `Rung ${about} names a what-if with a lead or an extra rule, which is never a rung.` })
    const standing = checkedStanding(plan, option, formulation)
    standings.set(rung.rung, standing)
    // what production derives from stored figures alone must claim no more than the checker finds, with its figures
    const stored = rungStanding(plan, option, formulation)
    const near = (left: number | undefined, right: number | undefined) => left === right || (left !== undefined && right !== undefined && Math.abs(left - right) < 1e-6)
    if (!endHolds(stored.end, standing.end) || (solvedEnd(stored.end) && solvedEnd(standing.end) && !(near(stored.outage, standing.outage) && near(stored.cost, standing.cost) && sameMetrics(stored.bought, standing.bought)))) {
      findings.push({ kind: 'stored', about, words: `Rung ${about} stands ${stored.end} on its stored figures (${stored.why}), ${stored.outage ?? 'no'} h and ${stored.cost ?? 'no'} in cost; the checker finds it ${standing.end} (${standing.why}), ${standing.outage ?? 'no'} h and ${standing.cost ?? 'no'}.` })
    }
    if (option !== undefined && standing.stale) {
      findings.push({ kind: 'rung', about, words: `Rung ${about} names option '${option.key}', which is ${standing.why}; a rung names only a fresh option.` })
      continue
    }
    if (!sameMetrics(rung.bought, standing.bought)) findings.push({ kind: 'bought', about, words: `Rung ${about} states bought time ${JSON.stringify(rung.bought)}; the checker counts ${JSON.stringify(standing.bought)}.` })
  }
  for (const item of items) {
    if (!('row' in item)) continue
    const row = item.row
    const about = `${row.from}-${row.to}`
    const from = standings.get(row.from), to = standings.get(row.to)
    if (from === undefined || to === undefined) { findings.push({ kind: 'rung', about, words: `Row ${about} compares a rung the section does not list.` }); continue }
    const derived = { from: from.end, to: to.end }
    for (const side of ['from', 'to'] as const) {
      if (!endHolds(row.ends[side], derived[side])) findings.push({ kind: 'ends', about, words: `Row ${about} states its ${side} end ${row.ends[side]}; lane K finds it ${derived[side]} (${(side === 'from' ? from : to).why}).` })
    }
    const both = solvedEnd(from.end) && solvedEnd(to.end)
    const outage = both ? to.outage! - from.outage! : undefined
    const cost = both ? to.cost! - from.cost! : undefined
    if (!wordStands(row.word, derived, outage)) findings.push({ kind: 'word', about, words: `Row ${about} reads "${row.word}", which is not true of a ${derived.from} lower rung and a ${derived.to} higher one${outage === undefined ? '' : ` with ${outage} h of outage between them`}.` })
    const figuresHold = both
      ? row.outage !== undefined && row.cost !== undefined && Math.abs(row.outage - outage!) < 1e-6 && Math.abs(row.cost - cost!) < 1e-6
      : row.outage === undefined && row.cost === undefined
    if (!figuresHold) findings.push({ kind: 'figure', about, words: `Row ${about} gives ${row.outage ?? 'no'} h and ${row.cost ?? 'no'} in cost; the checker's own figures are ${outage ?? 'none'} h and ${cost ?? 'none'}.` })
  }
  return findings
}

