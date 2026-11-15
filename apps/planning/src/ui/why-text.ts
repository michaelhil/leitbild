// "Why recommended" (T11) and "what differs from the earlier options" (T12), beside the timeline. The policy
// is the plan's own goal order in words; the deciding goal, the trade and the comparison are the Module's
// answer to planning.plan.explain (asks recommended and versus), shown as it gives them; what a method leaves
// unpriced comes from the plan's method options. Nothing here ranks or compares options itself.
import type { ExplainResult } from './api.ts'
import type { OptionView, PlanModel } from './model.ts'
import { goalShort, goalStep, type Context } from './status-text.ts'
import { unpricedByMethod, unpricedOf, type Unpriced } from './unpriced.ts'

/** What the panel shows of the Module's answer: its words, or why there are none yet. */
export type Answer =
  | { readonly state: 'loading' }
  | { readonly state: 'answered'; readonly lines: readonly string[] }
  | { readonly state: 'not-built' }
  | { readonly state: 'refused'; readonly text: string }

export const answered = (result: ExplainResult): Answer => ({ state: 'answered', lines: result.lines.map(line => line.trim()).filter(line => line !== '') })

/**
 * The plan's policy in one sentence: "Every hard rule must hold. Then, in order: 1. Over the 54 h guideline
 * · 2. Extra cost, compared in steps of NOK 25,000 · 3. Equipment-hours out of service."
 */
export const policyText = (context: Context): string =>
  `Every hard rule must hold. Then, in order: ${context.inputs.goals.map((goal, index) => {
    const step = goalStep(goal)
    return `${index + 1}. ${goalShort(goal, context)}${step === null ? '' : `, ${step}`}`
  }).join(' · ')}.`

export interface WhyView {
  readonly title: string
  readonly policy: string
  /** What the recommended option's method leaves unpriced. */
  readonly unpriced: readonly Unpriced[]
  /** The other method options' caveats, to weigh against it (T10). */
  readonly otherMethods: ReadonlyArray<{ readonly method: string; readonly items: readonly Unpriced[] }>
  /** Said when the Module has not answered yet with the deciding goal. */
  readonly missing: string
}

export const whyView = (option: OptionView, model: PlanModel, context: Context): WhyView => {
  const unpriced = unpricedOf(option, context.inputs, model.rows[option.key])
  const own = new Set(unpriced.map(item => item.method))
  return {
    title: `Why “${option.label}” is recommended`,
    policy: policyText(context),
    unpriced,
    otherMethods: unpricedByMethod(context.inputs).filter(entry => !own.has(entry.method)),
    missing: 'The deciding goal and the trade it made are not available yet in this version of Planning.',
  }
}

export interface CompareView {
  readonly title: string
  readonly against: string
  readonly missing: string
}

export const compareView = (option: OptionView): CompareView => ({
  title: 'What differs from the earlier options',
  against: `“${option.label}” now, against the same option in the set made before the latest change.`,
  missing: 'Comparing with the earlier options is not available yet in this version of Planning.',
})
