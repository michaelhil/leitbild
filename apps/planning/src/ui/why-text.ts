// "Why recommended" (T11) and "what differs from the earlier options" (T12), beside the timeline. Both are
// written from the Module's structured facts (planning.plan.explain, asks recommended and versus: the
// `recommended` and `versus` fields), never from its lines: the deciding goal, each goal's value against the
// other option's, the trade, the caveats, the measures that changed and the jobs that moved. The plan's rule
// is its own goal order in words. Nothing here ranks or compares options itself.
import type { RecommendedFacts, VersusFacts } from '../api/contract.ts'
import { noPreviousWords, type ExplainResult } from './api.ts'
import { hoursText, quantityText, type Mark } from './format.ts'
import type { OptionView, PlanModel } from './model.ts'
import { goalAimText, goalName, goalShort, statusMark, type Context } from './status-text.ts'

/** Where a question to the Module stands. `none`: there is nothing to compare with (no earlier set). */
export type Answer<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'answered'; readonly facts: T }
  | { readonly state: 'not-built' }
  | { readonly state: 'none' }
  | { readonly state: 'refused'; readonly text: string }

/** The facts of an answer; an answer without them is "not available yet", since the screen never reads lines. */
export const recommendedAnswer = (result: ExplainResult): Answer<RecommendedFacts> => result.recommended === undefined ? { state: 'not-built' } : { state: 'answered', facts: result.recommended }
export const versusAnswer = (result: ExplainResult): Answer<VersusFacts> => result.versus === undefined ? { state: 'not-built' } : { state: 'answered', facts: result.versus }

/**
 * The plan's policy, one line each: every hard rule first, then each goal in its full words with what its
 * step means. "2. Keep the extra cost as small as possible; costs within NOK 25,000 of each other count as equal."
 */
export const policyLines = (context: Context): readonly string[] =>
  ['Every hard rule must hold.', ...context.inputs.goals.map((goal, index) => `${index + 1}. ${goalAimText(goal, context)}.`)]

const goalWords = (context: Context, goal: number): string => {
  const item = context.inputs.goals[goal]
  return item === undefined ? 'a goal no longer in this plan' : goalShort(item, context)
}
/** What a goal measures, without its groups, for a sentence: "time over the 54 h guideline", "extra cost". */
const goalSubject = (context: Context, goal: number): string => {
  const item = context.inputs.goals[goal]
  if (item === undefined) return 'a goal no longer in this plan'
  const { scope: _scope, ...unscoped } = item
  return goalName(unscoped, context)
}
/** A goal's difference in a trade: "+NOK 50,400 extra cost", "−13 h over the 54 h guideline". */
const tradeWords = (context: Context, goal: number, by: number, unit: string, signed: boolean): string => {
  const item = context.inputs.goals[goal]
  const amount = `${signed ? by > 0 ? '+' : '−' : ''}${quantityText(Math.abs(by), unit)}`
  const subject = item === undefined ? 'on a goal no longer in this plan'
    : item.metric === 'span-over' ? item.threshold === undefined ? 'of outage' : `over the ${quantityText(item.threshold.value, item.threshold.unit)} guideline`
      : item.metric === 'extra-cost' ? 'extra cost'
        : item.metric === 'unavailable-hours' ? 'of equipment out of service'
          : item.metric === 'finish' ? 'on the finish of the last job' : 'of lateness'
  return `${amount} ${subject}`
}
const labelOf = (model: Pick<PlanModel, 'options'>, key: string): string => model.options?.items.find(option => option.key === key)?.label ?? 'another option'

export interface WhyGoalRow {
  readonly name: string
  readonly value: string
  readonly against: string | null
  /** The goal on which the two first differ, step by step: it decided. */
  readonly deciding: boolean
}

export interface WhyView {
  /** "Against “Rebuild in place”, the next in rank", or why there is no other option to weigh. */
  readonly against: string
  readonly againstLabel: string | null
  /** "Decided on extra cost: NOK 340,000 against NOK 120,000.", or that they tie. */
  readonly decided: string | null
  /** "The trade: +NOK 50,400 extra cost for −13 h over the 54 h guideline." */
  readonly trade: string | null
  readonly goals: readonly WhyGoalRow[]
  readonly caveats: ReadonlyArray<{ readonly method: string; readonly line: string; readonly against: string | null; readonly words: string | null }>
  /** What the option's status says about the plan's outage goal. */
  readonly outage: string | null
}

/** The trade in each goal's own unit, cost first: "+NOK 50,400 extra cost for −13 h over the 54 h guideline". */
export const tradeText = (facts: RecommendedFacts, context: Context): string | null => {
  if (facts.against === undefined) return null
  const order = [...facts.deciding === undefined ? [] : [facts.deciding], ...facts.goals.map(line => line.goal).filter(goal => goal !== facts.deciding)]
  const differences = order.flatMap(goal => {
    const line = facts.goals.find(entry => entry.goal === goal)
    if (line === undefined || line.against === undefined || line.value === line.against) return []
    return [{ goal, by: line.value - line.against, unit: line.unit }]
  })
  const said = (entry: { goal: number; by: number; unit: string }) => tradeWords(context, entry.goal, entry.by, entry.unit, true)
  const costs = differences.filter(entry => entry.by > 0).map(said)
  const gains = differences.filter(entry => entry.by < 0).map(said)
  const list = (items: readonly string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
  if (costs.length > 0 && gains.length > 0) return `The trade: ${list(costs)} for ${list(gains)}.`
  if (gains.length > 0) return `No goal is worse; it is better by ${list(differences.map(entry => tradeWords(context, entry.goal, entry.by, entry.unit, false)))}.`
  if (costs.length > 0) return `Differences, each within its goal's step: ${list(costs)}.`
  return null
}

export const whyView = (facts: RecommendedFacts, model: Pick<PlanModel, 'options'>, context: Context, named: boolean): WhyView => {
  const { inputs } = context
  const againstLabel = facts.against === undefined ? null : labelOf(model, facts.against)
  const line = (goal: number) => facts.goals.find(entry => entry.goal === goal)
  const deciding = facts.deciding === undefined ? undefined : line(facts.deciding)
  const decided = facts.against === undefined ? null
    : deciding === undefined || deciding.against === undefined
      ? 'They tie on every goal within its step, so either could be chosen; Planning lists this one first.'
      : `Decided on ${goalSubject(context, deciding.goal)}: ${quantityText(deciding.value, deciding.unit)} here against ${quantityText(deciding.against, deciding.unit)} for ${againstLabel}.`
  // The proven floor of the longest outage, in hours (G4): only when the outage goal measures the outage itself
  // (no guideline threshold) for one group, and has a bound. A guideline goal's bound says how far over the
  // guideline it can be, not how short the outage can be, so its line is dropped.
  const outage = (() => {
    if (facts.outage === undefined) return null
    const { goal, word, value, unit, bound } = facts.outage
    const item = inputs.goals[goal]
    const group = item?.scope?.groups?.length === 1 ? item.scope.groups[0]! : null
    if (item === undefined || item.metric !== 'span-over' || item.threshold !== undefined || group === null || bound === undefined) return null
    const name = context.names.group(group)
    return word === 'proven optimal' ? `${name} is out for ${quantityText(value, unit)}: proven the shortest possible.` : `No plan has ${name} out for less than ${quantityText(bound, unit)}, proven; this one has it out for ${quantityText(value, unit)}.`
  })()
  return {
    against: againstLabel === null ? 'No other ranked option keeps every hard rule, so there is none to weigh it against.' : `Against “${againstLabel}”${named ? '' : ', the next in rank'}.`,
    againstLabel, decided, trade: tradeText(facts, context),
    goals: facts.goals.map(entry => ({
      name: goalWords(context, entry.goal), value: quantityText(entry.value, entry.unit),
      against: entry.against === undefined ? null : quantityText(entry.against, entry.unit), deciding: entry.goal === facts.deciding,
    })),
    caveats: facts.caveats.map(caveat => {
      const method = inputs.methods.find(choice => choice.key === caveat.choice)
      const option = method?.options.find(entry => entry.key === caveat.option)
      const words = option?.caveats?.find(entry => entry.label === caveat.label)?.words ?? null
      const value = caveat.value === undefined || caveat.unit === undefined ? null : quantityText(caveat.value, caveat.unit)
      return {
        method: method === undefined || option === undefined ? 'A method no longer in this plan' : `${method.label}: ${option.label}`,
        line: value === null ? caveat.label : `${caveat.label}: ${value}`,
        against: caveat.against === undefined || caveat.unit === undefined || againstLabel === null ? null : `${quantityText(caveat.against, caveat.unit)} for “${againstLabel}”`,
        words,
      }
    }),
    outage,
  }
}

export interface CompareGoalRow { readonly name: string; readonly now: string; readonly was: string; readonly change: string }
export interface CompareView {
  readonly against: string
  /** The change log's own summaries since the earlier set, oldest first. */
  readonly changes: readonly string[]
  readonly incomplete: string | null
  /** Each goal's value now and before; null when the goals themselves changed. */
  readonly goals: readonly CompareGoalRow[] | null
  /** The longest outage of each group with a span rule, now and before, from the two options' own checker figures. */
  readonly outages: readonly CompareGoalRow[]
  readonly goalsNote: string | null
  readonly methods: readonly string[]
  readonly buys: readonly string[]
  readonly moved: ReadonlyArray<{ readonly job: string; readonly was: string; readonly now: string; readonly shift: string }>
  readonly more: string | null
  readonly added: readonly string[]
  /** Jobs no longer in the plan: they have no names left in it, so they are counted, and the changes name them. */
  readonly removed: string | null
  /** Nothing in the facts differs. */
  readonly same: boolean
}

const shiftText = (was: { start: string; finish: string }, now: { start: string; finish: string }): string => {
  const start = (Date.parse(now.start) - Date.parse(was.start)) / 3_600_000
  if (start !== 0) return `starts ${hoursText(Math.abs(start))} ${start > 0 ? 'later' : 'earlier'}`
  const finish = (Date.parse(now.finish) - Date.parse(was.finish)) / 3_600_000
  return `finishes ${hoursText(Math.abs(finish))} ${finish > 0 ? 'later' : 'earlier'}`
}

export const compareView = (facts: VersusFacts, option: Pick<OptionView, 'label' | 'metrics'>, previous: Pick<OptionView, 'label' | 'metrics'>, context: Context): CompareView => {
  const previousLabel = previous.label
  const { names, format, inputs } = context
  const signed = (by: number, unit: string) => Math.abs(by) < 1e-9 ? 'the same' : `${by > 0 ? '+' : '−'}${quantityText(Math.abs(by), unit)}`
  const methods = facts.methods.map(entry => {
    const method = inputs.methods.find(choice => choice.key === entry.choice)
    const label = (key: string) => method?.options.find(item => item.key === key)?.label ?? 'a method option no longer in this plan'
    return `${method?.label ?? 'A method choice'}: ${label(entry.now)}, was ${label(entry.was)}.`
  })
  const buys = [
    ...facts.buys.added.length === 0 ? [] : [`Now buys ${names.list(facts.buys.added, names.purchase)}.`],
    ...facts.buys.dropped.length === 0 ? [] : [`No longer buys ${names.list(facts.buys.dropped, names.purchase)}.`],
  ]
  const goals = facts.goals?.map(entry => ({
    name: goalWords(context, entry.goal), now: quantityText(entry.now, entry.unit), was: quantityText(entry.was, entry.unit), change: signed(entry.now - entry.was, entry.unit),
  })) ?? null
  const moved = facts.moved.map(entry => ({ job: names.job(entry.job), was: format.range(entry.was.start, entry.was.finish), now: format.range(entry.now.start, entry.now.finish), shift: shiftText(entry.was, entry.now) }))
  // G5: an outage that grows under the guideline changes no goal, so each limited group's longest outage is shown.
  const span = (of: Pick<OptionView, 'metrics'>, group: string) => of.metrics.find(metric => metric.id === `span:${group}`)
  const outages = [...new Set(inputs.rules.flatMap(rule => rule.kind === 'span-limit' ? [rule.group] : []))].flatMap(group => {
    const now = span(option, group), was = span(previous, group)
    return now === undefined || was === undefined ? [] : [{ name: `Longest outage, ${names.group(group)}`, now: quantityText(now.value, now.unit), was: quantityText(was.value, was.unit), change: signed(now.value - was.value, now.unit) }]
  })
  const sameGoals = (goals === null || goals.every(row => row.change === 'the same')) && outages.every(row => row.change === 'the same')
  return {
    against: `“${option.label}” now, against “${previousLabel}” in the set made before the latest changes.`,
    changes: facts.changes.map(change => change.summary),
    incomplete: facts.complete ? null : 'Some earlier changes are no longer in the plan\'s history, so this list is not complete.',
    goals, outages, goalsNote: goals === null ? 'The goals themselves changed, so their values are not compared.' : null,
    methods, buys, moved,
    more: facts.movedMore === 0 ? null : `${facts.movedMore} more ${facts.movedMore === 1 ? 'job moved' : 'jobs moved'}.`,
    added: facts.added.map(names.job),
    removed: facts.removed.length === 0 ? null : `${facts.removed.length} ${facts.removed.length === 1 ? 'job of the earlier set is' : 'jobs of the earlier set are'} no longer in the plan.`,
    same: sameGoals && methods.length === 0 && buys.length === 0 && moved.length === 0 && facts.movedMore === 0 && facts.added.length === 0 && facts.removed.length === 0,
  }
}

/** An option of the earlier set, as the compare panel lists it: its name, its status word, and whether it was recommended. */
export interface PreviousRow { readonly key: string; readonly label: string; readonly mark: Mark; readonly recommended: boolean }
export const previousRows = (page: { readonly items: readonly OptionView[]; readonly recommended: string | null }): readonly PreviousRow[] =>
  page.items.map(item => ({ key: item.key, label: item.label, mark: statusMark(item.status.word), recommended: item.key === page.recommended }))

/** The earlier option a shown option is compared with: the same option if the earlier set has it, else the one it recommended. */
export const previousFor = (shown: string | null, page: { readonly items: readonly OptionView[]; readonly recommended: string | null }, chosen: string | null): string | null => {
  const has = (key: string | null) => key !== null && page.items.some(item => item.key === key)
  if (has(chosen)) return chosen
  if (has(shown)) return shown
  return has(page.recommended) ? page.recommended : page.items[0]?.key ?? null
}


/** No earlier set to compare with, in the screen's words (the refusal no_previous_options says the same). */
export { noPreviousWords }
