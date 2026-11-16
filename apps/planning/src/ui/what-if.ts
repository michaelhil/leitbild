// What-ifs (design §0.3, §4.2): a question asked beside the plan, never an edit of it. "At most … h out" adds
// one shorter outage limit as an extra hard rule; "Finish this group first" solves that group's outage first;
// "Cheapest that keeps every rule" solves the plan's extra-cost goal first. Each is one Generate request kept
// beside the options already there. Its answer is a card: never a row of the options table, never
// recommended, never a rung. Goals are named by the plan's ids, never by their place in a list.
import { timeUnitMs } from '../time/units.ts'
import type { GenerateInput } from './api.ts'
import { hoursText, quantityText } from './format.ts'
import { createNames, otherWarnings, sizeCautionOf, type ItemStatus, type OptionView, type PlanModel } from './model.ts'
import { outageOf, planLimitOf } from './options-glance.ts'
import { certificateText, goalMark, goalShort, statusView, type Context, type GoalLine, type StatusView } from './status-text.ts'
import { unpricedOf, type Unpriced } from './unpriced.ts'

export type WhatIfKind = 'out' | 'first' | 'cheapest'
export type WhatIfAsk =
  | { readonly kind: 'out'; readonly group: string; readonly hours: string }
  | { readonly kind: 'first'; readonly group: string }
  | { readonly kind: 'cheapest' }
export type WhatIfVariant = NonNullable<GenerateInput['variants']>[number]

/** The kinds this plan can ask, in planner words, and the group a span what-if starts on. */
export const whatIfChoices = (context: Context): { readonly kinds: ReadonlyArray<{ readonly value: WhatIfKind; readonly label: string }>; readonly groups: ReadonlyArray<{ readonly value: string; readonly label: string }>; readonly group: string } => {
  const { inputs } = context
  const groups = inputs.groups.map(group => ({ value: group.key, label: group.label }))
  const limited = inputs.rules.find(rule => rule.kind === 'span-limit')
  const kinds: Array<{ value: WhatIfKind; label: string }> = []
  if (groups.length > 0) kinds.push({ value: 'out', label: 'At most … h out' }, { value: 'first', label: 'Finish this group first, with its shortest outage' })
  if (inputs.goals.some(goal => goal.metric === 'extra-cost')) kinds.push({ value: 'cheapest', label: 'Cheapest that keeps every rule' })
  return { kinds, groups, group: limited?.kind === 'span-limit' ? limited.group : groups[0]?.value ?? '' }
}

const groupLabel = (context: Context, group: string): string => context.names.group(group)

/** A rule key no plan rule has, made from the what-if's own words. */
const freshKey = (base: string, context: Context): string => {
  const taken = new Set(context.inputs.rules.map(rule => rule.key))
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60)
  let key = clean
  for (let n = 2; taken.has(key); n += 1) key = `${clean.slice(0, 58)}-${n}`
  return key
}

/**
 * The one Generate variant a what-if asks for, or the problems in planner words. "At most … h out" asks for
 * less than the plan's own limit on that group, which stays in force beside it.
 */
export const whatIfVariant = (ask: WhatIfAsk, context: Context): { readonly ok: true; readonly label: string; readonly variant: WhatIfVariant } | { readonly ok: false; readonly problems: readonly string[] } => {
  const { inputs } = context
  if (ask.kind === 'cheapest') {
    const goal = inputs.goals.findIndex(item => item.metric === 'extra-cost')
    if (goal < 0) return { ok: false, problems: ['This plan has no extra-cost goal to solve first.'] }
    const label = 'Cheapest that keeps every rule'
    return { ok: true, label, variant: { label, lead: { goal } } }
  }
  if (!inputs.groups.some(group => group.key === ask.group)) return { ok: false, problems: ['Choose a function group.'] }
  const group = groupLabel(context, ask.group)
  if (ask.kind === 'first') {
    const label = `${group} first, with its shortest outage`
    return { ok: true, label, variant: { label, lead: { group: ask.group } } }
  }
  const hours = Number(ask.hours.trim().replace(',', '.'))
  if (ask.hours.trim() === '' || !Number.isFinite(hours) || hours <= 0) return { ok: false, problems: ['Give the longest outage as a number of hours, such as 48.'] }
  const own = inputs.rules.find(rule => rule.kind === 'span-limit' && rule.group === ask.group)
  if (own?.kind === 'span-limit') {
    const ownHours = own.limit.value * timeUnitMs[own.limit.unit] / timeUnitMs.h
    if (hours >= ownHours) return { ok: false, problems: [`The plan's own rule already allows ${quantityText(own.limit.value, own.limit.unit)} for ${group}; a what-if asks for less.`] }
  }
  const label = `At most ${hoursText(hours)} out: ${group}`
  return {
    ok: true, label,
    variant: {
      label,
      also: [{
        kind: 'span-limit', key: freshKey(`what-if-${ask.group}-${hours}h`, context), group: ask.group, limit: { value: hours, unit: 'h' },
        // The plan's own rule on the group stays in force; the what-if's limit is read the same way.
        singleEntry: own?.kind === 'span-limit' ? own.singleEntry : false,
        words: `What-if: ${group} back within ${hoursText(hours)}.`, source: { by: 'planner', note: 'Asked as a what-if on the plan screen' },
      }],
    },
  }
}

/** The request for one what-if: kept beside the options already there, so the plan's own options stay. */
export const whatIfRequest = (variant: WhatIfVariant) => ({ variants: [variant], keep: true as const })

/** Said on every what-if card. */
export const whatIfApart = 'A what-if. The plan\'s own goals and rules are unchanged, and this answer is not stored as the plan\'s ranking.'

export interface WhatIfCardView {
  readonly key: string
  readonly label: string
  /** What was asked, in one sentence. */
  readonly question: string
  /** The status block's view, with the lead's line first and the other goals worded as "best found at that cost". */
  readonly status: StatusView
  /** "Longest outage 47.5 h · this what-if's limit 48 h · the plan's rule 72 h", or null when there is no outage figure. */
  readonly outage: string | null
  readonly unpriced: readonly Unpriced[]
  readonly warnings: readonly string[]
  readonly caution: string | null
  readonly stale: boolean
  /** "Against Swap in refurbished spare (recommended): −1 h longest outage, +NOK 18,900 extra cost, back at the same time.": a difference from stored figures, never a ranking. */
  readonly against: string | null
}

const lower = (text: string): string => `${text.charAt(0).toLowerCase()}${text.slice(1)}`

/**
 * How a what-if differs from the recommended option, from the stored figures of both (walk V13): the longest
 * outage, the extra cost, and when the last test is done. A difference, not a ranking: what-ifs are never
 * ranked. Null unless both are validated feasible on the current plan.
 */
const againstRecommended = (option: OptionView, model: PlanModel, context: Context): string | null => {
  const recommended = model.options?.items.find(item => item.key === model.options?.recommended)
  if (recommended === undefined || recommended.key === option.key || !recommended.fresh || !option.fresh) return null
  if (recommended.status.word !== 'validated feasible' || option.status.word !== 'validated feasible') return null
  const signed = (by: number, text: (amount: number) => string) => `${by > 0 ? '+' : '−'}${text(Math.abs(by))}`
  const parts: string[] = []
  const mine = outageOf(option, context.inputs), theirs = outageOf(recommended, context.inputs)
  if (mine !== null && theirs !== null) {
    const by = mine.value - theirs.value
    parts.push(Math.abs(by) < 1e-9 ? 'the same longest outage' : `${signed(by, amount => quantityText(amount, mine.unit))} longest outage`)
  }
  const cost = context.inputs.goals.findIndex(goal => goal.metric === 'extra-cost')
  const costOf = (status: typeof option.status) => status.word === 'validated feasible' ? status.goals.find(line => line.goal === cost) : undefined
  const myCost = costOf(option.status), theirCost = costOf(recommended.status)
  if (cost >= 0 && myCost !== undefined && theirCost !== undefined) {
    const by = myCost.value - theirCost.value
    // Inside the plan's own cost step the two count as equal cost: said so, so a cheaper what-if is not misread (N6).
    const step = context.inputs.goals[cost]!.tolerance
    const band = step.value > 0 && Math.abs(by) < step.value ? ` (within the ${quantityText(step.value, step.unit)} the plan counts as equal cost)` : ''
    parts.push(Math.abs(by) < 0.5 ? 'the same extra cost' : `${signed(by, amount => quantityText(amount, myCost.unit))} extra cost${band}`)
  }
  const lastTest = (of: OptionView) => of.metrics.find(metric => metric.id === 'last-test')
  const myBack = lastTest(option), theirBack = lastTest(recommended)
  if (myBack !== undefined && theirBack !== undefined) {
    const by = myBack.value - theirBack.value
    parts.push(Math.abs(by) < 1e-9 ? 'back at the same time' : `back ${quantityText(Math.abs(by), myBack.unit)} ${by > 0 ? 'later' : 'earlier'}`)
  }
  return parts.length === 0 ? null : `Against ${recommended.label} (recommended): ${parts.join(', ')}.`
}

/** Method picks in planner words: "Swap in refurbished spare", or every method when the request fixed none. */
const methodsLabel = (methods: ReadonlyArray<{ readonly choice: string; readonly option: string }>, inputs: Context['inputs']): string =>
  methods.length === 0 ? 'Every method' : methods.map(pick => inputs.methods.find(choice => choice.key === pick.choice)?.options.find(entry => entry.key === pick.option)?.label ?? 'a method option no longer in this plan').join(', ')

/** A span as the compact item gives it: its rule, the least outage proven and the limit, in h. */
type SpanSummary = NonNullable<Extract<ItemStatus, { word: 'proven infeasible' }>['span']>

/**
 * A refused what-if's causes (walk V1), one per method combination under its method's name, from the compact
 * item (coordinator, after the re-walk sizes): a method with a span says its least outage against the limit,
 * "asked" when the what-if's own rule holds it, else that rule in its words (re-walk N2); a method without
 * one says the `line` the read gave it, without its "Not possible:" lead. With no methods by name, the
 * option's own cause, worded with the what-if's rule among the plan's. The full chain is "Why not possible".
 */
const refusalByMethod = (option: OptionView, context: Context): readonly string[] => {
  if (option.status.word !== 'proven infeasible') return []
  const withAlso = { ...context.inputs, rules: [...context.inputs.rules, ...option.variant.also ?? []] }
  const asked: Context = { ...context, inputs: withAlso, names: createNames(withAlso) }
  const askedRules = new Set((option.variant.also ?? []).map(rule => rule.key))
  const least = (span: SpanSummary): string =>
    `out at least ${hoursText(span.leastHours)}, against the ${hoursText(span.limitHours)}${askedRules.has(span.rule) ? ' asked' : ` of “${asked.names.rule(span.rule)}”`}.`
  const own = option.status
  const entries = own.byMethod ?? [{ methods: option.variant.methods, span: own.span, line: null }]
  // The card already says no plan keeps every rule, so a line's own "Not possible:" lead is not repeated.
  return entries.map(entry => `${methodsLabel(entry.methods, context.inputs)}: ${entry.span !== undefined ? least(entry.span) : entry.line?.replace(/^Not possible:\s*/, '') ?? certificateText(own.cause, asked)}`)
}

export const whatIfCard = (option: OptionView, model: PlanModel, context: Context): WhatIfCardView => {
  const { inputs } = context
  // A refusal: each method's verified cause under its name, never the plan's refusal lines (walk V1).
  const view = option.status.word === 'proven infeasible' ? { ...statusView(option.status, context), details: refusalByMethod(option, context) } : statusView(option.status, context)
  const lead = option.variant.lead
  const also = option.variant.also?.[0]
  const question = lead !== undefined && 'goal' in lead
    ? inputs.goals[lead.goal]?.metric === 'extra-cost'
      ? 'Asked: the cheapest plan that keeps every hard rule, then the plan\'s other goals in order.'
      : `Asked: ${inputs.goals[lead.goal] === undefined ? 'one goal' : lower(goalShort(inputs.goals[lead.goal]!, context))} first, then the plan's other goals in order.`
    : lead !== undefined
      ? `Asked: the shortest outage for ${groupLabel(context, lead.group)} first, then the plan's goals in order.`
      : also?.kind === 'span-limit'
        ? `Asked: every hard rule of the plan, and ${groupLabel(context, also.group)} out for at most ${quantityText(also.limit.value, also.limit.unit)}.`
        : also?.kind === 'due'
          ? `Asked: every hard rule of the plan, and ${context.names.job(also.job)} finished by ${context.format.clock(also.finishBy)}.`
          : 'Asked as a what-if.'

  let status = view
  if (option.status.word === 'validated feasible' && option.status.lead !== undefined) {
    const solved = option.status.lead
    const lines = option.status.goals.map((line, at) => ({ id: line.goal, view: view.goals[at]! }))
    // The other goals were solved after the lead, at what the lead settled: never proof, whatever their word.
    const after = 'goal' in solved
      ? inputs.goals[solved.goal]?.metric === 'extra-cost' ? 'best found at that cost' : `best found with ${lower(goalShort(inputs.goals[solved.goal]!, context))} first`
      : `best found with ${groupLabel(context, solved.group)} first`
    const rest = (id: number | null): GoalLine[] => lines.filter(line => line.id !== id).map(line => ({ ...line.view, mark: { shape: '≈', word: after }, distance: '' }))
    if ('goal' in solved) {
      const first = lines.find(line => line.id === solved.goal)
      status = { ...view, goals: [...first === undefined ? [] : [{ ...first.view, name: `${first.view.name} (solved first)` }], ...rest(solved.goal)] }
    } else {
      const gap = solved.word === 'proven optimal' || solved.bound === undefined ? 0 : solved.value - solved.bound.value
      const leadLine: GoalLine = {
        name: `Shortest outage for ${groupLabel(context, solved.group)} (solved first)`, value: quantityText(solved.value, solved.unit), mark: goalMark(solved.word),
        distance: gap > 0 && solved.bound !== undefined ? `no plan has it out for less than ${quantityText(solved.bound.value, solved.unit)}` : '',
      }
      status = { ...view, goals: [leadLine, ...rest(null)] }
    }
  }

  const outage = option.status.word === 'validated feasible' ? outageOf(option, inputs) : null
  const ownLimit = outage === null ? null : planLimitOf(outage.group, inputs)
  const asked = also?.kind === 'span-limit' && outage !== null && also.group === outage.group ? quantityText(also.limit.value, also.limit.unit) : null
  return {
    key: option.key, label: option.label, question, status,
    outage: outage === null ? null : [
      `Longest outage ${quantityText(outage.value, outage.unit)}`,
      ...asked === null ? [] : [`this what-if's limit ${asked}`],
      ...ownLimit === null ? [] : [`the plan's rule ${ownLimit}`],
    ].join(' · '),
    // A refused what-if has no plan, so nothing of it is left unpriced (re-walk N2).
    unpriced: option.status.word === 'proven infeasible' ? [] : unpricedOf(option, inputs, model.rows[option.key]),
    warnings: otherWarnings(option), caution: sizeCautionOf(option), stale: !option.fresh,
    against: againstRecommended(option, model, context),
  }
}

const quotedList = (labels: readonly string[]): string => {
  const quoted = labels.map(label => `“${label}”`)
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`
}

/**
 * The notice after a what-if is answered (walk V9): what was asked, the cards it replaced, if any, by name, and
 * where its card is. A card never vanishes without a word.
 */
export const whatIfAskedNotice = (label: string, before: ReadonlyArray<Pick<OptionView, 'key' | 'label'>>, after: ReadonlyArray<Pick<OptionView, 'key'>>, wide: boolean): string => {
  const replaced = before.filter(card => !after.some(item => item.key === card.key)).map(card => card.label)
  return `What-if answered: ${label}.${replaced.length === 0 ? '' : ` It replaced ${quotedList(replaced)}.`} Its card is ${wide ? 'on the right' : 'below'}.`
}

/** After a Generate that cleared the what-ifs, why they are gone (walk V9); null when none were cleared. */
export const whatIfsClearedNotice = (before: readonly unknown[], after: readonly unknown[]): string | null =>
  before.length === 0 || after.length > 0 ? null
    : `The ${before.length === 1 ? 'what-if was' : `${before.length} what-ifs were`} asked against the earlier options, so Generate cleared ${before.length === 1 ? 'it' : 'them'}. Ask again for the plan as it is now.`

/**
 * The keep rule, as the Module states it in Generate's description (walk V9): of at most 8 options the new
 * what-ifs stay, then the plan's own, then earlier what-ifs; the same what-if replaces itself; without keep
 * none stay. Said with the what-ifs, so a card never vanishes unexplained.
 */
export const whatIfKeepRule = 'A plan holds at most 8 options. The newest what-ifs stay first, then the plan\'s own options, then earlier what-ifs, so an earlier what-if can be replaced. The same what-if asked again replaces itself. Generate without a what-if clears them all.'
