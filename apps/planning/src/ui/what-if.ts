// What-ifs (design §0.3, §4.2): a question asked beside the plan, never an edit of it. "At most … h out" adds
// one shorter outage limit as an extra hard rule; "Finish this group first" solves that group's outage first;
// "Cheapest that keeps every rule" solves the plan's extra-cost goal first. Each is one Generate request kept
// beside the options already there. Its answer is a card: never a row of the options table, never
// recommended, never a rung. Goals are named by the plan's ids, never by their place in a list.
import { timeUnitMs } from '../time/units.ts'
import type { GenerateInput } from './api.ts'
import { hoursText, quantityText } from './format.ts'
import { otherWarnings, sizeCautionOf, type OptionView, type PlanModel } from './model.ts'
import { outageOf, planLimitOf } from './options-glance.ts'
import { goalMark, goalShort, statusView, type Context, type GoalLine, type StatusView } from './status-text.ts'
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
}

const lower = (text: string): string => `${text.charAt(0).toLowerCase()}${text.slice(1)}`

export const whatIfCard = (option: OptionView, model: PlanModel, context: Context): WhatIfCardView => {
  const { inputs } = context
  const view = statusView(option.status, context)
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
        distance: gap > 0 ? `could be up to ${quantityText(gap, solved.unit)} shorter` : '',
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
    unpriced: unpricedOf(option, inputs, model.rows[option.key]),
    warnings: otherWarnings(option), caution: sizeCautionOf(option), stale: !option.fresh,
  }
}
