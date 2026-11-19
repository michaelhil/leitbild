// The options side by side, above the timeline: per option its longest outage against the limit and its
// value on each goal, and under its name its status. A refused option says "Not possible" and its cause in
// hours, in one short line. Built from the options as read; nothing here is computed about a schedule.
// What-ifs are never rows here: each answers on its own card.
import type { PlanInputs } from '../plan/schema.ts'
import { quantityText, type Mark } from './format.ts'
import { otherWarnings, planOptions, sizeCautionOf, type OptionView, type PlanModel } from './model.ts'
import { shortCause } from './outcome.ts'
import { goalShort, statusView, type Context, type GoalLine } from './status-text.ts'
import { unpricedLine, unpricedOf } from './unpriced.ts'

export interface GlanceCell {
  readonly value: string
  /** The goal's word ("proven optimal", "best found"); none for a value that is not a goal's. */
  readonly mark: Mark | null
  /** The proven bound, said as itself, or nothing. */
  readonly distance: string
}
export interface GlanceRow {
  readonly key: string
  readonly label: string
  readonly recommended: boolean
  readonly mark: Mark
  readonly tone: 'good' | 'refusal' | 'unknown' | 'warning'
  /** One cell per column for an option with values; null for one that has none. */
  readonly cells: readonly (GlanceCell | null)[] | null
  /** For an option without values: "Not possible: …" in one short line with its hours, or what its status says. */
  readonly cause: string | null
  readonly stale: boolean
  /** The size caution in the Module's words, shown as a chip beside the status; null when the option has none. */
  readonly caution: string | null
  readonly warnings: readonly string[]
  /** The option that dominates it, by name: it is folded under the table, and can be opened. */
  readonly dominatedBy: string | null
  /** What its method leaves unpriced, one short line each: "Weeks without a ready SW spare: 10 weeks". */
  readonly unpriced: readonly string[]
}
export interface OptionsGlance { readonly columns: readonly string[]; readonly rows: readonly GlanceRow[] }

/** An option's longest outage: the group whose span is longest among the spans its outage-span goals report. */
export const outageOf = (option: Pick<OptionView, 'metrics'>, inputs: PlanInputs): { readonly group: string; readonly value: number; readonly unit: string } | null => {
  const spans = option.metrics.flatMap(metric => {
    const match = /^goal:(\d+):(.+)$/.exec(metric.id)
    const goal = match === null ? undefined : inputs.goals[Number(match[1])]
    return match !== null && goal?.metric === 'span-over' ? [{ group: match[2]!, value: metric.value, unit: metric.unit }] : []
  })
  return spans.reduce<typeof spans[number] | null>((most, span) => most === null || span.value > most.value ? span : most, null)
}

/** The plan's own limit on a group's outage, "72 h", or null when no rule limits it. */
export const planLimitOf = (group: string, inputs: PlanInputs): string | null => {
  const limit = inputs.rules.find(rule => rule.kind === 'span-limit' && rule.group === group)
  return limit?.kind === 'span-limit' ? quantityText(limit.limit.value, limit.limit.unit) : null
}

/** The longest outage an option has against that group's limit, "49 h of 72 h". */
const longestOutage = (option: OptionView, context: Context): string | null => {
  const longest = outageOf(option, context.inputs)
  if (longest === null) return null
  const limit = planLimitOf(longest.group, context.inputs)
  return `${quantityText(longest.value, longest.unit)}${limit === null ? '' : ` of ${limit}`}`
}

export const optionsGlance = (model: PlanModel, context: Context): OptionsGlance | null => {
  const options = planOptions(model)
  if (options.length === 0) return null
  const outages = options.map(option => option.status.word === 'validated feasible' ? longestOutage(option, context) : null)
  const withOutage = outages.some(outage => outage !== null)
  const goals = context.inputs.goals
  const rows = options.map((option, index): GlanceRow => {
    const view = statusView(option.status, context)
    const base = {
      key: option.key, label: option.label, recommended: option.key === model.options?.recommended, mark: view.mark,
      tone: view.word === 'validated feasible' ? 'good' as const : view.word === 'proven infeasible' ? 'refusal' as const : view.word === 'unresolved' ? 'unknown' as const : 'warning' as const,
      stale: !option.fresh, caution: sizeCautionOf(option), warnings: otherWarnings(option),
      // A refused option has no plan, so nothing of it is left unpriced (re-walk N2).
      unpriced: option.status.word === 'proven infeasible' ? [] : unpricedOf(option, context.inputs, model.rows[option.key]).map(unpricedLine),
      dominatedBy: option.dominated === undefined ? null : model.options?.items.find(item => item.key === option.dominated?.by)?.label ?? 'another option',
    }
    if (option.status.word !== 'validated feasible') {
      const cause = option.status.word === 'proven infeasible'
        ? `Not possible: ${shortCause(option, model, context)}`
        : [view.sentence, view.details[0]].filter(part => part !== undefined).join(' ')
      return { ...base, cells: null, cause }
    }
    const lines = new Map<number, GoalLine>(option.status.goals.map((line, at) => [line.goal, view.goals[at]!]))
    const outage = outages[index] ?? null
    return {
      ...base, cause: null,
      cells: [
        ...withOutage ? [outage === null ? null : { value: outage, mark: null, distance: '' }] : [],
        ...goals.map((_, goal) => { const line = lines.get(goal); return line === undefined ? null : { value: line.value, mark: line.mark, distance: line.distance } }),
      ],
    }
  })
  return { columns: [...withOutage ? ['Longest outage'] : [], ...goals.map(goal => goalShort(goal, context))], rows }
}

/** What the planner can ask about the options, under the table; each opens beside the timeline. */
export type ChoosePanel = 'ladder' | 'whatif' | 'why' | 'compare'
