// The options side by side, above the timeline: one row per option with its longest outage against the
// limit, its value on each goal and its status. A refused option's row says "Not possible" and its cause in
// hours. Built from the options as read; nothing here is computed about a schedule.
import { quantityText, type Mark } from './format.ts'
import type { OptionView, PlanModel } from './model.ts'
import { refusalLine } from './outcome.ts'
import { certificateText, goalShort, statusView, type Context, type GoalLine } from './status-text.ts'

export interface GlanceCell {
  readonly value: string
  /** The goal's word ("proven optimal", "best found"); none for a value that is not a goal's. */
  readonly mark: Mark | null
  /** "could be up to 3.5 h better", or nothing. */
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
  /** For an option without values: "Not possible: …" with its hours, or what its status says. */
  readonly cause: string | null
  readonly stale: boolean
  readonly warnings: readonly string[]
}
export interface OptionsGlance { readonly columns: readonly string[]; readonly rows: readonly GlanceRow[] }

/**
 * The longest outage an option has against that group's limit, "49 h of 72 h": from the span the option
 * reports for each group of an outage-span goal; the group whose span is longest is the one shown.
 */
const longestOutage = (option: OptionView, context: Context): string | null => {
  const spans = option.metrics.flatMap(metric => {
    const match = /^goal:(\d+):(.+)$/.exec(metric.id)
    const goal = match === null ? undefined : context.inputs.goals[Number(match[1])]
    return match !== null && goal?.metric === 'span-over' ? [{ group: match[2]!, value: metric.value, unit: metric.unit }] : []
  })
  const longest = spans.reduce<typeof spans[number] | null>((most, span) => most === null || span.value > most.value ? span : most, null)
  if (longest === null) return null
  const limit = context.inputs.rules.find(rule => rule.kind === 'span-limit' && rule.group === longest.group)
  return `${quantityText(longest.value, longest.unit)}${limit?.kind === 'span-limit' ? ` of ${quantityText(limit.limit.value, limit.limit.unit)}` : ''}`
}

export const optionsGlance = (model: PlanModel, context: Context): OptionsGlance | null => {
  const options = model.options?.items ?? []
  if (options.length === 0) return null
  const outages = options.map(option => option.status.word === 'validated feasible' ? longestOutage(option, context) : null)
  const withOutage = outages.some(outage => outage !== null)
  const goals = context.inputs.goals
  const rows = options.map((option, index): GlanceRow => {
    const view = statusView(option.status, context)
    const base = {
      key: option.key, label: option.label, recommended: option.key === model.options?.recommended, mark: view.mark,
      tone: view.word === 'validated feasible' ? 'good' as const : view.word === 'proven infeasible' ? 'refusal' as const : view.word === 'unresolved' ? 'unknown' as const : 'warning' as const,
      stale: !option.fresh, warnings: option.warnings.map(warning => warning.text),
    }
    if (option.status.word !== 'validated feasible') {
      const cause = option.status.word === 'proven infeasible'
        ? `Not possible: ${refusalLine(model.refusals[option.key]) ?? certificateText(option.status.cause, context)}`
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
