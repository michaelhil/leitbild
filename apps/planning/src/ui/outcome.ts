// What the latest Generate found, said where the planner looks first: the banner and the attention column.
// A refused option says its cause in hours, from the Module's refusal (explain, ask refusal), never only
// "none is validated feasible".
import type { Mark } from './format.ts'
import type { OptionView, PlanModel } from './model.ts'
import { certificateText, goalResult, statusView, type Context } from './status-text.ts'

export interface Outcome {
  readonly key: string
  readonly label: string
  readonly mark: Mark
  /** The status word, exactly as the status schema has it. */
  readonly word: string
  /** One line: the first goal for a feasible option, the proof's cause for a refused one. */
  readonly cause: string
  readonly recommended: boolean
}

/** The refusal's first line without its "Not possible:" lead, e.g. "6 jobs must run one after another …". */
const lead = (lines: readonly string[] | undefined): string | null => {
  const first = lines?.find(line => line.trim() !== '')
  return first === undefined ? null : first.replace(/^Not possible:\s*/, '')
}

export const outcomeOf = (option: OptionView, model: PlanModel, context: Context): Outcome => {
  const view = statusView(option.status, context)
  const recommended = option.key === model.options?.recommended
  const first = view.goals[0]
  const cause = option.status.word === 'proven infeasible'
    ? lead(model.refusals[option.key]) ?? certificateText(option.status.cause, context)
    : first !== undefined ? `least ${first.name}: ${goalResult(first)}` : [view.sentence, view.details[0]].filter(part => part !== undefined).join(' ')
  return { key: option.key, label: option.label, mark: view.mark, word: view.word, cause, recommended }
}

/** Why a search stopped before it finished, in words, or null when it ran to the end or used its budget. */
export const stoppedEarly = (option: OptionView): string | null => {
  if (!('run' in option.status)) return null
  return ({ memory: 'at the memory limit', cpu: 'when its computing time ran out', cancelled: 'because it was cancelled', ended: 'because the solver process ended' } as Record<string, string>)[option.status.run.stoppedBy] ?? null
}

/** The current options' outcomes; options made before the latest change claim nothing and are left out. */
export const outcomes = (model: PlanModel, context: Context): readonly Outcome[] =>
  (model.options?.items ?? []).filter(option => option.fresh).map(option => outcomeOf(option, model, context))

/** The banner under the plan's title: the recommendation, or that there is none, and every refusal's cause. */
export const outcomeBanner = (model: PlanModel, context: Context): { readonly title: string; readonly lines: readonly string[]; readonly recommended: boolean } | null => {
  const found = outcomes(model, context)
  if (found.length === 0) return null
  const recommended = found.find(outcome => outcome.recommended)
  const title = recommended !== undefined
    ? `Recommended: ${recommended.label}, ${recommended.word}.`
    : found.every(outcome => outcome.word === 'proven infeasible')
      ? `No option can be recommended: ${found.length === 1 ? 'it is' : found.length === 2 ? 'both are' : `all ${found.length} are`} proven infeasible.`
      : 'No option can be recommended: none is validated feasible.'
  const lines = found.filter(outcome => outcome.word !== 'validated feasible').map(outcome => `${outcome.label}: ${outcome.word}. ${outcome.cause}`)
  // A search that stopped early may have missed a better plan: said where the planner looks first.
  const early = (model.options?.items ?? []).filter(option => option.fresh).map(stoppedEarly).find(reason => reason !== null)
  if (early !== undefined) lines.unshift(`The search stopped early, ${early}: ${recommended === undefined ? 'a plan may still exist' : 'this option may not be the best'}. Generate again.`)
  return { title, lines, recommended: recommended !== undefined }
}
