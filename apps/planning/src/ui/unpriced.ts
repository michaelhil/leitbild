// What a method option leaves unpriced (its caveats, design §2.2), said beside every option that uses it,
// in why recommended and in a what-if's card: "Weeks without a ready SW spare: 10 weeks". The values are the
// plan's own, from its method options; nothing here is computed about a schedule.
import type { PlanInputs } from '../plan/schema.ts'
import { quantityText, type Mark } from './format.ts'
import type { DatedRow, OptionView } from './model.ts'

export const unpricedMark: Mark = { shape: '○', word: 'Unpriced' }

export interface Unpriced {
  /** "SW A pump assembly: Swap in refurbished spare" */
  readonly method: string
  readonly label: string
  /** "10 weeks", or null when the caveat has no value. */
  readonly value: string | null
  readonly words: string
  /** Who must agree, listed with the baseline and never signed in the tool; null when nobody is named. */
  readonly agreement: string | null
}

type MethodPick = { readonly choice: string; readonly option: string }

/**
 * The method options an option uses: the ones its request fixed and, for a choice left to the search, the
 * one whose jobs its schedule holds (only when the rows are read and hold exactly one).
 */
export const methodPicks = (option: Pick<OptionView, 'variant'>, inputs: PlanInputs, rows?: readonly DatedRow[]): readonly MethodPick[] => {
  const fixed = option.variant.methods
  const scheduled = new Set((rows ?? []).map(row => row.job))
  const searched = inputs.methods.filter(method => !fixed.some(pick => pick.choice === method.key)).flatMap(method => {
    const used = method.options.filter(entry => inputs.jobs.some(job => job.method?.choice === method.key && job.method.option === entry.key && scheduled.has(job.key)))
    return used.length === 1 ? [{ choice: method.key, option: used[0]!.key }] : []
  })
  return [...fixed, ...searched]
}

/** The caveats of one method option, in planner words. */
export const caveatsOf = (inputs: PlanInputs, pick: MethodPick): readonly Unpriced[] => {
  const method = inputs.methods.find(choice => choice.key === pick.choice)
  const chosen = method?.options.find(entry => entry.key === pick.option)
  if (method === undefined || chosen === undefined) return []
  return (chosen.caveats ?? []).map(caveat => ({
    method: `${method.label}: ${chosen.label}`, label: caveat.label,
    value: caveat.value === undefined || caveat.unit === undefined ? null : quantityText(caveat.value, caveat.unit),
    words: caveat.words, agreement: caveat.agreement ?? null,
  }))
}

/** Everything an option leaves unpriced, from the method options it uses. */
export const unpricedOf = (option: Pick<OptionView, 'variant'>, inputs: PlanInputs, rows?: readonly DatedRow[]): readonly Unpriced[] =>
  methodPicks(option, inputs, rows).flatMap(pick => caveatsOf(inputs, pick))

/** One short line: "Weeks without a ready SW spare: 10 weeks", or its words when it has no value. */
export const unpricedLine = (item: Unpriced): string => item.value === null ? `${item.label}: ${item.words}` : `${item.label}: ${item.value}`

/**
 * Every method option of the plan with its caveats, so two methods can be weighed on what neither price says
 * (T10): one entry per method option that has any.
 */
export const unpricedByMethod = (inputs: PlanInputs): ReadonlyArray<{ readonly method: string; readonly items: readonly Unpriced[] }> =>
  inputs.methods.flatMap(method => method.options.flatMap(entry => {
    const items = caveatsOf(inputs, { choice: method.key, option: entry.key })
    return items.length === 0 ? [] : [{ method: `${method.label}: ${entry.label}`, items }]
  }))
