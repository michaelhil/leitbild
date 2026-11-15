// "Why recommended" (design §4.2, §7 WhyRecommended, T11): the plan's goal order in words, the goal on which
// the recommended option's ranking key first differs from the option it is compared with, the trade in each
// goal's unit, the method caveats the ranking does not price, and what its status says about the outage goal.
// Built from stored, checked options only (the caller passes only options fresh on the plan's revision and
// formulation); keys come from rank.ts exactly as Generate ranks. Prose is generated here, never stored.
import { byteLength, clip, goalName, goalUnit, nameOf, names, valueWords } from './summary.ts'
import { goalResolution, type BoundCertificate, type Plan, type PlanInputs } from './schema.ts'
import { resultLimitBytes } from '../api/contract.ts'
import { rawOf } from '../solve/generate.ts'
import { goalKeys } from '../solve/rank.ts'

type Option = NonNullable<Plan['options']>['options'][number]
type Feasible = Extract<Option['status'], { word: 'validated feasible' }>
type GoalLine = Feasible['goals'][number]

/** Floating noise must not make two equal keys differ (rank.ts uses the same). */
const EPSILON = 1e-9

export const listWords = (items: readonly string[]): string => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
const capital = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/** Lines within an explain result's 4 KB (with no items): later lines go first. */
export const fitLines = (lines: readonly string[]): string[] => {
  const kept = lines.slice(0, 20).map(line => clip(line, 240))
  while (kept.length > 1 && byteLength({ lines: kept, items: [] }) > resultLimitBytes - 64) kept.pop()
  return kept
}

const keysOf = (inputs: PlanInputs, option: Option): number[] =>
  goalKeys(rawOf(option, inputs.goals.length), inputs.goals.map(goal => ({ threshold: goal.threshold?.value ?? 0, step: goal.tolerance.value })))
const differ = (left: number, right: number): boolean => Math.abs(left - right) > EPSILON
const goalsOf = (option: Option): readonly GoalLine[] => option.status.word === 'validated feasible' ? option.status.goals : []
const ranked = (option: Option): boolean => option.status.word === 'validated feasible' && option.variant.lead === undefined

/** What a better or worse value on goal `k` is called: "less extra cost", "fewer hours out of service". */
const betterWords = (inputs: PlanInputs, k: number, better: boolean): string => {
  const metric = inputs.goals[k]?.metric
  if (metric === 'finish') return `${better ? 'earlier' : 'later'} finish`
  return `${better ? metric === 'unavailable-hours' ? 'fewer' : 'less' : 'more'} ${goalName(inputs, k, true)}`
}

/** A bound's derivation in planner words, for a proof that names it. */
const certificateWords = (inputs: PlanInputs, certificate: BoundCertificate, unit: string): string => {
  switch (certificate.kind) {
    case 'zero': return `nothing is below 0 ${unit}`
    case 'least-span': return listWords(certificate.spans.map(span => `${nameOf(inputs, span.group)} is out at least ${valueWords(span.hours, 'h')}`))
    case 'least-outage': return 'each item is out at least from its latest first tag-out to its earliest last test'
    case 'earliest-finish': return `${names(inputs, certificate.jobs.map(job => job.job), 2)} cannot finish earlier`
    case 'crew-energy': return `${nameOf(inputs, certificate.resource)} needs ${valueWords(certificate.requiredHours, 'h')} of work first`
    case 'kept-free': return `'${nameOf(inputs, certificate.rule)}' keeps crews free`
    case 'fixed-costs': return 'costs every plan pays'
  }
}

/** What the recommended option's status says about the plan's outage goal: proven with its bound, or how far off it may be. */
const outageLine = (inputs: PlanInputs, option: Option): string | undefined => {
  const k = inputs.goals.findIndex(goal => goal.metric === 'span-over')
  const line = goalsOf(option)[k]
  if (line === undefined || option.status.word !== 'validated feasible') return undefined
  const resolution = goalResolution(line.unit, option.status.run.grid) ?? 0
  const head = `${capital(goalName(inputs, k, true))}: ${valueWords(line.value, line.unit)}`
  if (line.word === 'proven optimal') {
    const why = line.value < resolution / 2 && line.bound.certificate.kind === 'zero' ? certificateWords(inputs, line.bound.certificate, line.unit)
      : `bound ${valueWords(line.bound.value, line.unit)}: ${certificateWords(inputs, line.bound.certificate, line.unit)}`
    return `${head}, proven optimal: no plan has less (${why}).`
  }
  const gap = line.bound === undefined ? 0 : line.value - line.bound.value
  return gap > resolution / 2 ? `${head}, best found; it could be up to ${valueWords(gap, line.unit)} better.` : `${head}, best found.`
}

/** The method caveats the ranking does not price, for the recommended option and the one it is compared with. */
const caveatLines = (inputs: PlanInputs, option: Option, other: Option | undefined): string[] =>
  inputs.methods.flatMap(choice => {
    const pick = (of: Option | undefined) => {
      const key = of?.variant.methods.find(entry => entry.choice === choice.key)?.option
      return choice.options.find(entry => entry.key === key)
    }
    const own = pick(option), theirs = other === undefined ? undefined : pick(other)
    if (own === undefined) return []
    const compared = theirs === undefined || theirs.key === own.key ? undefined : theirs
    const labels = [...new Set([...(own.caveats ?? []), ...(compared?.caveats ?? [])].map(caveat => caveat.label))]
    return labels.map(label => {
      const value = (method: typeof own) => {
        const caveat = method.caveats?.find(entry => entry.label === label)
        if (caveat === undefined) return `none stated with '${method.label}'`
        const agreed = caveat.agreement === undefined ? '' : ` (agreed by ${caveat.agreement})`
        return `${caveat.value === undefined || caveat.unit === undefined ? caveat.words : valueWords(caveat.value, caveat.unit)} with '${method.label}'${agreed}`
      }
      return `Not in the ranking: ${label}: ${value(own)}${compared === undefined ? '' : `, against ${value(compared)}`}.`
    })
  })

/**
 * Why `recommended` ranks first. `others` are the set's other fresh options: the next in rank among those
 * validated feasible and without a lead is the comparison, unless the caller `named` another option.
 */
export const whyRecommendedLines = (inputs: PlanInputs, recommended: Option, others: readonly Option[], named?: Option): string[] => {
  const policy = `Ranked by: every hard rule kept first, ${inputs.goals.map((goal, k) => `then ${goalName(inputs, k)}${goal.tolerance.value > 0 ? ` (in steps of ${valueWords(goal.tolerance.value, goal.tolerance.unit)})` : ''}`).join(', ')}.`
  const asked = named !== undefined && named.key !== recommended.key ? named : undefined
  if (asked?.variant.lead !== undefined) {
    const lead = asked.variant.lead
    return fitLines([policy, `'${asked.label}' is a what-if that solves ${'goal' in lead ? goalName(inputs, lead.goal, true) : `the outage of ${nameOf(inputs, lead.group)}`} first: it is not ranked with the options.`])
  }
  if (asked !== undefined && asked.status.word !== 'validated feasible') {
    return fitLines([policy, `'${asked.label}' ${asked.status.word === 'proven infeasible' ? 'is proven infeasible' : `has no plan that keeps every hard rule (${asked.status.word})`}, so it is not ranked.`])
  }
  const keys = new Map([recommended, ...others].map(option => [option.key, keysOf(inputs, option)]))
  const candidates = others.filter(option => option.key !== recommended.key && ranked(option))
  const byRank = (left: Option, right: Option): number => {
    const a = keys.get(left.key)!, b = keys.get(right.key)!
    const k = a.findIndex((value, index) => differ(value, b[index]!))
    return k >= 0 ? a[k]! - b[k]! : left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  }
  const other = asked ?? [...candidates].sort(byRank)[0]
  const tail = [...caveatLines(inputs, recommended, other), ...[outageLine(inputs, recommended)].filter((line): line is string => line !== undefined)]
  if (other === undefined) {
    const refused = others.filter(option => option.key !== recommended.key && option.variant.lead === undefined && option.status.word !== 'validated feasible').length
    return fitLines([policy, `'${recommended.label}' is the only ranked option that keeps every hard rule${refused === 0 ? '' : `; ${refused} other${refused === 1 ? ' does' : 's do'} not`}.`, ...tail])
  }
  const mine = keys.get(recommended.key)!, theirs = keys.get(other.key)!
  const deciding = mine.findIndex((value, index) => differ(value, theirs[index]!))
  const values = (option: Option) => goalsOf(option)
  const value = (option: Option, k: number) => values(option)[k]?.value ?? 0
  const words = (option: Option, k: number) => valueWords(value(option, k), values(option)[k]?.unit ?? goalUnit(inputs, k))
  const head = asked === undefined ? `Next in rank: '${other.label}'.` : `Against '${other.label}':`
  if (deciding < 0) return fitLines([policy, head, `They tie on every goal within its step, so either may be chosen; Planning lists '${recommended.label}' first.`, ...tail])
  // Earlier goals equal within their step, though their values differ.
  const within = inputs.goals.slice(0, deciding).flatMap((goal, k) => differ(value(recommended, k), value(other, k))
    ? [`Within one step of ${valueWords(goal.tolerance.value, goal.tolerance.unit)} on ${goalName(inputs, k, true)}: ${words(recommended, k)} and ${words(other, k)}.`] : [])
  const decided = `Decided on ${goalName(inputs, deciding, true)}: ${words(recommended, deciding)} against ${words(other, deciding)}.`
  // The trade: every goal on which the two differ, the deciding one first, in its own unit.
  const order = [deciding, ...inputs.goals.map((_, k) => k).filter(k => k !== deciding)]
  const unit = (k: number) => values(recommended)[k]?.unit ?? goalUnit(inputs, k)
  const gains = order.filter(k => value(recommended, k) < value(other, k) - EPSILON).map(k => `${valueWords(value(other, k) - value(recommended, k), unit(k))} ${betterWords(inputs, k, true)}`)
  const costs = order.filter(k => value(recommended, k) > value(other, k) + EPSILON).map(k => `${valueWords(value(recommended, k) - value(other, k), unit(k))} ${betterWords(inputs, k, false)}`)
  const trade = gains.length === 0 ? [] : [costs.length === 0 ? `It gains ${listWords(gains)}, and is no worse on any goal.` : `The trade: ${listWords(gains)}, for ${listWords(costs)}.`]
  return fitLines([policy, head, ...within, decided, ...trade, ...tail])
}
