// "Why it starts then" and "what sets the finish", generated from planning.plan.explain's structure.
import type { z } from 'zod'
import type { explainResultSchema } from '../api/contract.ts'
import { hoursText } from './format.ts'
import type { DatedRow } from './model.ts'
import type { Context } from './status-text.ts'

export type ExplainResult = z.infer<typeof explainResultSchema>
export type ExplainItem = ExplainResult['items'][number]
type Because = ExplainItem['because'][number]

const until = (because: Because, context: Context): string => because.until === undefined ? '' : ` until ${context.format.clock(because.until)}`

const at = (because: Because, context: Context): string => because.until === undefined ? 'then' : `at ${context.format.clock(because.until)}`

/** One cause in words. Keys are shown by their names only. */
/**
 * One cause in words. An explanation's `about` may mix kinds (a busy crew with the jobs holding it; the
 * crews whose shift is off), so each key is named by what it is in this plan, never assumed to be one kind.
 */
export const causeText = (because: Because, context: Context): string => {
  const { names } = context
  const about = because.about
  const of = (...kinds: ReadonlyArray<ReturnType<typeof names.kindOf>>) => about.filter(key => kinds.includes(names.kindOf(key)))
  const busy = (word: string): string => {
    const holders = of('resource')
    const jobs = of('job')
    const who = holders.length > 0 ? names.list(holders) : 'the crew or tool it needs'
    return `${who} ${holders.length > 1 ? 'are' : 'is'} ${word}${jobs.length > 0 ? ` with ${names.list(jobs)}` : ''}${until(because, context)}`
  }
  switch (because.kind) {
    case 'link': return `it follows ${names.list(of('job').length > 0 ? of('job') : about)}${until(because, context)}`
    case 'crew': return busy('busy')
    case 'tool': return busy('in use')
    case 'shift': {
      const calendars = of('calendar')
      const crews = of('resource')
      return calendars.length > 0
        ? `no working time on ${names.list(calendars)}${crews.length > 0 ? ` for ${names.list(crews)}` : ''}${until(because, context)}`
        : `no working time for ${crews.length > 0 ? names.list(crews) : 'its crew or tool'}${until(because, context)}`
    }
    case 'availability': return of('rule').length > 0 ? `starting earlier would break “${names.list(of('rule'))}”` : 'starting earlier would take too much equipment out together'
    case 'span-limit': return of('rule').length > 0 ? `starting earlier would stretch the outage past “${names.list(of('rule'))}”` : 'starting earlier would stretch an outage past its limit'
    case 'window': return `the window opens ${at(because, context)}`
    case 'release': return `it cannot start before ${at(because, context)}`
    case 'lock': return 'you fixed its start'
    case 'data-date': return `nothing starts before the plan's "now", ${at(because, context)}`
    case 'late-as-possible': return 'it is placed as late as its successors allow, to keep equipment in service'
    case 'purchase-not-allowed': return `${names.list(of('purchase'))} ${of('purchase').length === 1 ? 'is' : 'are'} not allowed`
  }
}

const dueText = (rule: string, context: Context): string => {
  const due = context.inputs.rules.find(item => item.key === rule)
  return due?.kind === 'due' ? `due ${context.format.clock(due.finishBy)}` : 'a due time no longer in this plan'
}

/** Float with what limits it. Float counts logic and calendars only, and the screen says so. */
export const floatText = (float: DatedRow['float'] | { readonly workingHours: number; readonly limitedBy?: undefined }, context: Context): string => {
  const limit = float.limitedBy === undefined || float.limitedBy.kind === 'window-end'
    ? 'the window end'
    : float.limitedBy.kind === 'due' ? dueText(float.limitedBy.rule, context) : `“${context.names.rule(float.limitedBy.rule)}”`
  return `Float ${hoursText(float.workingHours)}, limited by: ${limit} (crew availability is not counted)`
}

export interface WhyStart {
  readonly job: string
  readonly when: string
  /** "It starts then because …" */
  readonly sentence: string
  readonly causes: readonly string[]
  /** All causes bind together: easing one alone does not move the job. */
  readonly joint: boolean
  readonly float: string
}

export const whyStart = (item: ExplainItem, context: Context, row?: DatedRow): WhyStart => {
  const causes = item.because.map(because => causeText(because, context))
  const sentence = item.joint && causes.length > 1
    ? `It starts then because all of these hold at once (easing only one does not move it): ${causes.join('; ')}.`
    : `It starts then because ${causes.join('; ')}.`
  return {
    job: context.names.job(item.job), when: context.format.range(item.start, item.finish), sentence, causes, joint: item.joint && causes.length > 1,
    float: floatText(row?.float ?? { workingHours: item.floatHours }, context),
  }
}

export interface FinishStep {
  readonly job: string
  readonly when: string
  readonly because: string
  /** The job's hard due time, a rule: "Due Thu 15:00: …". */
  readonly due: string | null
}

/** The chain that sets the finish, last job first as explain returns it. */
export const finishChain = (result: ExplainResult, context: Context): readonly FinishStep[] =>
  result.items.map(item => ({
    job: context.names.job(item.job),
    when: context.format.range(item.start, item.finish),
    because: `${item.joint && item.because.length > 1 ? 'Together: ' : ''}${item.because.map(because => causeText(because, context)).join('; ')}`,
    due: (() => {
      const due = context.inputs.rules.find(rule => rule.kind === 'due' && rule.job === item.job)
      return due?.kind === 'due' ? `Due ${context.format.clock(due.finishBy)}: ${due.words}` : null
    })(),
  }))
